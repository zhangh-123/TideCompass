const { getHomePath } = require('../../utils/route.js')
const {
  EXPENSE_CATEGORIES,
  BUDGET_SUBSCRIBE_TEMPLATE_ID
} = require('../../utils/expenseCategories.js')
const {
  sumExpenseByCategoryForMonth,
  yearMonthFromDate
} = require('../../utils/monthExpenseAgg.js')

function pad2(n) {
  return `${n}`.padStart(2, '0')
}

function parseYearMonth(str) {
  const m = /^(\d{4})-(\d{2})$/.exec(str)
  if (!m) return null
  return { y: Number(m[1]), mo: Number(m[2]) }
}

function formatYearMonth(y, mo) {
  return `${y}-${pad2(mo)}`
}

function formatMonthTitle(ym) {
  const p = parseYearMonth(ym)
  if (!p) return ym
  return `${p.y} 年 ${p.mo} 月`
}

function ymFromOffset(baseYm, deltaMonths) {
  const p = parseYearMonth(baseYm)
  if (!p) return baseYm
  const d = new Date(p.y, p.mo - 1 + deltaMonths, 1)
  return formatYearMonth(d.getFullYear(), d.getMonth() + 1)
}

Page({
  data: {
    yearMonth: '',
    monthTitle: '',
    rows: [],
    saving: false,
    monthNavDisabledPrev: false,
    monthNavDisabledNext: false
  },

  async onShow() {
    await this.guard()
    let ym = this.data.yearMonth
    if (!ym) {
      ym = yearMonthFromDate()
      this.setData({
        yearMonth: ym,
        monthTitle: formatMonthTitle(ym)
      })
    }
    await this.loadMonth(ym)
  },

  async guard() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).get()
      const user = data && data[0]
      let target = getHomePath(user || {})
      let allowSub = target === '/pages/index/index'
      try {
        const ad = wx.getStorageSync('assessmentData')
        if (user && user.isFirstAssessmentDone === false && ad && ad.completedAt) {
          allowSub = true
        }
      } catch (e2) {}
      if (!allowSub) {
        wx.reLaunch({ url: target })
      }
    } catch (e) {
      console.error(e)
    }
  },

  refreshNavBounds() {
    const ym = this.data.yearMonth
    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return
    const cur = yearMonthFromDate()
    const minYm = '2020-01'
    const maxYm = ymFromOffset(cur, 12)
    this.setData({
      monthNavDisabledPrev: ym <= minYm,
      monthNavDisabledNext: ym >= maxYm
    })
  },

  prevMonth() {
    if (this.data.monthNavDisabledPrev) return
    const ym = ymFromOffset(this.data.yearMonth, -1)
    this.setData({ yearMonth: ym, monthTitle: formatMonthTitle(ym) }, () =>
      this.refreshNavBounds()
    )
    this.loadMonth(ym)
  },

  nextMonth() {
    if (this.data.monthNavDisabledNext) return
    const ym = ymFromOffset(this.data.yearMonth, 1)
    this.setData({ yearMonth: ym, monthTitle: formatMonthTitle(ym) }, () =>
      this.refreshNavBounds()
    )
    this.loadMonth(ym)
  },

  async loadMonth(yearMonth) {
    const openId = wx.getStorageSync('openId')
    if (!openId) return

    const db = wx.cloud.database()
    try {
      const [budgetRes, spentMap] = await Promise.all([
        db.collection('budgets').where({ openId, yearMonth }).limit(1).get(),
        sumExpenseByCategoryForMonth(db, openId, yearMonth)
      ])

      const doc = budgetRes.data && budgetRes.data[0]
      const caps = (doc && doc.categories) || {}

      const rows = EXPENSE_CATEGORIES.map((category) => {
        const spent = Math.round(Number(spentMap[category]) || 0)
        const cap = Number(caps[category]) || 0
        const budgetInput =
          cap > 0 ? String(cap) : ''
        const over = cap > 0 && spent > cap
        return {
          category,
          spentFmt: `${spent}`,
          budgetInput,
          overClass: over ? 'over' : ''
        }
      })

      this.setData({
        yearMonth,
        monthTitle: formatMonthTitle(yearMonth),
        rows
      })
      this.refreshNavBounds()
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  onBudgetInput(e) {
    const category = e.currentTarget.dataset.category
    const val = e.detail.value
    const rows = this.data.rows.map((row) =>
      row.category === category ? { ...row, budgetInput: val } : row
    )
    this.setData({ rows })
  },

  async onSave() {
    const openId = wx.getStorageSync('openId')
    if (!openId) return

    const categories = {}
    this.data.rows.forEach((row) => {
      const raw = String(row.budgetInput || '').trim()
      if (!raw) return
      const n = Number(raw)
      if (!Number.isNaN(n) && n > 0) {
        categories[row.category] = Math.round(n)
      }
    })

    this.setData({ saving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'saveBudget',
        data: {
          yearMonth: this.data.yearMonth,
          categories
        }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      await this.loadMonth(this.data.yearMonth)
    } catch (err) {
      console.error(err)
      wx.showToast({ title: err.errMsg || '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  onRequestSubscribe() {
    const tmplId = BUDGET_SUBSCRIBE_TEMPLATE_ID
    if (!tmplId || tmplId.indexOf('REPLACE_') === 0) {
      wx.showToast({
        title: '请在 utils/expenseCategories.js 配置模板 ID',
        icon: 'none'
      })
      return
    }
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        const st = res[tmplId]
        if (st === 'accept') {
          wx.showToast({ title: '已授权，超支时将尝试推送', icon: 'none' })
          try {
            wx.setStorageSync('budgetSubscribeAccepted', true)
          } catch (e) {}
        } else if (st === 'reject') {
          wx.showToast({ title: '未授权则无法推送提醒', icon: 'none' })
        } else {
          wx.showToast({ title: '授权结果：' + (st || '未知'), icon: 'none' })
        }
      },
      fail: () => {
        wx.showToast({ title: '订阅请求失败', icon: 'none' })
      }
    })
  }
})
