const { getHomePath } = require('../../utils/route.js')
const { drawReportCard } = require('../../utils/shareImage.js')

function resolveEchartsLib() {
  try {
    const app = getApp()
    if (app && app.globalData && app.globalData.echartsLib) {
      return app.globalData.echartsLib
    }
  } catch (e) {}
  const em = require('../../libs/echarts.min.js')
  return em.default || em
}

const ECHARTS_LIB = resolveEchartsLib()

function fmtMoney(n) {
  const x = Math.round(Number(n) || 0)
  const s = String(Math.abs(x))
  const head = x < 0 ? '-' : ''
  return head + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const PIE_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#ca8a04',
  '#059669',
  '#0891b2',
  '#475569'
]

Page({
  data: {
    echartsLib: ECHARTS_LIB,
    ec: { lazyLoad: true },
    yearLabels: [],
    yearOptions: [],
    yearIndex: 0,
    selectedYear: new Date().getFullYear(),
    loading: true,
    loadError: '',
    emptyHint: '',
    totalIncomeFmt: '0',
    totalExpenseFmt: '0',
    balanceFmt: '0',
    balanceClass: 'pos',
    hasExpensePie: false,
    categoryRows: [],
    comparisonCaption: '',
    hasNetWorthComparison: false,
    startLabel: '',
    endLabel: '',
    netWorthStartFmt: '',
    netWorthEndFmt: '',
    netWorthDeltaFmt: '',
    deltaClass: 'pos',
    comparisonFallback: '',
    suggestion: '',
    sharingImage: false
  },

  _pieChart: null,
  _piePayload: null,

  onLoad() {
    this._echarts = ECHARTS_LIB || this.data.echartsLib
    const cy = new Date().getFullYear()
    const yearOptions = []
    for (let y = cy; y >= 2020; y--) yearOptions.push(y)
    const yearLabels = yearOptions.map((y) => `${y} 年`)
    this.setData({
      yearOptions,
      yearLabels,
      yearIndex: 0,
      selectedYear: cy
    })
  },

  async onShow() {
    await this.guard()
    await this.loadReport()
  },

  onUnload() {
    if (this._pieChart) {
      try {
        this._pieChart.dispose()
      } catch (e) {}
      this._pieChart = null
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

  onYearPick(e) {
    const idx = Number(e.detail.value)
    const y = this.data.yearOptions[idx]
    if (y == null || y === this.data.selectedYear) return
    this.setData({ yearIndex: idx, selectedYear: y })
    this.loadReport()
  },

  buildPieOption(pieData) {
    return {
      color: PIE_COLORS,
      tooltip: {
        trigger: 'item',
        formatter: '{b}: {c} 元 ({d}%)'
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        textStyle: { fontSize: 10 }
      },
      series: [
        {
          type: 'pie',
          radius: ['36%', '62%'],
          center: ['50%', '46%'],
          data: pieData || [],
          label: {
            formatter: '{b}\n{d}%',
            fontSize: 10
          }
        }
      ]
    }
  },

  initPieChart(pieData) {
    const comp = this.selectComponent('#annual-pie')
    if (!comp) return

    const ec = this._echarts
    if (!ec || typeof ec.init !== 'function') return

    if (this._pieChart) {
      try {
        this._pieChart.dispose()
      } catch (e) {}
      this._pieChart = null
    }

    const opt = this.buildPieOption(pieData)
    this._piePayload = pieData

    comp.init((canvas, width, height, dpr) => {
      const w = width || 300
      const h = height || 280
      const chart = ec.init(canvas, null, {
        width: w,
        height: h,
        devicePixelRatio: dpr || 1
      })
      canvas.setChart(chart)
      chart.setOption(opt)
      setTimeout(() => {
        try {
          chart.resize()
        } catch (e) {}
      }, 50)
      this._pieChart = chart
      return chart
    })
  },

  applyReportPayload(r) {
    const totalIncome = r.totalIncome || 0
    const totalExpense = r.totalExpense || 0
    const balance = typeof r.balance === 'number' ? r.balance : totalIncome - totalExpense

    const expensePie = r.expensePieData || []
    const hasExpensePie = expensePie.length > 0

    const categoryRows = (r.expenseByCategory || []).map((row) => {
      const pct =
        totalExpense > 0 ? Math.round((row.amount / totalExpense) * 100) : 0
      return {
        category: row.category,
        amountFmt: fmtMoney(row.amount),
        pct
      }
    })

    let comparisonCaption = ''
    let startLabel = ''
    let endLabel = ''
    let comparisonFallback =
      '本年度在所选维度下暂无可用对比数据。完成体检或维护资产负债快照并记账后，系统将自动估算净值变化。'

    if (r.netWorthComparisonSource === 'health_reports') {
      comparisonCaption =
        '对比来源：该年度首次与最后一次「体检报告」中的净值（财务诊断快照）。'
      startLabel = '首次体检净值（年初侧）'
      endLabel = '末次体检净值（年末侧）'
    } else if (r.netWorthComparisonSource === 'estimated') {
      comparisonCaption =
        '对比来源：根据当前资产负债快照与记账流水倒推的年初 / 年末净值估算（简化模型，仅供参考）。'
      startLabel = '估算年初净值（1 月 1 日附近）'
      endLabel = '估算年末净值（12 月 31 日附近）'
    }

    if (!r.hasNetWorthComparison) {
      comparisonCaption = ''
    }

    const hasNW = !!r.hasNetWorthComparison
    const delta = typeof r.netWorthDelta === 'number' ? r.netWorthDelta : 0

    this.setData({
      loading: false,
      loadError: '',
      emptyHint: r.emptyHint || '',
      totalIncomeFmt: fmtMoney(totalIncome),
      totalExpenseFmt: fmtMoney(totalExpense),
      balanceFmt: fmtMoney(balance),
      balanceClass: balance >= 0 ? 'pos' : 'neg',
      hasExpensePie,
      categoryRows,
      comparisonCaption,
      hasNetWorthComparison: hasNW,
      startLabel,
      endLabel,
      netWorthStartFmt: hasNW ? fmtMoney(r.netWorthStart) : '',
      netWorthEndFmt: hasNW ? fmtMoney(r.netWorthEnd) : '',
      netWorthDeltaFmt: hasNW ? `${delta >= 0 ? '+' : ''}${fmtMoney(delta)}` : '',
      deltaClass: delta >= 0 ? 'pos' : 'neg',
      comparisonFallback: hasNW ? '' : comparisonFallback,
      suggestion: r.suggestion || '坚持记账与定期体检，下一年的总结会更加清晰。'
    })

    wx.nextTick(() => {
      setTimeout(() => {
        if (hasExpensePie) {
          this.initPieChart(expensePie)
        } else if (this._pieChart) {
          try {
            this._pieChart.dispose()
          } catch (e) {}
          this._pieChart = null
        }
      }, 120)
    })
  },

  async loadReport() {
    const year = this.data.selectedYear
    this.setData({ loading: true, loadError: '' })

    try {
      const res = await wx.cloud.callFunction({
        name: 'generateAnnualReport',
        data: { year }
      })
      const r = res.result || {}
      if (!r.success) {
        this.setData({
          loading: false,
          loadError: r.message || '生成失败',
          hasExpensePie: false,
          categoryRows: [],
          hasNetWorthComparison: false,
          suggestion: '',
          emptyHint: ''
        })
        return
      }
      this.applyReportPayload(r)
    } catch (e) {
      console.error(e)
      this.setData({
        loading: false,
        loadError: (e && e.errMsg) || '网络异常，请稍后重试',
        hasExpensePie: false,
        categoryRows: [],
        hasNetWorthComparison: false,
        suggestion: '',
        emptyHint: ''
      })
    }
  },

  async onShareReportImage() {
    if (this.data.sharingImage) return
    this.setData({ sharingImage: true })
    try {
      const topCat =
        this.data.categoryRows && this.data.categoryRows.length
          ? this.data.categoryRows[0].category
          : '暂无'
      const file = await drawReportCard(
        this,
        'share-annual-canvas',
        {
          annualBalance: `${this.data.balanceFmt} 元`,
          topExpenseCategory: topCat,
          tip: this.data.suggestion
        },
        '年度报告'
      )
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath: file,
          success: () => resolve(),
          fail: (e) => reject(e)
        })
      })
      wx.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (e) {
      wx.showModal({
        title: '生成成功',
        content: '请在图片预览中长按保存，或检查相册授权。',
        showCancel: false
      })
    } finally {
      this.setData({ sharingImage: false })
    }
  }
})
