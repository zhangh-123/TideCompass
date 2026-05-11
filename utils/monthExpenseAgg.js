/**
 * 小程序端：聚合某自然月各支出类目合计（分页读取 transactions）
 */

function pad2(n) {
  return `${n}`.padStart(2, '0')
}

function yearMonthFromDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

function monthDateRange(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  return {
    from: `${yearMonth}-01`,
    to: `${yearMonth}-${pad2(lastDay)}`
  }
}

/**
 * @param {*} db wx.cloud.database()
 * @param {string} openId
 * @param {string} yearMonth YYYY-MM
 * @returns {Promise<Record<string, number>>}
 */
async function sumExpenseByCategoryForMonth(db, openId, yearMonth) {
  const _ = db.command
  const { from, to } = monthDateRange(yearMonth)
  const col = db.collection('transactions')
  const batch = 100
  let skip = 0
  const map = {}

  for (;;) {
    const res = await col
      .where({
        openId,
        type: 'expense',
        date: _.gte(from).and(_.lte(to))
      })
      .skip(skip)
      .limit(batch)
      .get()

    res.data.forEach((tx) => {
      const cat = tx.category || '其他'
      const amt = Number(tx.amount) || 0
      map[cat] = (map[cat] || 0) + amt
    })

    if (res.data.length < batch) break
    skip += batch
    if (skip > 20000) break
  }

  Object.keys(map).forEach((k) => {
    map[k] = Math.round(map[k])
  })
  return map
}

/**
 * @returns {{ hint: string, overspentLabels: string[] }}
 */
async function computeBudgetOverspendHint(db, openId, yearMonth, expenseCategories) {
  const budgetCol = db.collection('budgets')
  const bRes = await budgetCol.where({ openId, yearMonth }).limit(1).get()
  const doc = bRes.data && bRes.data[0]
  const caps = (doc && doc.categories) || {}

  const spentMap = await sumExpenseByCategoryForMonth(db, openId, yearMonth)
  const overspentLabels = []

  expenseCategories.forEach((cat) => {
    const cap = Number(caps[cat]) || 0
    if (cap <= 0) return
    const spent = Number(spentMap[cat]) || 0
    if (spent > cap) overspentLabels.push(cat)
  })

  let hint = ''
  if (overspentLabels.length === 1) {
    hint = `本月「${overspentLabels[0]}」支出已超过预算，可在「月度预算」中查看或调整。`
  } else if (overspentLabels.length > 1) {
    hint = `本月 ${overspentLabels.join('、')} 等类别已超过预算，可在「月度预算」中查看。`
  }

  return { hint, overspentLabels }
}

module.exports = {
  yearMonthFromDate,
  monthDateRange,
  sumExpenseByCategoryForMonth,
  computeBudgetOverspendHint
}
