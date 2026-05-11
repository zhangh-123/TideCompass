const { getHomePath } = require('../../utils/route.js')
const { isAdminPhone } = require('../../utils/admin.js')

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0)
  const sign = v < 0 ? '-' : ''
  const abs = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}¥${abs}`
}

function getWeekdayCN(date) {
  return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()]
}

function formatToday() {
  const d = new Date()
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${getWeekdayCN(d)}`
}

function monthRange() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const monthStart = `${y}-${m}-01`
  const monthEnd = `${y}-${m}-31`
  return { monthStart, monthEnd }
}

function pickNickname(user) {
  const p = (user && user.profile) || {}
  return p.nickname || p.name || p.realName || p.displayName || '用户'
}

function isOverdue(rec) {
  return !!(
    rec.overdue ||
    rec.isOverdue ||
    Number(rec.overdueDays || 0) > 0 ||
    String(rec.status || '').toLowerCase() === 'overdue'
  )
}

function parseAprPercent(rec) {
  let raw = rec.apr
  if (raw == null) raw = rec.aprRate
  if (raw == null) raw = rec.interestRate
  if (raw == null) raw = rec.yearRate
  let n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (n > 0 && n < 1) n = n * 100
  return n
}

function parsePrincipal(rec) {
  const cand = [rec.balance, rec.amount, rec.principal, rec.remainAmount, rec.remaining]
  for (const x of cand) {
    const n = Number(x)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

function computeDebtHealth(records) {
  if (!records || !records.length) {
    return {
      score: '暂无',
      tone: 'na',
      highCount: 0,
      monthlyInterest: 0,
      subtitle: '暂无红色债务'
    }
  }

  let hasOverdue = false
  let maxApr = 0
  let highCount = 0
  let monthlyInterest = 0

  for (const r of records) {
    const apr = parseAprPercent(r)
    if (isOverdue(r)) hasOverdue = true
    if (apr != null) maxApr = Math.max(maxApr, apr)

    if (apr != null && apr > 24) {
      highCount += 1
      const principal = parsePrincipal(r)
      monthlyInterest += principal * (apr / 100) / 12
    }
  }

  let score = 60
  if (hasOverdue || maxApr > 24) {
    score = 30
  } else if (maxApr > 0 && maxApr < 10 && !hasOverdue) {
    score = 90
  } else if (maxApr >= 10 && maxApr <= 24) {
    score = Math.round(90 - ((maxApr - 10) / 14) * 60)
  }

  let tone = 'mid'
  if (score === '暂无') tone = 'na'
  else if (score >= 80) tone = 'good'
  else if (score <= 45) tone = 'bad'

  const subtitle = highCount > 0 ? `检测到 ${highCount} 笔高息债务，每月利息 ${fmtMoney(monthlyInterest)}` : '暂无红色债务'

  return {
    score,
    tone,
    highCount,
    monthlyInterest,
    subtitle
  }
}

Page({
  data: {
    nickname: '用户',
    todayText: '',
    isVip: false,

    netWorthText: '暂无',
    netWorthTone: 'na',

    monthCashflowText: '暂无',
    monthCashflowTone: 'na',

    debtHealthScoreText: '暂无',
    debtHealthTone: 'na',

    debtCompassSubtitle: '暂无红色债务',
    stressVipOnly: true,
    showAdminEntry: false,
    warnings: [],
    hasWarning: false,

    loading: false
  },

  async onLoad() {
    this.setData({ todayText: formatToday() })
    await this.guard()
    await this.loadHomeData()
  },

  async onShow() {
    this.setData({ todayText: formatToday() })
    await this.guard()
    await this.loadHomeData()
  },

  async guard() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }

    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).limit(1).get()
      const user = data && data[0]
      const target = getHomePath(user || {})
      if (target !== '/pages/index/index') {
        wx.reLaunch({ url: target })
      }
    } catch (e) {
      console.error(e)
      wx.reLaunch({ url: '/pages/login/login' })
    }
  },

  async loadHomeData() {
    const openId = wx.getStorageSync('openId')
    if (!openId || this.data.loading) return

    this.setData({ loading: true })
    try {
      const db = wx.cloud.database()
      const _ = db.command
      const { monthStart, monthEnd } = monthRange()

      const [userRes, snapRes, txRes, debtRes] = await Promise.all([
        db.collection('users').where({ openId }).limit(1).get(),
        db.collection('balance_snapshot').where({ openId }).limit(1).get(),
        db
          .collection('transactions')
          .where({ openId, date: _.gte(monthStart).and(_.lte(monthEnd)) })
          .limit(500)
          .get(),
        db.collection('debt_records').where({ openId }).limit(500).get().catch(() => ({ data: [] }))
      ])

      const user = userRes.data && userRes.data[0]
      const snap = snapRes.data && snapRes.data[0]
      const txs = txRes.data || []
      const debts = debtRes.data || []

      let netWorthText = '暂无'
      let netWorthTone = 'na'
      if (snap) {
        const totalAssets = Number(snap.totalAssets)
        const totalLiabilities = Number(snap.totalLiabilities)
        let netWorth
        if (Number.isFinite(totalAssets) && Number.isFinite(totalLiabilities)) {
          netWorth = totalAssets - totalLiabilities
        } else if (Number.isFinite(Number(snap.netWorth))) {
          netWorth = Number(snap.netWorth)
        }
        if (Number.isFinite(netWorth)) {
          netWorthText = fmtMoney(netWorth)
          netWorthTone = netWorth >= 0 ? 'good' : 'bad'
        }
      }

      let income = 0
      let expense = 0
      for (const t of txs) {
        const amt = Math.abs(Number(t.amount) || 0)
        if (t.type === 'income') income += amt
        else expense += amt
      }
      let monthCashflowText = '暂无'
      let monthCashflowTone = 'na'
      if (txs.length > 0) {
        const cashflow = income - expense
        monthCashflowText = fmtMoney(cashflow)
        monthCashflowTone = cashflow >= 0 ? 'good' : 'bad'
      }

      const debtHealth = computeDebtHealth(debts)

      this.setData({
        nickname: pickNickname(user),
        isVip: !!(user && user.isVip && Number(user.vipExpireAt) > Date.now()),
        netWorthText,
        netWorthTone,
        monthCashflowText,
        monthCashflowTone,
        debtHealthScoreText: debtHealth.score === '暂无' ? '暂无' : `${debtHealth.score}分`,
        debtHealthTone: debtHealth.tone,
        debtCompassSubtitle: debtHealth.subtitle,
        stressVipOnly: !(
          user && user.isVip && Number(user.vipExpireAt) > Date.now()
        ),
        showAdminEntry: !!(user && isAdminPhone(user.phone))
      })

      await this.loadWarnings()
    } catch (e) {
      console.error('loadHomeData', e)
      this.setData({
        netWorthText: '暂无',
        monthCashflowText: '暂无',
        debtHealthScoreText: '暂无',
        debtCompassSubtitle: '暂无红色债务',
        showAdminEntry: false,
        warnings: [],
        hasWarning: false
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadWarnings() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getActiveWarnings', data: {} })
      const body = res.result || {}
      const warnings = Array.isArray(body.warnings) ? body.warnings : []
      this.setData({
        hasWarning: !!body.hasWarning && warnings.length > 0,
        warnings
      })
    } catch (e) {
      console.error('loadWarnings', e)
      this.setData({ hasWarning: false, warnings: [] })
    }
  },

  onWarningTap(e) {
    const jump = e.currentTarget.dataset.jump || 'none'
    if (jump === 'stress_test') {
      this.goStressTest()
      return
    }
    if (jump === 'add_transaction') {
      this.goAdd()
      return
    }
    if (jump === 'debt_compass') {
      this.goDebtCompass()
      return
    }
  },

  goBalanceSheet() {
    wx.navigateTo({ url: '/pages/balance/balance' })
  },

  goTransactions() {
    wx.navigateTo({ url: '/pages/transactions/transactions' })
  },

  goDebtCompass() {
    wx.navigateTo({ url: '/pages/debt_compass/debt_compass' })
  },

  goStressTest() {
    if (this.data.stressVipOnly) {
      wx.showModal({
        title: '会员专享',
        content: '现金流压力测试为会员功能，开通后可使用。',
        confirmText: '去开通',
        success: (res) => {
          if (res.confirm) wx.navigateTo({ url: '/pages/vip/vip' })
        }
      })
      return
    }
    wx.navigateTo({ url: '/pages/stress_test/stress_test' })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/add_transaction/add_transaction' })
  },

  goAnnualReport() {
    wx.navigateTo({ url: '/pages/annual_report/annual_report' })
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  async goAdmin() {
    if (!this.data.showAdminEntry) return
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).limit(1).get()
      const user = data && data[0]
      if (!user || !isAdminPhone(user.phone)) {
        this.setData({ showAdminEntry: false })
        wx.showToast({ title: '无管理员权限', icon: 'none' })
        return
      }
      wx.navigateTo({ url: '/pages/admin/admin' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '校验失败', icon: 'none' })
    }
  }
})
