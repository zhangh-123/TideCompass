const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

function pad2(n) {
  return `${n}`.padStart(2, '0')
}

function ymListRecent6() {
  const now = new Date()
  const list = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    list.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`)
  }
  return list
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

function scoreFromCoverageMonths(m) {
  const x = Number(m) || 0
  if (x >= 12) return 100
  if (x >= 9) return 90
  if (x >= 6) return 80
  if (x >= 3) return 60
  if (x >= 1) return 40
  return Math.round(x * 20)
}

function isLiquidAssetName(name) {
  const n = String(name || '')
  return /现金|存款|余额|活期|货币|银行卡|账户|理财|余额宝/.test(n)
}

function calcFinancialHealthFromSnapshot(snap) {
  if (!snap) return null
  const nw = Number(snap.netWorth)
  const ta = Number(snap.totalAssets)
  const tl = Number(snap.totalLiabilities)
  if (Number.isNaN(nw) || Number.isNaN(ta) || Number.isNaN(tl) || ta <= 0) return null
  const debtRatio = tl / ta
  const nwRatio = nw / ta
  const score = clamp(
    Math.round(nwRatio * 100 * 0.65 + (1 - debtRatio) * 100 * 0.35),
    0,
    100
  )
  return score
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = event.openId || wxContext.OPENID
  if (!openId) return { success: false, message: '缺少 openId' }

  const ym6 = ymListRecent6()
  const startDate = `${ym6[0]}-01`
  const endDate = `${ym6[5]}-31`

  try {
    const txRes = await db
      .collection('transactions')
      .where({
        openId,
        date: _.gte(startDate).and(_.lte(endDate))
      })
      .get()

    const monthMap = {}
    ym6.forEach((ym) => {
      monthMap[ym] = { income: 0, expense: 0 }
    })

    ;(txRes.data || []).forEach((tx) => {
      const ym = String(tx.date || '').slice(0, 7)
      if (!monthMap[ym]) return
      const amt = Number(tx.amount) || 0
      if (tx.type === 'income') monthMap[ym].income += amt
      else monthMap[ym].expense += amt
    })

    const incomeArr = ym6.map((ym) => monthMap[ym].income || 0)
    const expenseArr = ym6.map((ym) => monthMap[ym].expense || 0)
    const avgIncome = incomeArr.reduce((s, x) => s + x, 0) / 6
    const avgExpense = expenseArr.reduce((s, x) => s + x, 0) / 6

    // 1) 平均月结余率评分
    const rates = ym6.map((ym) => {
      const inc = monthMap[ym].income || 0
      const exp = monthMap[ym].expense || 0
      if (inc > 0) return clamp((inc - exp) / inc, -1, 1)
      return exp > 0 ? -1 : 0
    })
    const avgRate = rates.reduce((s, x) => s + x, 0) / rates.length
    const surplusScore = Math.round(((avgRate + 1) / 2) * 100)

    // 2) 收入稳定性：方差越小得分越高
    const variance =
      incomeArr.reduce((s, x) => s + (x - avgIncome) * (x - avgIncome), 0) /
      incomeArr.length
    const std = Math.sqrt(variance)
    const cv = avgIncome > 0 ? std / avgIncome : 2
    const stabilityScore = clamp(Math.round(100 - cv * 120), 0, 100)

    // 3) 紧急备用金覆盖月数：流动资产 / 月支出
    const snapRes = await db
      .collection('balance_snapshot')
      .where({ openId })
      .limit(1)
      .get()
    const snap = snapRes.data && snapRes.data[0]
    const liquidAssets = ((snap && snap.assets) || []).reduce((s, a) => {
      const name = a.name || a.type || ''
      const value = Number(a.value) || 0
      const count = Number(a.count) || 1
      const v =
        Object.prototype.hasOwnProperty.call(a, 'name') && a.name != null
          ? value
          : value * count
      return s + (isLiquidAssetName(name) ? v : 0)
    }, 0)
    const coverageMonths = avgExpense > 0 ? liquidAssets / avgExpense : 12
    const emergencyScore = scoreFromCoverageMonths(coverageMonths)

    const cashflowSafety = clamp(
      Math.round(surplusScore * 0.4 + stabilityScore * 0.25 + emergencyScore * 0.35),
      0,
      100
    )

    const userRes = await db.collection('users').where({ openId }).limit(1).get()
    const user = userRes.data && userRes.data[0]
    if (!user) return { success: false, message: '用户不存在' }

    const dynamicScores = Object.assign({}, user.dynamicScores || {}, {
      cashflowSafety
    })

    // 付费用户：额外动态更新财务健康度（简化版）
    let dynamicFinancialHealth = null
    if (user.isVip) {
      const f = calcFinancialHealthFromSnapshot(snap)
      if (f != null) {
        dynamicScores.financialHealth = f
        dynamicFinancialHealth = f
      }
    }

    await db.collection('users').doc(user._id).update({
      data: {
        dynamicScores,
        dynamicScoresUpdatedAt: Date.now()
      }
    })

    return {
      success: true,
      cashflowSafety,
      financialHealth: dynamicFinancialHealth,
      details: {
        surplusScore,
        stabilityScore,
        emergencyScore,
        coverageMonths: Number(coverageMonths.toFixed(2)),
        avgMonthlyIncome: Number(avgIncome.toFixed(2)),
        avgMonthlyExpense: Number(avgExpense.toFixed(2))
      }
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '更新失败' }
  }
}
