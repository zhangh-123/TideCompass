const PHONE_REG = /^1\d{10}$/
const { getHomePath } = require('../../utils/route.js')

Page({
  data: {
    phone: '',
    code: '',
    countdown: 0,
    sendingCode: false,
    binding: false,
    phoneFocus: false,
    codeFocus: false,
    phoneError: '',
    codeError: '',
    canBind: false
  },

  timer: null,

  onLoad() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.refreshBindState()
  },

  async onShow() {
    const openId = wx.getStorageSync('openId')
    if (!openId) return
    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).get()
      const row = data && data[0]
      if (row && row.phone) {
        wx.reLaunch({ url: getHomePath(row) })
      }
    } catch (e) {
      console.error(e)
    }
  },

  onUnload() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  refreshBindState() {
    const phone = (this.data.phone || '').trim()
    const code = (this.data.code || '').trim()
    let phoneError = ''
    let codeError = ''
    if (phone.length > 0 && !PHONE_REG.test(phone)) {
      phoneError = '请输入正确的11位手机号'
    }
    if (code.length > 0 && code.length < 6) {
      codeError = '请输入6位数字验证码'
    } else if (code.length === 6 && !/^\d{6}$/.test(code)) {
      codeError = '验证码须为6位数字'
    }
    const canBind = PHONE_REG.test(phone) && /^\d{6}$/.test(code)
    this.setData({ phoneError, codeError, canBind })
  },

  onPhoneFocus() {
    this.setData({ phoneFocus: true })
  },

  onPhoneBlur() {
    this.setData({ phoneFocus: false })
    this.refreshBindState()
  },

  onCodeFocus() {
    this.setData({ codeFocus: true })
  },

  onCodeBlur() {
    this.setData({ codeFocus: false })
    this.refreshBindState()
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value })
    this.refreshBindState()
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value })
    this.refreshBindState()
  },

  startCountdown() {
    if (this.timer) clearInterval(this.timer)
    this.setData({ countdown: 60 })
    this.timer = setInterval(() => {
      const next = this.data.countdown - 1
      if (next <= 0) {
        clearInterval(this.timer)
        this.timer = null
        this.setData({ countdown: 0 })
        return
      }
      this.setData({ countdown: next })
    }, 1000)
  },

  async onSendCode() {
    const phone = (this.data.phone || '').trim()
    if (!PHONE_REG.test(phone)) {
      wx.showToast({ title: '请输入11位手机号', icon: 'none' })
      return
    }
    if (this.data.countdown > 0 || this.data.sendingCode) return

    this.setData({ sendingCode: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'sendSmsCode',
        data: { phone }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({
          title: r.message || '发送失败',
          icon: 'none'
        })
        return
      }
      wx.showToast({ title: '验证码已发送', icon: 'success' })
      this.startCountdown()
    } catch (err) {
      console.error(err)
      wx.showToast({
        title: err.errMsg || '发送失败',
        icon: 'none'
      })
    } finally {
      this.setData({ sendingCode: false })
    }
  },

  async onConfirmBind() {
    if (!this.data.canBind || this.data.binding) return
    const phone = (this.data.phone || '').trim()
    const code = (this.data.code || '').trim()
    if (!PHONE_REG.test(phone)) {
      wx.showToast({ title: '请输入正确手机号', icon: 'none' })
      return
    }
    if (!/^\d{6}$/.test(code)) {
      wx.showToast({ title: '请输入6位验证码', icon: 'none' })
      return
    }
    if (this.data.binding) return

    this.setData({ binding: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'bindPhone',
        data: { phone, code }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({
          title: r.message || '绑定失败',
          icon: 'none',
          duration: 2500
        })
        return
      }
      wx.showToast({ title: '绑定成功', icon: 'success' })
      const openId = wx.getStorageSync('openId')
      const db = wx.cloud.database()
      const { data: rows } = await db.collection('users').where({ openId }).get()
      const user = rows && rows[0]
      wx.reLaunch({ url: getHomePath(user || {}) })
    } catch (err) {
      console.error(err)
      wx.showToast({
        title: err.errMsg || '绑定失败',
        icon: 'none'
      })
    } finally {
      this.setData({ binding: false })
    }
  }
})
