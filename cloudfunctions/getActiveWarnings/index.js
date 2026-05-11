const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtYuan(n) {
  const x = Math.round(toNum(n))
  const s = String(Math.abs(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `¥${s}`
}

function buildWarning(event) {
  const type = String(event && event.type)
  const month = Math.max(0, Math.round(toNum(event && event.time && event.time.relativeMonths)))
  const amount = toNum(event && event.amount)
  const desc = String((event && event.description) || '').trim()
  const name = String((event && event.name) || '').trim()

  if (type === 'income_loss_risk') {
    return {
      kind: 'income_risk',
      jump: 'stress_test',
      text: `⚠️ 您可能在 ${month} 个月后面临收入下降风险，建议进行压力测试。`
    }
  }
  if (type === 'lump_sum_expense') {
    return {
      kind: 'expense',
      jump: 'add_transaction',
      text: `📅 ${month} 个月后有一笔 ${fmtYuan(amount)} 的大额支出，请提前规划现金流。`
    }
  }
  if (type === 'debt_maturity') {
    return {
      kind: 'debt',
      jump: 'debt_compass',
      text: `💳 ${month} 个月后负债 ${name || desc || '项目'} 到期，请在负债罗盘中调整优先级。`
    }
  }
  return {
    kind: 'general',
    jump: 'none',
    text: `📌 ${month} 个月内有重要财务事件：${desc || '请关注近期资金安排。'}`
  }
}

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  if (!openId) return { hasWarning: false, warnings: [] }

  const [reportRes, userRes] = await Promise.all([
    db.collection('health_reports').where({ openId }).orderBy('createdAt', 'desc').limit(1).get(),
    db.collection('users').where({ openId }).limit(1).get()
  ])
  const report = reportRes.data && reportRes.data[0]
  const user = userRes.data && userRes.data[0]
  const events = (report && report.timeline_events) || []

  const warnings = events
    .filter((e) => toNum(e && e.time && e.time.relativeMonths) <= 3 && toNum(e && e.time && e.time.relativeMonths) >= 0)
    .map(buildWarning)
    .filter((w) => !!w && !!w.text)

  // 会员附加提醒：动态债务健康分下降
  if (
    user &&
    user.isVip &&
    user.dynamicScores &&
    Number.isFinite(toNum(user.dynamicScores.debtHealthDelta)) &&
    toNum(user.dynamicScores.debtHealthDelta) < 0
  ) {
    warnings.unshift({
      kind: 'vip_dynamic',
      jump: 'debt_compass',
      text: `📉 您的债务健康分下降了 ${Math.abs(toNum(user.dynamicScores.debtHealthDelta))} 分，建议立即复盘负债结构。`
    })
  }

  return {
    hasWarning: warnings.length > 0,
    warnings
  }
}
