/**
 * 从自然语言中提取结构化财务信息（启发式规则，可按业务迭代）
 */

function strip(s) {
  return String(s || '').trim()
}

function parseMoneyToYuan(numStr, unitRaw) {
  const n = parseFloat(String(numStr || '').replace(/,/g, ''))
  if (Number.isNaN(n) || n <= 0) return null
  const u = (unitRaw || '元').replace(/\s/g, '')
  if (u === '元' || u === '') return Math.round(n)
  if (u === '千') return Math.round(n * 1000)
  if (u === '万') return Math.round(n * 10000)
  if (u === '百万') return Math.round(n * 1000000)
  if (u === '亿') return Math.round(n * 100000000)
  return Math.round(n)
}

/** 月收入语境（须与金额同句或同段出现） */
const INCOME_HINT_RE =
  /收入|月薪|工资|月入|税后|年薪|年终奖|奖金|可支配收入|发薪|家庭.*月|夫妻.*月|爱人.*月|税收月收入|税后月收入/

/** 月支出语境 */
const EXPENSE_HINT_RE =
  /支出|开销|花销|生活费|月供|还贷|开支|固定支出|子女教育|孩子教育|赡养|基本生活|家庭日常|日常开销|每月花|每月开销|刚性|房贷/

/** 分项支出片段（用于多类目累加） */
const EXPENSE_SEGMENT_RE =
  /房贷|按揭|月供|日常|生活费|开销|教育|赡养|刚性|支出|花|还贷款/

/** 一次性/未来大额支出，不能当月收入 */
const ONE_TIME_OUTFLOW_RE =
  /择校费|学费|礼金|彩礼|首付|定金|装修款|罚款|赔偿|一次性|需支付|要交|要花|准备.{0,8}万|今年\d{1,2}月|明年|后年|择.{0,2}校/

const ASSET_AMOUNT_NOISE_RE = /资产|房|车|存款|基金|持仓|理财|债基|货基|混合|港股|周周报|余额|市值/

/** 家庭月支出合理上限（元），超过视为误把负债本金等计入月支 */
const MONTHLY_EXPENSE_HARD_CAP = 200000
const MONTHLY_INCOME_HARD_CAP = 500000

function hasIncomeContext(text) {
  const raw = strip(text)
  if (!raw) return false
  if (ONE_TIME_OUTFLOW_RE.test(raw) && !INCOME_HINT_RE.test(raw)) return false
  return INCOME_HINT_RE.test(raw)
}

function hasExpenseContext(text) {
  const raw = strip(text)
  if (!raw) return false
  if (hasIncomeContext(raw) && !EXPENSE_HINT_RE.test(raw)) return false
  return EXPENSE_HINT_RE.test(raw)
}

function scoreIncomeContext(text) {
  const raw = strip(text)
  let s = 0
  if (/税收月收入|税后月收入|家庭.*月收入|夫妻.*月收入/.test(raw)) s += 5
  if (/月收入|月薪|月入/.test(raw)) s += 4
  if (/税后|年薪|年终奖/.test(raw)) s += 2
  if (/收入/.test(raw)) s += 1
  if (ONE_TIME_OUTFLOW_RE.test(raw)) s -= 6
  if (ASSET_AMOUNT_NOISE_RE.test(raw) && !/收入|月薪|工资/.test(raw)) s -= 4
  return s
}

function firstMoneyInText(raw, unitDefault) {
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(亿|百万|万|千|元)?/)
  if (!m) return null
  const unit = m[2] || unitDefault || (/\d\s*万|万/.test(raw) ? '万' : '元')
  return parseMoneyToYuan(m[1], unit)
}

function detectAssetType(beforeSlice) {
  const b = beforeSlice || ''
  /* 「房贷」「按揭」含「房」，必须先判断，否则房贷余额会被标成房产资产 */
  if (/房贷|按揭|剩余(?:房贷)?贷款|房贷余额|贷款余额|待还本金/.test(b)) return null
  if (/房|不动产|房产/.test(b)) return '房产'
  if (/车|辆/.test(b)) return '车辆'
  if (/存款|现金|活期|定期|存单|零钱/.test(b)) return '存款'
  if (
    /股票|基金|理财|债券|贵金属|保单|股权|余额宝|持仓市值|理财产品|债基|货基|混合基金|港股基金|周周报/.test(
      b
    )
  ) {
    return '金融资产'
  }
  /* 单独「持仓」易与「持仓收益」混淆，仅在没有收益/盈亏语境时使用 */
  if (/持仓/.test(b) && !/(收益|盈亏|涨跌)/.test(b)) return '金融资产'
  /* 无明确资产语境时不记为资产，避免把利率、期数、流水号等误识别为「资产」行 */
  return null
}

/** 基金产品代码（6 位数字）易被误当成金额，如 001316、021583、006630 */
function isFundProductCodeNoise(raw, matchIndex, matchLen, val) {
  const token = String(raw.slice(matchIndex, matchIndex + (matchLen || 0)) || '').replace(/,/g, '')
  const before = raw.slice(Math.max(0, matchIndex - 28), matchIndex)
  const after = raw.slice(matchIndex + (matchLen || 0), matchIndex + (matchLen || 0) + 8)
  const hasDecimal = /[.,]\d/.test(token) || /,\d{3}/.test(token)
  if (hasDecimal) return false
  if (/^\d{5,7}$/.test(token.replace(/\..*$/, ''))) {
    if (/(?:基金|债基|货基|混合|港股)\s*$/.test(before)) return true
    if (/基金\d{4,6}$/.test(before)) return true
  }
  if (!hasDecimal && val > 0 && val < 100000 && /基金/.test(before)) return true
  if (/元/.test(after)) return false
  if (!hasDecimal && /^\d{5,7}$/.test(token) && /(?:债基|基金)/.test(before)) return true
  return false
}

