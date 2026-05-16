const { getHomePath } = require('../../utils/route.js')
const { clearAssessmentCaches } = require('../../utils/session.js')

/** 微信端 callFunction 默认超时偏短，冷启动时易报 Error: timeout；与云函数 config 上限对齐 */
const CLOUD_FUNCTION_CLIENT_MS = 60000

Page({
  data: {
    logging: false
  },

  async onWechatLogin() {
    if (this.data.logging) return
    this.setData({ logging: true })

    try {
      await new Promise((resolve, reject) => {
        wx.login({
          success: resolve,
          fail: reject
        })
      })

      const res = await wx.cloud.callFunction({
        name: 'getOpenId',
        config: { timeout: CLOUD_FUNCTION_CLIENT_MS }
      })

      const openId = res.result && res.result.openId
      if (!openId) {
        throw new Error('未获取到 openId')
      }

      const db = wx.cloud.database()
      const users = db.collection('users')
      const previousOpenId = wx.getStorageSync('openId') || ''
      const { data: existing } = await users.where({ openId }).limit(1).get()

      if (!existing || existing.length === 0) {
        await users.add({
          data: {
            openId,
            createdAt: Date.now(),
            isFirstAssessmentDone: false,
            hasSeenCarousel: false
          }
        })
        // 账号被管理员删除后重建时，清理本地旧体检缓存，避免旧对话“穿越”回来。
        clearAssessmentCaches(openId)
      }

      if (previousOpenId && previousOpenId !== openId) {
        clearAssessmentCaches(previousOpenId)
      }

      wx.setStorageSync('openId', openId)

      const { data: userRows } = await users.where({ openId }).limit(1).get()
      const record = userRows && userRows[0]
      const nextUrl = getHomePath(record)

      wx.reLaunch({
        url: nextUrl
      })
    } catch (err) {
      console.error('登录失败', err)
      const raw = String((err && (err.errMsg || err.message)) || '')
      const isTimeout = /timeout|超时/i.test(raw)
      wx.showToast({
        title: isTimeout ? '登录请求超时，请检查网络后重试' : raw || '登录失败',
        icon: 'none',
        duration: 2500
      })
    } finally {
      this.setData({ logging: false })
    }
  },

  onUserAgreement() {
    wx.showModal({
      title: '用户协议',
      content: '请查阅本产品公示的最新版《用户协议》全文；正式上线版本中将替换为完整正文链接。',
      showCancel: false,
      confirmText: '我知道了'
    })
  },

  onPrivacyPolicy() {
    wx.showModal({
      title: '隐私政策',
      content: '请查阅本产品公示的最新版《隐私政策》全文；正式上线版本中将替换为完整正文链接。',
      showCancel: false,
      confirmText: '我知道了'
    })
  }
})
