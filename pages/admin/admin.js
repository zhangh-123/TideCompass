const { isAdminPhone } = require('../../utils/admin.js')

function maskOpenId(oid) {
  const s = String(oid || '')
  if (s.length <= 8) return s || '—'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

function fmtTime(ts) {
  const n = Number(ts)
  if (!n) return '—'
  const d = new Date(n)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

Page({
  data: {
    loading: true,
    users: [],
    emptyText: ''
  },

  async onLoad() {
    await this.guardAndLoad()
  },

  async onPullDownRefresh() {
    await this.loadUsers()
    wx.stopPullDownRefresh()
  },

  async guardAndLoad() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }

    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).limit(1).get()
      const row = data && data[0]
      if (!row || !isAdminPhone(row.phone)) {
        wx.showToast({ title: '无管理员权限', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
        return
      }
      await this.loadUsers()
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '校验失败', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
    }
  },

  async loadUsers() {
    this.setData({ loading: true, emptyText: '' })
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminUsers',
        data: { action: 'listUsers' }
      })
      const body = res.result || {}
      if (!body.success) {
        wx.showToast({ title: body.message || '加载失败', icon: 'none' })
        this.setData({
          loading: false,
          users: [],
          emptyText: body.message || '加载失败'
        })
        return
      }
      const raw = body.list || []
      const users = raw.map((u) => ({
        ...u,
        openIdShort: maskOpenId(u.openId),
        phoneDisplay: u.phone || '未绑定手机',
        createdDisplay: fmtTime(u.createdAt),
        isProtectedAdmin: isAdminPhone(u.phone)
      }))
      this.setData({
        loading: false,
        users,
        emptyText: users.length === 0 ? '暂无用户' : ''
      })
    } catch (e) {
      console.error(e)
      this.setData({
        loading: false,
        users: [],
        emptyText: '网络异常'
      })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  onDeleteTap(e) {
    const id = e.currentTarget.dataset.id
    const phone = e.currentTarget.dataset.phone || ''
    if (!id) return

    wx.showModal({
      title: '确认删除用户',
      content: phone
        ? `将永久删除该用户（手机尾号 ${String(phone).slice(-4)}）及其全部数据：流水、资产负债快照、体检报告、预算、模拟方案、上传解析记录、订单记录等，不可恢复。`
        : '将永久删除该用户及其全部业务数据，不可恢复。',
      confirmColor: '#dc2626',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '清除数据中…', mask: true })
        try {
          const delRes = await wx.cloud.callFunction({
            name: 'adminUsers',
            data: { action: 'deleteUser', userId: id }
          })
          const body = delRes.result || {}
          wx.hideLoading()
          if (!body.success) {
            wx.showToast({ title: body.message || '删除失败', icon: 'none' })
            return
          }
          wx.showToast({ title: '已删除', icon: 'success' })
          await this.loadUsers()
        } catch (err) {
          wx.hideLoading()
          console.error(err)
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  }
})
