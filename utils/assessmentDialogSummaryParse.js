/**
 * 从体检对话中助手（assistant）的确认/汇总话术解析结构化 payload。
 * 用于 AI 对话已清晰总结、但规则抽取易失真时的优先数据源（次于 extractAssessmentStructured）。
 */

const { strip, parseMoneyToYuan } = require('./extractHelper.js')

const SUMMARY_MARKERS =
  /资产方面|收支方面|负债方面|保障与计划|总结|盘点|确认|如下|您的(?:资产|负债|收入|支出)/

function emptyPayload() {
  return {
    assets: [],
    liabilities: [],
    monthlyIncome: 0,
    monthlyExpense: 0,
    coreSkill: '',
    maxWorry: ''
  }
}

function findLastAssistantSummary(dialogHistory) {
  const list = Array.isArray(dialogHistory) ? dialogHistory : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (!m || m.role !== 'assistant') continue
    const content = strip(m.content)
    if (content.length < 24) continue
    if (SUMMARY_MARKERS.test(content)) return content
  }
  return ''
}

function parseMonthlyFromSummary(summary, kind) {
  const patterns =
    kind === 'income'
      ? [
          /月(?:均)?收入[^。\n]{0,40}?(?:约|大概|是|在)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)/,
          /家庭税后[^。\n]{0,40}?(\d+(?:\.\d+)?)\s*(万|千|元)/,
          /税后月(?:收入|薪)[^。\n]{0,30}?(\d+(?:\.\d+)?)\s*(万|千|元)/
        ]
      : [
          /月支出[^。\n]{0,40}?(?:约|大概|是|在)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)/,
          /固定支出[^。\n]{0,40}?(?:约|大概|是|在)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)/,
          /刚性支出[^。\n]{0,40}?(?:约|大概|是|在)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)/
        ]
  for (const re of patterns) {
    const m = summary.match(re)
    if (!m) continue
    const v = parseMoneyToYuan(m[1], m[2] || '万')
    if (v && v > 0) return Math.round(v)
  }
  return 0
}

function parseRowsFromSummarySection(summary, sectionRe, side) {
  const rows = []
  const sec = summary.match(sectionRe)
  if (!sec) return rows
  const block = sec[0]
  const lineRe =
    side === 'liability'
      ? /(?:^|\n)[\s*\-•]*([^。\n：:]{2,28}?)[：:]?\s*(?:约|大概)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)/gm
      : /(?:^|\n)[\s*\-•]*([^。\n：:]{2,28}?)[：:]?\s*(?:约|大概)?\s*(\d+(?:\.\d+)?)\s*(万|千|元)/gm
  let m
  while ((m = lineRe.exec(block)) !== null) {
    let name = strip(m[1]).replace(/^\*+|\*+$/g, '')
    if (!name || /方面|如下|总结/.test(name)) continue
    const v = parseMoneyToYuan(m[2], m[3] || '万')
    if (!v || v <= 0) continue
    if (side === 'liability' && /房贷|按揭/.test(name) && v < 50000) continue
    if (/收益|盈亏|涨跌/.test(name)) continue
    rows.push({ name: name.slice(0, 48), value: Math.round(v) })
  }
  return rows
}

/**
 * @param {Array<{role:string,content:string}>} dialogHistory
 */
function parseAssessmentFromDialogSummary(dialogHistory) {
  const summary = findLastAssistantSummary(dialogHistory)
  if (!summary) return emptyPayload()

  const monthlyIncome = parseMonthlyFromSummary(summary, 'income')
  const monthlyExpense = parseMonthlyFromSummary(summary, 'expense')

  let assets = parseRowsFromSummarySection(
    summary,
    /资产方面[\s\S]*?(?=收支方面|负债方面|保障与计划|$)/,
    'asset'
  )
  let liabilities = parseRowsFromSummarySection(
    summary,
    /(?:负债方面|负债)[\s\S]*?(?=收支方面|资产方面|保障与计划|$)/,
    'liability'
  )

  if (!liabilities.length) {
    const m = summary.match(/(?:房贷|按揭)[^。\n]{0,30}?(\d+(?:\.\d+)?)\s*万/)
    if (m) {
      const v = parseMoneyToYuan(m[1], '万')
      if (v >= 50000) liabilities.push({ name: '房贷', value: Math.round(v) })
    }
  }

  return {
    assets,
    liabilities,
    monthlyIncome,
    monthlyExpense,
    coreSkill: '',
    maxWorry: ''
  }
}

module.exports = {
  parseAssessmentFromDialogSummary,
  findLastAssistantSummary
}
