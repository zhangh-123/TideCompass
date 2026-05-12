const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const profile = event.profile

  if (!profile || typeof profile !== 'object') {
    return { success: false, message: 'profile 参数无效' }
  }

  const found = await db.collection('users').where({ openId }).get()
  if (!found.data || found.data.length === 0) {
    return { success: false, message: '用户不存在' }
  }

  const preserveAssessment = event.preserveAssessment === true
  const patch = { profile }
  if (!preserveAssessment) {
    patch.isFirstAssessmentDone = false
  }

  await db.collection('users').where({ openId }).update({
    data: patch
  })

  return { success: true }
}
