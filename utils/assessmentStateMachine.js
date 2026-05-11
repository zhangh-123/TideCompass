const {
  extractAssets,
  extractLiabilities,
  extractIncome,
  extractExpense,
  extractSkillAndWorry,
  sumAssetValue,
  strip,
  isNoLiabilityText
} = require('./extractHelper.js')

const PHASES = {
  LIFE_STAGE: 'LIFE_STAGE',
  ASSETS: 'ASSETS',
  LIABILITIES: 'LIABILITIES',
  INCOME: 'INCOME',
  EXPENSE: 'EXPENSE',
  DIFFERENCE: 'DIFFERENCE'
}

const PHASE_ORDER = [
  PHASES.LIFE_STAGE,
  PHASES.ASSETS,
  PHASES.LIABILITIES,
  PHASES.INCOME,
  PHASES.EXPENSE,
  PHASES.DIFFERENCE
]

const GEN_MAX_FOLLOW = 3

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function isVague(text) {
  return /不知道|不清楚|不明白|没想过|不好说|随便|都行|无所谓/i.test(strip(text))
}

function isConfirm(text) {
  return /^[\s]*(确认|好的|是|同意|可以|确定|OK|ok)[\s。.！!]*$/.test(strip(text))
}

function extractLifeStagePayload(text) {
  const t = strip(text)
  if (!t) return { kind: 'empty' }
  if (isVague(t)) return { kind: 'vague' }

  if (/已婚\s*有孩|已婚有孩/.test(t)) return { kind: 'ok', stage: '已婚有孩' }
  if (/已婚\s*无孩|已婚无孩/.test(t)) return { kind: 'ok', stage: '已婚无孩' }
  if (/单身/.test(t) && !/已婚/.test(t)) return { kind: 'ok', stage: '单身' }

  if (/其他/.test(t)) {
    const note = t.replace(/^.*?\b其他\b\s*[:：]?\s*/s, '').trim()
    if (note && note !== '其他') return { kind: 'ok', stage: '其他', note }
    return { kind: 'need_other_detail' }
  }

  return { kind: 'invalid' }
}

const QUESTIONS = {
  [PHASES.LIFE_STAGE]: [
    '先聊聊你的人生阶段：请选择「单身 / 已婚无孩 / 已婚有孩 / 其他」。若选「其他」，请简单说明你的情况。',
    '为了方便后续假设，请告诉我你当前的人生阶段：单身、已婚无孩、已婚有孩，或其他（需补充说明）。'
  ],
  [PHASES.ASSETS]: [
    '请用文字描述你的主要资产（总额需大于 0）。可参考：「一套房市值约 200 万，另有存款 30 万」。',
    '这一步需要了解你的资产规模。请列出至少一项资产并给出估值，例如「一辆车 15 万」「理财约 50 万」。'
  ],
  [PHASES.LIABILITIES]: [
    '你当前有哪些负债？若暂时没有，可直接回复「无」或「没有」。也可举例：「房贷余额 120 万」。',
    '请补充负债情况：包括房贷、车贷、信用卡或借款等；若没有，请回复「无」。'
  ],
  [PHASES.INCOME]: [
    '你的税后月收入大约是多少？可用「月薪 2 万」「税后 12000」「年薪 30 万」等形式。',
    '请描述稳定可支配收入（折算到每月）。支持月薪、年薪等方式，我会换算成月均金额（元）。'
  ],
  [PHASES.EXPENSE]: [
    '家庭或个人每月常规支出大约多少？可用「月支出 8000」「每月花销 1.2 万」等。',
    '请给出月度支出规模（日常开销为主）。可用「每月大概花 6000」之类的说法。'
  ],
  [PHASES.DIFFERENCE]: [
    '最后两步：① 你认为自己的一项核心技能是什么？② 财务上最大的担忧是什么？建议分行或用「技能：… / 担忧：…」写出。',
    '请同时给出「核心技能」和「最大担忧」两段信息（都要具体）。可用竖线分隔，如「编程｜担心失业」。'
  ]
}

