const { drawReportCard } = require('../../utils/shareImage.js')

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function mdToHtml(md) {
  let t = esc(md || '')
  t = t.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
  t = t.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
  t = t.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
  t = t.replace(/^\-\s+(.+)$/gm, '<li>$1</li>')
  t = t.replace(/(<li>[\s\S]*<\/li>)/g, (m) => `<ul>${m}</ul>`)
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  t = t.replace(/\n\n/g, '</p><p>')
  t = `<p>${t}</p>`
  return t
}

Page({
  data: {
    isVip: false,
    simulationId: '',
    planName: '',
    summary: {
      unemploymentMonths: 0,
      expenseReducePct: 0,
      newMonthlyIncome: 0
    },
    generating: false,
    reportText: '',
    reportHtml: '',
    usedFallback: false,
    sharingImage: false
  },

  onShareAppMessage() {
    return {
      title: `${this.data.planName || '模拟方案'} - AI诊断报告`,
      path: `/pages/ai_report/ai_report?simulationId=${this.data.simulationId}`
    }
  },

  async onLoad(query) {
    const simulationId = query.simulationId || ''
    this.setData({ simulationId })
    await this.loadData()
  },

  goVip() {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  async loadData() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    try {
      const db = wx.cloud.database()
      const [uRes, simRes] = await Promise.all([
        db.collection('users').where({ openId }).limit(1).get(),
        db.collection('simulations').doc(this.data.simulationId).get()
      ])
      const user = uRes.data && uRes.data[0]
      const isVip = !!(user && user.isVip && Number(user.vipExpireAt) > Date.now())
      if (!isVip) {
        this.setData({ isVip: false })
        return
      }
      const sim = simRes.data
      if (!sim || sim.openId !== openId) {
        wx.showToast({ title: '方案不存在', icon: 'none' })
        return
      }
      const p = sim.params || {}
      const txt = sim.reportText || ''
      this.setData({
        isVip: true,
        planName: sim.name || '未命名方案',
        summary: {
          unemploymentMonths: Number(p.unemploymentMonths) || 0,
          expenseReducePct: Number(p.expenseReducePct) || 0,
          newMonthlyIncome: Number(p.newMonthlyIncome) || 0
        },
        reportText: txt,
        reportHtml: txt ? mdToHtml(txt) : ''
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '读取失败', icon: 'none' })
    }
  },

  async onGenerate() {
    if (this.data.generating) return
    this.setData({ generating: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'generateAIReport',
        data: { simulationId: this.data.simulationId }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({ title: r.message || '生成失败', icon: 'none' })
        return
      }
      const txt = r.reportText || ''
      this.setData({
        reportText: txt,
        reportHtml: mdToHtml(txt),
        usedFallback: !!r.usedFallback
      })
      wx.showToast({ title: '报告已生成', icon: 'success' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e.errMsg || '生成失败', icon: 'none' })
    } finally {
      this.setData({ generating: false })
    }
  },

  onCopy() {
    if (!this.data.reportText) return
    wx.setClipboardData({ data: this.data.reportText })
  },

  onSaveLocal() {
    if (!this.data.reportText) return
    const key = `aiReport_${this.data.simulationId}`
    try {
      wx.setStorageSync(key, {
        simulationId: this.data.simulationId,
        planName: this.data.planName,
        reportText: this.data.reportText,
        savedAt: Date.now()
      })
      wx.showToast({ title: '已保存到本地', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  async onShareReportImage() {
    if (this.data.sharingImage) return
    this.setData({ sharingImage: true })
    try {
      const lines = String(this.data.reportText || '').split('\n').filter(Boolean)
      const summary = lines.find((x) => !/^#/.test(x)) || 'AI建议已生成，请查看完整内容。'
      const file = await drawReportCard(
        this,
        'share-ai-canvas',
        {
          planName: this.data.planName,
          delta: `${this.data.summary.newMonthlyIncome || 0} 元（月收入假设）`,
          summary
        },
        'AI报告'
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
