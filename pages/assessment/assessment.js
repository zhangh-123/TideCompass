const { hasCompleteProfile, getHomePath } = require('../../utils/route.js')
const { mergeProfileIntoAssessmentSystemPrompt } = require('../../utils/assessmentUserContext.js')
const {
  extractAssets,
  extractLiabilities,
  extractIncome,
  extractExpense,
  estimateMonthlyIncomeTotal,
  estimateMonthlyExpenseSum,
  sanitizeTextForAssetExtraction,
  extractSkillAndWorry,
  strip,
  dedupeFinancialRows,
  crossDedupeAssetsLiabilities
} = require('../../utils/extractHelper.js')
const { sanitizeOcrReviewText } = require('../../utils/ocrReviewText.js')
const {
  IMAGE_TABLE_VISION_USER_PROMPT,
  IMAGE_TABLE_VISION_SYSTEM_PROMPT,
  parseVisionFinancialTableReply,
  remapMergedRows,
  annotateReviewRows,
  serializeReviewRowsForChat,
  rowsFromPlainFinancialLines,
  CATEGORY_KEYS,
  makeReviewRowId
} = require('../../utils/visionFinancialTable.js')
const { mergeStructuredAssessmentPayload } = require('../../utils/assessmentStructuredMerge.js')

const DEFAULT_SYSTEM_PROMPT =
  '你是专业、温和的中文财务体检助手。目标是通过多轮对话收集完整财务画像并识别未来风险。必须覆盖并尽量量化这7类信息：1) 现金与存款（活期/定期/货基）2) 主要资产（房产、车辆、理财、股票基金等）3) 负债（余额、利率、月供/最低还款、到期时间）4) 稳定收入（税后月收入、是否波动）5) 固定支出（家庭刚性开销）6) 保障情况（医保/商保）7) 未来12个月已知事件（大额支出、收入变化、债务到期）。规则：若用户输入不便或信息较多，主动建议其上传银行/支付宝/微信账单或资产截图，并说明“可在输入框旁点击上传按钮进行OCR识别”；若用户提到未来事件但未给时间，必须追问时间；若金额缺失，优先追问金额或区间。只有当以上信息已覆盖，或用户明确表示“暂不清楚/没有更多可补充”时，才结束并在回复末尾明确写出：感谢您的分享，我将为您生成报告。每轮最多问2个关键问题，语气简洁自然，避免一次性长问卷。'

/** 完整匹配或子串匹配；模型常改写为「为您生成一份…报告」导致不含连续「为您生成报告」 */
const FINISH_SIGNAL_KEYWORDS = [
  '感谢您的分享，我将为您生成报告',
  '为您生成报告',
  '信息已经足够',
  '财务体检报告',
  '所有关键信息已收集完毕',
  '关键信息已收集完毕'
]
const REPORT_GENERATE_TIMEOUT_MS = 20000
/** 对话结构化抽取（与 extractTimelineEvents 串行），须小于云函数 timeout */
const STRUCTURED_EXTRACT_MS = 48000
/** 须大于云函数 chatCompletion 内 axios 超时，否则客户端会先断开 */
const CHAT_COMPLETION_CLIENT_MS = 45000
const CHAT_VISION_CLIENT_MS = 70000
/** 识图链路失败时在弹窗中追加，引导用户改用文字录入 */
const VISION_FAIL_USER_HINT =
  '当前图片识别有误，您也可以直接将数据通过文字发送给我，我一样可以帮您记录。'

function shouldAppendVisionUserHint(failStage, errMsg) {
  const stage = String(failStage || '')
  const msg = String(errMsg || '')
  if (stage.includes('调用AI识图')) return true
  if (/AI识图超时|图片识别失败|AI未返回可确认内容|模型调用失败|模型未返回内容/i.test(msg))
    return true
  return false
}

const CONTINUE_ASK_PATTERNS = [
  /请问/,
  /还需要了解/,
  /还想了解/,
  /还需补充/,
  /是否有/,
  /可以告诉我/,
  /为了.*评估/,
  /[?？]/,
  /(^|\n)\s*\d+[、.．]\s*/
]

const FIRST_ASSISTANT_MESSAGE =
  '您好，我是您的财务助手。能否简单说说，最近在财务或工作上最让您感到焦虑的事情是什么？'
