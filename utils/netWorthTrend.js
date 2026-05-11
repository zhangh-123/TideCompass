/**
 * 基于当前快照净值 + 近 6 个自然月收支，倒推「估算月末净值」趋势线（简化模型）
 * 假设：历史净值变化主要来自流水净额（忽略历史上手动改资产负债的时间点）
 */

function pad2(n) {
  return `${n}`.padStart(2, '0')
}

function ymOffset(base, deltaMonths) {
  const d = new Date(base.getFullYear(), base.getMonth() + deltaMonths, 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

/**
 * @param {number} snapshotNetWorth - 当前 balance_snapshot.netWorth
 * @param {Array<{date:string,type:string,amount:number}>} transactions
 * @returns {{ labels: string[], values: number[] }}
 */
function computeNetWorthTrend(snapshotNetWorth, transactions) {
  const nw = Number(snapshotNetWorth) || 0
  const monthlyNet = {}

  ;(transactions || []).forEach((tx) => {
    const d = (tx.date || '').slice(0, 7)
    if (!d || d.length < 7) return
    const amt = Number(tx.amount) || 0
    const delta = tx.type === 'income' ? amt : -amt
    monthlyNet[d] = (monthlyNet[d] || 0) + delta
  })

  const now = new Date()
  const monthsNewestFirst = []
  for (let i = 0; i < 6; i++) {
    monthsNewestFirst.push(ymOffset(now, -i))
  }

  let cursor = nw
  const pointsDesc = []
  for (let i = 0; i < monthsNewestFirst.length; i++) {
    const ym = monthsNewestFirst[i]
    pointsDesc.push({ ym, val: Math.round(cursor) })
    cursor -= monthlyNet[ym] || 0
  }

  pointsDesc.reverse()
  return {
    labels: pointsDesc.map((p) => p.ym),
    values: pointsDesc.map((p) => p.val)
  }
}

module.exports = {
  computeNetWorthTrend
}
