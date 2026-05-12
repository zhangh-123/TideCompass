/**
 * 大模型结构化 payload 与本地规则 inferAssessmentPayload 结果合并 + 轻量校验
 */

const {
  dedupeFinancialRows,
  crossDedupeAssetsLiabilities,
  strip
} = require('./extractHelper.js')

const DEFAULT_MONTHLY_INCOME_CAP = 500000
const DEFAULT_MONTHLY_EXPENSE_CAP = 200000

/** 名称像收益/盈亏的条目不进资产侧（双保险） */
const ASSET_NAME_NOISE_RE =
  /收益|盈亏|涨跌|利息到账|分红到账|万份收益|七日年化|成立以来收益|近\d+日收益/i

/** 负债极小金额多为 OCR 噪声 */
function sanitizeFinancialSide(rows, side) {
  const list = []
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue
    const name = strip(String(r.name || r.label || '')).slice(0, 48)
    const value = Math.round(Number(r.value) || 0)
    if (!name || !Number.isFinite(value) || value <= 0) continue
    if (side === 'asset' && ASSET_NAME_NOISE_RE.test(name)) continue
    if (side === 'liability') {
      if (/房贷|按揭/.test(name) && value < 1000) continue
      if (value < 10 && !/信用卡/.test(name)) continue
    }
    list.push({ name, value })
  }
  return list
}

function saneMonthly(n, cap) {
  const x = Math.round(Number(n) || 0)
  if (!Number.isFinite(x) || x <= 0) return 0
  if (x > cap * 200) return 0
  return Math.min(x, cap)
}

/**
 * @param {object|null} llmPayload - 云函数 extractAssessmentStructured 返回，字段与 infer 一致
 * @param {object} rulePayload - inferAssessmentPayload 结果
 * @returns {object} 合并后的 payload
 */
function mergeStructuredAssessmentPayload(llmPayload, rulePayload) {
  const rule = rulePayload && typeof rulePayload === 'object' ? rulePayload : {}
  const llm = llmPayload && typeof llmPayload === 'object' ? llmPayload : {}

  const llmAssets = sanitizeFinancialSide(llm.assets, 'asset')
  const llmLiab = sanitizeFinancialSide(llm.liabilities, 'liability')
  const ruleAssets = sanitizeFinancialSide(rule.assets, 'asset')
  const ruleLiab = sanitizeFinancialSide(rule.liabilities, 'liability')

  /* 合并：模型优先覆盖语义，规则补齐遗漏；同金额 dedupe 保留更具体名称 */
  const assets = dedupeFinancialRows([...llmAssets, ...ruleAssets])
  const liabilities = dedupeFinancialRows([...llmLiab, ...ruleLiab])
  const cross = crossDedupeAssetsLiabilities(assets, liabilities)

  const llmInc = saneMonthly(llm.monthlyIncome, DEFAULT_MONTHLY_INCOME_CAP)
  const llmExp = saneMonthly(llm.monthlyExpense, DEFAULT_MONTHLY_EXPENSE_CAP)
  const ruleInc = saneMonthly(rule.monthlyIncome, DEFAULT_MONTHLY_INCOME_CAP)
  const ruleExp = saneMonthly(rule.monthlyExpense, DEFAULT_MONTHLY_EXPENSE_CAP)

  const monthlyIncome = Math.max(llmInc, ruleInc)
  const monthlyExpense = Math.max(llmExp, ruleExp)

  const coreSkill = strip(String(llm.coreSkill || rule.coreSkill || '')).slice(0, 80)
  const maxWorry = strip(String(llm.maxWorry || rule.maxWorry || '')).slice(0, 120)

  return {
    assets: cross.assets,
    liabilities: cross.liabilities,
    monthlyIncome,
    monthlyExpense,
    coreSkill,
    maxWorry
  }
}

module.exports = {
  mergeStructuredAssessmentPayload,
  sanitizeFinancialSide,
  ASSET_NAME_NOISE_RE
}
