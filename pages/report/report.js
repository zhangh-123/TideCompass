const { generateReport } = require('../../utils/reportGenerator.js')
const {
  sumAssetValue,
  sumLiabilityValue,
  clampReasonableMonthlyExpense,
  clampReasonableMonthlyIncome
} = require('../../utils/extractHelper.js')
const { buildFinancialAdvicePrompt } = require('../../utils/financialAdvicePrompt.js')
const { parseAssessmentFromDialogSummary } = require('../../utils/assessmentDialogSummaryParse.js')

const ADVICE_CHAT_TIMEOUT_MS = 50000
const ADVICE_GENERATE_TIMEOUT_MS = 55000

function getStoredDialogHistory(openId) {
  const oid = openId || 'anonymous'
  const keys = [`assessment_dialog:${oid}`, `assessment_dialog_draft:${oid}`]
  for (let i = 0; i < keys.length; i++) {
    try {
      const raw = wx.getStorageSync(keys[i])
      if (Array.isArray(raw) && raw.length) return raw
      if (raw && Array.isArray(raw.messages) && raw.messages.length) return raw.messages
    } catch (e) {}
  }
  return []
}

function getDialogTextCorpus(openId) {
  return getStoredDialogHistory(openId)
    .map((m) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${String(m.content || '')}`)
    .join('\n')
}

/** 用对话原文 + 助手汇总校正月收支，避免旧缓存把房贷本金当月支出 */
function sanitizeBundleCashflow(bundle, openId) {
  const b = bundle && typeof bundle === 'object' ? { ...bundle } : {}
  const corpus = getDialogTextCorpus(openId)
  const dialogHistory = getStoredDialogHistory(openId)

  let inc = clampReasonableMonthlyIncome(Number(b.monthlyIncome) || 0, corpus)
  let exp = clampReasonableMonthlyExpense(Number(b.monthlyExpense) || 0, corpus)

  if (dialogHistory.length) {
    const fromSummary = parseAssessmentFromDialogSummary(dialogHistory)
    if (fromSummary.monthlyIncome > 0) inc = fromSummary.monthlyIncome
    if (fromSummary.monthlyExpense > 0) exp = fromSummary.monthlyExpense
  }

  b.monthlyIncome = inc
  b.monthlyExpense = exp
  b._dialogCorpus = corpus
  return b
}

function fmtMoneyYuan(n) {
  const x = Math.round(Number(n) || 0)
  const sign = x < 0 ? '-' : ''
  const body = String(Math.abs(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}¥${body}`
}

function formatReportDate(ts) {
  const d = new Date(Number(ts) || Date.now())
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}年${m}月${day}日`
}

function normalizeDetailRows(list) {
  return (list || []).map((it) => {
    const name = String(it.name || it.type || '项目').trim() || '项目'
    const value = Math.round((Number(it.value) || 0) * (Number(it.count) || 1))
    return { name, value, valueFmt: fmtMoneyYuan(value) }
  })
}

function hasValidPayload(stored) {
  const payload = stored && stored.payload ? stored.payload : null
  if (!payload) return false
  const assets = Array.isArray(payload.assets) ? payload.assets : []
  const liabilities = Array.isArray(payload.liabilities) ? payload.liabilities : []
  const monthlyIncome = Number(payload.monthlyIncome) || 0
  const monthlyExpense = Number(payload.monthlyExpense) || 0
  return assets.length > 0 || liabilities.length > 0 || monthlyIncome > 0 || monthlyExpense > 0
}

Page({
  data: {
    reportDateText: '',
    totalAssetsFmt: '¥0',
    totalLiabilitiesFmt: '¥0',
    netWorthFmt: '¥0',
    netWorthTone: 'pos',
    assets: [],
    liabilities: [],
    popupVisible: false,
    popupTitle: '',
    popupItems: [],
    aiAnalysis: '',
    aiLoading: true,
    aiError: '',
    showCompleteBtn: false,
    submitting: false,
    pageLoading: true,
    loadError: ''
  },

  _storedAssessment: null,
  _reportSnapshot: null,

  async onLoad(options = {}) {
    const fromAssessment = String(options.fromAssessment || '') === '1'
    this.setData({ showCompleteBtn: fromAssessment })

    try {
      const bundle = await this.loadReportBundle(options)
      if (!bundle) {
        this.setData({
          pageLoading: false,
          loadError: '未找到体检数据。请重新完成财务体检，或从首页进入后再试。'
        })
        return
      }

      const openId = wx.getStorageSync('openId') || ''
      const safeBundle = sanitizeBundleCashflow(bundle, openId)
      this._storedAssessment = safeBundle.rawAssessment
      this._reportSnapshot = safeBundle

      const assets = normalizeDetailRows(safeBundle.assets)
      const liabilities = normalizeDetailRows(safeBundle.liabilities)
      const totalAssets =
        typeof safeBundle.totalAssets === 'number'
          ? Math.round(safeBundle.totalAssets)
          : sumAssetValue(safeBundle.assets || [])
      const totalLiabilities =
        typeof safeBundle.totalLiabilities === 'number'
          ? Math.round(safeBundle.totalLiabilities)
          : sumLiabilityValue(safeBundle.liabilities || [])
      const netWorth =
        typeof safeBundle.netWorth === 'number'
          ? Math.round(safeBundle.netWorth)
          : totalAssets - totalLiabilities

      this.setData({
        reportDateText: formatReportDate(safeBundle.createdAt),
        totalAssetsFmt: fmtMoneyYuan(totalAssets),
        totalLiabilitiesFmt: fmtMoneyYuan(totalLiabilities),
        netWorthFmt: fmtMoneyYuan(netWorth),
        netWorthTone: netWorth >= 0 ? 'pos' : 'neg',
        assets,
        liabilities,
        pageLoading: false
      })

      this.fetchAiAnalysis(safeBundle)
    } catch (e) {
      console.error('report onLoad', e)
      this.setData({
        pageLoading: false,
        aiLoading: false,
        loadError: '报告加载异常，请重新编译后完成体检再进入。'
      })
    }
  },

  async loadReportBundle(options) {
    const fromAssessment = String(options.fromAssessment || '') === '1'
    const openId = wx.getStorageSync('openId') || ''

    let local = null
    try {
      local = wx.getStorageSync('assessmentData')
    } catch (e) {}

    let cloudBody = null
    try {
      const res = await wx.cloud.callFunction({ name: 'getLatestHealthReport' })
      cloudBody = res.result || {}
    } catch (e) {
      console.warn('getLatestHealthReport', e)
    }

    let timeline = []
    try {
      timeline =
        wx.getStorageSync(`assessment_timeline_events:${openId}`) ||
        wx.getStorageSync('assessment_timeline_events') ||
        []
    } catch (e) {}
    if (!Array.isArray(timeline)) timeline = []

    const profile = (cloudBody && cloudBody.profile) || {}

    const localHasPayload = local && local.payload != null
    const localValid = localHasPayload && hasValidPayload(local)
    const cloudReport = cloudBody && cloudBody.success && cloudBody.report ? cloudBody.report : null
    const localTs = local && local.completedAt ? Number(local.completedAt) : 0
    const cloudTs = cloudReport && cloudReport.createdAt ? Number(cloudReport.createdAt) : 0
    const preferLocal =
      localValid &&
      (!cloudReport || !cloudTs || (localTs && localTs >= cloudTs) || fromAssessment)
    const useLocal =
      localHasPayload && (preferLocal || fromAssessment || (localValid && !!local.completedAt))
    if (useLocal) {
      const p = local.payload
      return sanitizeBundleCashflow(
        {
          assets: p.assets || [],
          liabilities: p.liabilities || [],
          monthlyIncome: Number(p.monthlyIncome) || 0,
          monthlyExpense: Number(p.monthlyExpense) || 0,
          coreSkill: p.coreSkill || '',
          biggestWorry: p.maxWorry || '',
          timeline_events:
            timeline.length > 0
              ? timeline
              : (cloudBody && cloudBody.report && cloudBody.report.timeline_events) || [],
          profile,
          rawAssessment: local,
          createdAt: local.completedAt || Date.now()
        },
        openId
      )
    }

    if (cloudBody && cloudBody.success && cloudBody.report) {
      const r = cloudBody.report
      return sanitizeBundleCashflow(
        {
          assets: r.assets || [],
          liabilities: r.liabilities || [],
          monthlyIncome: Number(r.monthlyIncome) || 0,
          monthlyExpense: Number(r.monthlyExpense) || 0,
          coreSkill: r.coreSkill || '',
          biggestWorry: r.biggestWorry || '',
          timeline_events: r.timeline_events || timeline,
          totalAssets: r.totalAssets,
          totalLiabilities: r.totalLiabilities,
          netWorth: r.netWorth,
          profile: cloudBody.profile || profile,
          rawAssessment: null,
          createdAt: r.createdAt || Date.now()
        },
        openId
      )
    }

    return null
  },

  buildAdviceReportPayload(bundle) {
    const profile = (bundle && bundle.profile) || {}
    const assets = (bundle && bundle.assets) || []
    const liabilities = (bundle && bundle.liabilities) || []
    const corpus =
      bundle._dialogCorpus ||
      [
        String(bundle.coreSkill || ''),
        String(bundle.biggestWorry || ''),
        (bundle.assets || []).map((a) => `${a.name}${a.value}`).join(''),
        (bundle.liabilities || []).map((l) => `${l.name}${l.value}`).join('')
      ].join('\n')
    return {
      assets,
      liabilities,
      monthlyIncome: clampReasonableMonthlyIncome(bundle.monthlyIncome, corpus),
      monthlyExpense: clampReasonableMonthlyExpense(bundle.monthlyExpense, corpus),
      totalAssets:
        typeof bundle.totalAssets === 'number' ? bundle.totalAssets : sumAssetValue(assets),
      totalLiabilities:
        typeof bundle.totalLiabilities === 'number'
          ? bundle.totalLiabilities
          : sumLiabilityValue(liabilities),
      netWorth:
        typeof bundle.netWorth === 'number'
          ? bundle.netWorth
          : sumAssetValue(assets) - sumLiabilityValue(liabilities),
      timeline_events: bundle.timeline_events,
      coreSkill: bundle.coreSkill,
      biggestWorry: bundle.biggestWorry,
      jobStatus: profile.jobStatus,
      familyStructure: profile.familyStructure,
      profile
    }
  },

  withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message || '请求超时')), ms)
      Promise.resolve(promise)
        .then((v) => {
          clearTimeout(timer)
          resolve(v)
        })
        .catch((err) => {
          clearTimeout(timer)
          reject(err)
        })
    })
  },

  async callChatCompletionForAdvice(reportPayload) {
    const prompt = buildFinancialAdvicePrompt(reportPayload)
    const res = await this.withTimeout(
      wx.cloud.callFunction({
        name: 'chatCompletion',
        data: {
          messages: [{ role: 'user', content: prompt }],
          systemPrompt:
            '你是专业、温暖的中文财务规划师。只输出分析报告正文，不少于200字，不要输出 JSON 或额外说明。'
        }
      }),
      ADVICE_CHAT_TIMEOUT_MS,
      '智能分析响应超时'
    )
    const body = res.result || {}
    const text = body.reply ? String(body.reply).trim() : ''
    if (body.success && text.length >= 80) {
      return { ok: true, text }
    }
    return { ok: false, message: body.message || '模型未返回有效分析' }
  },

  llmDeployHint(message) {
    const msg = String(message || '')
    if (/LLM_API_KEY|未配置/.test(msg)) {
      return '请在云开发环境变量中配置 LLM_API_KEY（与 chatCompletion 相同）'
    }
    if (/axios|云端安装依赖|Cannot find module/i.test(msg)) {
      return '请在开发者工具中上传部署 generateFinancialAdvice、chatCompletion（云端安装依赖）'
    }
    if (/FUNCTION_NOT_FOUND|502003|云函数不存在/i.test(msg)) {
      return '请上传部署云函数 generateFinancialAdvice 与 chatCompletion'
    }
    if (/timeout|超时/i.test(msg)) return '模型响应超时，请稍后重试'
    return ''
  },

  async fetchAiAnalysis(bundle) {
    this.setData({ aiLoading: true, aiError: '' })
    const reportPayload = this.buildAdviceReportPayload(bundle)

    const applyAnalysis = (text, errHint = '', meta = {}) => {
      if (meta.source) {
        console.log('[report] ai analysis source:', meta.source, meta.detail || '')
      }
      this.setData({
        aiAnalysis: text,
        aiLoading: false,
        aiError: errHint
      })
    }

    const tryChatCompletion = async (reason) => {
      console.warn('[report] fallback to chatCompletion:', reason || '')
      try {
        return await this.callChatCompletionForAdvice(reportPayload)
      } catch (e) {
        console.warn('callChatCompletionForAdvice', e)
        return { ok: false, message: (e && (e.message || e.errMsg)) || '' }
      }
    }

    let body = {}
    let callErrMsg = ''
    try {
      const res = await this.withTimeout(
        wx.cloud.callFunction({
          name: 'generateFinancialAdvice',
          data: { report: reportPayload }
        }),
        ADVICE_GENERATE_TIMEOUT_MS,
        'generateFinancialAdvice 超时'
      )
      body = res.result || {}
    } catch (e) {
      callErrMsg = String((e && (e.errMsg || e.message)) || '')
      console.warn('generateFinancialAdvice callFunction', callErrMsg)
    }

    const analysisText = body.analysis ? String(body.analysis).trim() : ''
    if (body.success && analysisText.length >= 80) {
      const fromLlm = body.source === 'llm' || (!body.fromFallback && body.source !== 'rule_fallback')
      const hint = fromLlm
        ? ''
        : '（大模型未返回长文，以下为云函数根据体检数据生成的参考解读）'
      applyAnalysis(analysisText, hint, {
        source: fromLlm ? 'generateFinancialAdvice' : 'generateFinancialAdvice_cloud',
        detail: body.message
      })
      return
    }

    const fallbackReason =
      callErrMsg ||
      (body && body.message) ||
      'generateFinancialAdvice 未返回有效分析'

    const chat = await tryChatCompletion(fallbackReason)
    if (chat.ok) {
      applyAnalysis(chat.text, '', { source: 'chatCompletion', detail: fallbackReason })
      return
    }

    const deployHint = this.llmDeployHint(fallbackReason || (chat && chat.message))
    applyAnalysis(
      this.buildLocalFallbackAnalysis(bundle),
      deployHint
        ? `（${deployHint}；以下为本地参考解读）`
        : '（大模型暂不可用，以下为根据体检数据生成的参考解读）',
      { source: 'local', detail: fallbackReason }
    )
  },

  onKpiTap(e) {
    const kind = e.currentTarget.dataset.kind
    if (kind === 'assets') {
      this.openPopup('资产明细', this.data.assets)
    } else if (kind === 'liabilities') {
      this.openPopup('负债明细', this.data.liabilities)
    }
  },

  openPopup(title, items) {
    this.setData({
      popupVisible: true,
      popupTitle: title,
      popupItems: items || []
    })
  },

  closePopup() {
    this.setData({ popupVisible: false })
  },

  noop() {},

  async onComplete() {
    if (!this.data.showCompleteBtn || !this._storedAssessment) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    if (this.data.submitting) return

    const report = generateReport(this._storedAssessment)
    const reportData = {
      assets: report.assetsList,
      liabilities: report.liabilitiesList,
      netWorth: report.netWorth,
      totalAssets: report.totalAssets,
      totalLiabilities: report.totalLiabilities,
      monthlyIncome: report.monthlyIncome,
      monthlyExpense: report.monthlyExpense,
      radarScores: report.radarScores,
      insights: report.insights,
      coreSkill: report.coreSkill,
      biggestWorry: report.biggestWorry,
      timelineEvents: (this._reportSnapshot && this._reportSnapshot.timeline_events) || []
    }

    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'saveReport',
        data: {
          reportData,
          rawAssessment: this._storedAssessment
        }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }
      try {
        wx.removeStorageSync('assessmentData')
      } catch (e) {}
      wx.showToast({ title: '已完成', icon: 'success' })
      wx.reLaunch({ url: '/pages/index/index' })
    } catch (err) {
      console.error(err)
      wx.showToast({ title: err.errMsg || '保存失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  onGoHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  onGoAssessment() {
    wx.redirectTo({ url: '/pages/assessment/assessment?resume=1' })
  },

  onReenterAssessment() {
    wx.redirectTo({ url: '/pages/assessment/assessment?resume=1' })
  },

  buildLocalFallbackAnalysis(bundle) {
    const assets = sumAssetValue(bundle.assets || [])
    const liabilities = sumLiabilityValue(bundle.liabilities || [])
    const netWorth = assets - liabilities
    const openId = wx.getStorageSync('openId') || ''
    const corpus = bundle._dialogCorpus || getDialogTextCorpus(openId)
    const inc = clampReasonableMonthlyIncome(Number(bundle.monthlyIncome) || 0, corpus)
    const exp = clampReasonableMonthlyExpense(Number(bundle.monthlyExpense) || 0, corpus)
    const cf = inc - exp
    const lines = []
    lines.push(
      `根据本次体检录入，您的总资产约 ${fmtMoneyYuan(assets)}，总负债约 ${fmtMoneyYuan(liabilities)}，净资产约 ${fmtMoneyYuan(netWorth)}。`
    )
    if (inc > 0 && exp > 0) {
      lines.push(
        `按月收入 ${fmtMoneyYuan(inc)}、月支出 ${fmtMoneyYuan(exp)} 估算，月度现金流${cf >= 0 ? '为正' : '为负'}（约 ${fmtMoneyYuan(Math.abs(cf))}）。`
      )
    } else {
      lines.push('月收入或月支出尚未完整录入，建议补充后重新生成报告，以便评估现金流。')
    }
    lines.push(
      '建议：优先梳理高息负债；保留 3–6 个月生活费作应急金；基金类资产注意分散与流动性。'
    )
    lines.push('您已完成家底盘点，保持定期更新，财务掌控感会越来越好。')
    return lines.join('\n\n')
  }
})
