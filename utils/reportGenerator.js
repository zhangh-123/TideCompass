const {
  sumAssetValue,
  sumLiabilityValue
} = require('./extractHelper.js')

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function roundScore(n) {
  return Math.round(clamp(n, 0, 100))
}

function buildHiddenAssetCard(skill) {
  const s = (skill || '您的专业').trim() || '综合能力'
  return (
    `被低估的核心资产：您的「${s}」在当前环境下仍然具备可变现的人力资本属性。` +
    `将技能沉淀为可展示的成果（案例、作品、可度量产出），有助于提升议价能力与转型弹性。`
  )
}

function buildRiskCard(worry) {
  const w = (worry || '不确定性').trim() || '财务波动'
  return (
    `看不见的暗礁：您对「${w}」的关注度较高，意味着现金流安全边际需要单独建模。` +
    `建议优先预留覆盖 3–6 个月刚性支出的流动性缓冲，并审视负债期限与收入的匹配度。`
  )
}

/**
 * @param {object} assessmentData - 本地 assessmentData（含 payload）或纯 payload
 */
function generateReport(assessmentData) {
  const payload =
    assessmentData && assessmentData.payload
      ? assessmentData.payload
      : assessmentData || {}

  const assetsList = Array.isArray(payload.assets) ? payload.assets : []
  const liabilitiesList = Array.isArray(payload.liabilities)
    ? payload.liabilities
    : []

  const totalAssets = sumAssetValue(assetsList)
  const totalLiabilities = sumLiabilityValue(liabilitiesList)
  const netWorth = totalAssets - totalLiabilities

  const monthlyExpense = Math.max(1, Number(payload.monthlyExpense) || 1)
  const monthlyIncome = Math.max(0, Number(payload.monthlyIncome) || 0)

  const financialHealth = roundScore((netWorth / monthlyExpense) * 10)

  const incomeExpenseRatio =
    monthlyExpense > 0 ? monthlyIncome / monthlyExpense : monthlyIncome > 0 ? 3 : 0
  const cashflowSafety = roundScore((incomeExpenseRatio - 0.8) * 45 + 55)

  const skillText = (payload.coreSkill || '').trim()
  const worryText = (payload.maxWorry || '').trim()

  let skillRetention = roundScore(38 + skillText.length * 1.8)
  if (/AI|算法|数据|后端|前端|架构|产品|运营|销售|财务|法务/i.test(skillText)) {
    skillRetention = roundScore(skillRetention + 8)
  }

  let transformationResilience = roundScore(
    42 + skillText.length * 1.2 + worryText.length * 0.8
  )
  if (/裁员|失业|降薪|现金流|房贷|负债/i.test(worryText)) {
    transformationResilience = roundScore(transformationResilience - 6)
  }

  const radarScores = {
    financialHealth,
    skillRetention,
    transformationResilience,
    cashflowSafety
  }

  const hiddenAssetCard = buildHiddenAssetCard(skillText)
  const riskCard = buildRiskCard(worryText)

  return {
    netWorth,
    totalAssets,
    totalLiabilities,
    radarScores,
    assetsList,
    liabilitiesList,
    hiddenAssetCard,
    riskCard,
    coreSkill: skillText,
    biggestWorry: worryText,
    insights: {
      hiddenAssetCard,
      riskCard
    }
  }
}

module.exports = {
  generateReport
}
