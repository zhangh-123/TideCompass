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

function buildScoreNarrative(ctx) {
  const {
    radarScores,
    netWorth,
    totalAssets,
    totalLiabilities,
    monthlyIncome,
    monthlyExpense,
    coreSkill,
    biggestWorry
  } = ctx

  const fh = Number(radarScores.financialHealth) || 0
  const sk = Number(radarScores.skillRetention) || 0
  const tr = Number(radarScores.transformationResilience) || 0
  const cf = Number(radarScores.cashflowSafety) || 0

  const exp = Math.max(1, Number(monthlyExpense) || 1)
  const inc = Math.max(0, Number(monthlyIncome) || 0)
  const nw = Number(netWorth) || 0
  const monthsBuffer = nw / exp

  const parts = []

  parts.push(
    `【财务健康度 ${fh} 分】按「估算净资产 ÷ 月刚性支出 × 10」折算为 0–100 分。` +
      `当前识别到的资产合计约 ${Math.round(totalAssets)} 元、负债约 ${Math.round(totalLiabilities)} 元，净资产约 ${Math.round(nw)} 元；` +
      `月支出按 ${Math.round(exp)} 元估算，相当于净资产约能覆盖 ${monthsBuffer.toFixed(1)} 个月的支出。` +
      (nw < 0
        ? ' 净资产为负时，该指标会明显偏低，建议以「减债 + 增厚流动资产」优先。'
        : monthsBuffer < 3
          ? ' 缓冲偏薄时分数会偏低，可先盯住 3–6 个月生活费的安全垫。'
          : '')
  )

  parts.push(
    `【技能保值度 ${sk} 分】来自对话里是否识别到可迁移的职业技能关键词，并结合文本信息量做粗估。` +
      (coreSkill
        ? ` 已识别技能相关描述：「${String(coreSkill).slice(0, 40)}${String(coreSkill).length > 40 ? '…' : ''}」。`
        : ' 若尚未具体描述职业/技能，该项会停留在默认偏低区间。') +
      ' 补充行业、岗位、证书或作品，分数会更贴近真实「可变现能力」。'
  )

  parts.push(
    `【转型韧性 ${tr} 分】综合技能描述与「担忧」文本粗算：若提到裁员、失业、房贷压力等，会适度拉低。` +
      (biggestWorry
        ? ` 当前担忧摘要：「${String(biggestWorry).slice(0, 60)}${String(biggestWorry).length > 60 ? '…' : ''}」。`
        : '') +
      ' 该维度不是精确预测，而是提示你关注「现金流与职业安全边际」。'
  )

  const ratio = exp > 0 ? inc / exp : inc > 0 ? 3 : 0
  parts.push(
    `【现金流安全度 ${cf} 分】由「月收入 ÷ 月支出」相对 0.8 的偏离程度映射到 0–100 分（识别到的月收入 ${Math.round(inc)} 元、月支出 ${Math.round(exp)} 元，比值约 ${ratio.toFixed(2)}）。` +
      (inc <= 0 ? ' 若尚未录入稳定月收入，该分数会失真，建议回到记账或资料里补全。' : '') +
      (ratio < 1 ? ' 收入低于支出时，该项会明显偏低，优先核对支出是否被低估。' : '')
  )

  return parts.join('\n\n')
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

  const scoreNarrative = buildScoreNarrative({
    radarScores,
    netWorth,
    totalAssets,
    totalLiabilities,
    monthlyIncome,
    monthlyExpense,
    coreSkill: skillText,
    biggestWorry: worryText
  })

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
    monthlyIncome,
    monthlyExpense,
    scoreNarrative,
    insights: {
      hiddenAssetCard,
      riskCard
    }
  }
}

module.exports = {
  generateReport,
  buildScoreNarrative
}
