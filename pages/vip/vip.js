const { getHomePath } = require('../../utils/route.js')

function fmtDate(ts) {
  const d = new Date(Number(ts) || 0)
  if (!ts || Number.isNaN(d.getTime())) return '-'
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function showModalAsync(options) {
  return new Promise((resolve) => {
    wx.showModal(
      Object.assign({}, options, {
        success: (res) => resolve(res),
        fail: () => resolve({ confirm: false, cancel: true })
      })
    )
  })
}

function requestPaymentAsync(params) {
  return new Promise((resolve, reject) => {
    wx.requestPayment(
      Object.assign({}, params, {
        success: (res) => resolve(res),
        fail: (err) => reject(err)
      })
    )
  })
}

Page({
  data: {
    vipLoaded: false,
    isVip: false,
    remainDays: 0,
    vipExpireDate: '-',
    monthlyPrice: '19.00',
    yearlyPrice: '199.00',
    paying: false,
    currentPlan: ''
  },

  async onShow() {
    await this.guard()
    await this.loadVipStatus()
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

  async loadVipStatus() {
    try {
      const res = await wx.cloud.callFunction({ name: 'checkVipStatus', data: {} })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '读取会员状态失败', icon: 'none' })
        return
      }
      this.setData({
        vipLoaded: true,
        isVip: !!r.isVip,
        remainDays: Number(r.remainDays) || 0,
        vipExpireDate: fmtDate(r.vipExpireAt)
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e.errMsg || '读取失败', icon: 'none' })
    }
  },

  buyMonthly() {
    this.createAndPay('monthly')
  },

  buyYearly() {
    this.createAndPay('yearly')
  },

  async createAndPay(planType) {
    if (this.data.paying) return
    this.setData({ paying: true, currentPlan: planType })
    try {
      const orderRes = await wx.cloud.callFunction({
        name: 'createOrder',
        data: { planType }
      })
      const order = orderRes.result || {}
      if (!order.success) {
        wx.showToast({ title: order.message || '创建订单失败', icon: 'none' })
        return
      }

      if (order.mock) {
        const m = await showModalAsync({
          title: '模拟支付',
          content: '当前为测试模式，点击确认模拟支付成功。'
        })
        if (!m.confirm) return
        const cb = await wx.cloud.callFunction({
          name: 'vipCallback',
          data: {
            orderId: order.orderId,
            orderNo: order.orderNo,
            payResult: 'success'
          }
        })
        const cr = cb.result || {}
        if (!cr.success) {
          wx.showToast({ title: cr.message || '回调处理失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '开通成功', icon: 'success' })
        await this.loadVipStatus()
        return
      }

      const pp = order.paymentParams || {}
      try {
        const payRes = await requestPaymentAsync({
          timeStamp: pp.timeStamp,
          nonceStr: pp.nonceStr,
          package: pp.package,
          signType: pp.signType || 'MD5',
          paySign: pp.paySign
        })

        const cb = await wx.cloud.callFunction({
          name: 'vipCallback',
          data: {
            orderId: order.orderId,
            orderNo: order.orderNo,
            payResult: 'success',
            transactionId: payRes.transaction_id || ''
          }
        })
        const cr = cb.result || {}
        if (!cr.success) {
          wx.showToast({ title: cr.message || '支付后处理失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '开通成功', icon: 'success' })
        await this.loadVipStatus()
      } catch (err) {
        console.error(err)
        await wx.cloud.callFunction({
          name: 'vipCallback',
          data: {
            orderId: order.orderId,
            orderNo: order.orderNo,
            payResult: 'failed',
            failReason: err.errMsg || 'requestPayment_failed'
          }
        })
        wx.showToast({ title: '支付未完成', icon: 'none' })
      }
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e.errMsg || '支付流程失败', icon: 'none' })
    } finally {
      this.setData({ paying: false, currentPlan: '' })
    }
  }
})
