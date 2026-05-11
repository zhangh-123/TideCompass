const { getHomePath } = require('../../utils/route.js')
const { parseTransaction } = require('../../utils/parseTransaction.js')

function todayStr() {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

Page({
  msgSeq: 0,

  data: {
    messages: [],
    draft: '',
    scrollIntoView: '',
    sending: false
  },

  pendingParsed: null,

  onLoad() {
    this.pushAssistant(
      '用一句话描述一笔收支即可，例如：「打车花了35」「今天发工资12000」。我会按规则解析金额与类别。'
    )
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
      if (!allowSub) {
        wx.reLaunch({ url: target })
      }
    } catch (e) {
      console.error(e)
    }
  },

  pushMessage(role, content) {
    const id = ++this.msgSeq
    const messages = this.data.messages.concat({ id, role, content })
    this.setData({
      messages,
      scrollIntoView: `msg-${id}`
    })
  },

  pushAssistant(text) {
    this.pushMessage('assistant', text)
  },

  pushUser(text) {
    this.pushMessage('user', text)
  },

  onDraftInput(e) {
    this.setData({ draft: e.detail.value })
  },

  onSend() {
    if (this.data.sending) return
    const text = (this.data.draft || '').trim()
    if (!text) {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }

    this.pushUser(text)
    this.setData({ draft: '' })

    const parsed = parseTransaction(text)
    if (!parsed.success) {
      this.pushAssistant(
        parsed.message ||
          '未能识别金额或类别，请重新输入，例如‘打车花了35元’'
      )
      return
    }

    const { type, category, amount, note } = parsed.data
    this.pendingParsed = parsed.data

    const typeLabel = type === 'income' ? '收入' : '支出'
    wx.showModal({
      title: '确认记账',
      content: `类型：${typeLabel}\n类别：${category}\n金额：${amount} 元\n备注：${note || '（空）'}`,
      confirmText: '确认保存',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) {
          this.pushAssistant('已取消，可重新输入。')
          this.pendingParsed = null
          return
        }
        this.saveTransaction(parsed.data)
      }
    })
  },

  async saveTransaction(data) {
    this.setData({ sending: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'addTransaction',
        data: {
          date: todayStr(),
          type: data.type,
          category: data.category,
          amount: data.amount,
          note: data.note || ''
        }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({
          title: r.message || '保存失败',
          icon: 'none'
        })
        this.pushAssistant(`保存失败：${r.message || '请稍后重试'}`)
        return
      }
      wx.showToast({ title: '已记账', icon: 'success' })
      this.pushAssistant('已记入流水并更新了现金余额。你还可以继续输入下一笔。')
    } catch (err) {
      console.error(err)
      wx.showToast({
        title: err.errMsg || '保存失败',
        icon: 'none'
      })
      this.pushAssistant('保存失败，请检查网络或云函数是否已部署。')
    } finally {
      this.setData({ sending: false })
      this.pendingParsed = null
    }
  }
})
