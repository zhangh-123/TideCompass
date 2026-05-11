const { computeNetWorthTrend } = require('../../utils/netWorthTrend.js')
const { toChineseMoneyUpper } = require('../../utils/chineseMoney.js')

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

function lineValue(item) {
  if (!item || typeof item !== 'object') return 0
  const v = Number(item.value) || 0
  if (
    Object.prototype.hasOwnProperty.call(item, 'name') &&
    item.name != null &&
    item.name !== ''
  ) {
    return v
  }
  const c = Number(item.count) || 1
  return v * c
}

function normalizeRow(item) {
  const name = String(item.name || item.type || '项目').trim() || '项目'
  return {
    name,
    value: lineValue(item),
    valueFmt: fmtMoney(lineValue(item))
  }
}

function computeNwFromSnap(snap) {
  if (!snap) return 0
  if (typeof snap.netWorth === 'number') return snap.netWorth
  const ta =
    typeof snap.totalAssets === 'number'
      ? snap.totalAssets
      : (snap.assets || []).reduce((s, i) => s + lineValue(i), 0)
  const tl =
    typeof snap.totalLiabilities === 'number'
      ? snap.totalLiabilities
      : (snap.liabilities || []).reduce((s, i) => s + lineValue(i), 0)
  return ta - tl
}