function maxStrikeBeforeDefault(phase) {
  return phase === PHASES.LIABILITIES ? 1 : GEN_MAX_FOLLOW
}

function applyDefaults(phase) {
  switch (phase) {
    case PHASES.LIFE_STAGE:
      return {
        lifeStage: '其他',
        lifeStageOtherNote: '（系统默认值，已与你确认）'
      }
    case PHASES.ASSETS:
      return {
        assets: [{ type: '默认示例资产', value: 100000, count: 1 }]
      }
    case PHASES.LIABILITIES:
      return { liabilities: [] }
    case PHASES.INCOME:
      return { monthlyIncome: 8000 }
    case PHASES.EXPENSE:
      return { monthlyExpense: 5000 }
    case PHASES.DIFFERENCE:
      return {
        coreSkill: '（系统默认）暂未描述的核心技能',
        maxWorry: '（系统默认）暂未描述的担忧'
      }
    default:
      return {}
  }
}

class AssessmentStateMachine {
  constructor() {
    this.phaseIndex = 0
    this.collected = {}
    this.strikeCount = 0
    this.awaitingDefaultConfirm = false
    this.pendingDefaultPayload = null
    this.lifeNeedOtherDetail = false
  }

  getProgress() {
    return {
      current: Math.min(this.phaseIndex + 1, PHASE_ORDER.length),
      total: PHASE_ORDER.length
    }
  }

  currentPhase() {
    return PHASE_ORDER[this.phaseIndex]
  }

  openingQuestionForPhase(phase) {
    return pick(QUESTIONS[phase] || QUESTIONS[PHASE_ORDER[0]])
  }

  resetStrike() {
    this.strikeCount = 0
  }

  bumpStrike() {
    this.strikeCount += 1
  }

  enterDefaultConfirm(phase) {
    const payload = applyDefaults(phase)
    this.awaitingDefaultConfirm = true
    this.pendingDefaultPayload = { phase, payload }
    let tip = ''
    if (phase === PHASES.LIFE_STAGE) {
      tip = '人生阶段将暂记为「其他」，说明使用系统默认表述。'
    } else if (phase === PHASES.ASSETS) {
      tip = '资产将暂记为「10 万元示例资产」。'
    } else if (phase === PHASES.LIABILITIES) {
      tip = '负债将暂记为「无」。'
    } else if (phase === PHASES.INCOME) {
      tip = '月收入将暂记为「8000 元/月」。'
    } else if (phase === PHASES.EXPENSE) {
      tip = '月支出将暂记为「5000 元/月」。'
    } else if (phase === PHASES.DIFFERENCE) {
      tip = '技能与担忧将使用系统占位描述。'
    }
    return `你已经多次未能提供有效信息。为保证流程继续，${tip}\n\n请回复「确认」采用上述默认值；若想自己填写，可直接补充一段更清晰的具体描述（我会重新解析）。`
  }

  mergeCollected(patch) {
    this.collected = Object.assign({}, this.collected, patch)
  }

  advancePhase() {
    this.phaseIndex += 1
    this.resetStrike()
    this.awaitingDefaultConfirm = false
    this.pendingDefaultPayload = null
    this.lifeNeedOtherDetail = false
  }

  snapshotData() {
    return JSON.parse(JSON.stringify(this.collected))
  }

  /** 启动对话的首条 AI 文案 */
  getInitialAssistantMessage() {
    this.resetStrike()
    return this.openingQuestionForPhase(this.currentPhase())
  }

