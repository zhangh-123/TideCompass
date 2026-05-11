const { getHomePath } = require('../../utils/route.js')
const { EXPENSE_CATEGORIES } = require('../../utils/expenseCategories.js')

function isAllowedFile(name) {
  const lower = String(name || '').toLowerCase()
  return lower.endsWith('.csv') || lower.endsWith('.xlsx')
}

Page({
  data: {
    uploadItems: [],
    parsing: false,
    parsingFileID: '',
    parseStatusText: '',
    resultKind: '',
    parsedTransactions: [],
    parsedAssets: [],
    importing: false
  },

  async onShow() {
    await this.guard()
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
      if (!allowSub) wx.reLaunch({ url: target })
    } catch (e) {
      console.error(e)
    }
  },

  pushUploadItem(item) {
    const list = this.data.uploadItems.slice()
    list.unshift(item)
    this.setData({ uploadItems: list })
  },

  async uploadTempFile(tempFilePath, fileName) {
    wx.showLoading({ title: '上传中', mask: true })
    try {
      const ext = fileName.split('.').pop() || 'dat'
      const cloudPath = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const res = await wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath })
      wx.hideLoading()
      this.pushUploadItem({ fileID: res.fileID, fileName })
      wx.showToast({ title: '上传成功', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.errMsg || '上传失败', icon: 'none' })
    }
  },

  chooseImage() {
    wx.chooseImage({
      count: 9,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const files = res.tempFiles || []
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          await this.uploadTempFile(f.path, f.name || `image_${Date.now()}.jpg`)
        }
      }
    })
  },

  chooseFile() {
    wx.chooseMessageFile({
      count: 5,
      type: 'file',
      extension: ['csv', 'xlsx'],
      success: async (res) => {
        const files = res.tempFiles || []
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          if (!isAllowedFile(f.name)) {
            wx.showToast({ title: `仅支持 csv/xlsx：${f.name}`, icon: 'none' })
            continue
          }
          await this.uploadTempFile(f.path, f.name)
        }
      }
    })
  },

  async startParse(e) {
    const fileID = e.currentTarget.dataset.fileid
    const fileName = e.currentTarget.dataset.filename
    if (!fileID || this.data.parsing) return

    this.setData({ parsing: true, parsingFileID: fileID, parseStatusText: '正在解析，请稍候…' })
    try {
      const res = await wx.cloud.callFunction({
        name: 'parseFile',
        data: { fileID, fileName }
      })
      const r = res.result || {}
      if (!r.success) {
        this.setData({ parseStatusText: r.message || '解析失败' })
        return
      }
      const parsed = r.parsedResult || {}
      if (parsed.kind === 'assets') {
        this.setData({
          resultKind: 'assets',
          parsedAssets: (parsed.assets || []).map((x) => ({ ...x, checked: true })),
          parsedTransactions: [],
          parseStatusText: `解析完成：识别 ${parsed.assets ? parsed.assets.length : 0} 条资产项`
        })
      } else {
        this.setData({
          resultKind: 'transactions',
          parsedTransactions: (parsed.transactions || []).map((x) => ({ ...x, checked: true })),
          parsedAssets: [],
          parseStatusText: `解析完成：识别 ${parsed.transactions ? parsed.transactions.length : 0} 条交易记录`
        })
      }
    } catch (e2) {
      this.setData({ parseStatusText: e2.errMsg || '解析失败' })
    } finally {
      this.setData({ parsing: false, parsingFileID: '' })
    }
  },

  toggleItem(e) {
    const kind = e.currentTarget.dataset.kind
    const idx = Number(e.currentTarget.dataset.index)
    if (kind === 'transactions') {
      const list = this.data.parsedTransactions.slice()
      if (!list[idx]) return
      list[idx].checked = !list[idx].checked
      this.setData({ parsedTransactions: list })
      return
    }
    const assets = this.data.parsedAssets.slice()
    if (!assets[idx]) return
    assets[idx].checked = !assets[idx].checked
    this.setData({ parsedAssets: assets })
  },

  async importTransactions() {
    const selected = this.data.parsedTransactions.filter((x) => x.checked)
    if (!selected.length) {
      wx.showToast({ title: '请先勾选记录', icon: 'none' })
      return
    }

    this.setData({ importing: true })
    let ok = 0
    let fail = 0
    try {
      for (let i = 0; i < selected.length; i++) {
        const t = selected[i]
        const cat = t.type === 'expense' && EXPENSE_CATEGORIES.includes(t.category) ? t.category : '其他'
        const res = await wx.cloud.callFunction({
          name: 'addTransaction',
          data: {
            date: t.date,
            type: t.type === 'income' ? 'income' : 'expense',
            category: cat,
            amount: Number(t.amount) || 0,
            note: t.description || '文件解析导入'
          }
        })
        if (res.result && res.result.success) ok += 1
        else fail += 1
      }
      wx.showToast({ title: `导入完成 成功${ok} 失败${fail}`, icon: 'none' })
    } catch (e) {
      wx.showToast({ title: `导入中断：${e.errMsg || '错误'}`, icon: 'none' })
    } finally {
      this.setData({ importing: false })
    }
  },

  async importAssets() {
    const selected = this.data.parsedAssets.filter((x) => x.checked)
    if (!selected.length) {
      wx.showToast({ title: '请先勾选资产项', icon: 'none' })
      return
    }

    this.setData({ importing: true })
    let ok = 0
    let fail = 0
    try {
      for (let i = 0; i < selected.length; i++) {
        const a = selected[i]
        const res = await wx.cloud.callFunction({
          name: 'updateBalanceSnapshot',
          data: {
            op: 'addAsset',
            name: a.name,
            value: Number(a.value) || 0
          }
        })
        if (res.result && res.result.success) ok += 1
        else fail += 1
      }
      wx.showToast({ title: `导入完成 成功${ok} 失败${fail}`, icon: 'none' })
    } catch (e) {
      wx.showToast({ title: `导入中断：${e.errMsg || '错误'}`, icon: 'none' })
    } finally {
      this.setData({ importing: false })
    }
  }
})
