const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

/**
 * 返回当前用户的 openId。
 * 说明：微信云开发中 openId 由 cloud.getWXContext() 提供；
 * event.userInfo.openId 在客户端未传入时不可用，故以服务端上下文为准。
 */
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openId =
    (event.userInfo && event.userInfo.openId) || wxContext.OPENID
  return {
    openId
  }
}
