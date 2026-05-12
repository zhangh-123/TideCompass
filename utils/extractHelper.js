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

function detectAssetType(beforeSlice) {
  const b = beforeSlice || ''
  /* 「房贷」「按揭」含「房」，必须先判断，否则房贷余额会被标成房产资产 */
  if (/房贷|按揭|剩余(?:房贷)?贷款|房贷余额|贷款余额|待还本金/.test(b)) return null
  if (/房|不动产|房产/.test(b)) return '房产'
  if (/车|辆/.test(b)) return '车辆'
  if (/存款|现金|活期|定期|存单/.test(b)) return '存款'
  if (/股票|基金|理财|债券|贵金属|保单|股权|余额宝|持仓市值|理财产品/.test(b)) return '金融资产'
  /* 单独「持仓」易与「持仓收益」混淆，仅在没有收益/盈亏语境时使用 */
  if (/持仓/.test(b) && !/(收益|盈亏|涨跌)/.test(b)) return '金融资产'
  return '资产'
}

/**
 * 判断该数字是否处于「月供 / 每月还款」语境，避免把月还款额误记为本金负债。
 */
/** 仅当金额紧邻「月供」类关键词之前（或带 /月）时跳过，避免同一句里「本金 + 月供」前半段被误伤 */
function liabilityAmountIsMonthlyPayment(raw, matchIndex, matchLen) {
  const len = matchLen || 0
  const before = raw.slice(Math.max(0, matchIndex - 16), matchIndex)
  if (
    /(?:月供|月供款|每月(?:需)?还|月还款|按揭月还|每期还|最低还款|每期应还)\s*$/.test(before)
  ) {
    return true
  }
  const after = raw.slice(matchIndex + len, Math.min(raw.length, matchIndex + len + 12))
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

/** 按揭/房贷剩余本金语境：记入负债，不计入房产资产 */
function assetAmountIsMortgagePrincipalNoise(raw, matchIndex, matchLen) {
  const win = contextWindow(raw, matchIndex, 72, 22)
  if (!/(?:房贷|按揭|商业贷|公积金贷|贷款余额|剩余(?:贷款|本息)?)/.test(win)) return false
  if (/市值|估值|评估价|挂牌价|现价|总价/.test(win) && !/(?:房贷|按揭|贷)\s*[:：]?\s*[\d,]+/.test(win))
    return false
  return true
}

/**
 * 提取资产列表：{ type, value(元), count }
 */
function extractAssets(text) {
  const raw = strip(scrubAssessmentFilenameNoise(text))
  if (!raw) return []

  const items = []
  const re = /([\d,]+(?:\.[\d,]+)?)\s*(亿|百万|万|千|元)?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    if (assetAmountIsMonthlyPayment(raw, m.index, (m[0] || '').length)) continue
    const val = parseMoneyToYuan(m[1], m[2])
    if (!val) continue
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
    items.push({ type, value: val, count })
  }

  return items
}

function sumAssetValue(items) {
  return items.reduce((s, it) => s + it.value * (it.count || 1), 0)
}

function isNoLiabilityText(text) {
  const t = strip(text)
  if (!t) return false
  return /^(无|没有|暂无|零|零负债|没负债|没有负债|没有欠款|无负债|无欠款)$/i.test(t)
}

/**
 * 提取负债列表；明确表示「无」返回 []
 */
function extractLiabilities(text) {
  const raw = strip(text)
  if (!raw) return []
  if (isNoLiabilityText(raw)) return []

  const items = []
  const re = /([\d,]+(?:\.[\d,]+)?)\s*(亿|百万|万|千|元)?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    if (liabilityAmountIsMonthlyPayment(raw, m.index, (m[0] || '').length)) continue
    const val = parseMoneyToYuan(m[1], m[2])
    if (!val) continue
    const matchLen = (m[0] || '').length
    const win = contextWindow(raw, m.index, 52, 16)
    if (
      /总资产|资产总额|资产合计|基金资产|证券资产|可用余额|存款余额|理财本金|持仓市值|份额净值/.test(win) &&
      !/负债|贷款|欠款|按揭|车贷|房贷|信用卡|借呗|花呗/.test(win)
    ) {
      continue
    }
    const before = raw.slice(Math.max(0, m.index - 24), m.index)
    const beforeForDebt = raw.slice(Math.max(0, m.index - 40), m.index)
    const afterForDebt = raw.slice(
      m.index + matchLen,
      Math.min(raw.length, m.index + matchLen + 12)
    )
    let type = '负债'
    if (/房贷|按揭|房贷余额/.test(before)) type = '房贷'
    else if (/车贷/.test(before)) type = '车贷'
    else if (/信用卡/.test(before)) type = '信用卡'
    else if (/借款|欠款|贷款/.test(before)) type = '借款'
    /* 不要用过长窗口：否则会匹配到同句后面的「房贷」，把「年终奖」误当成负债 */
    const debtCue =
      /(?:房贷|车贷|按揭|贷款|欠款|信用卡|借呗|花呗|白条|分期|抵押|负债|借款|债务|按揭款)/.test(beforeForDebt) ||
      /(?:待还|本金|欠款)/.test(afterForDebt) ||
      /(?:应还|应付)\s*$/.test(beforeForDebt)
    if (type === '负债' && !debtCue) continue
    /* 房贷本金极少为几元～几百元，多为 OCR 碎片或期数误读 */
    if (type === '房贷' && val > 0 && val < 1000) continue
    if (type !== '信用卡' && val > 0 && val < 10) continue
    items.push({ type, value: val, count: 1 })
  }
  return items
}

