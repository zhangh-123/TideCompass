/**
 * 用户信息页 profile 是否满足必填项（与表单校验一致）
 */
function hasCompleteProfile(profile) {
  if (!profile || typeof profile !== 'object') return false

  const {
    birthYear,
    careerStatus,
    familyStructure,
    supportElderly,
    region
  } = profile

  if (
    birthYear == null ||
    typeof birthYear !== 'number' ||
    !careerStatus ||
    !familyStructure ||
    typeof supportElderly !== 'boolean'
  ) {
    return false
  }

  if (!region || !Array.isArray(region) || region.length < 3) return false
  if (!region[0] || !region[1]) return false

  if (familyStructure === 'married_with_children') {
    const c = profile.childrenCount
    if (
      c === undefined ||
      c === null ||
      typeof c !== 'number' ||
      c < 0 ||
      c > 5 ||
      !Number.isInteger(c)
    ) {
      return false
    }
  }

  return true
}

/**
 * 登录 openId 已存在时的目标路径（不含未登录）
 */
function getHomePath(user) {
  if (!user || typeof user !== 'object') return '/pages/login/login'
  if (!user.phone) return '/pages/bind_phone/bind_phone'
  if (!hasCompleteProfile(user.profile)) return '/pages/profile/profile'
  if (user.hasSeenCarousel !== true) return '/pages/carousel/carousel'

  if (!user.isFirstAssessmentDone) {
    try {
      const ad = wx.getStorageSync('assessmentData')
      if (ad && ad.payload && ad.completedAt) {
        const created = Number(user.createdAt) || 0
        const doneAt = Number(ad.completedAt) || 0
        // 账号被删后重建：同一 openId 新文档的 createdAt 晚于旧体检完成时间，本地 assessmentData 为残留，应走体检而非报告
        if (created && doneAt && doneAt < created) {
          try {
            wx.removeStorageSync('assessmentData')
          } catch (e2) {}
        } else if (
          ad.serverUserId &&
          user._id &&
          ad.serverUserId !== user._id
        ) {
          try {
            wx.removeStorageSync('assessmentData')
          } catch (e3) {}
        } else {
          return '/pages/report/report'
        }
      }
    } catch (e) {}
    return '/pages/assessment/assessment'
  }

  return '/pages/index/index'
}

module.exports = {
  hasCompleteProfile,
  getHomePath
}
