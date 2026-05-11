const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

/** 开发测试：固定手机号与验证码 */
const TEST_PHONE = '19999999999'
const TEST_CODE = '123456'

function randomSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

exports.main = async (event) => {
  const phone = (event.phone || '').trim()

  if (!/^1\d{10}$/.test(phone)) {
    return { success: false, message: '请输入11位有效手机号' }
  }

  const code = phone === TEST_PHONE ? TEST_CODE : randomSixDigitCode()
  const expireAt = Date.now() + 10 * 60 * 1000

  await db.collection('sms_codes').add({
    data: {
      phone,
      code,
      expireAt,
      used: false
    }
  })

  console.log('[sendSmsCode] phone=%s code=%s expireAt=%s', phone, code, expireAt)

  return { success: true }
}
