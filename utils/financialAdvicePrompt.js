/**
 * 财务体检报告 · 智能分析 Prompt（客户端与云函数 generateFinancialAdvice 共用）
 */

function fmtList(rows) {
  if (!rows || !rows.length) return '（无明细）'
  return rows
    .map((r) => {
      const name = String(r.name || r.type || '项目').trim() || '项目'
      const val = Math.round((Number(r.value) || 0) * (Number(r.count) || 1))
      return `${name} ${val}元`
    })
    .join('；')
}

function fmtTimeline(events) {
  if (!events || !events.length) return '（暂无）'
  return events
    .slice(0, 8)
    .map((ev) => {
      const desc = String(ev.description || ev.title || ev.type || '事件').trim()
      const amt = Number(ev.amount)
      const amtStr = Number.isFinite(amt) && amt > 0 ? `，约${Math.round(amt)}元` : ''
      const when = ev.date || ev.month || ev.time || ''
      return `${when ? when + '：' : ''}${desc}${amtStr}`
    })
    .join('；')
}

function buildFinancialAdviceContext(report) {
  const r = report && typeof report === 'object' ? report : {}
  const assets = Array.isArray(r.assets) ? r.assets : []
  const liabilities = Array.isArray(r.liabilities) ? r.liabilities : []
  const sumSide = (rows) =>
    rows.reduce((s, row) => s + Math.round((Number(row.value) || 0) * (Number(row.count) || 1)), 0)

  const totalAssets =
    typeof r.totalAssets === 'number' ? Math.round(r.totalAssets) : sumSide(assets)
  const totalLiabilities =
    typeof r.totalLiabilities === 'number' ? Math.round(r.totalLiabilities) : sumSide(liabilities)
  const netWorth =
    typeof r.netWorth === 'number' ? Math.round(r.netWorth) : totalAssets - totalLiabilities

  const profile = r.profile && typeof r.profile === 'object' ? r.profile : {}

  return {
    jobStatus: r.jobStatus || profile.jobStatus || '未填写',
    familyStructure: r.familyStructure || profile.familyStructure || '未填写',
    monthlyIncome: Number(r.monthlyIncome) > 0 ? Number(r.monthlyIncome) : '（未提供）',
    monthlyExpense: Number(r.monthlyExpense) > 0 ? Number(r.monthlyExpense) : '（未提供）',
    totalAssets,
    totalLiabilities,
    netWorth,
    assetsList: fmtList(assets),
    liabilitiesList: fmtList(liabilities),
    timelineEvents: fmtTimeline(r.timeline_events || r.timelineEvents),
    coreSkill: r.coreSkill || '',
    biggestWorry: r.biggestWorry || r.maxWorry || ''
  }
}

function buildFinancialAdvicePrompt(report) {
  const ctx = buildFinancialAdviceContext(report)
  return `你是一位资深财务规划师。请根据以下用户数据，生成一段针对其财务状况的个性化分析报告（不少于200字）。

用户信息：
- 职业状态：${ctx.jobStatus}
- 家庭结构：${ctx.familyStructure}
- 月收入：${ctx.monthlyIncome} 元
- 月支出：${ctx.monthlyExpense} 元
- 总资产：${ctx.totalAssets} 元（明细：${ctx.assetsList}）
- 总负债：${ctx.totalLiabilities} 元（明细：${ctx.liabilitiesList}）
- 净资产：${ctx.netWorth} 元
- 近期财务相关事件：${ctx.timelineEvents}
- 核心技能/职业相关：${ctx.coreSkill || '未说明'}
- 用户主要担忧：${ctx.biggestWorry || '未说明'}

要求：
1. 首先评价其净资产状况和负债水平。
2. 指出现金流健康度（月收入减月支出）。
3. 给出1-2条切实可行的改善建议。
4. 语气专业、温暖，对财务状况好的用户予以肯定，对差的用户给予鼓励而不批评。
5. 最后以一句积极的寄语结尾。

请直接输出分析报告文本，不要输出任何额外说明或JSON。`
}

module.exports = {
  buildFinancialAdvicePrompt,
  buildFinancialAdviceContext,
  fmtList,
  fmtTimeline
}
