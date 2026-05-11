const { getHomePath } = require('../../utils/route.js')

function fmtMoney(n) {
  const x = Math.round(Number(n) || 0)
  const s = String(Math.abs(x))
  const head = x < 0 ? '-' : ''
  return head + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function currentMonthPrefix() {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}`
}

Page({
  data: {
    flatList: [],
    slideMap: {},
    monthIncomeFmt: '0',
    monthExpenseFmt: '0',
    monthBalanceFmt: '0',
    monthBalance: 0,
    loading: false
  },

  touchStartX: 0,
  touchRowId: '',

  async onShow() {
    await this.guard()
    await this.loadTransactions()
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

  async loadTransactions() {
    const openId = wx.getStorageSync('openId')
    if (!openId) return

    this.setData({ loading: true })
    try {
      const db = wx.cloud.database()
      const { data } = await db
        .collection('transactions')
        .where({ openId })
        .orderBy('createdAt', 'desc')
        .limit(300)
        .get()

      const list = data || []
      const ym = currentMonthPrefix()
      let inc = 0
      let exp = 0
      list.forEach((t) => {
        if (!t.date || !t.date.startsWith(ym)) return
        const a = Number(t.amount) || 0
        if (t.type === 'income') inc += a
        else exp += a
      })
      const balance = inc - exp

      const byDate = {}
      list.forEach((t) => {
        const d = t.date || ''
        if (!byDate[d]) byDate[d] = []
        const cat = t.category || '其他'
        byDate[d].push({
          ...t,
          categoryShort: cat.slice(0, 1),
          amountFmt: fmtMoney(t.amount)
        })
      })

      const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a))
      const flatList = []
      let rk = 0
      dates.forEach((date) => {
        flatList.push({ kind: 'header', date, rowKey: `h-${rk++}` })
        byDate[date].forEach((row) => {
          flatList.push({
            kind: 'row',
            rowKey: row._id,
            ...row
          })
        })
      })

      this.setData({
        flatList,
        slideMap: {},
        monthIncomeFmt: fmtMoney(inc),
        monthExpenseFmt: fmtMoney(exp),
        monthBalanceFmt: fmtMoney(balance),
        monthBalance: balance
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onRowTouchStart(e) {
    const id = e.currentTarget.dataset.id
    this.touchStartX = e.touches[0].clientX
    this.touchRowId = id

    const slideMap = {}
    const cur = (this.data.slideMap || {})[id] || 0
    slideMap[id] = cur
    Object.keys(this.data.slideMap || {}).forEach((k) => {
      if (k !== id) slideMap[k] = 0
    })
    this.setData({ slideMap })
  },

  onRowTouchMove(e) {
    const id = e.currentTarget.dataset.id
    if (!id || id !== this.touchRowId) return
    const x = e.touches[0].clientX
    const dx = x - this.touchStartX
    if (dx >= 0) {
      this.setData({ [`slideMap.${id}`]: 0 })
      return
    }
    const slide = Math.max(dx, -140)
    this.setData({ [`slideMap.${id}`]: slide })
  },

  onRowTouchEnd(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const v = (this.data.slideMap && this.data.slideMap[id]) || 0
    const target = v < -56 ? -140 : 0
    this.setData({ [`slideMap.${id}`]: target })
  },

  onDeleteRow(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return

    wx.showModal({
      title: '删除流水',
      content: '将删除该记录并回滚现金余额，确定吗？',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中' })
        try {
          const cf = await wx.cloud.callFunction({
            name: 'deleteTransaction',
            data: { transactionId: id }
          })
          const r = cf.result || {}
          if (!r.success) {
            wx.showToast({ title: r.message || '删除失败', icon: 'none' })
            return
          }
          wx.showToast({ title: '已删除', icon: 'success' })
          await this.loadTransactions()
        } catch (err) {
          console.error(err)
          wx.showToast({ title: err.errMsg || '删除失败', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  }
})
