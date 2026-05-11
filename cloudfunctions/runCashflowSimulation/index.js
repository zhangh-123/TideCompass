const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

exports.main = async (event = {}) => {
  const initialAssets = toNum(event.initialAssets)
  const monthlyIncome = toNum(event.monthlyIncome)
  const monthlyExpense = toNum(event.monthlyExpense)
  const events = Array.isArray(event.events) ? event.events : []

  let cash = initialAssets
  const monthlyCashflow = []
  for (let month = 1; month <= 12; month++) {
    let monthlyNet = monthlyIncome - monthlyExpense
    events
      .filter((e) => Math.round(toNum(e.monthOffset)) === month)
      .forEach((e) => {
        const amount = toNum(e.amount)
        if (String(e.type) === 'income') monthlyNet += amount
        else monthlyNet -= amount
      })
    cash += monthlyNet
    monthlyCashflow.push(cash)
  }

  return {
    success: true,
    monthlyCashflow
  }
}