/**
 * 用户常按「基金名+代码+金额」口述，优先用结构化模式提取，避免代码被当成金额。
 */
function extractFundStyleHoldings(text) {
  const raw = strip(scrubAssessmentFilenameNoise(text))
  if (!raw) return []

  const out = []
  const seen = new Set()
  const add = (name, numStr, unit) => {
    const val = parseMoneyToYuan(numStr, unit || '元')
    if (!val || val < 100) return
    const label = String(name || '金融资产').trim()
    const key = `${label}|${val}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ type: '金融资产', name: label, value: val, count: 1 })
  }

  let m
  const patterns = [
    { re: /债基\s*\d{6}\s*[，,]\s*([\d,]+(?:\.\d+)?)\s*元/g, name: '债基' },
    { re: /周周报[^，,。\d]{0,16}?([\d,]+(?:\.\d+)?)\s*元/g, name: '周周报' },
    { re: /混合基金\s*\d{6}\s*[，,]\s*([\d,]+(?:\.\d+)?)\s*元/g, name: '混合基金' },
    { re: /港股基金\s*\d{6}\s*[，,]\s*([\d,]+(?:\.\d+)?)\s*元/g, name: '港股基金' },
    {
      re: /(?:此外|还有)[^。\n]{0,20}?不到\s*([\d.]+)\s*万\s*元[^。\n]{0,16}?(?:活期|零钱)/g,
      name: '活期零钱',
      unit: '万'
    },
    { re: /(?:活期|零钱)[^。\n]{0,12}?([\d,]+(?:\.\d+)?)\s*元/g, name: '活期零钱' }
  ]

  for (const p of patterns) {
    while ((m = p.re.exec(raw)) !== null) {
      add(p.name, m[1], p.unit || '元')
    }
  }
  return out
}

/**
 * 判断该数字是否处于「月供 / 每月还款」语境，避免把月还款额误记为本金负债。
 */
/** 仅当金额紧邻「月供」类关键词之前（或带 /月）时跳过，避免同一句里「本金 + 月供」前半段被误伤 */
function liabilityAmountIsMonthlyPayment(raw, matchIndex, matchLen, valYuan, unitRaw) {
  const len = matchLen || 0
  const before = raw.slice(Math.max(0, matchIndex - 22), matchIndex)
  const unit = unitRaw || ''
  const val = Math.round(Number(valYuan) || 0)
  const isPrincipalChunk =
    (unit === '万' || unit === '亿' || unit === '百万' || val >= 100000) &&
    /(?:房贷|按揭|负债|本金|剩余|待还|欠款|贷款)/.test(before)
  if (isPrincipalChunk) return false

  if (
    /(?:月供|月供款|每个月|每月(?:个)?(?:需)?还|月还款|按揭月还|每期还|最低还款|每期应还|月还)\s*$/i.test(
      before
    )
  ) {
    return true
  }
  const after = raw.slice(matchIndex + len, Math.min(raw.length, matchIndex + len + 10))
  if (/^[\s,，]{0,2}(?:月供|月还)/.test(after) && val > 0 && val < 100000) return true
  return /^[\s,，万千百亿元块]*[\/／]\s*月/.test(after)
}

/** 避免把月供、月还款误记为房产/存款等资产 */
function assetAmountIsMonthlyPayment(raw, matchIndex, matchLen) {
  const len = matchLen || 0
  const before = raw.slice(Math.max(0, matchIndex - 14), matchIndex)
  if (/(?:月供|月还|每月(?:需)?还|月还款|每期还|应还(?:款)?)\s*$/.test(before)) return true
  const after = raw.slice(matchIndex + len, Math.min(raw.length, matchIndex + len + 12))
  return /^[\s,，万千百亿元块]*[\/／]\s*月/.test(after)
}

function contextWindow(raw, matchIndex, beforeLen, afterLen) {
  const lo = Math.max(0, matchIndex - beforeLen)
  const hi = Math.min(raw.length, matchIndex + afterLen)
  return raw.slice(lo, hi)
}

/** 去掉上传文件名里的时间戳，避免被正则当成「资产金额」 */
function scrubAssessmentFilenameNoise(text) {
  return String(text || '').replace(/assessment_\d{10,}_/gi, 'assessment_x_')
}

/**
 * 去掉明显不应参与「资产」识别的行（收入、刚性支出、择校等），保留含理财/存款等关键词的混合行。
 */
function sanitizeTextForAssetExtraction(text) {
  let s = scrubAssessmentFilenameNoise(text)
  const lines = s.split(/\n/).filter((line) => {
    const t = strip(line)
    if (!t) return false
    if (/^【图片\s*\d+[：:]\s*[^\n]*\.(jpg|jpeg|png)/i.test(t)) return false
    if (
      /(?:月薪|月收入|每个月收入|每月收入|爱人(?:的)?收入|配偶(?:的)?收入|老婆(?:的)?收入|老公(?:的)?收入|年终奖|工资在|收入在|收入大约)/.test(
        t
      ) &&
      !/(基金|理财|存款|余额宝|总资产|帮你投|债券|股票|持仓|定投)/.test(t)
    ) {
      return false
    }
    if (
      /(?:基本生活|子女教育|赡养老人|其他开销|教育支出|生活开销|固定支出|日常开销|物业费|水电)/.test(t) &&
      /\d/.test(t) &&
      !/(基金|理财|存款|余额宝|总资产|帮你投)/.test(t)
    ) {
      return false
    }
    if (
      /(?:择校|学费|年底[^。\n]{0,8}支付|支付[^。\n]{0,6}(?:万|元)|大额支出|购车|装修费|医疗费)/.test(t) &&
      !/(余额|持仓|资产项|基金|理财)/.test(t)
    ) {
      return false
    }
    /* 收益/盈亏类多为流水，不应当本金资产参与合计 */
    if (
      /(?:昨日|今日|当日|最近|持仓|累计|浮动|成立以来|近\d+日|持有)(?:收益|盈亏)|(?:收益|盈亏|涨跌)(?:额)?[:：]|日收益|万份收益/.test(
        t
      ) &&
      !/总资产|净值|市值|本金|份额/.test(t)
    ) {
      return false
    }
    return true
  })
  return lines.join('\n')
}

/** 疑似把时间戳、文件名数字误认为金额（元） */
function isGarbagePersonalAssetAmount(val, raw, matchIndex, matchLen) {
  if (!Number.isFinite(val) || val <= 0) return true
  if (val >= 1e11) return true
  const lo = Math.max(0, matchIndex - 36)
  const hi = Math.min(raw.length, matchIndex + matchLen + 28)
  const ctx = raw.slice(lo, hi)
  if (val >= 1e9 && /\.(jpg|jpeg|png)|assessment_/i.test(ctx)) return true
  if (val <= 2 && /\.(jpg|jpeg|png)/i.test(ctx)) return true
  return false
}

/** 收入 / 支出语境下的金额不要记入资产 */
function assetAmountInIncomeExpenseContext(raw, matchIndex) {
  const win = contextWindow(raw, matchIndex, 88, 28)
  /* 「持仓收益」等含「持仓」，但不是持仓本金 */
  if (
    /(?:昨日|今日|当日|最近|持仓|累计|浮动|成立以来|近\d+日|持有)(?:收益|盈亏)|(?:^|[\s：:])收益[:：]|日收益|涨跌额|盈亏额|万份收益/.test(
      win
    ) &&
    !/总资产|净值|本金|余额|市值/.test(win)
  ) {
    return true
  }
  const hasProduct =
    /基金|理财|存款|余额宝|帮你投|股票|债券|总资产|资产项|定期|活期|净值|市值|持仓市值|理财产品/.test(win) ||
    (/持仓/.test(win) && !/(收益|盈亏|涨跌)/.test(win))
  if (hasProduct) return false
  if (
    /(?:税后)?(?:月收入|月薪|月入|每个月收入|每月收入|爱人|配偶|老婆|老公)(?:的)?(?:收入|工资)|年终奖|工资在|收入在|收入大约/.test(win)
  ) {
    return true
  }
  if (
    /(?:开销|支出|赡养|子女教育|基本生活|其他开销|生活费|保费|择校|学费|年底.{0,6}支付|大额支出)/.test(win)
  ) {
    return true
  }
  return false
}

/** 按揭/房贷剩余本金语境：记入负债，不计入房产资产（仅看金额前的局部语境，避免同句后面的「房贷」误伤前面的存款） */
function assetAmountIsMortgagePrincipalNoise(raw, matchIndex, matchLen) {
  const len = matchLen || 0
  const before = raw.slice(Math.max(0, matchIndex - 40), matchIndex)
  if (!/(?:房贷|按揭|商业贷|公积金贷|贷款余额|剩余(?:贷款|本息)?)/.test(before)) return false
  const after = raw.slice(matchIndex + len, Math.min(raw.length, matchIndex + len + 16))
  const local = before + after
  if (/市值|估值|评估价|挂牌价|现价|总价/.test(local) && !/(?:房贷|按揭|贷)\s*[:：]?\s*[\d,]+/.test(local))
    return false
  return true
}

/**
 * 提取资产列表：{ type, value(元), count }
 */
function extractAssets(text) {
  const raw = strip(scrubAssessmentFilenameNoise(text))
  if (!raw) return []

  const items = [...extractFundStyleHoldings(raw)]
  const seenVal = new Set(items.map((it) => it.value))

  const re = /([\d,]+(?:\.[\d,]+)?)\s*(亿|百万|万|千|元)?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    if (assetAmountIsMonthlyPayment(raw, m.index, (m[0] || '').length)) continue
    const val = parseMoneyToYuan(m[1], m[2])
    if (!val) continue
    if (isFundProductCodeNoise(raw, m.index, (m[0] || '').length, val)) continue
    if (isGarbagePersonalAssetAmount(val, raw, m.index, (m[0] || '').length)) continue
    if (assetAmountInIncomeExpenseContext(raw, m.index)) continue
    const endOfMatch = m.index + (m[0] || '').length
    if (val >= 1940 && val <= 2030 && /年/.test(raw.slice(endOfMatch, endOfMatch + 3))) continue
    const win = contextWindow(raw, m.index, 48, 16)
    if (/总负债|负债合计|负债总额|欠款合计/.test(win) && !/资产|存款|余额|理财/.test(win)) continue
    if (assetAmountIsMortgagePrincipalNoise(raw, m.index, (m[0] || '').length)) continue
    const before = raw.slice(Math.max(0, m.index - 24), m.index)
    const type = detectAssetType(before)
    if (!type) continue
    const wideWin = contextWindow(raw, m.index, 80, 26)
    if (type === '房产' && /(?:房贷|按揭|贷款余额|剩余贷款)/.test(wideWin)) continue
    if ((type === '房产' || type === '车辆') && val < 10000) continue
    let count = 1
    const countMatch = before.match(/(\d+)\s*套/)
    if (countMatch) count = Math.max(1, parseInt(countMatch[1], 10) || 1)
    if (seenVal.has(val)) continue
    seenVal.add(val)
    let name = type
    if (/债基/.test(before)) name = '债基'
    else if (/周周报/.test(before)) name = '周周报'
    else if (/混合基金/.test(before)) name = '混合基金'
    else if (/港股基金/.test(before)) name = '港股基金'
    else if (/活期|零钱/.test(before)) name = '活期零钱'
    items.push({ type, name, value: val, count })
  }

  return items
}

function sumAssetValue(items) {
  return (items || []).reduce((s, it) => {
    const v = Math.round(Number(it.value) || 0)
    const c = Number(it.count) || 1
    return s + v * c
  }, 0)
}

function isNoLiabilityText(text) {
  const t = strip(text)
  if (!t) return false
  return /^(无|没有|暂无|零|零负债|没负债|没有负债|没有欠款|无负债|无欠款)$/i.test(t)
}

/**
 * 房贷/按揭剩余本金（优先匹配，避免月供、小额误记）
 */
function extractMortgageStyleLiabilities(text) {
  const raw = strip(text)
  if (!raw) return []
  const out = []
  const seen = new Set()
  const add = (val, name) => {
    const v = Math.round(Number(val) || 0)
    if (!v || v < 100000) return
    const label = String(name || '房贷').trim()
    const key = `${label}|${v}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ type: '房贷', name: label, value: v, count: 1 })
  }

  let m
  const patterns = [
    /(?:房贷|按揭)(?:剩余|余额|待还|欠款|本金)?[^。\d]{0,24}?(\d+(?:\.\d+)?)\s*万/g,
    /(?:负债|欠款)(?:约|大约)?[^。\d]{0,12}?(\d+(?:\.\d+)?)\s*万/g,
    /(?:剩余|尚欠|待还)(?:房贷|按揭)?(?:本金|余额)?[^。\d]{0,16}?(\d+(?:\.\d+)?)\s*万/g,
    /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*万[^。\n]{0,14}(?:房贷|按揭)/g,
    /(?:房贷|按揭)[^。\d]{0,20}?(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*元/g
  ]
  for (const re of patterns) {
    while ((m = re.exec(raw)) !== null) {
      const unit = /万/.test(m[0]) ? '万' : '元'
      const val = parseMoneyToYuan(m[1], unit)
      if (val) add(val, '房贷')
    }
  }
  return out
}

