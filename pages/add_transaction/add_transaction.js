const { getHomePath } = require('../../utils/route.js')
const { EXPENSE_CATEGORIES } = require('../../utils/expenseCategories.js')
const {
  yearMonthFromDate,
  computeBudgetOverspendHint
} = require('../../utils/monthExpenseAgg.js')

function todayStr() {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

Page({
  data: {
    date: todayStr(),
    txType: 'expense',
    categories: ['餐饮', '购物', '居住', '交通', '医疗', '娱乐', '教育', '其他'],
    categoryIndex: 0,
    amount: '',
    note: '',
    saving: false,
    budgetTip: ''
  },

  async onShow() {
    await this.guard()
    await this.loadBudgetTip()
  },

  async loadBudgetTip() {
    const openId = wx.getStorageSync('openId')
    if (!openId) return
    try {
      const db = wx.cloud.database()
      const hintRes = await computeBudgetOverspendHint(
        db,
        openId,
        yearMonthFromDate(),
        EXPENSE_CATEGORIES
      )
      this.setData({ budgetTip: hintRes.hint || '' })
    } catch (e) {
      this.setData({ budgetTip: '' })
    }
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

  onDateChange(e) {
    this.setData({ date: e.detail.value })
  },

  setExpense() {
    this.setData({ txType: 'expense' })
  },

  setIncome() {
    this.setData({ txType: 'income' })
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },

  onAmountInput(e) {
    this.setData({ amount: e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  async onSave() {
    const { date, txType, categories, categoryIndex, amount, note } = this.data
    const amt = parseFloat(amount)
    if (!amount || Number.isNaN(amt) || amt <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'addTransaction',
        data: {
          date,
          type: txType,
          category: categories[categoryIndex],
          amount: amt,
          note
        }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已记账', icon: 'success' })
      await this.loadBudgetTip()
      setTimeout(() => {
        const pages = getCurrentPages()
        if (pages.length > 1) wx.navigateBack()
        else wx.redirectTo({ url: '/pages/index/index' })
      }, 450)
    } catch (err) {
      console.error(err)
      wx.showToast({ title: err.errMsg || '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  }
})