  /** 处理用户一句输入 */
  processInput(userMessage) {
    const msg = strip(userMessage)

    if (this.awaitingDefaultConfirm) {
      if (isConfirm(msg)) {
        this.mergeCollected(this.pendingDefaultPayload.payload)
        this.advancePhase()
        if (this.phaseIndex >= PHASE_ORDER.length) {
          return { replies: [this.buildCompletionMsg()], completed: true, data: this.snapshotData() }
        }
        return {
          replies: ['好的，已记录。我们继续下一步。\n\n' + this.openingQuestionForPhase(this.currentPhase())],
          completed: false
        }
      }
      if (!isVague(msg) && msg.length >= 2) {
        this.awaitingDefaultConfirm = false
        this.pendingDefaultPayload = null
        this.resetStrike()
        return this.processInput(userMessage)
      }
      return {
        replies: ['请先回复「确认」以采用默认值，或给出一段更具体的描述。'],
        completed: false
      }
    }

    const phase = this.currentPhase()

    if (phase === PHASES.LIFE_STAGE) {
      return this.handleLifeStage(msg)
    }
    if (phase === PHASES.ASSETS) {
      return this.handleAssets(msg)
    }
    if (phase === PHASES.LIABILITIES) {
      return this.handleLiabilities(msg)
    }
    if (phase === PHASES.INCOME) {
      return this.handleIncome(msg)
    }
    if (phase === PHASES.EXPENSE) {
      return this.handleExpense(msg)
    }
    if (phase === PHASES.DIFFERENCE) {
      return this.handleDifference(msg)
    }

    return { replies: ['系统异常，请稍后重试。'], completed: false }
  }

