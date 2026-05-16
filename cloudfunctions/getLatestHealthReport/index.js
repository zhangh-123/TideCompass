const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const CAREER_LABELS = {
  employed: '在职',
  freelance: '自由职业',
  unemployed: '待业',
  retired: '退休'
}

const FAMILY_LABELS = {
  single: '单身',
  married_no_child: '已婚无孩',
  married_with_children: '已婚有孩',
  other: '其他'
}

function pickBestReport(docs) {
  const list = Array.isArray(docs) ? docs : []
  if (!list.length) return null

  let timeline = []
  for (const d of list) {
    const te = d.timeline_events
    if (Array.isArray(te) && te.length) {
      timeline = te
      break
    }
  }

  const withSheet = list.find(
    (d) =>
      (Array.isArray(d.assets) && d.assets.length) ||
      (Array.isArray(d.liabilities) && d.liabilities.length) ||
      typeof d.totalAssets === 'number'
  )
  const base = withSheet || list[0]
  const raw = base.rawAssessment && base.rawAssessment.payload ? base.rawAssessment.payload : {}

  return {
    assets: base.assets || raw.assets || [],
    liabilities: base.liabilities || raw.liabilities || [],
    monthlyIncome:
      Number(base.monthlyIncome) ||
      Number(raw.monthlyIncome) ||
      0,
    monthlyExpense:
      Number(base.monthlyExpense) ||
      Number(raw.monthlyExpense) ||
      0,
    coreSkill: base.coreSkill || raw.coreSkill || '',
    biggestWorry: base.biggestWorry || raw.maxWorry || raw.biggestWorry || '',
    timeline_events: timeline.length ? timeline : base.timeline_events || [],
    netWorth: typeof base.netWorth === 'number' ? base.netWorth : null,
    totalAssets: typeof base.totalAssets === 'number' ? base.totalAssets : null,
    totalLiabilities:
      typeof base.totalLiabilities === 'number' ? base.totalLiabilities : null,
    radarScores: base.radarScores || null,
    insights: base.insights || null,
    createdAt: base.createdAt || Date.now()
  }
}

function formatProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {}
  const career = p.careerStatus || p.jobStatus || ''
  const family = p.familyStructure || ''
  return {
    jobStatus: CAREER_LABELS[career] || career || '未填写',
    familyStructure: FAMILY_LABELS[family] || family || '未填写',
    careerStatus: career,
    familyStructureRaw: family,
    coreSkillHint: p.industry || '',
    childrenCount: p.childrenCount
  }
}

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  if (!openId) {
    return { success: false, message: '未登录' }
  }

  try {
    const [hrRes, userRes] = await Promise.all([
      db
        .collection('health_reports')
        .where({ openId })
        .orderBy('createdAt', 'desc')
        .limit(8)
        .get(),
      db.collection('users').where({ openId }).limit(1).get()
    ])

    const report = pickBestReport(hrRes.data || [])
    const user = userRes.data && userRes.data[0]
    const profile = formatProfile(user && user.profile)

    if (!report) {
      return { success: false, message: '暂无体检报告记录', profile }
    }

    return { success: true, report, profile }
  } catch (e) {
    console.error('getLatestHealthReport', e)
    return { success: false, message: e.message || '读取报告失败' }
  }
}
