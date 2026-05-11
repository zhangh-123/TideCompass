const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  if (!openId) return { success: false, message: '未登录' }

  const found = await db.collection('users').where({ openId }).limit(1).get()
  const user = found.data && found.data[0]
  if (!user) return { success: false, message: '用户不存在' }

  await db.collection('users').doc(user._id).update({
    data: { hasSeenCarousel: true }
  })

  return { success: true }
}
