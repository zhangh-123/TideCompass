function resolveEchartsLib() {
  try {
    const app = getApp()
    if (app && app.globalData && app.globalData.echartsLib) return app.globalData.echartsLib
  } catch (e) {}
  const em = require('../../libs/echarts.min.js')
  return em.default || em
}

const ECHARTS_LIB = resolveEchartsLib()

function fmtDate(ts) {
  const d = new Date(Number(ts) || 0)
  if (Number.isNaN(d.getTime())) return '-'
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

Page({
  data: {
    echartsLib: ECHARTS_LIB,
    ec: { lazyLoad: true },
    isVip: false,
    investModes: ['一次性投资', '分期投资'],
    investModeIndex: 0,
    form: {
      initialNetWorth: 0,
      unemploymentMonths: 6,
      expenseReducePct: 20,
      currentMonthlyIncome: 12000,
      currentMonthlyExpense: 7000,
      newMonthlyIncome: 9000,
      extraInvestment: 10000,
      investmentMode: 'once',
      installmentMonths: 6
    },
    running: false,
    saving: false,
    chartReady: false,
    savedPlans: [],
    compareAId: '',
    compareBId: ''
  },

  _chart: null,
  _lastResult: null,

  async onShow() {
    await this.loadInit()
  },

  goVip() {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  async loadInit() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    try {
      const db = wx.cloud.database()
      const [uRes, snapRes, txRes] = await Promise.all([
        db.collection('users').where({ openId }).limit(1).get(),
        db.collection('balance_snapshot').where({ openId }).limit(1).get(),
        db.collection('transactions').where({ openId }).orderBy('createdAt', 'desc').limit(200).get()
      ])
      const user = uRes.data && uRes.data[0]
      const isVip = !!(user && user.isVip && Number(user.vipExpireAt) > Date.now())
      if (!isVip) {
        this.setData({ isVip: false })
        return
      }
      const snap = snapRes.data && snapRes.data[0]
      const netWorth = snap && typeof snap.netWorth === 'number' ? snap.netWorth : 0
      const monthPrefix = (() => {
        const d = new Date()
        return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}`
      })()
      const items = txRes.data || []
      const income = items.reduce((s, x) => (String(x.date || '').startsWith(monthPrefix) && x.type === 'income' ? s + (Number(x.amount) || 0) : s), 0)
      const expense = items.reduce((s, x) => (String(x.date || '').startsWith(monthPrefix) && x.type === 'expense' ? s + (Number(x.amount) || 0) : s), 0)
      this.setData({
        isVip: true,
        form: Object.assign({}, this.data.form, {
          initialNetWorth: Math.round(netWorth),
          currentMonthlyIncome: Math.round(income || this.data.form.currentMonthlyIncome),
          currentMonthlyExpense: Math.round(expense || this.data.form.currentMonthlyExpense)
        })
      })
      await this.loadPlans()
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '读取失败', icon: 'none' })
    }
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k
    const v = e.detail.value
    this.setData({ form: Object.assign({}, this.data.form, { [k]: v }) })
  },

  onInvestModeChange(e) {
    const idx = Number(e.detail.value)
    this.setData({
      investModeIndex: idx,
      form: Object.assign({}, this.data.form, { investmentMode: idx === 1 ? 'installment' : 'once' })
    })
  },

  buildParams() {
    const f = this.data.form
    return {
      initialNetWorth: Number(f.initialNetWorth) || 0,
      unemploymentMonths: Number(f.unemploymentMonths) || 0,
      expenseReducePct: Number(f.expenseReducePct) || 0,
      currentMonthlyIncome: Number(f.currentMonthlyIncome) || 0,
      currentMonthlyExpense: Number(f.currentMonthlyExpense) || 0,
      newMonthlyIncome: Number(f.newMonthlyIncome) || 0,
      extraInvestment: Number(f.extraInvestment) || 0,
      investmentMode: f.investmentMode === 'installment' ? 'installment' : 'once',
      installmentMonths: Number(f.installmentMonths) || 1
    }
  },

  optionForSingle(values) {
    return {
      color: ['#2563eb'],
      grid: { left: 40, right: 16, top: 28, bottom: 30 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', boundaryGap: false, data: values.map((_, i) => `M${i + 1}`) },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } } },
      series: [{ type: 'line', smooth: true, data: values, areaStyle: { opacity: 0.08 } }]
    }
  },

  optionForCompare(aVals, bVals) {
    const x = aVals.map((_, i) => `M${i + 1}`)
    return {
      color: ['#2563eb', '#dc2626'],
      legend: { data: ['方案A', '方案B'] },
      grid: { left: 40, right: 16, top: 40, bottom: 30 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', boundaryGap: false, data: x },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } } },
      series: [
        { name: '方案A', type: 'line', smooth: true, data: aVals },
        { name: '方案B', type: 'line', smooth: true, data: bVals }
      ]
    }
  },

  renderChart(option) {
    const comp = this.selectComponent('#sim-chart')
    if (!comp) return
    if (this._chart) {
      try { this._chart.dispose() } catch (e) {}
      this._chart = null
    }
    const ec = ECHARTS_LIB || this.data.echartsLib
    comp.init((canvas, width, height, dpr) => {
      const chart = ec.init(canvas, null, { width: width || 320, height: height || 260, devicePixelRatio: dpr || 1 })
      canvas.setChart(chart)
      chart.setOption(option)
      this._chart = chart
      return chart
    })
  },

  async onRun() {
    if (this.data.running) return
    this.setData({ running: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'runSimulation',
        data: { action: 'run', params: this.buildParams() }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '模拟失败', icon: 'none' })
        return
      }
      this._lastResult = r.result
      this.setData({ chartReady: true })
      this.renderChart(this.optionForSingle((r.result && r.result.monthlyNetWorth) || []))
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e.errMsg || '模拟失败', icon: 'none' })
    } finally {
      this.setData({ running: false })
    }
  },

  async onSavePlan() {
    if (this.data.saving) return
    const name = `方案${Date.now().toString().slice(-6)}`

    this.setData({ saving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'runSimulation',
        data: {
          action: 'save',
          name,
          params: this.buildParams()
        }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      await this.loadPlans()
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e.errMsg || '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  async loadPlans() {
    try {
      const res = await wx.cloud.callFunction({ name: 'runSimulation', data: { action: 'list' } })
      const r = res.result || {}
      if (!r.success) return
      const plans = (r.simulations || []).map((x) => Object.assign({}, x, { createdAtText: fmtDate(x.createdAt) }))
      this.setData({ savedPlans: plans })
    } catch (e) {
      console.warn(e)
    }
  },

  toggleCompareA(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ compareAId: this.data.compareAId === id ? '' : id })
  },

  toggleCompareB(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ compareBId: this.data.compareBId === id ? '' : id })
  },

  async removePlan(e) {
    const id = e.currentTarget.dataset.id
    try {
      await wx.cloud.callFunction({ name: 'runSimulation', data: { action: 'remove', simulationId: id } })
      await this.loadPlans()
    } catch (err) {}
  },

  openAIReport(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/ai_report/ai_report?simulationId=${id}` })
  },

  onCompare() {
    const a = this.data.savedPlans.find((x) => x._id === this.data.compareAId)
    const b = this.data.savedPlans.find((x) => x._id === this.data.compareBId)
    if (!a || !b) {
      wx.showToast({ title: '请先选择A/B方案', icon: 'none' })
      return
    }
    const aVals = (a.result && a.result.monthlyNetWorth) || []
    const bVals = (b.result && b.result.monthlyNetWorth) || []
    if (!aVals.length || !bVals.length) {
      wx.showToast({ title: '方案数据异常', icon: 'none' })
      return
    }
    this.setData({ chartReady: true })
    this.renderChart(this.optionForCompare(aVals, bVals))
  }
})
