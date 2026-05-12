/**
 * 将用户已录入的 profile 转为一句中文叙事，用于财务体检大模型 system 提示词。
 * 字段与 pages/profile、utils/route.hasCompleteProfile 保持一致。
 */

const CAREER_LABEL = {
  employed: '目前在职',
  freelance: '目前为自由职业',
  unemployed: '目前待业',
  retired: '目前已退休'
}

const FAMILY_LABEL = {
  single: '单身',
  married_no_child: '已婚无孩',
  married_with_children: null,
  other: '婚姻/家庭结构为其他情况'
}

const EDU_LABEL = {
  high_school_and_below: '学历为高中及以下',
  associate: '学历为大专',
  bachelor: '学历为本科',
  master: '学历为硕士',
  doctor: '学历为博士'
}

const INDUSTRY_LABEL = {
  internet: '从事互联网行业',
  finance: '从事金融行业',
  education: '从事教育行业',
  manufacturing: '从事制造业',
  other: '从事其他行业'
}

/**
 * @param {object|null|undefined} profile
 * @returns {string} 无可用信息时返回空字符串
 */
function buildProfileNarrativeForPrompt(profile) {
  if (!profile || typeof profile !== 'object') return ''

  const parts = []

  const y = profile.birthYear
  if (typeof y === 'number' && y >= 1950 && y <= 2010) {
    parts.push(`${y}年出生`)
  }

  const career = profile.careerStatus && CAREER_LABEL[profile.careerStatus]
  if (career) parts.push(career)

  const fs = profile.familyStructure
  if (fs === 'married_with_children') {
    const n = profile.childrenCount
    if (typeof n === 'number' && n >= 0 && Number.isInteger(n)) {
      parts.push(`已婚育有${n}名子女`)
    } else {
      parts.push('已婚有子女')
    }
  } else if (fs && FAMILY_LABEL[fs]) {
    parts.push(FAMILY_LABEL[fs])
  }

  if (profile.supportElderly === true) {
    parts.push('家中有老人需要赡养')
  }

  const region = profile.region
  if (Array.isArray(region) && region.length) {
    const loc = region.filter(Boolean).join('')
    if (loc) parts.push(`常居于${loc}`)
  }

  if (profile.education && EDU_LABEL[profile.education]) {
    parts.push(EDU_LABEL[profile.education])
  }

  if (profile.industry && INDUSTRY_LABEL[profile.industry]) {
    parts.push(INDUSTRY_LABEL[profile.industry])
  }

  if (Object.prototype.hasOwnProperty.call(profile, 'hasProperty')) {
    if (profile.hasProperty === true) parts.push('已持有房产')
    else if (profile.hasProperty === false) parts.push('未持有房产')
  }

  return parts.join('，')
}

/**
 * 在默认财务体检 system 提示词中插入用户画像（插在首句「你是…助手。」之后）。
 * @param {string} defaultSystemPrompt 完整默认提示词
 * @param {object|null|undefined} profile
 */
function mergeProfileIntoAssessmentSystemPrompt(defaultSystemPrompt, profile) {
  const base = String(defaultSystemPrompt || '').trim()
  if (!base) return base

  const narrative = buildProfileNarrativeForPrompt(profile)
  if (!narrative) return base

  const firstStop = base.indexOf('。')
  if (firstStop === -1) {
    return `${base}\n\n当前用户已录入的基本情况：${narrative}。请结合该背景对话，勿重复盘问已体现的身份与家庭结构（仍需按规则收集财务量化信息）。`
  }

  const head = base.slice(0, firstStop + 1)
  const tail = base.slice(firstStop + 1)
  const bridge =
    `当前你所面对的用户是一个${narrative}的用户。请结合以上背景自然对话：对已体现的身份、家庭与地域信息不要反复确认，但仍须按后续要求系统收集并量化财务状况（现金、资产、负债、收支、保障与未来12个月事件等）。`

  return `${head}${bridge}${tail}`
}

module.exports = {
  buildProfileNarrativeForPrompt,
  mergeProfileIntoAssessmentSystemPrompt
}