  handleLifeStage(msg) {
    if (this.lifeNeedOtherDetail) {
      if (!msg || isVague(msg)) {
        this.bumpStrike()
        if (this.strikeCount > maxStrikeBeforeDefault(PHASES.LIFE_STAGE)) {
          return { replies: [this.enterDefaultConfirm(PHASES.LIFE_STAGE)], completed: false }
        }
        return {
          replies: ['「其他」需要一句简短说明（不能为空，也尽量不要只回复「不知道」）。方便举个例子吗？'],
          completed: false
        }
      }
      this.mergeCollected({
        lifeStage: '其他',
        lifeStageOtherNote: msg
      })
      this.advancePhase()
      return {
        replies: ['收到。下一步是关于资产的估算。\n\n' + this.openingQuestionForPhase(this.currentPhase())],
        completed: false
      }
    }

    const payload = extractLifeStagePayload(msg)
    if (payload.kind === 'vague' || payload.kind === 'empty') {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.LIFE_STAGE)) {
        return { replies: [this.enterDefaultConfirm(PHASES.LIFE_STAGE)], completed: false }
      }
      return {
        replies: ['我需要明确的选项之一（单身 / 已婚无孩 / 已婚有孩 / 其他）。若不清楚，可以说最接近的一项；仍不确定我会继续追问。'],
        completed: false
      }
    }

    if (payload.kind === 'need_other_detail') {
      this.lifeNeedOtherDetail = true
      this.resetStrike()
      return {
        replies: ['了解了，你选择「其他」。请用一句话补充说明你的具体情况（必填）。'],
        completed: false
      }
    }

    if (payload.kind === 'invalid') {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.LIFE_STAGE)) {
        return { replies: [this.enterDefaultConfirm(PHASES.LIFE_STAGE)], completed: false }
      }
      return {
        replies: ['没有识别到你的人生阶段选项。请直接回复：单身 / 已婚无孩 / 已婚有孩 / 其他（可带简短说明）。'],
        completed: false
      }
    }

    if (payload.kind === 'ok') {
      this.mergeCollected({
        lifeStage: payload.stage,
        lifeStageOtherNote: payload.note || ''
      })
      this.advancePhase()
      return {
        replies: ['收到。接下来想了解资产的大致规模。\n\n' + this.openingQuestionForPhase(this.currentPhase())],
        completed: false
      }
    }

    return { replies: ['解析异常，请换一种说法试试。'], completed: false }
  }

  handleAssets(msg) {
    if (!msg || isVague(msg)) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.ASSETS)) {
        return { replies: [this.enterDefaultConfirm(PHASES.ASSETS)], completed: false }
      }
      return {
        replies: ['这一步不能为空哦。请尽量给出至少一项资产及估值，例如「一套房价值约 200 万」。'],
        completed: false
      }
    }

    const items = extractAssets(msg)
    const total = sumAssetValue(items)
    if (!items.length || total <= 0) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.ASSETS)) {
        return { replies: [this.enterDefaultConfirm(PHASES.ASSETS)], completed: false }
      }
      return {
        replies: [
          '暂时没能从你的描述里提取到「大于 0」的资产金额。请包含数字与单位（万/千/元均可），例如「房产 200 万 + 存款 20 万」。'
        ],
        completed: false
      }
    }

    this.mergeCollected({ assets: items })
    this.advancePhase()
    return {
      replies: ['资产信息已记录。接下来是负债情况。\n\n' + this.openingQuestionForPhase(this.currentPhase())],
      completed: false
    }
  }

  handleLiabilities(msg) {
    if (!msg || isVague(msg)) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.LIABILITIES)) {
        return { replies: [this.enterDefaultConfirm(PHASES.LIABILITIES)], completed: false }
      }
      return {
        replies: ['如果没有负债，请直接回复「无」或「没有」；若有，请写出大致类型与金额。'],
        completed: false
      }
    }

    if (isNoLiabilityText(msg)) {
      this.mergeCollected({ liabilities: [] })
      this.advancePhase()
      return {
        replies: ['好的，暂按无负债记录。下一题关于收入。\n\n' + this.openingQuestionForPhase(this.currentPhase())],
        completed: false
      }
    }

    const items = extractLiabilities(msg)
    const total = items.reduce((s, it) => s + it.value * (it.count || 1), 0)
    if (!items.length || total <= 0) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.LIABILITIES)) {
        return { replies: [this.enterDefaultConfirm(PHASES.LIABILITIES)], completed: false }
      }
      return {
        replies: [
          '没能识别有效负债金额。若确实没有负债请回复「无」；若有借款，请包含数字与单位，例如「房贷剩余 80 万」。'
        ],
        completed: false
      }
    }

    this.mergeCollected({ liabilities: items })
    this.advancePhase()
    return {
      replies: ['负债信息已记录。我们继续估算税后月收入。\n\n' + this.openingQuestionForPhase(this.currentPhase())],
      completed: false
    }
  }

  handleIncome(msg) {
    if (!msg || isVague(msg)) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.INCOME)) {
        return { replies: [this.enterDefaultConfirm(PHASES.INCOME)], completed: false }
      }
      return {
        replies: ['我需要一个月收入水平的数字描述（折算人民币元）。可以说「月薪 1.5 万」或「年薪 24 万」等。'],
        completed: false
      }
    }

    const income = extractIncome(msg)
    if (!income || income <= 0) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.INCOME)) {
        return { replies: [this.enterDefaultConfirm(PHASES.INCOME)], completed: false }
      }
      return {
        replies: ['没有提取到有效的月收入金额。请包含数字与单位（或明确年薪/月薪），例如「税后 9000」「年薪 36 万」。'],
        completed: false
      }
    }

    this.mergeCollected({ monthlyIncome: income })
    this.advancePhase()
    return {
      replies: [`已记录你的月均税后收入约为 ${income} 元。接下来是支出。\n\n` + this.openingQuestionForPhase(this.currentPhase())],
      completed: false
    }
  }

  handleExpense(msg) {
    if (!msg || isVague(msg)) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.EXPENSE)) {
        return { replies: [this.enterDefaultConfirm(PHASES.EXPENSE)], completed: false }
      }
      return {
        replies: ['请给出月度支出水平的数字描述（元），例如「每月花销 7000」「月支出 1.2 万」。'],
        completed: false
      }
    }

    const expense = extractExpense(msg)
    if (!expense || expense <= 0) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.EXPENSE)) {
        return { replies: [this.enterDefaultConfirm(PHASES.EXPENSE)], completed: false }
      }
      return {
        replies: ['没有提取到有效的月支出金额。请包含数字与单位，例如「月支出 6000」「每个月大概花 8 千」。'],
        completed: false
      }
    }

    this.mergeCollected({ monthlyExpense: expense })
    this.advancePhase()
    return {
      replies: [`已记录月支出约 ${expense} 元。最后一题，收集你的技能与担忧。\n\n` + this.openingQuestionForPhase(this.currentPhase())],
      completed: false
    }
  }

  handleDifference(msg) {
    if (!msg || isVague(msg)) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.DIFFERENCE)) {
        return { replies: [this.enterDefaultConfirm(PHASES.DIFFERENCE)], completed: false }
      }
      return {
        replies: ['两部分都需要具体描述：① 核心技能 ② 最大担忧。可用两行文字，或写成「技能：… / 担忧：…」。'],
        completed: false
      }
    }

    const { skill, worry } = extractSkillAndWorry(msg)
    if (!strip(skill) || !strip(worry)) {
      this.bumpStrike()
      if (this.strikeCount > maxStrikeBeforeDefault(PHASES.DIFFERENCE)) {
        return { replies: [this.enterDefaultConfirm(PHASES.DIFFERENCE)], completed: false }
      }
      return {
        replies: ['我需要同时识别到「技能」和「担忧」两段有效文字。示例：「技能：产品设计｜担忧：现金流断裂」。'],
        completed: false
      }
    }

    this.mergeCollected({
      coreSkill: strip(skill),
      maxWorry: strip(worry)
    })
    this.advancePhase()
    return {
      replies: [this.buildCompletionMsg()],
      completed: true,
      data: this.snapshotData()
    }
  }

  buildCompletionMsg() {
    return '太好了，六个环节的信息都已采集完成。接下来将为你生成体检报告。'
  }

  clearCollectedFromPhase(fromIdx) {
    for (let i = fromIdx; i < PHASE_ORDER.length; i++) {
      const p = PHASE_ORDER[i]
      if (p === PHASES.LIFE_STAGE) {
        delete this.collected.lifeStage
        delete this.collected.lifeStageOtherNote
      }
      if (p === PHASES.ASSETS) delete this.collected.assets
      if (p === PHASES.LIABILITIES) delete this.collected.liabilities
      if (p === PHASES.INCOME) delete this.collected.monthlyIncome
      if (p === PHASES.EXPENSE) delete this.collected.monthlyExpense
      if (p === PHASES.DIFFERENCE) {
        delete this.collected.coreSkill
        delete this.collected.maxWorry
      }
    }
  }

  /** 上一步：返回 { ok, replies } */
  goBack() {
    if (this.awaitingDefaultConfirm) {
      this.awaitingDefaultConfirm = false
      this.pendingDefaultPayload = null
      this.resetStrike()
      return {
        ok: true,
        replies: ['已取消默认值确认。请重新回答当前题目。（追问计数已重置）']
      }
    }

    if (this.phaseIndex === 0 && !this.lifeNeedOtherDetail) {
      return { ok: false, replies: ['已经是第一步，无法继续返回。'] }
    }

    if (this.phaseIndex === 0 && this.lifeNeedOtherDetail) {
      this.lifeNeedOtherDetail = false
      this.resetStrike()
      return {
        ok: true,
        replies: ['好的，我们回到人生阶段选项。请重新选择：单身 / 已婚无孩 / 已婚有孩 / 其他。']
      }
    }

    const targetIndex = this.phaseIndex - 1
    this.clearCollectedFromPhase(targetIndex)
    this.phaseIndex = targetIndex
    this.resetStrike()
    this.lifeNeedOtherDetail = false
    this.awaitingDefaultConfirm = false
    this.pendingDefaultPayload = null

    return {
      ok: true,
      replies: ['已返回上一阶段，请重新填写。\n\n' + this.openingQuestionForPhase(this.currentPhase())]
    }
  }
}

module.exports = {
  PHASES,
  PHASE_ORDER,
  AssessmentStateMachine
}