function sumLiabilityValue(items) {
  return items.reduce((s, it) => s + it.value * (it.count || 1), 0)
}

/**
 * 月收入（元）；年薪会先折算为月均
 */
function extractIncome(text) {
  const raw = strip(text)
  if (!raw) return null

  let m = raw.match(/月薪\s*([\d.]+)\s*(万|千|元)?/)
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
    let yearly = parseMoneyToYuan(m[1], m[2] || '元')
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

  m = raw.match(/([\d.]+)\s*万/)
  if (m && !/资产|房|车|存款/.test(raw)) {
    const v = parseMoneyToYuan(m[1], '万')
    return v && v > 0 ? v : null
  }

  m = raw.match(/([\d.]+)\s*(?:元)?\s*[\/／]\s*月/)
  if (m) {
    const v = parseMoneyToYuan(m[1], '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/\b([\d]{2,})\b/)
  if (m) {
    const v = parseFloat(m[1])
    if (!Number.isNaN(v) && v > 0 && v < 1e9) return Math.round(v)
  }

  return null
}

/**
 * 月支出（元）
 */
function extractExpense(text) {
  const raw = strip(text)
  if (!raw) return null

  let m = raw.match(/月支出\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/每月\s*(?:花|开销|支出)?\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  m = raw.match(/生活费\s*([\d.]+)\s*(万|千|元)?/)
  if (m) {
    const v = parseMoneyToYuan(m[1], m[2] || '元')
    return v && v > 0 ? v : null
  }

  const fallback = extractIncome(raw.replace(/收入|薪/g, ''))
  return fallback
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
  const fb = extractIncome(raw)
  return fb && fb < 5e6 ? fb : 0
}

/**
 * 刚性月支出估算（元）：从「基本生活 / 子女教育 / 赡养 / 其他开销」等分项累加。
 */
function estimateMonthlyExpenseSum(text) {
  const raw = strip(text)
  if (!raw) return 0
  const parts = raw.split(/[，,。\n]+/).map(strip).filter(Boolean)
  const chunks = parts.length ? parts : [raw]
  let sum = 0
  const bump = (p, re) => {
    if (!re.test(p)) return
    const m = p.match(/(\d[\d,]*(?:\.\d+)?)/)
    if (!m) return
    const unitGuess = /万/.test(p) ? '万' : /千/.test(p) ? '千' : '元'
    const v = parseMoneyToYuan(m[1].replace(/,/g, ''), unitGuess)
    if (v && v > 0 && v < 1e7) sum += v
  }
  for (const p of chunks) {
    bump(p, /基本生活(?:开销|费|支出)?/)
    bump(p, /子女教育/)
    bump(p, /赡养老人/)
    bump(p, /其他开销/)
  }
  return Math.round(sum)
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
    if (/房产|车辆|存款/.test(n)) return 3
    if (/金融资产|理财|股票|基金/.test(n)) return 3
    if (n === '资产' || n === '负债') return 1
    return 2
  }
  const byVal = new Map()
  for (const row of list) {
    const v = Math.round(Number(row.value))
    const prev = byVal.get(v)
    if (!prev || rank(row.name) > rank(prev.name)) {
      byVal.set(v, { name: row.name, value: v })
    }
  }
  return Array.from(byVal.values())
}

/**
 * 同一金额既被标成资产又被标成「负债」时，去掉误抓的负债（常见于账单里「总资产」与「负债」同屏 OCR）。
 */
function crossDedupeAssetsLiabilities(assets, liabilities) {
  const assetVals = new Set((assets || []).map((a) => Math.round(Number(a.value) || 0)))
  const liab = (liabilities || []).filter((l) => {
    const v = Math.round(Number(l.value) || 0)
    if (!v) return false
    if (!assetVals.has(v)) return true
    const nm = String(l.name || '')
    if (nm === '负债') return false
    if (/房贷|车贷|信用卡|借款/.test(nm)) return true
    return false
  })
  return { assets: assets || [], liabilities: liab }
}

module.exports = {
  extractAssets,
  extractLiabilities,
  extractIncome,
  extractExpense,
  estimateMonthlyIncomeTotal,
  estimateMonthlyExpenseSum,
  sanitizeTextForAssetExtraction,
  extractSkillAndWorry,
  sumAssetValue,
  sumLiabilityValue,
  isNoLiabilityText,
  strip,
  liabilityAmountIsMonthlyPayment,
  dedupeFinancialRows,
  crossDedupeAssetsLiabilities
}
