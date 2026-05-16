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

    /**
     * onLaunch 首帧 getCurrentPages() 常为空，currentRoute 会被当成 ''。
     * 若此时误判「与目标页不一致」而二次 wx.reLaunch，会与登录/首屏数据库请求并发，易触发 Error: timeout。
     */
    let attempts = 0
    const maxAttempts = 40

    const run = () => {
      attempts += 1
      const pages = getCurrentPages()
      if (!pages || !pages.length) {
        if (attempts < maxAttempts) {
          setTimeout(run, 50)
        }
        return
      }

      const currentRoute = `/${pages[pages.length - 1].route}`

      wx.cloud
        .database()
        .collection('users')
        .where({ openId })
        .limit(1)
        .get()
        .then((res) => {
          const user = res.data && res.data[0]
          if (!user) return
          const url = getHomePath(user)
          if (!url || url === '/pages/login/login') return
          const pagesNow = getCurrentPages()
          if (!pagesNow || !pagesNow.length) return
          const routeNow = `/${pagesNow[pagesNow.length - 1].route}`
          if (url === routeNow) return
          wx.reLaunch({ url })
        })
        .catch((e) => console.error('syncRouteToUserState', e))
    }

    run()
  }
})