/**
 * 提取负债列表；明确表示「无」返回 []
 */
function extractLiabilities(text) {
  const raw = strip(text)
  if (!raw) return []
  if (isNoLiabilityText(raw)) return []

  const items = [...extractMortgageStyleLiabilities(raw)]
  const seenVal = new Map()
  for (const it of items) {
    seenVal.set(it.value, it)
  }

  const re = /([\d,]+(?:\.[\d,]+)?)\s*(亿|百万|万|千|元)?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const val = parseMoneyToYuan(m[1], m[2])
    if (!val) continue
    if (liabilityAmountIsMonthlyPayment(raw, m.index, (m[0] || '').length, val, m[2])) continue
    const matchLen = (m[0] || '').length
    const win = contextWindow(raw, m.index, 52, 20)
    if (
      /总资产|资产总额|资产合计|基金资产|证券资产|可用余额|存款余额|理财本金|持仓市值|份额净值|债基|周周报|混合基金|港股基金/.test(
        win
      ) &&
      !/负债|贷款|欠款|按揭|车贷|房贷|信用卡|借呗|花呗/.test(win)
    ) {
      continue
    }
    const before = raw.slice(Math.max(0, m.index - 24), m.index)
    const beforeForDebt = raw.slice(Math.max(0, m.index - 40), m.index)
    const afterForDebt = raw.slice(
      m.index + matchLen,
      Math.min(raw.length, m.index + matchLen + 20)
    )
    let type = '负债'
    let name = '负债'
    if (/房贷|按揭|房贷余额/.test(before) || /(?:房贷|按揭)/.test(afterForDebt)) {
      type = '房贷'
      name = '房贷'
    } else if (/车贷/.test(before) || /车贷/.test(afterForDebt)) {
      type = '车贷'
      name = '车贷'
    } else if (/信用卡|花呗|借呗|白条/.test(before) || /信用卡|花呗|借呗/.test(afterForDebt)) {
      type = '信用卡'
      name = '信用卡'
    } else if (/借款|欠款|贷款/.test(before)) {
      type = '借款'
      name = '借款'
    }
    const debtCue =
      /(?:房贷|车贷|按揭|贷款|欠款|信用卡|借呗|花呗|白条|分期|抵押|负债|借款|债务|按揭款)/.test(
        beforeForDebt
      ) ||
      /(?:房贷|车贷|按揭|贷款|信用卡|借呗|花呗|待还|本金|欠款)/.test(afterForDebt) ||
      /(?:应还|应付)\s*$/.test(beforeForDebt)
    if (type === '负债' && !debtCue) continue
    /* 房贷剩余本金很少低于 5 万；7500/5000 多为月供或误抓 */
    if (type === '房贷' && val > 0 && val < 50000) continue
    if (type === '车贷' && val > 0 && val < 10000) continue
    if (type === '负债' && val > 0 && val < 10000) continue
    if (type !== '信用卡' && val > 0 && val < 10) continue
    if (seenVal.has(val)) continue
    seenVal.set(val, { type, name, value: val, count: 1 })
    items.push({ type, name, value: val, count: 1 })
  }
  return items
}

