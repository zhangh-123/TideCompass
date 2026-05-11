function fmtMoney(n) {
  const x = Math.round(Number(n) || 0)
  const s = String(Math.abs(x))
  return `${x < 0 ? '-' : ''}¥${s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function monthPrefix() {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}`
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

Page({
  data: {
    loading: false,
    running: false,
    isVip: false,

    initialAssets: 0,
    initialAssetsFmt: '暂无',

    monthlyIncome: 0,
    monthlyExpense: 0,
    monthlyIncomeInput: '0',
    monthlyExpenseInput: '0',

    timelineEvents: [],
    selectedEventIds: [],
    selectedEventIdSet: {},

    customMonthInput: '1',
    customAmountInput: '',
    customType: 'expense',
    customEvents: [],

    incomeReducePctInput: '0',
    incomeReduceStartMonthInput: '1',
    incomeReduceDurationInput: '0',
    oneOffExpenseAmountInput: '',
    oneOffExpenseMonthInput: '1',

    simSeries: [],
    simResultHint: '暂无'
  },

  async onShow() {
    await this.loadData()
  },

  goVip() {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ [key]: e.detail.value })
  },

  onCustomTypeChange(e) {
    this.setData({ customType: e.detail.value })
  },

  onTimelineSelectChange(e) {
    const ids = e.detail.value || []
    const set = {}
    ids.forEach((id) => {
      set[id] = true
    })
    this.setData({ selectedEventIds: ids, selectedEventIdSet: set })
  },

  addCustomEvent() {
    const monthOffset = Math.max(1, Math.min(12, Math.round(toNum(this.data.customMonthInput))))
    const amount = toNum(this.data.customAmountInput)
    const type = this.data.customType === 'income' ? 'income' : 'expense'
    if (amount <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' })
      return
    }
    const id = `c_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    const row = {
      id,
      monthOffset,
      amount,
      type,
      title: `第${monthOffset}个月 · ${type === 'income' ? '收入' : '支出'} ${fmtMoney(amount)}`
    }
    this.setData({
      customEvents: this.data.customEvents.concat(row),
      customAmountInput: ''
    })
  },

  removeCustomEvent(e) {
    const id = e.currentTarget.dataset.id
    this.setData({
      customEvents: this.data.customEvents.filter((x) => x.id !== id)
    })
  },

  async runSimulation() {
    if (this.data.running) return

    const initialAssets = toNum(this.data.initialAssets)
    const monthlyIncome = toNum(this.data.monthlyIncomeInput)
    const monthlyExpense = toNum(this.data.monthlyExpenseInput)
    if (monthlyIncome <= 0 && monthlyExpense <= 0) {
      wx.showToast({ title: '请先输入月收入或月支出', icon: 'none' })
      return
    }

    const events = []
    const selectedSet = this.data.selectedEventIdSet || {}
    ;(this.data.timelineEvents || []).forEach((e) => {
      if (selectedSet[e.id]) {
        events.push({
          monthOffset: e.monthOffset,
          amount: e.amount || 0,
          type: e.type
        })
      }
    })
    ;(this.data.customEvents || []).forEach((e) => {
      events.push({
        monthOffset: e.monthOffset,
        amount: e.amount,
        type: e.type
      })
    })

    const pct = Math.max(0, Math.min(100, toNum(this.data.incomeReducePctInput)))
    const startMonth = Math.max(1, Math.min(12, Math.round(toNum(this.data.incomeReduceStartMonthInput))))
    const duration = Math.max(0, Math.min(12, Math.round(toNum(this.data.incomeReduceDurationInput))))
    if (pct > 0 && duration > 0) {
      for (let i = 0; i < duration; i++) {
        const m = startMonth + i
        if (m > 12) break
        const loss = monthlyIncome * (pct / 100)
        if (loss > 0) {
          events.push({
            monthOffset: m,
            amount: loss,
            type: 'expense'
          })
        }
      }
    }

    const oneOffAmount = toNum(this.data.oneOffExpenseAmountInput)
    const oneOffMonth = Math.max(1, Math.min(12, Math.round(toNum(this.data.oneOffExpenseMonthInput))))
    if (oneOffAmount > 0) {
      events.push({
        monthOffset: oneOffMonth,
        amount: oneOffAmount,
        type: 'expense'
      })
    }

    this.setData({ running: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'runCashflowSimulation',
        data: {
          initialAssets,
          monthlyIncome,
          monthlyExpense,
          events
        }
      })
      const body = res.result || {}
      if (!body.success) {
        wx.showToast({ title: body.message || '模拟失败', icon: 'none' })
        return
      }
      const arr = Array.isArray(body.monthlyCashflow) ? body.monthlyCashflow : []
      const simSeries = arr.map((v, idx) => ({
        month: idx + 1,
        cash: Number(v) || 0,
        cashFmt: fmtMoney(v)
      }))
      const finalCash = simSeries.length ? simSeries[simSeries.length - 1].cash : initialAssets
      const hint =
        finalCash >= 0
          ? `12个月后预计结余 ${fmtMoney(finalCash)}`
          : `第12个月预计缺口 ${fmtMoney(Math.abs(finalCash))}`
      this.setData({
        simSeries,
        simResultHint: hint
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '模拟失败', icon: 'none' })
    } finally {
      this.setData({ running: false })
    }
  },

  async loadData() {
    const openId = wx.getStorageSync('openId')
    if (!openId || this.data.loading) return

    this.setData({ loading: true })
    try {
      const db = wx.cloud.database()
      const now = Date.now()
      const month = monthPrefix()
      const [userRes, snapRes, txRes, reportRes] = await Promise.all([
        db.collection('users').where({ openId }).limit(1).get(),
        db.collection('balance_snapshot').where({ openId }).limit(1).get(),
        db.collection('transactions').where({ openId }).orderBy('createdAt', 'desc').limit(500).get(),
        db
          .collection('health_reports')
          .where({ openId })
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get()
      ])

      const user = userRes.data && userRes.data[0]
      const isVip = !!(user && user.isVip && Number(user.vipExpireAt) > now)
      if (!isVip) {
        this.setData({ isVip: false })
        return
      }

      const snap = snapRes.data && snapRes.data[0]
      const initialAssetsRaw =
        snap && Number.isFinite(Number(snap.netWorth))
          ? Number(snap.netWorth)
          : toNum(snap && snap.totalAssets) - toNum(snap && snap.totalLiabilities)

      const txs = txRes.data || []
      let income = 0
      let expense = 0
      txs.forEach((t) => {
        if (!String(t.date || '').startsWith(month)) return
        const amt = Math.abs(toNum(t.amount))
        if (t.type === 'income') income += amt
        else expense += amt
      })
      if (income <= 0) income = 10000
      if (expense <= 0) expense = 7000

      const latestReport = reportRes.data && reportRes.data[0]
      const timeline = (latestReport && latestReport.timeline_events) || []
      const timelineEvents = timeline
        .map((e, idx) => {
          const monthOffset = Math.round(toNum(e && e.time && e.time.relativeMonths))
          if (monthOffset < 1 || monthOffset > 12) return null
          const amount = toNum(e && e.amount)
          if (amount <= 0) return null
          const rawType = String(e && e.type)
          const type =
            rawType === 'income_loss_risk' ||
            rawType === 'lump_sum_expense' ||
            rawType === 'debt_maturity'
              ? 'expense'
              : 'income'
          return {
            id: `t_${idx}`,
            monthOffset,
            amount,
            type,
            title: e && e.description ? String(e.description) : '未来事件',
            subtitle: `第${monthOffset}个月 · ${type === 'income' ? '收入' : '支出'} ${fmtMoney(amount)}`
          }
        })
        .filter(Boolean)

      const ids = timelineEvents.map((e) => e.id)
      const idSet = {}
      ids.forEach((id) => {
        idSet[id] = true
      })

      this.setData({
        isVip: true,
        initialAssets: initialAssetsRaw,
        initialAssetsFmt: fmtMoney(initialAssetsRaw),
        monthlyIncome: income,
        monthlyExpense: expense,
        monthlyIncomeInput: String(Math.round(income)),
        monthlyExpenseInput: String(Math.round(expense)),
        timelineEvents,
        selectedEventIds: ids,
        selectedEventIdSet: idSet,
        simSeries: [],
        simResultHint: '暂无'
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '读取失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
