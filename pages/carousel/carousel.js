Page({
  data: {
    current: 0,
    saving: false,
    slides: [
      {
        title: '你知道如果明天失业，你的家庭能撑多久吗？',
        sub: '我们用银行级的流动性压力测试，帮你算出安全垫。',
        icon: '⏳💵'
      },
      {
        title: '你的负债，正在以多快的速度吞噬你的未来？',
        sub: '自动算出最优偿还顺序，让你少还数万元利息。',
        icon: '📈🔴'
      },
      {
        title: '你最大的资产，可能一直被忽视',
        sub: '评估技能保值度，规划转行路线。',
        icon: '🧑✨'
      },
      {
        title: '像银行一样，管理你的人生资产负债表',
        sub: '记账、分析、优化，看清每一分钱的流向。',
        icon: '🧭'
      },
      {
        title: '立即开始你的财务体检',
        sub: '只需要回答几个问题，获得专业报告。完全免费。',
        icon: '🚀'
      }
    ]
  },

  onLoad() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
    }
  },

  onSwiperChange(e) {
    this.setData({ current: e.detail.current || 0 })
  },

  async markSeenAndGo() {
    if (this.data.saving) return
    this.setData({ saving: true })

    try {
      const r = await wx.cloud.callFunction({
        name: 'updateUserCarouselStatus',
        data: {}
      })
      const body = r.result || {}
      if (!body.success) {
        throw new Error(body.message || '更新状态失败')
      }
    } catch (err) {
      console.error('mark carousel seen failed', err)
      try {
        const openId = wx.getStorageSync('openId')
        if (openId) {
          await wx.cloud.database().collection('users').where({ openId }).update({
            data: { hasSeenCarousel: true }
          })
        }
      } catch (e2) {
        console.error('fallback update failed', e2)
      }
    } finally {
      this.setData({ saving: false })
    }

    wx.reLaunch({ url: '/pages/assessment/assessment' })
  },

  onSkip() {
    this.markSeenAndGo()
  },

  onStart() {
    this.markSeenAndGo()
  }
})