function sumLiabilityValue(items) {
  return items.reduce((s, it) => s + it.value * (it.count || 1), 0)
}

/**
 * 月收入（元）；年薪会先折算为月均。无收入语境时不猜测，避免把择校费、资产金额当收入。
 */
function extractIncome(text) {
  const raw = strip(text)
  if (!raw) return null
  if (ONE_TIME_OUTFLOW_RE.test(raw) && !INCOME_HINT_RE.test(raw)) return null

  let m = raw.match(/(?:税收|税后)(?:月)?收入\s*(?:大概|约|是|在)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '万')
    if (v && v > 0 && v < 5e6) return v
  }

  m = raw.match(/月薪\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/月入\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/税后\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/年薪\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const yearly = parseMoneyToYuan(m[1], m[2] || '元')
    if (!yearly) return null
    return Math.max(1, Math.round(yearly / 12))
  }

  m = raw.match(/年薪\s*([\d.]+)\s*$/)
  if (m) {
    const yearly = parseFloat(m[1])
    if (!Number.isNaN(yearly) && yearly > 0) return Math.max(1, Math.round((yearly * 10000) / 12))
  }

  m = raw.match(/([\d.]+)\s*万\s*[\/／]?\s*月/)
  if (m) {
    const v = parseMoneyToYuan(m[1], '万')
    return v && v > 0 ? v : null
  }

  if (hasIncomeContext(raw)) {
    m = raw.match(/月收入\s*(?:大概|约|是)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)?/)
    if (m) {
      const v = parseMoneyToYuan(m[1], m[2] || '万')
      if (v && v > 0 && v < 5e6) return v
    }

    m = raw.match(/([\d.]+)\s*万/)
    if (m && !ASSET_AMOUNT_NOISE_RE.test(raw)) {
      const v = parseMoneyToYuan(m[1], '万')
      if (v && v > 0 && v < 5e6) return v
    }

    m = raw.match(/([\d.]+)\s*(?:元)?\s*[\/／]\s*月/)
    if (m) {
      const v = parseMoneyToYuan(m[1], '元')
      return v && v > 0 ? v : null
    }
  }

  return null
}

