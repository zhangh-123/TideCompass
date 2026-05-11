const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function toNum(v, d = 0) {
  const n = Number(v)
  return Number.isNaN(n) ? d : n
}

function runProjection(params) {
  const months = 12
  const unemploymentMonths = clamp(Math.floor(toNum(params.unemploymentMonths, 0)), 0, months)
  const expenseReducePct = clamp(toNum(params.expenseReducePct, 0), 0, 100)
  const currentMonthlyIncome = Math.max(0, toNum(params.currentMonthlyIncome, 0))
  const currentMonthlyExpense = Math.max(0, toNum(params.currentMonthlyExpense, 0))
  const newMonthlyIncome = Math.max(0, toNum(params.newMonthlyIncome, 0))
  const extraInvestment = Math.max(0, toNum(params.extraInvestment, 0))
  const installmentMonths = clamp(Math.floor(toNum(params.installmentMonths, 1)), 1, months)
  const investmentMode = params.investmentMode === 'installment' ? 'installment' : 'once'

  let netWorth = toNum(params.initialNetWorth, 0)
  const series = []
  const monthlyInvestment =
    investmentMode === 'installment' ? extraInvestment / installmentMonths : 0

  for (let i = 1; i <= months; i++) {
    const inUnemployment = i <= unemploymentMonths
    const income = inUnemployment ? 0 : (newMonthlyIncome || currentMonthlyIncome)
    const expense =
      inUnemployment
        ? currentMonthlyExpense * (1 - expenseReducePct / 100)
        : currentMonthlyExpense
    const invest =
      investmentMode === 'once'
        ? i === 1
          ? extraInvestment
          : 0
        : i <= installmentMonths
          ? monthlyInvestment
          : 0
    const delta = income - expense - invest
    netWorth += delta
    series.push({
      month: i,
      income: Math.round(income),
      expense: Math.round(expense),
      investment: Math.round(invest),
      delta: Math.round(delta),
      netWorth: Math.round(netWorth)
    })
  }

  return {
    monthlyNetWorth: series.map((x) => x.netWorth),
    series
  }
}

async function saveScenario(openId, payload) {
  const col = db.collection('simulations')
  const list = await col.where({ openId }).orderBy('createdAt', 'desc').limit(6).get()
  const existing = list.data || []
  if (existing.length >= 5) {
    const last = existing[existing.length - 1]
    await col.doc(last._id).remove()
  }
  const add = await col.add({
    data: {
      openId,
      name: String(payload.name || '未命名方案').slice(0, 20),
      params: payload.params || {},
      result: payload.result || {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  })
  return add._id
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const action = event.action || 'run'

  if (!openId) return { success: false, message: '缺少 openId' }

  try {
    const userRes = await db.collection('users').where({ openId }).limit(1).get()
    const user = userRes.data && userRes.data[0]
    const isVip = !!(user && user.isVip && Number(user.vipExpireAt) > Date.now())
    if (!isVip) {
      return { success: false, message: '会员专属功能，请先开通会员' }
    }

    if (action === 'run') {
      const result = runProjection(event.params || {})
      return { success: true, result }
    }

    if (action === 'save') {
      const result = runProjection(event.params || {})
      const id = await saveScenario(openId, {
        name: event.name,
        params: event.params || {},
        result
      })
      return { success: true, simulationId: id, result }
    }

    if (action === 'list') {
      const res = await db
        .collection('simulations')
        .where({ openId })
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get()
      return { success: true, simulations: res.data || [] }
    }

    if (action === 'remove') {
      const id = event.simulationId
      if (!id) return { success: false, message: '缺少 simulationId' }
      const doc = await db.collection('simulations').doc(id).get()
      if (!doc.data || doc.data.openId !== openId) {
        return { success: false, message: '无权删除该方案' }
      }
      await db.collection('simulations').doc(id).remove()
      return { success: true }
    }

    return { success: false, message: '未知 action' }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '模拟失败' }
  }
}
