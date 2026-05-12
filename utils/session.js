/**
 * 本地会话：体检草稿缓存清理与退出登录
 */

function clearAssessmentCaches(openId) {
  const oid = String(openId || '').trim()
  const keys = [
    'assessmentData',
    'assessment_dialog',
    'assessment_dialog_draft',
    'assessment_timeline_events',
    `assessment_dialog:${oid}`,
    `assessment_dialog_draft:${oid}`,
    `assessment_timeline_events:${oid}`
  ]
  keys.forEach((k) => {
    try {
      wx.removeStorageSync(k)
    } catch (e) {}
  })
}

function logoutAndGoLogin() {
  const openId = wx.getStorageSync('openId') || ''
  clearAssessmentCaches(openId)
  try {
    wx.removeStorageSync('openId')
  } catch (e) {}
  wx.reLaunch({ url: '/pages/login/login' })
}

module.exports = {
  clearAssessmentCaches,
  logoutAndGoLogin
}
