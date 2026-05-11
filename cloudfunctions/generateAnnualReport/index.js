const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const EXPENSE_CAT_HINTS = {
  餐饮:
    '餐饮支出占比较高，可适当减少外出就餐、尝试制定月度伙食预算。',
  购物:
    '购物类支出突出，建议区分「必要」与「冲动」，大件可先放入心愿单冷静几天。',
  居住:
    '居住相关支出占比较高，可关注租金/房贷是否与收入匹配，留意水电节能。',
  交通:
    '交通支出较多，可评估通勤方式组合（公共交通、拼车）是否有优化空间。',
  医疗:
    '医疗支出占比较高，请关注是否有可预期的复查或保险覆盖，做好应急预留。',
  娱乐:
    '娱乐支出比例偏高，可为休闲预算设定上限，兼顾生活质量与储蓄目标。',
  教育:
    '教育投入占比较高，建议复盘该项是否为一次性支出，并评估长期回报。',
  其他: '「其他」类支出占比较高，建议在记账时细化类别，便于来年分析。'
}

async function fetchTransactionsByDateRange(openId, dateFrom, dateTo) {
  const col = db.collection('transactions')
  const batch = 100
  let skip = 0
  const out = []
  for (;;) {
    const res = await col
      .where({
        openId,
        date: _.gte(dateFrom).and(_.lte(dateTo))
      })
      .skip(skip)
      .limit(batch)
      .get()
    out.push(...res.data)
    if (res.data.length < batch) break
    skip += batch
    if (skip > 20000) break
  }
  return out
}

async function fetchTransactionsAfterDate(openId, dateAfter) {
  const col = db.collection('transactions')
  const batch = 100
  let skip = 0
  const out = []
  for (;;) {
    const res = await col
      .where({
        openId,
        date: _.gt(dateAfter)
      })
      .skip(skip)
      .limit(batch)
      .get()
    out.push(...res.data)
    if (res.data.length < batch) break
    skip += batch
    if (skip > 20000) break
  }
  return out
}

function netCashDelta(records) {
  return records.reduce((sum, tx) => {
    const a = Number(tx.amount) || 0
    return sum + (tx.type === 'income' ? a : -a)
  }, 0)
}

function summarizeYearTransactions(rows) {
  let totalIncome = 0
  let totalExpense = 0
  const expenseMap = {}

  rows.forEach((tx) => {
    const a = Number(tx.amount) || 0
    if (tx.type === 'income') {
      totalIncome += a
    } else if (tx.type === 'expense') {
      totalExpense += a
      const cat = tx.category || '其他'
      expenseMap[cat] = (expenseMap[cat] || 0) + a
    }
  })

  const expenseByCategory = Object.keys(expenseMap)
    .map((category) => ({
      category,
      amount: Math.round(expenseMap[category])
    }))
    .sort((x, y) => y.amount - x.amount)

  const pieData = expenseByCategory.map((x) => ({
    name: x.category,
    value: x.amount
  }))

  let suggestion = ''
  if (totalExpense <= 0) {
    suggestion =
      totalIncome > 0
        ? '本年度有收入记录但暂无支出，继续保持良好消费习惯，记得为未来大额支出预留缓冲。'
        : '本年度暂无收支流水，养成记账习惯能让年度报告更有意义。'
  } else {
    const top = expenseByCategory[0]
    const pct = Math.round((top.amount / totalExpense) * 100)
    const hint =
      EXPENSE_CAT_HINTS[top.category] ||
      `「${top.category}」支出占比约 ${pct}%，建议为该类别设定年度预算上限并定期复盘。`
    suggestion =
      pct >= 25
        ? `您的「${top.category}」支出占比偏高（约 ${pct}%）。${hint}`
        : `本年度支出结构相对分散，最大类别为「${top.category}」（约 ${pct}%）。${hint}`
  }

  return {
    totalIncome: Math.round(totalIncome),
    totalExpense: Math.round(totalExpense),
    expenseByCategory,
    expensePieData: pieData,
    suggestion
  }
}

