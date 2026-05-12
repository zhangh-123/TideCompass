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
  if (/房|不动产|房产/.test(b)) return '房产'
  if (/车|辆/.test(b)) return '车辆'
  if (/存款|现金|活期|定期|存单/.test(b)) return '存款'
  if (/股票|基金|理财|债券|贵金属|保单|股权|余额宝|持仓|市值/.test(b)) return '金融资产'
  return '资产'
}

/**
 * 判断该数字是否处于「月供 / 每月还款」语境，避免把月还款额误记为本金负债。
 */
function liabilityAmountIsMonthlyPayment(raw, matchIndex) {
  const lo = Math.max(0, matchIndex - 40)
  const hi = Math.min(raw.length, matchIndex + 18)
  const ctx = raw.slice(lo, hi)
  return /月供|月供款|每月(?:需)?还|月还款|按揭月还|每期还|元\s*[\/／]\s*月|\/月|块钱\s*一\s*个月|最低还款|每期应还|按揭.*月/.test(
    ctx
  )
}

/** 避免把月供、月还款误记为房产/存款等资产 */
function assetAmountIsMonthlyPayment(raw, matchIndex) {
  const lo = Math.max(0, matchIndex - 40)
  const hi = Math.min(raw.length, matchIndex + 18)
  return /月供|月还|每月(?:需)?还|月还款|每期还|元\s*[\/／]\s*月|\/月|应还(?:款)?/.test(raw.slice(lo, hi))
}

function contextWindow(raw, matchIndex, beforeLen, afterLen) {
  const lo = Math.max(0, matchIndex - beforeLen)
  const hi = Math.min(raw.length, matchIndex + afterLen)
  return raw.slice(lo, hi)
}

/**
 * 提取资产列表：{ type, value(元), count }
 */
function extractAssets(text) {
  const raw = strip(text)
  if (!raw) return []

  const items = []
  const re = /([\d,]+(?:\.[\d,]+)?)\s*(亿|百万|万|千|元)?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    if (assetAmountIsMonthlyPayment(raw, m.index)) continue
    const val = parseMoneyToYuan(m[1], m[2])
    if (!val) continue
    const endOfMatch = m.index + (m[0] || '').length
    if (val >= 1940 && val <= 2030 && /年/.test(raw.slice(endOfMatch, endOfMatch + 3))) continue
    const win = contextWindow(raw, m.index, 48, 16)
    if (/总负债|负债合计|负债总额|欠款合计/.test(win) && !/资产|存款|余额|理财/.test(win)) continue
    const before = raw.slice(Math.max(0, m.index - 24), m.index)
    const type = detectAssetType(before)
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
    if (liabilityAmountIsMonthlyPayment(raw, m.index)) continue
    const val = parseMoneyToYuan(m[1], m[2])
    if (!val) continue
    const win = contextWindow(raw, m.index, 52, 16)
    if (
      /总资产|资产总额|资产合计|基金资产|证券资产|可用余额|存款余额|理财本金|持仓市值|份额净值/.test(win) &&
      !/负债|贷款|欠款|按揭|车贷|房贷|信用卡|借呗|花呗/.test(win)
    ) {
      continue
    }
    const before = raw.slice(Math.max(0, m.index - 24), m.index)
    let type = '负债'
    if (/房贷|按揭|房贷余额/.test(before)) type = '房贷'
    else if (/车贷/.test(before)) type = '车贷'
    else if (/信用卡/.test(before)) type = '信用卡'
    else if (/借款|欠款|贷款/.test(before)) type = '借款'
    const debtCue = /债|贷款|欠款|按揭|车贷|房贷|信用卡|借呗|花呗|白条|分期|抵押|本金|应还|应付|借款/.test(win)
    if (type === '负债' && !debtCue) continue
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
  extractSkillAndWorry,
  sumAssetValue,
  sumLiabilityValue,
  isNoLiabilityText,
  strip,
  liabilityAmountIsMonthlyPayment,
  dedupeFinancialRows,
  crossDedupeAssetsLiabilities
}