Page({
  data: {
    echartsLib: ECHARTS_LIB,
    ec: { lazyLoad: true },
    totalAssetsFmt: '0',
    totalLiabilitiesFmt: '0',
    netWorthFmt: '0',
    totalAssetsCn: '零圆整',
    totalLiabilitiesCn: '零圆整',
    netWorthCn: '零圆整',
    assets: [],
    liabilities: [],
    dialogVisible: false,
    dialogTitle: '',
    dialogName: '',
    dialogAmount: '',
    importing: false,
    _dialogOp: '',
    _dialogIndex: -1
  },

  _lineChart: null,
  _trendPayload: null,

  noop() {},

  onLoad() {
    this._echarts = ECHARTS_LIB || this.data.echartsLib
  },

  async onShow() {
    await this.refreshAll()
  },

  onUnload() {
    if (this._lineChart) {
      try {
        this._lineChart.dispose()
      } catch (e) {}
      this._lineChart = null
    }
  },

  applySnapshot(snap) {
    const rawA = (snap && snap.assets) || []
    const rawL = (snap && snap.liabilities) || []
    const assets = rawA.map(normalizeRow)
    const liabilities = rawL.map(normalizeRow)

    let ta =
      snap && typeof snap.totalAssets === 'number'
        ? snap.totalAssets
        : assets.reduce((s, x) => s + x.value, 0)
    let tl =
      snap && typeof snap.totalLiabilities === 'number'
        ? snap.totalLiabilities
        : liabilities.reduce((s, x) => s + x.value, 0)
    const nw =
      snap && typeof snap.netWorth === 'number' ? snap.netWorth : ta - tl

    this.setData({
      totalAssetsFmt: fmtMoney(ta),
      totalLiabilitiesFmt: fmtMoney(tl),
      netWorthFmt: fmtMoney(nw),
      totalAssetsCn: toChineseMoneyUpper(ta),
      totalLiabilitiesCn: toChineseMoneyUpper(tl),
      netWorthCn: toChineseMoneyUpper(nw),
      assets,
      liabilities
    })
  },

  async refreshAll() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }

    try {
      const db = wx.cloud.database()
      const MAX = 500
      const [snapRes, txRes] = await Promise.all([
        db.collection('balance_snapshot').where({ openId }).limit(1).get(),
        db
          .collection('transactions')
          .where({ openId })
          .orderBy('createdAt', 'desc')
          .limit(MAX)
          .get()
      ])

      const snap = snapRes.data && snapRes.data[0]
      if (!snap) {
        this.applySnapshot({
          assets: [],
          liabilities: [],
          totalAssets: 0,
          totalLiabilities: 0,
          netWorth: 0
        })
      } else {
        this.applySnapshot(snap)
      }

      const txs = (txRes.data || []).slice().reverse()
      const nw = computeNwFromSnap(snap)

      const trend = computeNetWorthTrend(nw, txs)
      this._trendPayload = trend
      wx.nextTick(() => {
        setTimeout(() => this.initTrendChart(trend), 120)
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  buildLineOption(trend) {
    const labels = (trend && trend.labels) || []
    const values = (trend && trend.values) || []
    return {
      color: ['#2563eb'],
      grid: { left: 48, right: 16, top: 28, bottom: 36 },
      tooltip: {
        trigger: 'axis'
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLabel: { fontSize: 10, color: '#64748b' }
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#64748b' },
        splitLine: { lineStyle: { color: '#f1f5f9' } }
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          data: values,
          areaStyle: { opacity: 0.08 }
        }
      ]
    }
  },

  initTrendChart(trend) {
    const comp = this.selectComponent('#balance-trend')
    if (!comp) return

    const ec = this._echarts
    if (!ec || typeof ec.init !== 'function') {
      console.error('ECharts 未正确加载')
      return
    }

    if (this._lineChart) {
      try {
        this._lineChart.dispose()
      } catch (e) {}
      this._lineChart = null
    }

    const opt = this.buildLineOption(trend || this._trendPayload || { labels: [], values: [] })

    comp.init((canvas, width, height, dpr) => {
      const w = width || 300
      const h = height || 220
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
      this._lineChart = chart
      return chart
    })
  },

  async callUpdate(payload) {
    try {
      wx.showLoading({ title: '保存中', mask: true })
      const res = await wx.cloud.callFunction({
        name: 'updateBalanceSnapshot',
        data: payload
      })
      wx.hideLoading()
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' })
        return false
      }
      this.applySnapshot({
        assets: r.assets,
        liabilities: r.liabilities,
        totalAssets: r.totalAssets,
        totalLiabilities: r.totalLiabilities,
        netWorth: r.netWorth
      })

      const db = wx.cloud.database()
      const openId = wx.getStorageSync('openId')
      const txRes = await db
        .collection('transactions')
        .where({ openId })
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get()
      const txs = (txRes.data || []).slice().reverse()
      const trend = computeNetWorthTrend(r.netWorth, txs)
      this._trendPayload = trend
      if (this._lineChart) {
        try {
          this._lineChart.setOption(this.buildLineOption(trend), true)
        } catch (e) {
          this.initTrendChart(trend)
        }
      } else {
        this.initTrendChart(trend)
      }
      return true
    } catch (err) {
      wx.hideLoading()
      console.error(err)
      wx.showToast({
        title: (err && err.errMsg) || '调用失败',
        icon: 'none'
      })
      return false
    }
  },

  openAddAsset() {
    this.setData({
      dialogVisible: true,
      dialogTitle: '添加资产',
      dialogName: '',
      dialogAmount: '',
      _dialogOp: 'addAsset',
      _dialogIndex: -1
    })
  },

  openAddLiability() {
    this.setData({
      dialogVisible: true,
      dialogTitle: '添加负债',
      dialogName: '',
      dialogAmount: '',
      _dialogOp: 'addLiability',
      _dialogIndex: -1
    })
  },

  onEdit(e) {
    const kind = e.currentTarget.dataset.kind
    const index = Number(e.currentTarget.dataset.index)
    const row =
      kind === 'asset' ? this.data.assets[index] : this.data.liabilities[index]
    if (!row) return

    const op = kind === 'asset' ? 'updateAsset' : 'updateLiability'
    this.setData({
      dialogVisible: true,
      dialogTitle: kind === 'asset' ? '编辑资产' : '编辑负债',
      dialogName: row.name,
      dialogAmount: String(row.value),
      _dialogOp: op,
      _dialogIndex: index
    })
  },

  onDelete(e) {
    const kind = e.currentTarget.dataset.kind
    const index = Number(e.currentTarget.dataset.index)
    const row =
      kind === 'asset' ? this.data.assets[index] : this.data.liabilities[index]
    if (!row) return

    wx.showModal({
      title: '确认删除',
      content: `删除「${row.name}」？`,
      success: (res) => {
        if (!res.confirm) return
        const op = kind === 'asset' ? 'deleteAsset' : 'deleteLiability'
        this.callUpdate({ op, index })
      }
    })
  },

  closeDialog() {
    this.setData({ dialogVisible: false })
  },

  onNameInput(e) {
    this.setData({ dialogName: e.detail.value })
  },

  onAmountInput(e) {
    this.setData({ dialogAmount: e.detail.value })
  },

  async confirmDialog() {
    const name = (this.data.dialogName || '').trim()
    const amountNum = Number(this.data.dialogAmount)
    if (!name) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    if (Number.isNaN(amountNum) || amountNum < 0) {
      wx.showToast({ title: '金额无效', icon: 'none' })
      return
    }

    const op = this.data._dialogOp
    const idx = this.data._dialogIndex
    let payload = { op }

    if (op === 'addAsset' || op === 'addLiability') {
      payload.name = name
      payload.value = amountNum
    } else if (op === 'updateAsset' || op === 'updateLiability') {
      payload.index = idx
      payload.name = name
      payload.value = amountNum
    } else {
      return
    }

    const ok = await this.callUpdate(payload)
    if (ok) {
      this.closeDialog()
    }
  },

  async importFromReport() {
    if (this.data.importing) return
    this.setData({ importing: true })
    try {
      const ok = await this.callUpdate({ op: 'importFromReport' })
      if (ok) {
        wx.showToast({ title: '已合并导入', icon: 'success' })
      }
    } finally {
      this.setData({ importing: false })
    }
  }
})
