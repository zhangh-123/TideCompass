/** 管理员手机号（与云函数 adminUsers 内校验保持一致） */
const ADMIN_PHONE = '19999999999'

function normalizePhone(phone) {
  return String(phone == null ? '' : phone)
    .replace(/\s/g, '')
    .trim()
}

function isAdminPhone(phone) {
  return normalizePhone(phone) === ADMIN_PHONE
}

module.exports = {
  ADMIN_PHONE,
  normalizePhone,
  isAdminPhone
}
