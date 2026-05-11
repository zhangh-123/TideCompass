const { getHomePath } = require('./utils/route.js')

const echartsModule = require('./libs/echarts.min.js')

App({
  globalData: {
    echartsLib: echartsModule.default || echartsModule
  },

  onLaunch() {
    wx.cloud.init({
      env: 'cloud1-d6gjif92ta11597a6',
      traceUser: true
    })
    this.syncRouteToUserState()
  },

  syncRouteToUserState() {
    const openId = wx.getStorageSync('openId')
    if (!openId) return

    const pages = getCurrentPages()
    const currentRoute = pages && pages.length ? `/${pages[pages.length - 1].route}` : ''

    wx.cloud
      .database()
      .collection('users')
      .where({ openId })
      .get()
      .then((res) => {
        const user = res.data && res.data[0]
        if (!user) return
        const url = getHomePath(user)
        if (url === currentRoute) return
        wx.reLaunch({ url })
      })
      .catch((e) => console.error('syncRouteToUserState', e))
  }
})
