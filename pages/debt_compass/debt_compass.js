function fmtMoney(n) {
  const v = Math.round(Number(n) || 0)
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${v < 0 ? '-' : ''}¥${s}`
}

function parseApr(rec) {
  let raw = rec.apr
  if (raw == null) raw = rec.aprRate
  if (raw == null) raw = rec.interestRate
  if (raw == null) raw = rec.yearRate
  let n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (n > 0 && n < 1) n *= 100
  return n
}

function parseBalance(rec) {
  return Number(rec.balance || rec.amount || rec.principal || rec.remainAmount || 0) || 0
}

Page({
  data: {
    list: [],
    urgentList: [],
    summary: '暂无红色债务',
    loading: false,
    sortMode: 'avalanche'
  },

  async onLoad() {
    await this.loadData()
  },

  async onShow() {
    await this.loadData()
  },

  async loadData() {
    const openId = wx.getStorageSync('openId')
    if (!openId || this.data.loading) return

    this.setData({ loading: true })
    try {
      const r = await wx.cloud.callFunction({
        name: 'getDebtRoute',
        data: { sortMode: this.data.sortMode }
      })
      const body = r.result || {}
      if (!body.success) throw new Error(body.message || '获取路线失败')
      const rows = body.routeList || []
      const urgent = body.urgentDebts || []

      let high = 0
      let highMonthly = 0
      const mapRow = (r) => {
        const apr = Number(r.apr)
        const bal = Number(r.balance) || 0
        const isHigh = apr > 24
        if (isHigh) {
          high += 1
          highMonthly += bal * (apr / 100) / 12
        }
        const rm = r.remainingMonths == null ? null : Number(r.remainingMonths)
        return {
          _id: r._id,
          name: r.name || '债务项',
          balanceText: fmtMoney(bal),
          aprText: apr ? `${apr.toFixed(2)}%` : '暂无',
          high: isHigh,
          remainingText: rm == null ? '到期时间未设置' : `剩余 ${rm} 个月`,
          urgent: rm != null && rm <= 3,
          urgencyScoreText: `紧迫度 ${Number(r.urgencyScore || 0).toFixed(2)}`
        }
      }
      const list = rows.map(mapRow)
      const urgentList = urgent.map(mapRow)
      const summary = high > 0 ? `检测到 ${high} 笔高息债务，每月利息约 ${fmtMoney(highMonthly)}` : '暂无红色债务'
      this.setData({ list, urgentList, summary })
    } catch (e) {
      console.error(e)
      this.setData({ list: [], urgentList: [], summary: '暂无红色债务' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onSortModeChange(e) {
    const sortMode = e.detail.value || 'avalanche'
    this.setData({ sortMode }, () => this.loadData())
  }
})