function snapshotNetWorth(doc) {
  if (!doc) return null
  if (typeof doc.netWorth === 'number') return doc.netWorth
  const ta =
    typeof doc.totalAssets === 'number'
      ? doc.totalAssets
      : (doc.assets || []).reduce((s, i) => {
          const v = Number(i.value) || 0
          const c = Number(i.count) || 1
          const val =
            Object.prototype.hasOwnProperty.call(i, 'name') &&
            i.name != null &&
            i.name !== ''
              ? v
              : v * c
          return s + val
        }, 0)
  const tl =
    typeof doc.totalLiabilities === 'number'
      ? doc.totalLiabilities
      : (doc.liabilities || []).reduce((s, i) => {
          const v = Number(i.value) || 0
          const c = Number(i.count) || 1
          const val =
            Object.prototype.hasOwnProperty.call(i, 'name') &&
            i.name != null &&
            i.name !== ''
              ? v
              : v * c
          return s + val
        }, 0)
  return ta - tl
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const year = parseInt(event.year, 10)
  const now = new Date()
  const currentYear = now.getFullYear()

  if (!year || year < 2000 || year > currentYear + 1) {
    return { success: false, message: '年份无效' }
  }

  const yStart = new Date(year, 0, 1).getTime()
  const yEnd = new Date(year, 11, 31, 23, 59, 59, 999).getTime()
  const dateFrom = `${year}-01-01`
  const dateTo = `${year}-12-31`

  try {
    const yearTx = await fetchTransactionsByDateRange(openId, dateFrom, dateTo)
    const summary = summarizeYearTransactions(yearTx)

    const firstHr = await db
      .collection('health_reports')
      .where({
        openId,
        createdAt: _.gte(yStart).and(_.lte(yEnd))
      })
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get()

    const lastHr = await db
      .collection('health_reports')
      .where({
        openId,
        createdAt: _.gte(yStart).and(_.lte(yEnd))
      })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()

    let netWorthStart = null
    let netWorthEnd = null
    let netWorthComparisonSource = 'none'

    const hrCount =
      firstHr.data && firstHr.data.length && lastHr.data && lastHr.data.length

    if (hrCount) {
      netWorthStart = Number(firstHr.data[0].netWorth)
      netWorthEnd = Number(lastHr.data[0].netWorth)
      if (Number.isNaN(netWorthStart)) netWorthStart = null
      if (Number.isNaN(netWorthEnd)) netWorthEnd = null
      if (netWorthStart != null && netWorthEnd != null) {
        netWorthComparisonSource = 'health_reports'
      }
    }

    if (netWorthComparisonSource !== 'health_reports') {
      const snapRes = await db.collection('balance_snapshot').where({ openId }).limit(1).get()
      const snap = snapRes.data && snapRes.data[0]
      const nwNow = snapshotNetWorth(snap)

      if (nwNow != null && !Number.isNaN(nwNow)) {
        const afterYearTx = await fetchTransactionsAfterDate(openId, dateTo)
        const flowAfter = netCashDelta(afterYearTx)
        const flowYear = netCashDelta(yearTx)
        netWorthEnd = Math.round(nwNow - flowAfter)
        netWorthStart = Math.round(netWorthEnd - flowYear)
        netWorthComparisonSource = 'estimated'
      } else {
        netWorthStart = null
        netWorthEnd = null
        netWorthComparisonSource = 'none'
      }
    }

    const deltaNw =
      netWorthStart != null && netWorthEnd != null
        ? Math.round(netWorthEnd - netWorthStart)
        : null

    const hasTransactionData =
      summary.totalIncome > 0 || summary.totalExpense > 0 || yearTx.length > 0
    const hasNetWorthComparison =
      netWorthStart != null && netWorthEnd != null && netWorthComparisonSource !== 'none'

    return {
      success: true,
      year,
      ...summary,
      balance: Math.round(summary.totalIncome - summary.totalExpense),
      netWorthStart,
      netWorthEnd,
      netWorthDelta: deltaNw,
      netWorthComparisonSource,
      hasTransactionData,
      hasNetWorthComparison,
      emptyHint: !hasTransactionData
        ? '本年度暂无记账流水，收支汇总将为空；仍可查看净值对比（若有体检或快照估算）。'
        : ''
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '生成失败' }
  }
}
