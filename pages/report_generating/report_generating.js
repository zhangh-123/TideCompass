Page({
  data: {
    hint: '准备跳转报告页…'
  },

  async onLoad() {
    const openId = wx.getStorageSync('openId') || ''
    const messages =
      wx.getStorageSync(`assessment_dialog:${openId}`) || wx.getStorageSync('assessment_dialog') || []
    try {
      this.setData({ hint: '正在提取关键时间事件…' })
      await wx.cloud.callFunction({
        name: 'extractTimeEvents',
        data: { messages }
      })
    } catch (e) {
      console.warn('extractTimeEvents not available or failed', e)
    }

    this.setData({ hint: '即将打开报告…' })
    setTimeout(() => {
      wx.redirectTo({ url: '/pages/report/report' })
    }, 600)
  }
})
