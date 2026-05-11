const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  if (!openId) return { success: false, message: '缺少 openId' }

  try {
    const res = await db.collection('users').where({ openId }).limit(1).get()
    const user = res.data && res.data[0]
    if (!user) return { success: false, message: '用户不存在' }

    const now = Date.now()
    const expireAt = Number(user.vipExpireAt) || 0
    const isVip = !!user.isVip && expireAt > now
    const remainDays = isVip ? Math.ceil((expireAt - now) / (24 * 60 * 60 * 1000)) : 0

    if (user.isVip && !isVip) {
      await db.collection('users').doc(user._id).update({
        data: {
          isVip: false,
          vipUpdatedAt: now
        }
      })
    }

    return {
      success: true,
      isVip,
      remainDays,
      vipExpireAt: expireAt,
      vipPlanType: user.vipPlanType || ''
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '查询失败' }
  }
}
