const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

const VALID_TYPES = ['income', 'expense']
const VALID_CATS = [
  '餐饮',
  '购物',
  '居住',
  '交通',
  '医疗',
  '娱乐',
  '教育',
  '其他'
]

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  const date = (event.date || '').trim()
  const type = event.type
  const category = event.category
  const amount = Math.abs(Number(event.amount))
  const note = (event.note || '').trim()

  if (!date || !type || !category || !amount || amount <= 0) {
    return { success: false, message: '请填写完整记账信息' }
  }
  if (!VALID_TYPES.includes(type)) {
    return { success: false, message: '类型无效' }
  }
  if (!VALID_CATS.includes(category)) {
    return { success: false, message: '类别无效' }
  }

  await db.collection('transactions').add({
    data: {
      openId,
      date,
      type,
      category,
      amount,
      note,
      createdAt: Date.now()
    }
  })

  const deltaCash = type === 'income' ? amount : -amount

  try {
    await cloud.callFunction({
      name: 'updateCashBalance',
      data: { deltaCash }
    })
  } catch (e) {
    console.error('updateCashBalance invoke failed', e)
    return { success: false, message: '更新现金余额失败，请稍后重试' }
  }

  if (type === 'expense') {
    try {
      await cloud.callFunction({
        name: 'checkBudgetAndNotify',
        data: { date, category, amount }
      })
    } catch (e) {
      console.error('checkBudgetAndNotify invoke failed', e)
    }
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