/** 房贷剩余本金描述，不能当作月支出 */
function isMortgagePrincipalOnlySegment(segment) {
  const p = strip(segment)
  if (!p || !/房贷|按揭/.test(p)) return false
  if (/(?:每个月|每月|月供|月还|月还款|月还款额)/.test(p)) return false
  if (/(?:还剩|剩余|余额|待还|欠款|本金|尚欠|尾款|总共贷|贷款总额)/.test(p)) return true
  const m = p.match(/(\d+(?:\.\d+)?)\s*(万|千|元)?/)
  if (!m) return false
  const unitGuess = m[2] || (/万/.test(p) ? '万' : '元')
  const v = parseMoneyToYuan(m[1], unitGuess)
  return v >= 100000 && /(?:还|剩|余|欠|贷|万)/.test(p)
}

function parseExpenseAmountFromSegment(segment) {
  const p = strip(segment)
  if (!p) return 0
  if (ONE_TIME_OUTFLOW_RE.test(p) && !EXPENSE_SEGMENT_RE.test(p)) return 0
  if (hasIncomeContext(p) && !EXPENSE_HINT_RE.test(p)) return 0
  if (isMortgagePrincipalOnlySegment(p)) return 0

  let m = p.match(/(?:每个月|每月|月供|月还)\s*(\d+(?:\.\d+)?)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    if (v && v > 0 && v < MONTHLY_EXPENSE_HARD_CAP) return v
  }

  m = p.match(/(\d+(?:\.\d+)?)\s*(万|千|元)\s*(?:\/|／)?\s*月/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    if (v && v > 0 && v < MONTHLY_EXPENSE_HARD_CAP) return v
  }

  if (/房贷|按揭/.test(p) && !/(?:每个月|每月|月供|月还)/.test(p)) return 0

  if (!EXPENSE_SEGMENT_RE.test(p)) return 0

  m = p.match(/(\d+(?:\.\d+)?)\s*(万|千|元)?/)
  if (!m) return 0
  const unitGuess = m[2] || (/万/.test(p) ? '万' : /千/.test(p) ? '千' : '元')
  const v = parseMoneyToYuan(m[1], unitGuess)
  if (v && v > 0 && v < MONTHLY_EXPENSE_HARD_CAP) return v
  return 0
}

function clampReasonableMonthlyExpense(expense, corpus) {
  let x = Math.round(Number(expense) || 0)
  if (x <= 0) return 0
  if (x <= MONTHLY_EXPENSE_HARD_CAP) return x

  const recomputed = estimateMonthlyExpenseSum(corpus || '')
  if (recomputed > 0 && recomputed <= MONTHLY_EXPENSE_HARD_CAP) return recomputed

  if (x >= 500000 && /房贷|按揭/.test(corpus || '')) {
    return recomputed > 0 ? recomputed : 0
  }
  return MONTHLY_EXPENSE_HARD_CAP
}

function clampReasonableMonthlyIncome(income, corpus) {
  let x = Math.round(Number(income) || 0)
  if (x <= 0) return 0
  if (x <= MONTHLY_INCOME_HARD_CAP) return x
  const recomputed = estimateMonthlyIncomeTotal(corpus || '')
  if (recomputed > 0 && recomputed <= MONTHLY_INCOME_HARD_CAP) return recomputed
  return MONTHLY_INCOME_HARD_CAP
}

/**
 * 同一条话术里多类月支出（房贷+日常+教育+赡养）逐项累加。
 */