const QUICK_EMOJIS = ['🙂', '😄', '🙏', '💪', '📈', '💰', '🏠', '🚗', '🧾', '✅']
Page({
  msgSeq: 0,

  data: {
    title: '财务体检',
    messages: [],
    draft: '',
    sendDisabled: true,
    composerFocus: false,
    scrollIntoView: '',
    generating: false,
    showGenerateButton: false,
    aiTyping: false,
    uploadingImage: false,
    sending: false,
    emojiVisible: false,
    quickEmojis: QUICK_EMOJIS,
    imageReviewVisible: false,
    imageReviewRows: [],
    reviewCategoryLabels: ['资产', '负债', '收入', '支出', '其他']
  },
  currentOpenId: '',

  async onLoad() {
    const ok = await this.runGuard()
    if (!ok) return

    this.currentOpenId = wx.getStorageSync('openId') || ''
    await this.refreshAssessmentSystemPromptFromDb()
    const cached = this.restoreDraft()
    if (cached && cached.messages && cached.messages.length) {
      const normalized = this.normalizeMessages(cached.messages)
      this.msgSeq = normalized.length
      this.setData({
        messages: normalized,
        draft: cached.draft || '',
        sendDisabled: !(cached.draft || '').trim(),
        showGenerateButton: this.containsFinishSignal(normalized)
      })
      this.scrollToLast()
      return
    }

    this.pushAssistant(FIRST_ASSISTANT_MESSAGE)
    this.persistDraft()
  },

  async onShow() {
    if (this.data.generating) {
      this.setData({ generating: false })
    }
    await this.runGuard()
  },

  onUnload() {
    this.persistDraft()
  },

  async refreshAssessmentSystemPromptFromDb() {
    this.assessmentSystemPrompt = DEFAULT_SYSTEM_PROMPT
    try {
      const openId = wx.getStorageSync('openId')
      if (!openId) return
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).get()
      const user = data && data[0]
      if (user && user.profile) {
        this.assessmentSystemPrompt = mergeProfileIntoAssessmentSystemPrompt(
          DEFAULT_SYSTEM_PROMPT,
          user.profile
        )
      }
    } catch (e) {
      console.error('refreshAssessmentSystemPromptFromDb', e)
      this.assessmentSystemPrompt = DEFAULT_SYSTEM_PROMPT
    }
  },

  async runGuard() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return false
    }

    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).get()
      const user = data && data[0]
      if (!user || !user.phone) {
        wx.reLaunch({ url: '/pages/bind_phone/bind_phone' })
        return false
      }
      if (!hasCompleteProfile(user.profile)) {
        wx.reLaunch({ url: '/pages/profile/profile' })
        return false
      }

      let target = getHomePath(user || {})
      let ad = null
      try {
        ad = wx.getStorageSync('assessmentData')
      } catch (e2) {}
      const doneLocalButFlagPending = user && user.isFirstAssessmentDone === false && ad && ad.completedAt
      if (doneLocalButFlagPending) target = '/pages/index/index'
      if (target !== '/pages/assessment/assessment') {
        if (target === '/pages/report/report') {
          wx.redirectTo({ url: target })
        } else {
          wx.reLaunch({ url: target })
        }
        return false
      }

      return true
    } catch (e) {
      console.error(e)
      wx.reLaunch({ url: '/pages/profile/profile' })
      return false
    }
  },

  normalizeMessages(messages) {
    return (messages || []).map((m, idx) => ({
      id: idx + 1,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
      messageType: m.messageType === 'file' ? 'file' : 'text',
      fileName: m.fileName || '',
      fileSizeKb: Number(m.fileSizeKb) || 0,
      localPath: m.localPath || '',
      cloudFileId: m.cloudFileId || ''
    }))
  },

  toApiMessages() {
    return this.data.messages.map((m) => ({ role: m.role, content: m.content }))
  },

  parseMoneyFromText(text) {
    const normalized = String(text || '').replace(/,/g, '').replace(/\s+/g, '')
    if (!normalized) return null

    // 支持：100万 / 100w / 100W / 3.5千 / 2k / 1.2亿 / 500元
    const match = normalized.match(/(\d+(?:\.\d+)?)(亿|万|千|百|w|W|k|K|元|块)?/)
    if (!match) return null

    const base = Number(match[1])
    if (!Number.isFinite(base)) return null

    const unit = match[2] || ''
    let multiplier = 1
    if (unit === '亿') multiplier = 100000000
    else if (unit === '万' || unit === 'w' || unit === 'W') multiplier = 10000
    else if (unit === '千' || unit === 'k' || unit === 'K') multiplier = 1000
    else if (unit === '百') multiplier = 100

    return Math.round(base * multiplier)
  },

  chineseDigitToNumber(ch) {
    const map = {
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9
    }
    return Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : null
  },

  parseChineseSection(sectionText) {
    const section = String(sectionText || '')
    if (!section) return 0
    let num = 0
    let current = 0
    const unitMap = { 十: 10, 百: 100, 千: 1000 }
    for (let i = 0; i < section.length; i += 1) {
      const ch = section[i]
      const digit = this.chineseDigitToNumber(ch)
      if (digit != null) {
        current = digit
        continue
      }
      const unit = unitMap[ch]
      if (unit) {
        const base = current || 1
        num += base * unit
        current = 0
      }
    }
    return num + current
  },

  parseChineseMoneyFromText(text) {
    const src = String(text || '').replace(/\s+/g, '')
    if (!src) return null
    const m = src.match(/[零一二两三四五六七八九十百千万亿]+/)
    if (!m) return null
    const raw = m[0]
    if (!raw) return null

    let total = 0
    let rest = raw

    const yiIdx = rest.indexOf('亿')
    if (yiIdx >= 0) {
      const left = rest.slice(0, yiIdx)
      total += this.parseChineseSection(left) * 100000000
      rest = rest.slice(yiIdx + 1)
    }

    const wanIdx = rest.indexOf('万')
    if (wanIdx >= 0) {
      const left = rest.slice(0, wanIdx)
      total += this.parseChineseSection(left) * 10000
      rest = rest.slice(wanIdx + 1)
    }

    total += this.parseChineseSection(rest)
    return total > 0 ? total : null
  },

  extractAmountsWithIndex(text) {
    const src = String(text || '')
    const reg = /(\d+(?:\.\d+)?)(亿|万|千|百|w|W|k|K|元|块)?/g
    const out = []
    let m = null
    while ((m = reg.exec(src))) {
      const num = Number(m[1])
      if (!Number.isFinite(num)) continue
      const unit = m[2] || ''
      let multiplier = 1
      if (unit === '亿') multiplier = 100000000
      else if (unit === '万' || unit === 'w' || unit === 'W') multiplier = 10000
      else if (unit === '千' || unit === 'k' || unit === 'K') multiplier = 1000
      else if (unit === '百') multiplier = 100
      out.push({
        value: Math.round(num * multiplier),
        index: m.index
      })
    }
    return out
  },

  pickNearestAmountByKeyword(text, keywordReg) {
    const src = String(text || '')
    const amounts = this.extractAmountsWithIndex(src)
    if (!amounts.length) return null
    const matches = []
    const globalReg = new RegExp(keywordReg.source, 'g')
    let km = null
    while ((km = globalReg.exec(src))) {
      matches.push(km.index)
    }
    if (!matches.length) return null
    let best = null
    let bestDist = Infinity
    amounts.forEach((a) => {
      matches.forEach((kIdx) => {
        const d = Math.abs(a.index - kIdx)
        if (d < bestDist) {
          bestDist = d
          best = a
        }
      })
    })
    return best && best.value > 0 ? best.value : null
  },

  inferAssessmentPayload(dialogHistory, timelineEvents) {
    const userTexts = (dialogHistory || [])
      .filter((m) => m.role === 'user')
      .map((m) => String(m.content || ''))
    const allUserText = userTexts.join('\n')

    const payload = {
      assets: [],
      liabilities: [],
      monthlyIncome: 0,
      monthlyExpense: 0,
      coreSkill: '',
      maxWorry: (userTexts[0] || '').slice(0, 80)
    }

    if (/互联网|程序员|开发|工程师|产品|运营|销售|财务|法务|教师/.test(allUserText)) {
      const skillMatched = allUserText.match(/(程序员|开发|工程师|产品|运营|销售|财务|法务|教师)/)
      payload.coreSkill = skillMatched ? skillMatched[1] : ''
    }

    const sw = extractSkillAndWorry(allUserText)
    if (sw.skill) payload.coreSkill = sw.skill
    if (sw.worry) payload.maxWorry = sw.worry.slice(0, 120)

    const assetDedupe = new Map()
    const pushAsset = (name, value) => {
      const v = Math.round(Number(value) || 0)
      if (!Number.isFinite(v) || v <= 0) return
      const label = String(name || '资产').trim() || '资产'
      const key = `${label}|${v}`
      if (assetDedupe.has(key)) return
      assetDedupe.set(key, { name: label, value: v })
    }

    userTexts.forEach((txt) => {
      const raw = strip(txt)
      if (!raw) return
      const segments = raw
        .split(/\n+|；|;/)
        .map((s) => strip(s))
        .filter(Boolean)
      const chunks = segments.length ? segments : [raw]
      chunks.forEach((chunk) => {
        const cleaned = sanitizeTextForAssetExtraction(chunk)
        if (!strip(cleaned)) return
        extractAssets(cleaned).forEach((it) => {
          const subtotal = Math.round(it.value * (it.count || 1))
          pushAsset(it.type, subtotal)
        })
      })
    })

    const liabDedupe = new Map()
    const pushLiability = (name, value) => {
      const v = Math.round(Number(value) || 0)
      if (!Number.isFinite(v) || v <= 0) return
      const label = String(name || '负债').trim() || '负债'
      const key = `${label}|${v}`
      if (liabDedupe.has(key)) return
      liabDedupe.set(key, { name: label, value: v })
    }

    userTexts.forEach((txt) => {
      const raw = strip(txt)
      if (!raw) return
      const segments = raw
        .split(/\n+|；|;/)
        .map((s) => strip(s))
        .filter(Boolean)
      const chunks = segments.length ? segments : [raw]
      chunks.forEach((chunk) => {
        extractLiabilities(chunk).forEach((it) => {
          pushLiability(it.type, it.value)
        })
      })
    })

    const estimatedInc = estimateMonthlyIncomeTotal(allUserText)
    const estimatedExp = estimateMonthlyExpenseSum(allUserText)
    userTexts.forEach((txt) => {
      const inc = extractIncome(txt)
      if (inc && inc < 5e6) payload.monthlyIncome = Math.max(payload.monthlyIncome, inc)
      const exp = extractExpense(txt)
      if (exp && exp < 2e5) payload.monthlyExpense = Math.max(payload.monthlyExpense, exp)
    })
    if (estimatedInc > 0) payload.monthlyIncome = Math.max(payload.monthlyIncome, estimatedInc)
    if (estimatedExp > 0) payload.monthlyExpense = Math.max(payload.monthlyExpense, estimatedExp)

    ;(Array.isArray(timelineEvents) ? timelineEvents : []).forEach((ev) => {
      const amount = Number(ev && ev.amount)
      if (!Number.isFinite(amount) || amount <= 0) return
      if (ev.type === 'debt_maturity') {
        pushLiability(ev.description || '债务到期', amount)
      } else if (ev.type === 'lump_sum_expense') {
        /* 一次性支出不计入「月经常性支出」，避免择校费等把月度现金流模型撑爆 */
      } else if (ev.type === 'asset_locked') {
        pushAsset(ev.description || '资产', amount)
      }
    })

    payload.assets = dedupeFinancialRows(Array.from(assetDedupe.values()))
    payload.liabilities = dedupeFinancialRows(Array.from(liabDedupe.values()))
    const cross = crossDedupeAssetsLiabilities(payload.assets, payload.liabilities)
    payload.assets = cross.assets
    payload.liabilities = cross.liabilities

    return payload
  },

  persistDraft() {
    try {
      wx.setStorageSync(this.getDraftStorageKey(), {
        draft: this.data.draft || '',
        messages: this.toApiMessages(),
        ownerOpenId: this.currentOpenId || '',
        updatedAt: Date.now()
      })
    } catch (e) {
      console.warn('persist draft failed', e)
    }
  },

  restoreDraft() {
    try {
      const cached = wx.getStorageSync(this.getDraftStorageKey())
      if (cached && cached.ownerOpenId && cached.ownerOpenId !== this.currentOpenId) {
        return null
      }
      return cached
    } catch (e) {
      return null
    }
  },

  clearDraft() {
    try {
      wx.removeStorageSync(this.getDraftStorageKey())
    } catch (e) {}
  },

  getDraftStorageKey() {
    return `assessment_dialog_draft:${this.currentOpenId || 'anonymous'}`
  },

  getDialogStorageKey() {
    return `assessment_dialog:${this.currentOpenId || 'anonymous'}`
  },

  getTimelineStorageKey() {
    return `assessment_timeline_events:${this.currentOpenId || 'anonymous'}`
  },

  buildImageConfirmMessage(text) {
    const body = String(text || '').trim()
    return `我上传图片后已核对识别内容，确认与资产负债相关的信息如下（已删除无关与重复项）：\n${body}\n请把这些信息纳入体检，并继续补问我还缺少的关键信息。`
  },

  async onUploadImageTap() {
    if (this.data.uploadingImage || this.data.aiTyping || this.data.generating || this.data.sending) return
    this.setData({ uploadingImage: true, emojiVisible: false, imageReviewVisible: false })
    let failStage = '选择图片'
    try {
      const chooseRes = await new Promise((resolve, reject) => {
        wx.chooseImage({
          count: 9,
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject
        })
      })
      const tempFiles = chooseRes.tempFiles || []
      const paths =
        (chooseRes.tempFilePaths && chooseRes.tempFilePaths.length
          ? chooseRes.tempFilePaths
          : tempFiles.map((f) => f.path).filter(Boolean)) || []
      if (!paths.length) throw new Error('未选择图片')

      const ocrMergedRows = []
      const total = paths.length
      for (let i = 0; i < total; i += 1) {
        const path = paths[i]
        const tempFile = tempFiles[i] || { path, size: 0 }
        failStage = `读取图片 (${i + 1}/${total})`
        if (!path) continue

        const fileName = tempFile.name || `assessment_${Date.now()}_${i + 1}.jpg`
        const fileSizeKb = Math.max(1, Math.round((tempFile.size || 0) / 1024))
        this.pushMessage('user', '', {
          messageType: 'file',
          fileName,
          fileSizeKb,
          localPath: path,
          cloudFileId: ''
        })

        failStage = `上传云存储 (${i + 1}/${total})`
        wx.showLoading({ title: `上传并识别 ${i + 1}/${total}…`, mask: true })
        const ext = (path.split('.').pop() || 'jpg').toLowerCase()
        const cloudPath = `assessment/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}.${ext}`
        const up = await wx.cloud.uploadFile({ cloudPath, filePath: path })

        const list = this.data.messages.slice()
        const last = list[list.length - 1]
        if (last && last.messageType === 'file' && !last.cloudFileId && last.localPath === path) {
          last.cloudFileId = up.fileID
          this.setData({ messages: list }, () => this.scrollToBottom())
        }

        failStage = `获取图片链接 (${i + 1}/${total})`
        const tempUrlRes = await wx.cloud.getTempFileURL({ fileList: [up.fileID] })
        const tempFileURL =
          tempUrlRes &&
          tempUrlRes.fileList &&
          tempUrlRes.fileList[0] &&
          tempUrlRes.fileList[0].tempFileURL
        if (!tempFileURL) {
          throw new Error('未获取到图片访问链接')
        }

        failStage = `调用AI识图 (${i + 1}/${total})`
        const parseRes = await this.withTimeout(
          wx.cloud.callFunction({
            name: 'chatCompletion',
            data: {
              imageUrl: tempFileURL,
              userPrompt: IMAGE_TABLE_VISION_USER_PROMPT,
              systemPrompt: IMAGE_TABLE_VISION_SYSTEM_PROMPT
            }
          }),
          CHAT_VISION_CLIENT_MS,
          'AI识图超时，请稍后重试'
        )
        const body = parseRes.result || {}
        if (!body.success) throw new Error(body.message || '图片识别失败')

        const extracted = String(body.reply || '').trim()
        if (!extracted) throw new Error('AI未返回可确认内容')

        let parsedRows = parseVisionFinancialTableReply(extracted)
        if (!parsedRows.length) {
          const tidied = sanitizeOcrReviewText(extracted) || extracted
          parsedRows = rowsFromPlainFinancialLines(tidied)
        }
        const slimRows = parsedRows.map(({ depth, padRpx, categoryIndex, ...rest }) => rest)
        ocrMergedRows.push(...remapMergedRows(slimRows, `img${i}`))
      }

      wx.hideLoading()
      const tableRows =
        ocrMergedRows.length > 0
          ? annotateReviewRows(ocrMergedRows)
          : annotateReviewRows([
              {
                id: makeReviewRowId(),
                parentId: null,
                label: '',
                amount: '',
                category: 'asset',
                isTotal: false
              }
            ])
      this.setData({
        imageReviewVisible: true,
        imageReviewRows: tableRows
      })
      this.scrollToBottom()
    } catch (e) {
      wx.hideLoading()
      console.error(e)
      const msg = String((e && (e.message || e.errMsg)) || '图片识别失败')
      let content = msg.slice(0, 280)
      if (shouldAppendVisionUserHint(failStage, msg)) {
        content = [content, VISION_FAIL_USER_HINT].join('\n\n')
      }
      wx.showModal({
        title: `${failStage}失败`,
        content: content.slice(0, 600),
        showCancel: false
      })
    } finally {
      this.setData({ uploadingImage: false })
    }
  },

  containsFinishSignal(messages) {
    return (messages || []).some(
      (m) =>
        m.role === 'assistant' &&
        this.shouldShowGenerateButtonByReply(m.content)
    )
  },

  isFinishSignalText(text) {
    const content = String(text || '')
    if (!strip(content)) return false
    if (FINISH_SIGNAL_KEYWORDS.some((kw) => content.includes(kw))) return true
    /* 结束话术变体：感谢分享 + 承诺生成报告（中间可有修饰语） */
    if (
      /感谢[^。\n]{0,28}分享/.test(content) &&
      (/为您[^。\n]{0,40}生成[^。\n]{0,48}报告/.test(content) || /生成[^。\n]{0,48}财务体检报告/.test(content))
    ) {
      return true
    }
    return false
  },

  hasContinueAskSignal(text) {
    const content = String(text || '')
    return CONTINUE_ASK_PATTERNS.some((reg) => reg.test(content))
  },

  shouldShowGenerateButtonByReply(text) {
    const content = String(text || '')
    if (!this.isFinishSignalText(content)) return false
    // 同一条回复里若仍包含追问特征，则视为“未完成收集”，不能提前关闭输入框。
    return !this.hasContinueAskSignal(content)
  },

  withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message || '请求超时')), ms)
      })
    ])
  },

  scrollToBottom() {
    this.setData({ scrollIntoView: '' })
    wx.nextTick(() => {
      this.setData({ scrollIntoView: 'chat-end' })
    })
  },

  scrollToLast() {
    this.scrollToBottom()
  },

  pushMessage(role, content, extra = {}) {
    const id = ++this.msgSeq
    const messages = this.data.messages.concat({
      id,
      role,
      content,
      messageType: 'text',
      ...extra
    })
    this.setData({ messages }, () => {
      this.scrollToBottom()
    })
  },

  pushUser(text) {
    this.pushMessage('user', text)
  },

  pushAssistant(text) {
    this.pushMessage('assistant', text)
  },

  async requestAssistantReply() {
    this.setData({ aiTyping: true }, () => {
      this.scrollToBottom()
    })
    try {
      const res = await this.withTimeout(
        wx.cloud.callFunction({
          name: 'chatCompletion',
          data: {
            messages: this.toApiMessages(),
            systemPrompt: this.assessmentSystemPrompt || DEFAULT_SYSTEM_PROMPT
          }
        }),
        CHAT_COMPLETION_CLIENT_MS,
        'AI响应超时，请稍后重试'
      )
      const body = res.result || {}
      if (!body.success || !body.reply) {
        throw new Error(body.message || 'AI回复失败')
      }
      this.pushAssistant(String(body.reply))
      if (this.shouldShowGenerateButtonByReply(body.reply)) {
        this.setData({ showGenerateButton: true }, () => this.scrollToBottom())
      }
    } catch (e) {
      console.error(e)
      const msg = String((e && (e.message || e.errMsg)) || 'AI回复失败，请重试')
      wx.showToast({ title: msg.slice(0, 18), icon: 'none' })
    } finally {
      this.setData({ aiTyping: false, sending: false })
      this.persistDraft()
      this.scrollToBottom()
    }
  },

  onDraftInput(e) {
    const draft = e.detail.value
    const sendDisabled = !(draft || '').trim()
    this.setData({ draft, sendDisabled })
    this.persistDraft()
  },

  onComposerFocus() {
    this.setData({ composerFocus: true, emojiVisible: false })
  },

  onComposerBlur() {
    this.setData({ composerFocus: false })
  },

  async onSend() {
    if (this.data.aiTyping || this.data.generating || this.data.sending) return
    const text = (this.data.draft || '').trim()
    if (!text) {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }

    this.pushUser(text)
    this.setData({ draft: '', sendDisabled: true, sending: true })
    this.persistDraft()
    await this.requestAssistantReply()
  },

  onToggleEmoji() {
    if (this.data.aiTyping || this.data.generating || this.data.sending) return
    this.setData({ emojiVisible: !this.data.emojiVisible })
  },

  onPickEmoji(e) {
    const emoji = String((e.currentTarget.dataset && e.currentTarget.dataset.emoji) || '')
    if (!emoji) return
    const draft = `${this.data.draft || ''}${emoji}`
    this.setData({
      draft,
      sendDisabled: !draft.trim(),
      emojiVisible: false
    })
    this.persistDraft()
  },

  onReviewMaskTouchMove() {},

  collectSubtreeIds(rootId, rows) {
    const ids = new Set([rootId])
    let grew = true
    while (grew) {
      grew = false
      ;(rows || []).forEach((r) => {
        if (r.parentId && ids.has(r.parentId) && !ids.has(r.id)) {
          ids.add(r.id)
          grew = true
        }
      })
    }
    return ids
  },

  onReviewLabelInput(e) {
    const id = e.currentTarget.dataset.id
    const v = e.detail.value || ''
    const rows = this.data.imageReviewRows.map((r) => (r.id === id ? { ...r, label: v } : r))
    this.setData({ imageReviewRows: annotateReviewRows(rows) })
  },

  onReviewAmountInput(e) {
    const id = e.currentTarget.dataset.id
    const v = e.detail.value || ''
    const rows = this.data.imageReviewRows.map((r) => (r.id === id ? { ...r, amount: v } : r))
    this.setData({ imageReviewRows: annotateReviewRows(rows) })
  },

  onReviewCategoryPick(e) {
    const id = e.currentTarget.dataset.id
    const idx = Number(e.detail.value)
    const key = CATEGORY_KEYS[idx] || 'other'
    const rows = this.data.imageReviewRows.map((r) =>
      r.id === id ? { ...r, category: key } : r
    )
    this.setData({ imageReviewRows: annotateReviewRows(rows) })
  },

  onDeleteReviewRow(e) {
    const id = e.currentTarget.dataset.id
    const subtree = this.collectSubtreeIds(id, this.data.imageReviewRows)
    let rows = this.data.imageReviewRows.filter((r) => !subtree.has(r.id))
    if (!rows.length) {
      rows = [
        {
          id: makeReviewRowId(),
          parentId: null,
          label: '',
          amount: '',
          category: 'asset',
          isTotal: false
        }
      ]
    }
    this.setData({ imageReviewRows: annotateReviewRows(rows) })
  },

  onAddReviewRootRow() {
    const row = {
      id: makeReviewRowId(),
      parentId: null,
      label: '',
      amount: '',
      category: 'asset',
      isTotal: false
    }
    this.setData({
      imageReviewRows: annotateReviewRows(this.data.imageReviewRows.concat(row))
    })
  },

  onAddReviewChildRow(e) {
    const parentId = e.currentTarget.dataset.parentId
    const row = {
      id: makeReviewRowId(),
      parentId,
      label: '',
      amount: '',
      category: 'asset',
      isTotal: false
    }
    this.setData({
      imageReviewRows: annotateReviewRows(this.data.imageReviewRows.concat(row))
    })
  },

  onCancelImageReview() {
    this.setData({
      imageReviewVisible: false,
      imageReviewRows: []
    })
  },

  async onConfirmImageReview() {
    const rows = this.data.imageReviewRows || []
    const slim = rows.map(({ depth, padRpx, categoryIndex, ...r }) => r)
    const hasUseful = slim.some((r) => strip(r.label) && strip(r.amount))
    const text = serializeReviewRowsForChat(slim)
    if (!strip(text) || !hasUseful) {
      wx.showToast({ title: '请至少填写一行名称与金额', icon: 'none' })
      return
    }
    this.setData({
      imageReviewVisible: false,
      imageReviewRows: [],
      sending: true
    })
    this.pushUser(this.buildImageConfirmMessage(text))
    this.persistDraft()
    await this.requestAssistantReply()
  },

  async onPreviewFile(e) {
    const item = e.currentTarget.dataset || {}
    const localPath = String(item.local || '')
    const cloudFileId = String(item.cloud || '')
    try {
      if (localPath) {
        wx.previewImage({ urls: [localPath], current: localPath })
        return
      }
      if (!cloudFileId) {
        wx.showToast({ title: '文件链接不可用', icon: 'none' })
        return
      }
      const res = await wx.cloud.getTempFileURL({ fileList: [cloudFileId] })
      const list = (res.fileList || []).filter((x) => x && x.tempFileURL).map((x) => x.tempFileURL)
      if (!list.length) {
        wx.showToast({ title: '预览地址获取失败', icon: 'none' })
        return
      }
      wx.previewImage({ urls: list, current: list[0] })
    } catch (err) {
      console.error(err)
      wx.showToast({ title: '预览失败', icon: 'none' })
    }
  },

  onExit() {
    this.persistDraft()
    wx.showModal({
      title: '退出体检',
      content: '已为你保存对话草稿，稍后可继续。',
      confirmText: '退出',
      success: (res) => {
        if (res.confirm) {
          wx.reLaunch({ url: '/pages/index/index' })
        }
      }
    })
  },

  async buildFinalAssessmentPayload(dialogHistory, timelineEvents) {
    const rulePayload = this.inferAssessmentPayload(dialogHistory, timelineEvents)
    try {
      const structRes = await this.withTimeout(
        wx.cloud.callFunction({
          name: 'extractAssessmentStructured',
          data: { dialogHistory }
        }),
        STRUCTURED_EXTRACT_MS,
        '结构化抽取超时'
      )
      const body = structRes.result || {}
      if (body.success && body.payload) {
        return mergeStructuredAssessmentPayload(body.payload, rulePayload)
      }
    } catch (err) {
      console.warn('extractAssessmentStructured', err)
    }
    return rulePayload
  },

  async onGenerateReport() {
    if (this.data.generating) return
    this.setData({ generating: true })
    const dialogHistory = this.toApiMessages()
    try {
      wx.setStorageSync(this.getDialogStorageKey(), dialogHistory)
      const res = await this.withTimeout(
        wx.cloud.callFunction({
          name: 'extractTimelineEvents',
          data: { dialogHistory }
        }),
        REPORT_GENERATE_TIMEOUT_MS,
        '报告生成超时，先进入报告页查看基础结果'
      )
      const body = res.result || {}
      if (!body.success) {
        throw new Error(body.message || '提取时间事件失败')
      }
      const timelineEvents = Array.isArray(body.timeline_events) ? body.timeline_events : []
      wx.setStorageSync(this.getTimelineStorageKey(), timelineEvents)

      let serverUserId = ''
      try {
        const db = wx.cloud.database()
        const { data } = await db.collection('users').where({ openId: this.currentOpenId }).limit(1).get()
        const u = data && data[0]
        if (u && u._id) serverUserId = String(u._id)
      } catch (e) {}

      const payload = await this.buildFinalAssessmentPayload(dialogHistory, timelineEvents)
      const assessmentData = {
        payload,
        completedAt: Date.now(),
        ...(serverUserId ? { serverUserId } : {})
      }
      wx.setStorageSync('assessmentData', assessmentData)
      this.clearDraft()
      wx.redirectTo({ url: '/pages/report/report?timeline=1&fromAssessment=1' })
    } catch (e) {
      console.error(e)
      const msg = String((e && (e.message || e.errMsg)) || '提取时间事件失败')
      wx.showToast({ title: msg.slice(0, 18), icon: 'none' })
      try {
        const payload = await this.buildFinalAssessmentPayload(dialogHistory, [])
        const assessmentData = {
          payload,
          completedAt: Date.now()
        }
        wx.setStorageSync('assessmentData', assessmentData)
      } catch (e2) {
        console.error(e2)
      }
      wx.redirectTo({ url: '/pages/report/report?timeline=0&fromAssessment=1' })
    } finally {
      this.setData({ generating: false })
    }
  }
})
