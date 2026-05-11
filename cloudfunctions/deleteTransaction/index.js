const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const transactionId = event.transactionId

  if (!transactionId) {
    return { success: false, message: '缺少 transactionId' }
  }

  let tx
  try {
    const doc = await db.collection('transactions').doc(transactionId).get()
    tx = doc.data
  } catch (e) {
    console.error(e)
    return { success: false, message: '记录不存在' }
  }

  if (!tx || tx.openId !== openId) {
    return { success: false, message: '无权删除该记录' }
  }

  await db.collection('transactions').doc(transactionId).remove()

  const amt = Number(tx.amount) || 0
  const deltaCash = tx.type === 'income' ? -amt : amt

  try {
    await cloud.callFunction({
      name: 'updateCashBalance',
      data: { deltaCash }
    })
  } catch (e) {
    console.error('updateCashBalance invoke failed', e)
    return { success: false, message: '回滚现金余额失败，请联系管理员' }
  }

  cloud
    .callFunction({
      name: 'updateCashflowScore',
      data: { openId }
    })
    .catch((e) => {
      console.error('updateCashflowScore invoke failed', e)
    })

  return { success: true }
}
