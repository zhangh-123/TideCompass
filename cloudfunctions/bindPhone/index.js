const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const phone = (event.phone || '').trim()
  const code = (event.code || '').trim()

  if (!/^1\d{10}$/.test(phone) || !/^\d{6}$/.test(code)) {
    return { success: false, message: '手机号或验证码格式不正确' }
  }

  const now = Date.now()

  const { data: smsRows } = await db
    .collection('sms_codes')
    .where({
      phone,
      code,
      used: false,
      expireAt: _.gt(now)
    })
    .limit(1)
    .get()

  if (!smsRows || smsRows.length === 0) {
    return { success: false, message: '验证码错误或已过期' }
  }

  const smsDoc = smsRows[0]

  const { data: conflictUsers } = await db
    .collection('users')
    .where({
      phone,
      openId: _.neq(openId)
    })
    .limit(1)
    .get()

  if (conflictUsers && conflictUsers.length > 0) {
    return { success: false, message: '该手机号已绑定其他微信账号' }
  }

  const userRes = await db.collection('users').where({ openId }).get()
  if (!userRes.data || userRes.data.length === 0) {
    return { success: false, message: '用户不存在，请重新登录' }
  }

  await db
    .collection('users')
    .where({ openId })
    .update({
      data: {
        phone
      }
    })

  await db.collection('sms_codes').doc(smsDoc._id).update({
    data: {
      used: true
    }
  })

  return { success: true }
}
