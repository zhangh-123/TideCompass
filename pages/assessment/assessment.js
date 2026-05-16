const { hasCompleteProfile, getHomePath } = require('../../utils/route.js')
const { mergeProfileIntoAssessmentSystemPrompt } = require('../../utils/assessmentUserContext.js')
const {
  extractAssets,
  extractLiabilities,
  pickMonthlyIncomeFromUserTexts,
  pickMonthlyExpenseFromUserTexts,
  reconcileMonthlyCashflow,
  sanitizeTextForAssetExtraction,
  extractSkillAndWorry,
  strip,
  dedupeFinancialRows,
  crossDedupeAssetsLiabilities,
  filterFinancialRowsGroundedInText
} = require('../../utils/extractHelper.js')
const { mergeStructuredAssessmentPayload } = require('../../utils/assessmentStructuredMerge.js')
const { parseAssessmentFromDialogSummary } = require('../../utils/assessmentDialogSummaryParse.js')
const {
  ASSESSMENT_DIALOG_VERSION,
  FIRST_ASSISTANT_MESSAGE,
  DEFAULT_SYSTEM_PROMPT,
  isLegacyOpeningMessage
} = require('../../utils/assessmentDialogPrompt.js')

const COMPOSER_PLACEHOLDER = '请输入您的回复'

/** AI 回复中出现以下表述时，可显示「生成报告」按钮（须同时通过 shouldShowGenerateButtonByReply） */
const FINISH_SIGNAL_KEYWORDS = [
  '可以生成财务体检报告',
  '感谢您的分享，我将为您生成报告',
  '为您生成报告',
  '信息已经足够',
  '所有关键信息已收集完毕',
  '关键信息已收集完毕'
]
/** 须小于云函数 extractTimelineEvents config.json timeout（60s） */
const REPORT_GENERATE_TIMEOUT_MS = 55000
/** 对话结构化抽取（与 extractTimelineEvents 串行），须小于云函数 timeout */
const STRUCTURED_EXTRACT_MS = 55000
/** 须大于云函数 chatCompletion 内 axios 超时，否则客户端会先断开 */
const CHAT_COMPLETION_CLIENT_MS = 45000

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

