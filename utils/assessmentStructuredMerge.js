/**
 * 体检报告结构化数据合并：AI 优先，规则兜底
 *
 * 优先级（每一字段）：
 * 1. extractAssessmentStructured 云函数（全对话 + 助手汇总）
 * 2. parseAssessmentFromDialogSummary（助手确认话术）
 * 3. inferAssessmentPayload 规则抽取
 */

const {
  dedupeFinancialRows,
  crossDedupeAssetsLiabilities,
  reconcileMonthlyCashflow,
  clampReasonableMonthlyExpense,
  clampReasonableMonthlyIncome,
  strip
} = require('./extractHelper.js')

const DEFAULT_MONTHLY_INCOME_CAP = 500000
const DEFAULT_MONTHLY_EXPENSE_CAP = 200000

const ASSET_NAME_NOISE_RE =
  /收益|盈亏|涨跌|利息到账|分红到账|万份收益|七日年化|成立以来收益|近\d+日收益/i

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

function pickFinancialRows(llmRows, summaryRows, ruleRows, side) {
  const llm = sanitizeFinancialSide(llmRows, side)
  if (llm.length) return llm
  const summary = sanitizeFinancialSide(summaryRows, side)
  if (summary.length) return summary
  return sanitizeFinancialSide(ruleRows, side)
}

function pickMonthly(llmVal, summaryVal, ruleVal, cap) {
  const llm = saneMonthly(llmVal, cap)
  if (llm > 0) return llm
  const summary = saneMonthly(summaryVal, cap)
  if (summary > 0) return summary
  return saneMonthly(ruleVal, cap)
}

/**
 * @param {object|null} llmPayload - extractAssessmentStructured
 * @param {object} rulePayload - inferAssessmentPayload（兜底）
 * @param {string} [userTextCorpus] - 用户原话，用于月收支纠错
 * @param {object|null} [summaryPayload] - 助手汇总话术解析
 */
function mergeStructuredAssessmentPayload(
  llmPayload,
  rulePayload,
  userTextCorpus = '',
  summaryPayload = null
) {
  const rule = rulePayload && typeof rulePayload === 'object' ? rulePayload : {}
  const llm = llmPayload && typeof llmPayload === 'object' ? llmPayload : {}
  const summary = summaryPayload && typeof summaryPayload === 'object' ? summaryPayload : {}

  const assets = pickFinancialRows(llm.assets, summary.assets, rule.assets, 'asset')
  const liabilities = pickFinancialRows(
    llm.liabilities,
    summary.liabilities,
    rule.liabilities,
    'liability'
  )
  const cross = crossDedupeAssetsLiabilities(
    dedupeFinancialRows(assets),
    dedupeFinancialRows(liabilities)
  )

  let monthlyIncome = pickMonthly(
    llm.monthlyIncome,
    summary.monthlyIncome,
    rule.monthlyIncome,
    DEFAULT_MONTHLY_INCOME_CAP
  )
  let monthlyExpense = pickMonthly(
    llm.monthlyExpense,
    summary.monthlyExpense,
    rule.monthlyExpense,
    DEFAULT_MONTHLY_EXPENSE_CAP
  )

  const cash = reconcileMonthlyCashflow(monthlyIncome, monthlyExpense, userTextCorpus)
  monthlyIncome = clampReasonableMonthlyIncome(cash.monthlyIncome, userTextCorpus)
  monthlyExpense = clampReasonableMonthlyExpense(cash.monthlyExpense, userTextCorpus)

  const coreSkill = strip(String(llm.coreSkill || summary.coreSkill || rule.coreSkill || '')).slice(
    0,
    80
  )
  const maxWorry = strip(
    String(llm.maxWorry || summary.maxWorry || rule.maxWorry || '')
  ).slice(0, 120)

  const dataSource =
    Object.keys(llm).length && (llm.assets?.length || llm.monthlyIncome)
      ? 'llm_structured'
      : summary.assets?.length || summary.monthlyIncome
        ? 'assistant_summary'
        : 'rules_fallback'

  return {
    assets: cross.assets,
    liabilities: cross.liabilities,
    monthlyIncome,
    monthlyExpense,
    coreSkill,
    maxWorry,
    dataSource
  }
}

module.exports = {
  mergeStructuredAssessmentPayload,
  sanitizeFinancialSide,
  ASSET_NAME_NOISE_RE
}
