const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

function roughExtract(messages) {
  const text = (messages || []).map((m) => String(m.content || '')).join('\n')
  const patterns = [
    /\d{4}年\d{1,2}月\d{1,2}日/g,
    /\d{1,2}月\d{1,2}日/g,
    /下周|下个月|明年|本月底|月底|月底前|下季度|年底/g
  ]
  const events = []
  patterns.forEach((re) => {
    const ms = text.match(re) || []
    ms.forEach((x) => events.push({ time: x, source: 'dialog' }))
  })
  return events.slice(0, 50)
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const messages = Array.isArray(event.messages) ? event.messages : []
  const events = roughExtract(messages)

  try {
    const db = cloud.database()
    await db.collection('time_events').add({
      data: {
        openId,
        events,
        source: 'assessment_dialog',
        createdAt: Date.now()
      }
    })
  } catch (e) {
    console.warn('save time_events failed', e)
  }

  return { success: true, events }
}