Page({
  msgSeq: 0,

  data: {
    title: '财务体检',
    messages: [],
    /** 仅在恢复草稿、发送后清空时写入；bindinput 过程中勿改，避免重渲染把输入框顶没 */
    composerSeed: '',
    sendDisabled: true,
    composerFocus: false,
    scrollIntoView: '',
    generating: false,
    showGenerateButton: false,
    aiTyping: false,
    sending: false,
    inputLocked: false,
    composerPlaceholder: COMPOSER_PLACEHOLDER,
    /** 键盘高度（px），用于把底部输入条顶到键盘上方 */
    keyboardHeight: 0,
    /** 聊天区底部留白 = 输入条高度 + 键盘高度，避免被挡住 */
    chatBottomPad: 72
  },
  currentOpenId: '',
  /** 输入中缓存，避免对话区 setData 时用旧 draft 覆盖导致无法输入 */
  _composerDraft: '',
  _persistDraftTimer: null,
  _assessmentPageReady: false,
  _skipComposerSyncOnShow: false,
  _scrollClearTimer: null,
  _composerBarPx: 72,
  _keyboardHeightHandler: null,

  getComposerBarHeightPx() {
    try {
      const sys = wx.getSystemInfoSync()
      const safeBottom = sys.safeArea
        ? Math.max(0, Math.round(sys.screenHeight - sys.safeArea.bottom))
        : 0
      return Math.round(56 + safeBottom)
    } catch (e) {
      return 72
    }
  },

  initComposerInsets() {
    const barPx = this.getComposerBarHeightPx()
    this._composerBarPx = barPx
    this.setData({
      keyboardHeight: 0,
      chatBottomPad: barPx
    })
  },

  applyKeyboardHeight(heightPx) {
    const barPx = this._composerBarPx || this.getComposerBarHeightPx()
    const h = Math.max(0, Math.round(Number(heightPx) || 0))
    const pad = barPx + h
    if (h === this.data.keyboardHeight && pad === this.data.chatBottomPad) return
    this.setData({ keyboardHeight: h, chatBottomPad: pad }, () => {
      if (h > 0) this.scrollToBottom()
    })
  },

  bindKeyboardHeightListener() {
    if (this._keyboardHeightHandler || !wx.onKeyboardHeightChange) return
    this._keyboardHeightHandler = (res) => {
      this.applyKeyboardHeight(res && res.height)
    }
    wx.onKeyboardHeightChange(this._keyboardHeightHandler)
  },

  unbindKeyboardHeightListener() {
    if (!this._keyboardHeightHandler) return
    if (wx.offKeyboardHeightChange) {
      wx.offKeyboardHeightChange(this._keyboardHeightHandler)
    }
    this._keyboardHeightHandler = null
  },

  getComposerDraft() {
    if (typeof this._composerDraft === 'string') return this._composerDraft
    return this.data.composerSeed || ''
  },

  syncComposerToView(extraPatch = {}) {
    const draft = this.getComposerDraft()
    this._composerDraft = draft
    this.setData(
      Object.assign(
        {
          composerSeed: draft,
          sendDisabled: !strip(draft)
        },
        extraPatch
      )
    )
  },

  clearComposer() {
    this._composerDraft = ''
    this.setData({
      composerSeed: '',
      sendDisabled: true
    })
  },

  unlockComposerInput(reason) {
    if (reason) console.warn('[assessment] unlockComposerInput', reason)
    const patch = {
      aiTyping: false,
      sending: false,
      inputLocked: false
    }
    if (this.data.generating) patch.generating = false
    this.setData(this.syncInputLocked(patch))
  },

  syncInputLocked(patch = {}) {
    const aiTyping = patch.aiTyping !== undefined ? patch.aiTyping : this.data.aiTyping
    const sending = patch.sending !== undefined ? patch.sending : this.data.sending
    const generating = patch.generating !== undefined ? patch.generating : this.data.generating
    const inputLocked = !!(aiTyping || sending || generating)
    return Object.assign({}, patch, { inputLocked })
  },

  resetComposerLocks(reason) {
    if (reason) console.warn('[assessment] resetComposerLocks', reason)
    this.setData(
      this.syncInputLocked({
        aiTyping: false,
        sending: false
      })
    )
  },

  async onLoad(options = {}) {
    this._resumeFromReport = String(options.resume || '') === '1'
    this._assessmentPageReady = false
    this._skipComposerSyncOnShow = true
    const ok = await this.runGuard()
    if (!ok) return

    this.currentOpenId = wx.getStorageSync('openId') || ''
    this._composerDraft = ''
    this.initComposerInsets()
    this.bindKeyboardHeightListener()
    await this.refreshAssessmentSystemPromptFromDb()
    const cached = this.restoreDraft()
    const cacheValid =
      cached &&
      cached.messages &&
      cached.messages.length &&
      cached.dialogVersion === ASSESSMENT_DIALOG_VERSION

    if (cacheValid) {
      let normalized = this.normalizeMessages(cached.messages)
      normalized = this.migrateOpeningMessageIfNeeded(normalized)
      this.msgSeq = normalized.length
      const draft = cached.draft || ''
      this._composerDraft = draft
      this.setData(
        this.syncInputLocked({
          messages: normalized,
          composerSeed: draft,
          sendDisabled: !draft.trim(),
          showGenerateButton: this.containsFinishSignal(normalized)
        })
      )
      this.persistDraft(true)
      this.scrollToLast()
      this._assessmentPageReady = true
      return
    }

    if (cached && cached.dialogVersion !== ASSESSMENT_DIALOG_VERSION) {
      this.clearDraft()
    }
    this.startFreshDialog()
    this._assessmentPageReady = true
  },

  refreshComposerAfterNavigateBack(lockPatch = {}) {
    if (this.data.showGenerateButton) {
      if (Object.keys(lockPatch).length) this.setData(lockPatch)
      return
    }
    try {
      const cached = this.restoreDraft()
      if (cached && typeof cached.draft === 'string') {
        this._composerDraft = cached.draft
      }
    } catch (e) {
      console.warn('refreshComposer restore draft', e)
    }
    this.syncComposerToView(lockPatch)
  },

  /** 将首条助手消息替换为当前版本开场白 */
  migrateOpeningMessageIfNeeded(messages) {
    const list = (messages || []).slice()
    const idx = list.findIndex((m) => m.role === 'assistant')
    if (idx < 0) return list
    if (!isLegacyOpeningMessage(list[idx].content)) return list
    list[idx] = { ...list[idx], content: FIRST_ASSISTANT_MESSAGE }
    return list
  },

  startFreshDialog() {
    this.msgSeq = 0
    this.setData(
      this.syncInputLocked({
        messages: [],
        composerSeed: '',
        sendDisabled: true,
        showGenerateButton: false
      })
    )
    this.pushAssistant(FIRST_ASSISTANT_MESSAGE)
    this.persistDraft(true)
  },

  async onShow() {
    let lockPatch = {}
    if (this.data.generating || this.data.aiTyping || this.data.sending || this.data.inputLocked) {
      lockPatch = this.syncInputLocked({
        aiTyping: false,
        sending: false,
        inputLocked: false,
        generating: false
      })
    }
    if (this._assessmentPageReady && !this._skipComposerSyncOnShow) {
      this.refreshComposerAfterNavigateBack(lockPatch)
      lockPatch = {}
    } else if (Object.keys(lockPatch).length) {
      this.setData(lockPatch)
    }
    this._skipComposerSyncOnShow = false
    await this.runGuard()
  },

  onHide() {
    if (this._persistDraftTimer) clearTimeout(this._persistDraftTimer)
    this.applyKeyboardHeight(0)
    this.persistDraft(true)
  },

  onUnload() {
    if (this._persistDraftTimer) clearTimeout(this._persistDraftTimer)
    if (this._scrollClearTimer) clearTimeout(this._scrollClearTimer)
    this.unbindKeyboardHeightListener()
    this.persistDraft(true)
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
      if (this._resumeFromReport) {
        return true
      }
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

  inferAssessmentPayload(dialogHistory, _timelineEvents) {
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
          pushAsset(it.name || it.type, subtotal)
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
          pushLiability(it.name || it.type, it.value)
        })
      })
    })

    const cash = reconcileMonthlyCashflow(
      pickMonthlyIncomeFromUserTexts(userTexts),
      pickMonthlyExpenseFromUserTexts(userTexts),
      allUserText
    )
    payload.monthlyIncome = cash.monthlyIncome
    payload.monthlyExpense = cash.monthlyExpense

    /* 不把 extractTimelineEvents（另一路 LLM）的金额写入资产负债表：易与用户未口述的数字串线，
     * 导致报告出现「重复大额」等虚假明细。时间轴仅保留在报告页的时间线展示。 */

    payload.assets = filterFinancialRowsGroundedInText(
      Array.from(assetDedupe.values()),
      allUserText
    )
    payload.liabilities = filterFinancialRowsGroundedInText(
      Array.from(liabDedupe.values()),
      allUserText
    )
    payload.assets = dedupeFinancialRows(payload.assets)
    payload.liabilities = dedupeFinancialRows(payload.liabilities)
    const cross = crossDedupeAssetsLiabilities(payload.assets, payload.liabilities)
    payload.assets = cross.assets
    payload.liabilities = cross.liabilities

    return payload
  },

  persistDraft(immediate) {
    if (this._persistDraftTimer) clearTimeout(this._persistDraftTimer)
    const write = () => {
      try {
        wx.setStorageSync(this.getDraftStorageKey(), {
          draft: this.getComposerDraft(),
          messages: this.data.messages.map((m) => ({
            role: m.role,
            content: m.content,
            messageType: m.messageType,
            fileName: m.fileName,
            fileSizeKb: m.fileSizeKb,
            localPath: m.localPath,
            cloudFileId: m.cloudFileId
          })),
          dialogVersion: ASSESSMENT_DIALOG_VERSION,
          ownerOpenId: this.currentOpenId || '',
          updatedAt: Date.now()
        })
      } catch (e) {
        console.warn('persist draft failed', e)
      }
    }
    if (immediate) {
      write()
      return
    }
    this._persistDraftTimer = setTimeout(write, 280)
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
    if (/可以生成[^。\n]{0,12}财务体检报告/.test(content)) return true
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
    if (/可以生成财务体检报告|感谢您的分享，我将为您生成报告/.test(content)) {
      return !/请先|仍需|还需要您|继续补充|尚未/.test(content)
    }
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
    if (this._scrollClearTimer) clearTimeout(this._scrollClearTimer)
    this.setData({ scrollIntoView: 'chat-end' })
    /* 滚动完成后必须清空，否则 scroll-into-view 常驻会导致用户无法上下滑动聊天记录 */
    this._scrollClearTimer = setTimeout(() => {
      this._scrollClearTimer = null
      this.setData({ scrollIntoView: '' })
    }, 420)
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
    this.setData(this.syncInputLocked({ aiTyping: true }), () => {
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
      this.clearComposer()
      this.unlockComposerInput('afterReply')
      this.persistDraft(true)
      this.scrollToBottom()
    }
  },

  onDraftInput(e) {
    const v = e.detail.value == null ? '' : String(e.detail.value)
    this._composerDraft = v
    const sendDisabled = !strip(v)
    if (sendDisabled !== this.data.sendDisabled) {
      this.setData({ sendDisabled })
    }
    this.persistDraft()
  },

  onComposerKeyboardHeight(e) {
    const h = e && e.detail && e.detail.height
    if (h != null) this.applyKeyboardHeight(h)
  },

  onComposerFocus() {
    this.setData({ composerFocus: true }, () => {
      wx.nextTick(() => this.scrollToBottom())
    })
  },

  onComposerBlur() {
    this.setData({ composerFocus: false })
    this.persistDraft(true)
  },

  async onSend(e) {
    if (this.data.generating) return
    if (this.data.sending || this.data.aiTyping) return
    if (e && e.detail && e.detail.value != null) {
      this._composerDraft = String(e.detail.value)
    }
    const text = this.getComposerDraft().trim()
    if (!text) {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }

    this.pushUser(text)
    this.clearComposer()
    this.setData(
      this.syncInputLocked({
        sending: true
      })
    )
    this.persistDraft(true)
    await this.requestAssistantReply()
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
    const summaryPayload = parseAssessmentFromDialogSummary(dialogHistory)
    const userTextCorpus = (dialogHistory || [])
      .filter((m) => m.role === 'user')
      .map((m) => String(m.content || ''))
      .join('\n')

    let llmPayload = null
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
        llmPayload = body.payload
      } else {
        console.warn('extractAssessmentStructured', body.message || 'no payload')
      }
    } catch (err) {
      console.warn('extractAssessmentStructured', err)
    }

    const merged = mergeStructuredAssessmentPayload(
      llmPayload,
      rulePayload,
      userTextCorpus,
      summaryPayload
    )
    console.log('[assessment] payload dataSource:', merged.dataSource || 'unknown')
    const { dataSource, ...payload } = merged
    return payload
  },

  async onGenerateReport() {
    if (this.data.generating) return
    this.setData(this.syncInputLocked({ generating: true }))
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
      console.warn('onGenerateReport timeline or pipeline', e)
      const errMsg = String((e && (e.errMsg || e.message)) || '')
      const timelineOnlyFail =
        /超时|timeout|timed out|时间事件|extractTimeline/i.test(errMsg) ||
        /cloud call function fail|errCode.*-1/i.test(errMsg)
      if (!timelineOnlyFail) {
        const msg = errMsg || '报告生成异常'
        wx.showToast({ title: msg.slice(0, 18), icon: 'none' })
      }
      try {
        const payload = await this.buildFinalAssessmentPayload(dialogHistory, [])
        const assessmentData = {
          payload,
          completedAt: Date.now()
        }
        wx.setStorageSync('assessmentData', assessmentData)
        if (timelineOnlyFail) {
          wx.showToast({
            title: '时间轴提取超时，报告已生成',
            icon: 'none',
            duration: 2200
          })
        }
      } catch (e2) {
        console.error(e2)
        wx.showToast({ title: '报告数据生成失败', icon: 'none' })
        return
      }
      wx.redirectTo({ url: '/pages/report/report?timeline=0&fromAssessment=1' })
    } finally {
      this.setData(this.syncInputLocked({ generating: false }))
    }
  }
})
