const { hasCompleteProfile } = require('../../utils/route.js')
const { isAdminPhone } = require('../../utils/admin.js')
const { logoutAndGoLogin } = require('../../utils/session.js')

function maskPhone(phone) {
  const s = String(phone || '').replace(/\s/g, '')
  if (s.length >= 11) return `${s.slice(0, 3)}****${s.slice(-4)}`
  if (s.length >= 7) return `${s.slice(0, 2)}****${s.slice(-2)}`
  return s ? '已绑定' : ''
}

function buildYearLabels() {
  const ys = []
  for (let y = 1950; y <= 2010; y++) ys.push(String(y))
  return ['请选择'].concat(ys)
}

Page({
  data: {
    yearLabels: buildYearLabels(),
    birthYearIndex: 0,
    birthYearText: '请选择出生年份',
    careerOptions: [
      { value: 'employed', label: '在职' },
      { value: 'freelance', label: '自由职业' },
      { value: 'unemployed', label: '待业' },
      { value: 'retired', label: '退休' }
    ],
    careerStatus: '',
    familyOptions: [
      { value: 'single', label: '单身' },
      { value: 'married_no_child', label: '已婚无孩' },
      { value: 'married_with_children', label: '已婚有孩' },
      { value: 'other', label: '其他' }
    ],
    familyStructure: '',
    childrenCount: '',
    supportElderly: false,
    regionLabels: null,
    regionDisplay: '请选择省 / 市 / 区',
    educationLabels: ['暂不填写', '高中及以下', '大专', '本科', '硕士', '博士'],
    educationValues: [
      null,
      'high_school_and_below',
      'associate',
      'bachelor',
      'master',
      'doctor'
    ],
    educationIndex: 0,
    industryLabels: ['暂不填写', '互联网', '金融', '教育', '制造业', '其他'],
    industryValues: [null, 'internet', 'finance', 'education', 'manufacturing', 'other'],
    industryIndex: 0,
    hasProperty: false,
    propertySpecified: false,
    canSubmit: false,
    submitting: false,
    optionalExpanded: false,

    profileComplete: false,
    showAdminEntry: false,
    minePhoneMasked: '',
    isEditingProfile: false
  },

  toggleOptional() {
    this.setData({ optionalExpanded: !this.data.optionalExpanded })
  },

  onCareerTap(e) {
    const value = e.currentTarget.dataset.value
    if (!value) return
    this.setData({ careerStatus: value })
    this.refreshCanSubmit()
  },

  onFamilyTap(e) {
    const familyStructure = e.currentTarget.dataset.value
    if (!familyStructure) return
    const patch = { familyStructure }
    if (familyStructure !== 'married_with_children') {
      patch.childrenCount = ''
    }
    this.setData(patch)
    this.refreshCanSubmit()
  },

  async onLoad() {
    await this.ensureAccess()
  },

  async onShow() {
    await this.ensureAccess()
  },

  async ensureAccess() {
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }

    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).get()
      const row = data && data[0]
      if (!row || !row.phone) {
        wx.reLaunch({ url: '/pages/bind_phone/bind_phone' })
        return
      }
      if (hasCompleteProfile(row.profile)) {
        const editing = this.data.isEditingProfile
        wx.setNavigationBarTitle({ title: editing ? '修改个人信息' : '我的' })
        this.setData({
          profileComplete: true,
          showAdminEntry: isAdminPhone(row.phone),
          minePhoneMasked: maskPhone(row.phone)
        })
        return
      }
      wx.setNavigationBarTitle({ title: '个人信息' })
      this.setData({
        profileComplete: false,
        showAdminEntry: false,
        minePhoneMasked: '',
        isEditingProfile: false
      })
    } catch (e) {
      console.error(e)
      wx.reLaunch({ url: '/pages/bind_phone/bind_phone' })
    }
  },

  refreshCanSubmit() {
    const d = this.data
    let ok = true

    if (!d.birthYearIndex || d.birthYearIndex <= 0) ok = false
    if (!d.careerStatus || !d.familyStructure) ok = false
    if (!d.regionLabels || !Array.isArray(d.regionLabels) || d.regionLabels.length < 3)
      ok = false
    else if (!d.regionLabels[0] || !d.regionLabels[1]) ok = false

    if (ok && d.familyStructure === 'married_with_children') {
      const n = parseInt(d.childrenCount, 10)
      if (
        Number.isNaN(n) ||
        !Number.isInteger(n) ||
        n < 0 ||
        n > 5 ||
        d.childrenCount === ''
      ) {
        ok = false
      }
    }

    if (ok !== d.canSubmit) {
      this.setData({ canSubmit: ok })
    }
  },

  onBirthYearChange(e) {
    const idx = Number(e.detail.value)
    const label = this.data.yearLabels[idx] || '请选择出生年份'
    this.setData({
      birthYearIndex: idx,
      birthYearText: idx > 0 ? label : '请选择出生年份'
    })
    this.refreshCanSubmit()
  },

  onChildrenInput(e) {
    this.setData({ childrenCount: e.detail.value })
    this.refreshCanSubmit()
  },

  onSupportElderlyChange(e) {
    this.setData({ supportElderly: !!e.detail.value })
    this.refreshCanSubmit()
  },

  onRegionChange(e) {
    const raw = e.detail.value
    const labels = Array.isArray(raw) ? raw : []
    const text = labels.filter(Boolean).join(' ')
    this.setData({
      regionLabels: labels.length ? labels : null,
      regionDisplay: text || '请选择省 / 市 / 区'
    })
    this.refreshCanSubmit()
  },

  onEducationChange(e) {
    this.setData({ educationIndex: Number(e.detail.value) })
  },

  onIndustryChange(e) {
    this.setData({ industryIndex: Number(e.detail.value) })
  },

  onHasPropertyChange(e) {
    this.setData({
      propertySpecified: true,
      hasProperty: !!e.detail.value
    })
  },

  hydrateProfileToForm(profile) {
    const yearLabels = this.data.yearLabels
    const p = profile || {}
    let birthYearIndex = 0
    let birthYearText = '请选择出生年份'
    if (typeof p.birthYear === 'number') {
      const ys = String(p.birthYear)
      const idx = yearLabels.indexOf(ys)
      if (idx >= 0) {
        birthYearIndex = idx
        birthYearText = ys
      }
    }

    const region = Array.isArray(p.region) ? p.region.slice() : []
    const regionLabels = region.length >= 2 ? region : null
    const regionDisplay = region.filter(Boolean).join(' ') || '请选择省 / 市 / 区'

    let educationIndex = 0
    const ev = this.data.educationValues
    if (p.education != null) {
      const ei = ev.indexOf(p.education)
      if (ei >= 0) educationIndex = ei
    }

    let industryIndex = 0
    const iv = this.data.industryValues
    if (p.industry != null) {
      const ii = iv.indexOf(p.industry)
      if (ii >= 0) industryIndex = ii
    }

    const propertySpecified = Object.prototype.hasOwnProperty.call(p, 'hasProperty')
    const hasProperty = !!p.hasProperty

    const optionalExpanded = !!(p.education || p.industry || propertySpecified)

    let childrenCount = ''
    if (p.familyStructure === 'married_with_children' && typeof p.childrenCount === 'number') {
      childrenCount = String(p.childrenCount)
    }

    this.setData({
      birthYearIndex,
      birthYearText,
      careerStatus: p.careerStatus || '',
      familyStructure: p.familyStructure || '',
      childrenCount,
      supportElderly: !!p.supportElderly,
      regionLabels,
      regionDisplay,
      educationIndex,
      industryIndex,
      hasProperty,
      propertySpecified,
      optionalExpanded
    })
    this.refreshCanSubmit()
  },

  async onEditProfile() {
    const openId = wx.getStorageSync('openId')
    if (!openId) return
    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).limit(1).get()
      const row = data && data[0]
      if (!row || !hasCompleteProfile(row.profile)) {
        wx.showToast({ title: '资料加载失败', icon: 'none' })
        return
      }
      this.hydrateProfileToForm(row.profile)
      wx.setNavigationBarTitle({ title: '修改个人信息' })
      this.setData({ isEditingProfile: true })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  onCancelEdit() {
    wx.setNavigationBarTitle({ title: '我的' })
    this.setData({ isEditingProfile: false })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将清除本机登录状态与本地体检草稿，需重新登录。',
      confirmText: '退出',
      success: (res) => {
        if (res.confirm) logoutAndGoLogin()
      }
    })
  },

  async onNext() {
    if (!this.data.canSubmit || this.data.submitting) return

    const d = this.data
    const birthYear = parseInt(d.yearLabels[d.birthYearIndex], 10)

    const profile = {
      birthYear,
      careerStatus: d.careerStatus,
      familyStructure: d.familyStructure,
      supportElderly: d.supportElderly,
      region: (d.regionLabels || []).slice()
    }

    if (d.familyStructure === 'married_with_children') {
      profile.childrenCount = parseInt(d.childrenCount, 10)
    }

    const edu = d.educationValues[d.educationIndex]
    if (edu != null) profile.education = edu

    const ind = d.industryValues[d.industryIndex]
    if (ind != null) profile.industry = ind

    if (d.propertySpecified) profile.hasProperty = d.hasProperty

    const preserveAssessment = !!(this.data.profileComplete && this.data.isEditingProfile)

    this.setData({ submitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'saveUserProfile',
        data: { profile, preserveAssessment }
      })
      const r = res.result || {}
      if (!r.success) {
        wx.showToast({
          title: r.message || '保存失败',
          icon: 'none'
        })
        return
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      if (preserveAssessment) {
        wx.setNavigationBarTitle({ title: '我的' })
        this.setData({ isEditingProfile: false })
        return
      }
      wx.reLaunch({ url: '/pages/carousel/carousel' })
    } catch (err) {
      console.error(err)
      wx.showToast({
        title: err.errMsg || '保存失败',
        icon: 'none'
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async goAdmin() {
    if (!this.data.showAdminEntry) return
    const openId = wx.getStorageSync('openId')
    if (!openId) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    try {
      const db = wx.cloud.database()
      const { data } = await db.collection('users').where({ openId }).limit(1).get()
      const user = data && data[0]
      if (!user || !isAdminPhone(user.phone)) {
        this.setData({ showAdminEntry: false })
        wx.showToast({ title: '无管理员权限', icon: 'none' })
        return
      }
      wx.navigateTo({ url: '/pages/admin/admin' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '校验失败', icon: 'none' })
    }
  }
})