function sumMonthlyExpenseFromMultiItemMessage(text) {
  const raw = strip(text)
  if (!raw || !EXPENSE_HINT_RE.test(raw)) return 0
  if (hasIncomeContext(raw) && !EXPENSE_HINT_RE.test(raw)) return 0

  const parts = raw.split(/[，,；;。\n]+/).map(strip).filter(Boolean)
  const segments = parts.length > 1 ? parts : [raw]
  let sum = 0
  let hits = 0

  for (const p of segments) {
    if (!EXPENSE_SEGMENT_RE.test(p)) continue
    const v = parseExpenseAmountFromSegment(p)
    if (v > 0) {
      sum += v
      hits += 1
    }
  }

  if (sum > MONTHLY_EXPENSE_HARD_CAP) {
    sum = 0
    hits = 0
    for (const p of segments) {
      if (isMortgagePrincipalOnlySegment(p)) continue
      if (!EXPENSE_SEGMENT_RE.test(p)) continue
      const v = parseExpenseAmountFromSegment(p)
      if (v > 0) {
        sum += v
        hits += 1
      }
    }
  }

  if (hits >= 2) return clampReasonableMonthlyExpense(Math.round(sum), raw)
  if (hits === 1 && segments.length === 1 && /日常|教育|赡养|开销|月供/.test(raw)) {
    return clampReasonableMonthlyExpense(Math.round(sum), raw)
  }

  const categoryAmountRe =
    /(?:每个月|每月|月供|月还|家庭日常(?:生活)?开销?|日常(?:生活)?开销?|孩子教育|子女教育|赡养老人|赡养)[^0-9]{0,16}(\d+(?:\.\d+)?)\s*(万|千|元)?|(?:房贷|按揭)[^0-9]{0,12}(?:每个月|每月|月供)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(万|千|元)?/g
  let m
  let sum2 = 0
  let hits2 = 0
  while ((m = categoryAmountRe.exec(raw)) !== null) {
    const num = m[1] || m[2]
    const unit = m[2] && m[1] ? m[2] : m[3]
    const v = parseMoneyToYuan(num, unit || '元')
    if (v && v > 0 && v < MONTHLY_EXPENSE_HARD_CAP) {
      sum2 += v
      hits2 += 1
    }
  }
  if (hits2 >= 2) return clampReasonableMonthlyExpense(Math.round(sum2), raw)

  return 0
}

/**
 * 月支出（元）；不得从纯收入描述中回退抽取；多类目话术优先累加。
 */
function extractExpense(text) {
  const raw = strip(text)
  if (!raw) return null
  if (hasIncomeContext(raw) && !EXPENSE_HINT_RE.test(raw)) return null

  const multi = sumMonthlyExpenseFromMultiItemMessage(raw)
  if (multi > 0) return multi

  let m = raw.match(/固定支出\s*(?:大概|约|是)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '万')
    if (v && v > 0 && v < 2e6) return v
  }

  m = raw.match(/月支出\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/每月\s*(?:花|开销|支出)\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/生活费\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  if (hasExpenseContext(raw)) {
    const v = parseExpenseAmountFromSegment(raw)
    if (v && v > 0 && v < 2e6) return v
  }

  return null
}

/**
 * 家庭税后月收入估算（元）：双人固定月入 + 年终奖折算月均（启发式，避免 OCR 段落误匹配单笔「最大数字」）。
 */
function estimateMonthlyIncomeTotal(text) {
  const raw = strip(text)
  if (!raw) return 0
  const parts = raw.split(/[，,。\n]+/).map(strip).filter(Boolean)
  const chunks = parts.length ? parts : [raw]
  let sum = 0
  let bonusYearly = 0

  for (const p of chunks) {
    if (ONE_TIME_OUTFLOW_RE.test(p) && !INCOME_HINT_RE.test(p)) continue
    if (/债基|混合基金|港股基金|周周报|持仓|理财本金/.test(p) && !/(收入|月薪|工资|年薪)/.test(p)) {
      continue
    }
    if (
      /(我和|家庭|夫妻).*(税收月收入|税后月收入|月收入|月薪)/.test(p) ||
      /(税收月收入|税后月收入).*(爱人|夫妻|家庭)/.test(p)
    ) {
      const v = firstMoneyInText(p, '万')
      if (v && v > 0 && v < 5e6) return Math.round(v)
    }
    if (/年终奖/.test(p)) {
      const m = p.match(/(\d+(?:\.\d+)?)\s*(万|千|元)?/)
      if (m) {
        const y = parseMoneyToYuan(m[1], m[2] || '元')
        if (y && y > 0 && y < 1e9) bonusYearly += y
      }
      continue
    }
    if (/(爱人|配偶|老婆|老公)/.test(p) && /(?:收入|月薪|工资)/.test(p)) {
      const m = p.match(/(\d[\d,]*(?:\.\d+)?)/)
      if (!m) continue
      const unitGuess = /万/.test(p) ? '万' : /千/.test(p) ? '千' : '元'
      const v = parseMoneyToYuan(m[1].replace(/,/g, ''), unitGuess)
      if (v && v > 0 && v < 1e7) sum += v
      continue
    }
    if (
      /我/.test(p) &&
      !/(爱人|配偶|老婆|老公)/.test(p) &&
      /(?:收入在|月收入|月薪|每个月收入|每月收入)/.test(p)
    ) {
      const m = p.match(/(\d[\d,]*(?:\.\d+)?)/)
      if (!m) continue
      const unitGuess = /万/.test(p) ? '万' : /千/.test(p) ? '千' : '元'
      const v = parseMoneyToYuan(m[1].replace(/,/g, ''), unitGuess)
      if (v && v > 0 && v < 1e7) sum += v
    }
  }

  if (bonusYearly > 0) sum += Math.round(bonusYearly / 12)
  if (sum > 0) return Math.round(sum)

  let best = 0
  for (const p of chunks) {
    if (!hasIncomeContext(p)) continue
    const v = extractIncome(p)
    if (v && v > best && v < 5e6) best = v
  }
  return best
}

