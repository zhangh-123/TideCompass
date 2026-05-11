const cloud = require('wx-server-sdk')
const { TEMPLATE_ID, buildBudgetOverrunData } = require('./config')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

async function sumExpenseForCategoryMonth(openId, yearMonth, category) {
  const [yy, mm] = yearMonth.split('-').map(Number)
  const lastDay = new Date(yy, mm, 0).getDate()
  const pad = (n) => `${n}`.padStart(2, '0')
  const from = `${yearMonth}-01`
  const to = `${yearMonth}-${pad(lastDay)}`

  const col = db.collection('transactions')
  const batch = 100
  let skip = 0
  let sum = 0

  for (;;) {
    const res = await col
      .where({
        openId,
        type: 'expense',
        category,
        date: _.gte(from).and(_.lte(to))
      })
      .skip(skip)
      .limit(batch)
      .get()

    res.data.forEach((tx) => {
      sum += Number(tx.amount) || 0
    })

    if (res.data.length < batch) break
    skip += batch
    if (skip > 20000) break
  }

  return Math.round(sum)
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  const date = String(event.date || '').trim()
  const category = event.category
  const amount = Number(event.amount)

  if (!date || date.length < 7 || !category || Number.isNaN(amount) || amount <= 0) {
    return { success: false, message: '参数无效' }
  }

  const yearMonth = date.slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return { success: false, message: '日期无效' }
  }

  try {
    const budgetRes = await db
      .collection('budgets')
      .where({ openId, yearMonth })
      .limit(1)
      .get()

    const budgetDoc = budgetRes.data && budgetRes.data[0]
    const caps = (budgetDoc && budgetDoc.categories) || {}
    const budgetCap = Number(caps[category])

    if (!budgetCap || budgetCap <= 0) {
      return { success: true, skipped: true, reason: 'no_budget' }
    }

    const sumAfter = await sumExpenseForCategoryMonth(openId, yearMonth, category)
    const sumBefore = Math.max(0, sumAfter - Math.round(amount))

    const crossed = sumBefore <= budgetCap && sumAfter > budgetCap
    if (!crossed) {
      return { success: true, skipped: true, reason: 'no_cross', sumAfter, budgetCap }
    }

    if (!TEMPLATE_ID || TEMPLATE_ID.indexOf('REPLACE_') === 0) {
      return { success: true, skipped: true, reason: 'template_not_configured' }
    }

    const tmplData = buildBudgetOverrunData(category, sumAfter, budgetCap)

    const sendRes = await cloud.callFunction({
      name: 'sendSubscribeMessage',
      data: {
        templateId: TEMPLATE_ID,
        page: 'pages/budget/budget',
        data: tmplData,
        miniprogramState: event.miniprogramState || 'formal'
      }
    })

    const sr = sendRes.result || {}
    return {
      success: true,
      notified: !!sr.success,
      sendResult: sr
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '检测失败' }
  }
}
