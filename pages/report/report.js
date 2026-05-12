const { generateReport, buildScoreNarrative } = require('../../utils/reportGenerator.js')
const { drawReportCard } = require('../../utils/shareImage.js')

/** 首次渲染就要拿到实例，否则 ec-canvas 在 ready 里发现 echarts 为空会直接 return */
function resolveEchartsLib() {
  try {
    const app = getApp()
    if (app && app.globalData && app.globalData.echartsLib) {
      return app.globalData.echartsLib
    }
  } catch (e) {
    /* App 尚未就绪时走本地 require */
  }
  const em = require('../../libs/echarts.min.js')
  return em.default || em
}

const ECHARTS_LIB = resolveEchartsLib()

function fmtYuan(n) {
  const x = Math.round(Number(n) || 0)
  const s = String(Math.abs(x))
  const head = x < 0 ? '-' : ''
  return head + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function linesFromEntries(items) {
  if (!items || !items.length) return []
  return items.map((it) => {
    const hasName = Object.prototype.hasOwnProperty.call(it, 'name')
    const cnt = hasName ? 1 : it.count || 1
    const unit = Number(it.value) || 0
    const subtotal = Math.round(unit * cnt)
    const label = it.name || it.type || '项目'
    if (hasName) {
      return `${label} ｜ ${fmtYuan(subtotal)} 元`
    }
    return `${label} × ${cnt} ｜ ${fmtYuan(subtotal)} 元（单项 ${fmtYuan(unit)} 元）`
  })
}

function buildScoreTone(scores) {
  const tone = (v) => {
    const x = Number(v) || 0
    if (x >= 75) return 'mint'
    if (x < 45) return 'warn'
    return 'neutral'
  }
  return {
    financialHealth: tone(scores.financialHealth),
    skillRetention: tone(scores.skillRetention),
    transformationResilience: tone(scores.transformationResilience),
    cashflowSafety: tone(scores.cashflowSafety)
  }
}

function buildEmotionLine(scores) {
  const cf = Number(scores.cashflowSafety) || 0
  const avg =
    ((Number(scores.financialHealth) || 0) +
      (Number(scores.skillRetention) || 0) +
      (Number(scores.transformationResilience) || 0) +
      cf) /
    4
  if (avg >= 72 && cf >= 70) {
    return '你的财务健康状况整体良好，现金流非常安全，继续保持哦✨'
  }
  if (cf >= 65) {
    return '现金流安全边际不错，搭配记账复盘会更安心。'
  }
  if (avg >= 58) {
    return '整体在中位区间，循序渐进就能明显提升可控感。'
  }
  return '别担心，我们一起拆解重点：先稳住现金流，再逐步优化结构。'
}

function buildTrendHint(netWorth) {
  const n = Number(netWorth) || 0
  if (n > 0) return '净资产为正 → 建议保持稳定结余巩固安全边际'
  if (n < 0) return '净资产为负 ↑ 优先稳住现金流并逐步减重负债'
  return '可从月度结余开始，逐步增厚净资产 →'
}

function hasValidAssessmentPayload(stored) {
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
    echartsLib: ECHARTS_LIB,
    ec: {
      lazyLoad: true
    },
    radarScores: {
      financialHealth: 0,
      skillRetention: 0,
      transformationResilience: 0,
      cashflowSafety: 0
    },
    totalAssetsFmt: '0',
    totalLiabilitiesFmt: '0',
    netWorthFmt: '0',
    assetLines: [],
    liabilityLines: [],
    hiddenAssetCard: '',
    riskCard: '',
    submitting: false,
    refreshingScore: false,
    dynamicHint: '',
    sharingImage: false,
    emotionLine: '',
    trendHint: '',
    netWorthTone: 'pos',
    scoreNarrative: '',
    scoreNarrativeLines: [],
    scoreTone: {
      financialHealth: 'neutral',
      skillRetention: 'neutral',
      transformationResilience: 'neutral',
      cashflowSafety: 'neutral'
    },
    assetExpanded: false,
    liabilityExpanded: false,
    radarReady: false,
    refresherLoading: false,
    timelineEvents: []
  },

  _report: null,
  _storedAssessment: null,
  _reportMode: 'assessment',
  _radarInitRetry: 0,

  async onLoad(options = {}) {
    const currentOpenId = wx.getStorageSync('openId') || ''
    try {
      const fromDialog = String(options.timeline || '') === '1'
      if (fromDialog) {
        const timeline =
          wx.getStorageSync(`assessment_timeline_events:${currentOpenId}`) ||
          wx.getStorageSync('assessment_timeline_events') ||
          []
        this.setData({ timelineEvents: Array.isArray(timeline) ? timeline : [] })
      }
    } catch (e) {}

    let stored = null
    try {
      stored = wx.getStorageSync('assessmentData')
    } catch (e) {
      console.error(e)
    }

    const fromAssessmentGenerate = String(options.fromAssessment || '') === '1'
    const missingStored = !stored
    const payloadWeak = !hasValidAssessmentPayload(stored)
    /** 刚从体检点「生成报告」进来：即使抽取结果全空也要留在报告页，避免误跳回对话 */
    const forceShowAssessmentReport =
      fromAssessmentGenerate && stored && stored.payload != null && !missingStored

    if ((missingStored || payloadWeak) && !forceShowAssessmentReport) {
      await this.loadLatestReportMode()
      return
    }

    this._storedAssessment = stored
    const report = generateReport(stored)
    this._report = report

    this._reportMode = 'assessment'
    const merged = await this.resolveDynamicRadarScores(report.radarScores)
    const pres = this.computePresentation(merged.scores, report.netWorth)
    this.setData({
      radarScores: merged.scores,
      totalAssetsFmt: fmtYuan(report.totalAssets),
      totalLiabilitiesFmt: fmtYuan(report.totalLiabilities),
      netWorthFmt: fmtYuan(report.netWorth),
      assetLines: linesFromEntries(report.assetsList),
      liabilityLines: linesFromEntries(report.liabilitiesList),
      hiddenAssetCard: report.hiddenAssetCard,
      riskCard: report.riskCard,
      dynamicHint: merged.hint,
      radarReady: false,
      ...pres,
      scoreNarrative: report.scoreNarrative || '',
      scoreNarrativeLines: (report.scoreNarrative || '')
        .split(/\n\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    })
    wx.nextTick(() => {
      setTimeout(() => this.initRadar(merged.scores), 80)
    })
  },

  onReady() {
    const scores = this.data.radarScores
    if (!scores) return
    wx.nextTick(() => {
      setTimeout(() => this.initRadar(scores), 120)
    })
  },

  async loadLatestReportMode() {
    try {
      const openId = wx.getStorageSync('openId')
      if (!openId) {
        wx.redirectTo({ url: '/pages/assessment/assessment' })
        return
      }
      const db = wx.cloud.database()
      const [hrRes, snapRes] = await Promise.all([
        db
          .collection('health_reports')
          .where({ openId })
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get(),
        db.collection('balance_snapshot').where({ openId }).limit(1).get()
      ])

      const hr = hrRes.data && hrRes.data[0]
      const snap = snapRes.data && snapRes.data[0]
      if (!hr && !snap) {
        wx.redirectTo({ url: '/pages/assessment/assessment' })
        return
      }

      const baseScores = hr
        ? {
            financialHealth: Number(hr.radarScores && hr.radarScores.financialHealth) || 0,
            skillRetention: Number(hr.radarScores && hr.radarScores.skillRetention) || 0,
            transformationResilience:
              Number(hr.radarScores && hr.radarScores.transformationResilience) || 0,
            cashflowSafety: Number(hr.radarScores && hr.radarScores.cashflowSafety) || 0
          }
        : {
            financialHealth: 50,
            skillRetention: 50,
            transformationResilience: 50,
            cashflowSafety: 50
          }

      const merged = await this.resolveDynamicRadarScores(baseScores)

      const totalAssets =
        snap && typeof snap.totalAssets === 'number'
          ? snap.totalAssets
          : ((snap && snap.assets) || []).reduce((s, x) => s + (Number(x.value) || 0), 0)
      const totalLiabilities =
        snap && typeof snap.totalLiabilities === 'number'
          ? snap.totalLiabilities
          : ((snap && snap.liabilities) || []).reduce((s, x) => s + (Number(x.value) || 0), 0)
      const netWorth =
        snap && typeof snap.netWorth === 'number'
          ? snap.netWorth
          : totalAssets - totalLiabilities

      this._reportMode = 'latest'
      const pres = this.computePresentation(merged.scores, netWorth)
      const monthlyExpenseGuess = Math.max(
        1,
        Number(hr && hr.monthlyExpense) ||
          Number(snap && snap.monthlyExpense) ||
          5000
      )
      const scoreNarrative = buildScoreNarrative({
        radarScores: merged.scores,
        netWorth,
        totalAssets,
        totalLiabilities,
        monthlyIncome: Number(hr && hr.monthlyIncome) || Number(snap && snap.monthlyIncome) || 0,
        monthlyExpense: monthlyExpenseGuess,
        coreSkill: (hr && hr.coreSkill) || '',
        biggestWorry: (hr && hr.biggestWorry) || ''
      })
      this.setData({
        radarScores: merged.scores,
        totalAssetsFmt: fmtYuan(totalAssets),
        totalLiabilitiesFmt: fmtYuan(totalLiabilities),
        netWorthFmt: fmtYuan(netWorth),
        assetLines: linesFromEntries((snap && snap.assets) || (hr && hr.assets) || []),
        liabilityLines: linesFromEntries((snap && snap.liabilities) || (hr && hr.liabilities) || []),
        hiddenAssetCard:
          (hr && hr.insights && hr.insights.hiddenAssetCard) ||
          '建议持续积累可迁移技能与现金流缓冲。',
        riskCard:
          (hr && hr.insights && hr.insights.riskCard) ||
          '近期记账变化较大，请关注月度结余和预算超支情况。',
        dynamicHint: merged.hint,
        radarReady: false,
        ...pres,
        scoreNarrative,
        scoreNarrativeLines: (scoreNarrative || '')
          .split(/\n\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      })
      wx.nextTick(() => {
        setTimeout(() => this.initRadar(merged.scores), 80)
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '读取报告失败', icon: 'none' })
      wx.redirectTo({ url: '/pages/assessment/assessment' })
    }
  },

  async resolveDynamicRadarScores(baseScores) {
    let scores = Object.assign({}, baseScores || {})
    let hint = ''
    try {
      const openId = wx.getStorageSync('openId')
      if (!openId) return { scores, hint }
      const db = wx.cloud.database()
      const uRes = await db.collection('users').where({ openId }).limit(1).get()
      const u = uRes.data && uRes.data[0]
      const ds = (u && u.dynamicScores) || {}
      if (typeof ds.cashflowSafety === 'number') {
        scores.cashflowSafety = ds.cashflowSafety
        hint = '现金流安全度已使用动态跟踪分数'
      }
      if (u && u.isVip && typeof ds.financialHealth === 'number') {
        scores.financialHealth = ds.financialHealth
        hint = hint ? `${hint}；财务健康度已按付费动态模式更新` : '财务健康度已按付费动态模式更新'
      }
    } catch (e) {
      console.warn(e)
    }
    return { scores, hint }
  },

  computePresentation(scores, netWorthNum) {
    return {
      scoreTone: buildScoreTone(scores),
      emotionLine: buildEmotionLine(scores),
      trendHint: buildTrendHint(netWorthNum),
      netWorthTone: (Number(netWorthNum) || 0) >= 0 ? 'pos' : 'neg'
    }
  },

  toggleAssets() {
    this.setData({ assetExpanded: !this.data.assetExpanded })
  },

  toggleLiabilities() {
    this.setData({ liabilityExpanded: !this.data.liabilityExpanded })
  },

  async onScrollRefresh() {
    this.setData({ refresherLoading: true })
    try {
      if (this._reportMode === 'latest') {
        await this.loadLatestReportMode()
      } else if (this._storedAssessment && this._report) {
        const merged = await this.resolveDynamicRadarScores(this._report.radarScores)
        const pres = this.computePresentation(merged.scores, this._report.netWorth)
        this.setData({
          radarScores: merged.scores,
          dynamicHint: merged.hint,
          radarReady: false,
          ...pres,
          scoreNarrative: this._report.scoreNarrative || '',
          scoreNarrativeLines: (this._report.scoreNarrative || '')
            .split(/\n\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        })
        wx.nextTick(() => {
          setTimeout(() => this.initRadar(merged.scores), 60)
        })
      }
    } catch (e) {
      console.error(e)
    } finally {
      this.setData({ refresherLoading: false })
    }
  },

  async onRefreshScore() {
    if (this.data.refreshingScore) return
    this.setData({ refreshingScore: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'updateCashflowScore',
        data: {}
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '刷新失败', icon: 'none' })
        return
      }

      const current = Object.assign({}, this.data.radarScores)
      current.cashflowSafety = r.cashflowSafety
      if (typeof r.financialHealth === 'number') {
        current.financialHealth = r.financialHealth
      }
      this.setData({
        radarScores: current,
        dynamicHint: '现金流安全度已按最新记账动态更新'
      })
      if (this._radarChart) {
        try {
          this._radarChart.setOption(this.buildRadarOption(current), true)
        } catch (e) {}
      }
      wx.showToast({ title: '评分已刷新', icon: 'success' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e.errMsg || '刷新失败', icon: 'none' })
    } finally {
      this.setData({ refreshingScore: false })
    }
  },

  async onShareReportImage() {
    if (this.data.sharingImage) return
    this.setData({ sharingImage: true })
    try {
      const openId = wx.getStorageSync('openId') || ''
      const caseNoMasked = openId
        ? `TC-${openId.slice(0, 3)}****${openId.slice(-3)}`
        : 'TC-****'
      const file = await drawReportCard(
        this,
        'share-report-canvas',
        {
          caseNoMasked,
          netWorth: `${this.data.netWorthFmt} 元`,
          keyInsight: this.data.hiddenAssetCard || this.data.riskCard
        },
        '体检报告'
      )
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath: file,
          success: () => resolve(),
          fail: (e) => reject(e)
        })
      })
      wx.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (e) {
      wx.showModal({
        title: '生成成功',
        content: '请在弹出的图片预览中长按保存，或检查相册授权。',
        showCancel: false
      })
    } finally {
      this.setData({ sharingImage: false })
    }
  },

  buildRadarOption(scores) {
    const vals = [
      scores.financialHealth,
      scores.skillRetention,
      scores.transformationResilience,
      scores.cashflowSafety
    ]
    return {
      color: ['#1e3a8a'],
      radar: {
        radius: '58%',
        splitNumber: 4,
        axisName: {
          color: '#64748b',
          fontSize: 11
        },
        indicator: [
          { name: '财务健康度', max: 100 },
          { name: '技能保值度', max: 100 },
          { name: '转型韧性', max: 100 },
          { name: '现金流安全度', max: 100 }
        ]
      },
      series: [
        {
          type: 'radar',
          areaStyle: { opacity: 0.22 },
          lineStyle: { width: 2 },
          data: [{ value: vals, name: '诊断' }]
        }
      ]
    }
  },

  initRadar(scores) {
    const ec = ECHARTS_LIB || this.data.echartsLib
    if (!ec || typeof ec.init !== 'function') {
      this.setData({ radarReady: true })
      console.error('ECharts 未正确加载')
      return
    }

    wx.createSelectorQuery()
      .in(this)
      .select('.radar-box')
      .boundingClientRect((rect) => {
        this._radarBoxRect = rect || null
        this._initRadarWithBox(scores, ec)
      })
      .exec()
  },

  _initRadarWithBox(scores, ec) {
    const box = this._radarBoxRect
    const fallbackW = box && box.width > 20 ? box.width : 300
    const fallbackH = box && box.height > 20 ? box.height : 300

    const comp = this.selectComponent('#report-radar')
    if (!comp) {
      if (this._radarInitRetry < 8) {
        this._radarInitRetry += 1
        setTimeout(() => this.initRadar(scores), 150)
        return
      }
      this.setData({ radarReady: true })
      console.warn('ec-canvas not found')
      return
    }

    this.setData({ radarReady: false })

    if (this._radarChart) {
      try {
        this._radarChart.dispose()
      } catch (e) {}
      this._radarChart = null
    }

    const readyGuardTimer = setTimeout(() => {
      if (!this.data.radarReady) this.setData({ radarReady: true })
    }, 4000)
    try {
      comp.init((canvas, width, height, dpr) => {
        const w = width > 20 && height > 20 ? width : fallbackW
        const h = width > 20 && height > 20 ? height : fallbackH
        const chart = ec.init(canvas, null, {
          width: w,
          height: h,
          devicePixelRatio: dpr || 1
        })
        if (canvas && typeof canvas.setChart === 'function') {
          canvas.setChart(chart)
        }
        chart.setOption(this.buildRadarOption(scores))
        setTimeout(() => {
          try {
            chart.resize()
          } catch (e) {}
        }, 80)
        this._radarChart = chart
        this._radarInitRetry = 0
        clearTimeout(readyGuardTimer)
        this.setData({ radarReady: true })
        return chart
      })
    } catch (e) {
      clearTimeout(readyGuardTimer)
      console.error('initRadar failed', e)
      this.setData({ radarReady: true })
    }
  },

  async onComplete() {
    if (!this._report || !this._storedAssessment || this.data.submitting) return

    const report = this._report
    const reportData = {
      assets: report.assetsList,
      liabilities: report.liabilitiesList,
      netWorth: report.netWorth,
      totalAssets: report.totalAssets,
      totalLiabilities: report.totalLiabilities,
      radarScores: report.radarScores,
      insights: report.insights,
      coreSkill: report.coreSkill,
      biggestWorry: report.biggestWorry,
      timelineEvents: this.data.timelineEvents || []
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
        wx.showToast({
          title: r.message || '保存失败',
          icon: 'none'
        })
        return
      }

      try {
        wx.removeStorageSync('assessmentData')
      } catch (e) {}

      wx.showToast({ title: '已完成', icon: 'success' })
      wx.reLaunch({ url: '/pages/index/index' })
    } catch (err) {
      console.error(err)
      wx.showToast({
        title: err.errMsg || '保存失败',
        icon: 'none'
      })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