/**
 * 从用户多轮话术中选取最可信的月收入（元），避免 Math.max 把择校费/资产金额抬成收入。
 */
function pickMonthlyIncomeFromUserTexts(userTexts) {
  const texts = Array.isArray(userTexts) ? userTexts : []
  let best = 0
  let bestScore = -99

  texts.forEach((txt) => {
    const raw = strip(txt)
    if (!raw || !hasIncomeContext(raw)) return
    const v = extractIncome(raw)
    if (!v || v >= 5e6) return
    const score = scoreIncomeContext(raw)
    if (score > bestScore) {
      bestScore = score
      best = v
    } else if (score === bestScore && v > 0) {
      if (best > 150000 && v <= 150000) best = v
      else if (v > best && best < 3000) best = v
    }
  })

  const estimated = estimateMonthlyIncomeTotal(texts.join('\n'))
  if (estimated > 0 && estimated < 5e6) {
    if (!best || (best > 150000 && estimated <= 150000)) best = estimated
    else if (estimated > best && best <= 150000) best = estimated
    else if (!best) best = estimated
  }
  return Math.round(best) || 0
}

/**
 * 从用户话术中选取月支出（元）
 */
function pickMonthlyExpenseFromUserTexts(userTexts) {
  const texts = Array.isArray(userTexts) ? userTexts : []
  let best = 0
  texts.forEach((txt) => {
    const raw = strip(txt)
    if (!raw || !hasExpenseContext(raw)) return
    const multi = sumMonthlyExpenseFromMultiItemMessage(raw)
    if (multi > best) best = multi
    const v = extractExpense(raw)
    if (v && v > best && v < 2e6) best = v
  })
  const corpus = texts.join('\n')
  const estimated = estimateMonthlyExpenseSum(corpus)
  if (estimated > best) best = estimated
  return clampReasonableMonthlyExpense(Math.round(best) || 0, corpus)
}

/**
 * 纠正月收入/月支出被误抽取或互换（如 20 万择校费 → 收入、3.7 万收入 → 支出）
 */
function reconcileMonthlyCashflow(monthlyIncome, monthlyExpense, userText) {
  let inc = Math.round(Number(monthlyIncome) || 0)
  let exp = Math.round(Number(monthlyExpense) || 0)
  const corpus = strip(userText)

  if (inc >= 100000 && exp >= 15000 && exp <= 120000 && inc / exp >= 4) {
    const bigWan = Math.round(inc / 10000)
    const smallWan = Math.round(exp / 10000)
    const feeLike =
      corpus &&
      new RegExp(`${bigWan}\\s*万`).test(corpus) &&
      /择校|学费|一次性|支付|需付|要花/.test(corpus)
    const incomeLike =
      corpus &&
      new RegExp(`${smallWan}(?:\\.\\d+)?\\s*万`).test(corpus) &&
      /收入|月薪|税后|税收月/.test(corpus)
    if (feeLike && incomeLike) {
      inc = exp
      exp = estimateMonthlyExpenseSum(corpus) || exp
    }
  }

  if (inc > 0 && exp > 0 && exp > inc && hasIncomeContext(corpus) && !hasExpenseContext(corpus)) {
    const tmp = inc
    inc = exp
    exp = tmp
  }

  const recomputedExp = estimateMonthlyExpenseSum(corpus)
  if (recomputedExp > exp && recomputedExp <= MONTHLY_EXPENSE_HARD_CAP) {
    const looksUndercounted =
      exp > 0 &&
      recomputedExp >= exp * 1.5 &&
      /日常|教育|赡养|开销|月供|房贷/.test(corpus)
    if (looksUndercounted || exp < 10000) exp = recomputedExp
  }

  inc = clampReasonableMonthlyIncome(inc, corpus)
  exp = clampReasonableMonthlyExpense(exp, corpus)

  return { monthlyIncome: inc, monthlyExpense: exp }
}

/**
 * 刚性月支出估算（元）：从「基本生活 / 子女教育 / 赡养 / 其他开销」等分项累加。
 */
function estimateMonthlyExpenseSum(text) {
  const raw = strip(text)
  if (!raw) return 0

  const multi = sumMonthlyExpenseFromMultiItemMessage(raw)
  if (multi > 0) return multi

  const parts = raw.split(/[，,；;。\n]+/).map(strip).filter(Boolean)
  const chunks = parts.length ? parts : [raw]
  let sum = 0
  const bump = (p, re) => {
    if (!re.test(p)) return
    const v = parseExpenseAmountFromSegment(p)
    if (v > 0) sum += v
  }
  for (const p of chunks) {
    if (isMortgagePrincipalOnlySegment(p)) continue
    bump(p, /基本生活(?:开销|费|支出)?/)
    bump(p, /家庭日常(?:生活)?开销?/)
    bump(p, /日常(?:生活)?开销?/)
    bump(p, /子女教育|孩子教育/)
    bump(p, /赡养老人|赡养/)
    bump(p, /(?:每个月|每月|月供|月还)/)
    bump(p, /其他开销/)
  }
  return clampReasonableMonthlyExpense(Math.round(sum), raw)
}

/**
 * 提取核心技能 & 最大担忧
 */
