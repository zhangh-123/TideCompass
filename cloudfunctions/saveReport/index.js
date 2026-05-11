const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

function toSnapshotRows(list) {
  return (list || []).map((item) => ({
    name: String(item.name || item.type || '项目').trim() || '项目',
    value: (Number(item.value) || 0) * (Number(item.count) || 1)
  }))
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const reportData = event.reportData
  const rawAssessment = event.rawAssessment

  if (!reportData || typeof reportData !== 'object') {
    return { success: false, message: 'reportData 无效' }
  }

  await db.collection('health_reports').add({
    data: {
      openId,
      createdAt: Date.now(),
      assets: reportData.assets || [],
      liabilities: reportData.liabilities || [],
      netWorth: reportData.netWorth,
      totalAssets: reportData.totalAssets,
      totalLiabilities: reportData.totalLiabilities,
      radarScores: reportData.radarScores || {},
      insights: reportData.insights || {},
      coreSkill: reportData.coreSkill || '',
      biggestWorry: reportData.biggestWorry || '',
      timeline_events: reportData.timelineEvents || [],
      rawAssessment: rawAssessment || null
    }
  })

  const snapCol = db.collection('balance_snapshot')
  const snapRes = await snapCol.where({ openId }).limit(1).get()

  const snapshotDoc = {
    openId,
    assets: toSnapshotRows(reportData.assets || []),
    liabilities: toSnapshotRows(reportData.liabilities || []),
    netWorth: reportData.netWorth,
    totalAssets: reportData.totalAssets,
    totalLiabilities: reportData.totalLiabilities,
    radarScores: reportData.radarScores || {},
    updatedAt: Date.now()
  }

  if (snapRes.data && snapRes.data.length > 0) {
    await snapCol.doc(snapRes.data[0]._id).update({
      data: snapshotDoc
    })
  } else {
    await snapCol.add({
      data: Object.assign({}, snapshotDoc, { createdAt: Date.now() })
    })
  }

  await db.collection('users').where({ openId }).update({
    data: {
      isFirstAssessmentDone: true
    }
  })

  return { success: true }
}