function extractSkillAndWorry(text) {
  const raw = strip(text)
  if (!raw) return { skill: '', worry: '' }

  if (/[|｜]/.test(raw)) {
    const parts = raw.split(/[|｜]/).map((s) => strip(s))
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { skill: parts[0], worry: parts[1] }
    }
  }

  let skill = ''
  let worry = ''

  const km = raw.match(/(?:技能|擅长|核心能力)[:：]\s*([^，；;\n]+)/)
  const wm = raw.match(/(?:担忧|担心|顾虑|最怕)[:：]\s*(.+)/)

  if (km) skill = strip(km[1])
  if (wm) worry = strip(wm[1])

  if (skill && worry) return { skill, worry }

  const lines = raw
    .split(/\n/)
    .map((l) => strip(l))
    .filter(Boolean)
  if (lines.length >= 2 && (!skill || !worry)) {
    return {
      skill: skill || lines[0],
      worry: worry || lines[lines.length - 1]
    }
  }

  return { skill, worry }
}

/**
 * 同侧多条里相同金额合并为一条，优先保留语义更具体的名称。
 */
function dedupeFinancialRows(rows) {
  const list = (rows || []).filter((r) => r && Number(r.value) > 0)
  const rank = (name) => {
    const n = String(name || '')
    if (/房贷|车贷|信用卡|借款/.test(n)) return 4
    if (/债基|周周报|混合|港股|活期|零钱/.test(n)) return 4
    if (/房产|车辆|存款/.test(n)) return 3
    if (/金融资产|理财|股票|基金/.test(n)) return 3
    if (n === '资产' || n === '负债') return 1
    return 2
  }
  const byKey = new Map()
  for (const row of list) {
    const v = Math.round(Number(row.value))
    const name = String(row.name || row.type || '项目').trim() || '项目'
    const key = `${name}|${v}`
    const prev = byKey.get(key)
    if (!prev || rank(name) > rank(prev.name)) {
      byKey.set(key, { name, value: v })
    }
  }
  return Array.from(byKey.values())
}

/**
 * 同一金额既被标成资产又被标成「负债」时，去掉误抓的负债（常见于账单里「总资产」与「负债」同屏 OCR）。
 */
function crossDedupeAssetsLiabilities(assets, liabilities) {
  const assetVals = new Set((assets || []).map((a) => Math.round(Number(a.value) || 0)))
  const liabVals = new Set((liabilities || []).map((l) => Math.round(Number(l.value) || 0)))
  const isGenericAssetName = (nm) => /^(资产|金融资产)$/.test(String(nm || ''))
  const isGenericLiabilityName = (nm) => nm === '负债'

  const liab = (liabilities || []).filter((l) => {
    const v = Math.round(Number(l.value) || 0)
    if (!v) return false
    if (!assetVals.has(v)) return true
    const nm = String(l.name || '')
    if (isGenericLiabilityName(nm)) return false
    if (/房贷|车贷|信用卡|借款/.test(nm)) return true
    return false
  })

  const assetsOut = (assets || []).filter((a) => {
    const v = Math.round(Number(a.value) || 0)
    if (!v) return false
    if (!liabVals.has(v)) return true
    const nm = String(a.name || '')
    if (isGenericAssetName(nm)) return false
    if (/房产|车辆|存款/.test(nm)) return true
    if (/房贷|车贷|信用卡|借款/.test(nm)) return false
    return true
  })

  return { assets: assetsOut, liabilities: liab }
}

/** 金额须在用户原文语料中可核对（防 OCR 碎片、模型复述数字等误抓） */
function amountGroundedInCorpus(valueYuan, corpus) {
  const v = Math.round(Number(valueYuan) || 0)
  if (!v || v <= 0) return false
  const raw = String(corpus || '')
  if (!strip(raw)) return false
  const s = raw.replace(/,/g, '')

  if (s.includes(String(v))) return true

  if (v >= 10000 && v % 10000 === 0) {
    const wan = v / 10000
    const wanPat = String(wan).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    if (new RegExp(`${wanPat.replace('.', '\\.')}\\s*(?:万|w|W)`).test(s)) return true
  }
  if (v >= 1000 && v % 1000 === 0) {
    const q = v / 1000
    if (new RegExp(`${q}\\s*千`).test(s)) return true
  }
  if (v >= 100000000 && v % 100000000 === 0) {
    const yi = v / 100000000
    if (new RegExp(`${yi}\\s*亿`).test(s)) return true
  }

  const re = /([\d,]+(?:\.[\d,]+)?)\s*(亿|百万|万|千|元)?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const parsed = parseMoneyToYuan(m[1], m[2])
    if (!parsed) continue
    const tol = Math.max(2, Math.round(v * 0.02))
    if (Math.abs(parsed - v) <= tol) return true
  }
  return false
}

function filterFinancialRowsGroundedInText(rows, corpus) {
  return (rows || []).filter((r) => {
    const v = Math.round(Number(r && r.value) || 0)
    if (!v) return false
    return amountGroundedInCorpus(v, corpus)
  })
}

module.exports = {
  extractAssets,
  extractFundStyleHoldings,
  extractMortgageStyleLiabilities,
  extractLiabilities,
  extractIncome,
  extractExpense,
  hasIncomeContext,
  hasExpenseContext,
  pickMonthlyIncomeFromUserTexts,
  pickMonthlyExpenseFromUserTexts,
  clampReasonableMonthlyExpense,
  clampReasonableMonthlyIncome,
  reconcileMonthlyCashflow,
  estimateMonthlyIncomeTotal,
  estimateMonthlyExpenseSum,
  sanitizeTextForAssetExtraction,
  extractSkillAndWorry,
  sumAssetValue,
  sumLiabilityValue,
  isNoLiabilityText,
  strip,
  parseMoneyToYuan,
  liabilityAmountIsMonthlyPayment,
  dedupeFinancialRows,
  crossDedupeAssetsLiabilities,
  amountGroundedInCorpus,
  filterFinancialRowsGroundedInText
}
