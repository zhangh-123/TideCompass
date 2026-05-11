const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

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

function sanitizeCategories(raw) {
  const cleaned = {}
  if (!raw || typeof raw !== 'object') return cleaned
  VALID_CATS.forEach((key) => {
    const v = Number(raw[key])
    if (!Number.isNaN(v) && v > 0) {
      cleaned[key] = Math.round(v)
    }
  })
  return cleaned
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const yearMonth = String(event.yearMonth || '').trim()

  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return { success: false, message: 'yearMonth 格式应为 YYYY-MM' }
  }

  const categories = sanitizeCategories(event.categories)

  try {
    const col = db.collection('budgets')
    const exist = await col.where({ openId, yearMonth }).limit(1).get()

    const now = Date.now()
    if (exist.data && exist.data.length) {
      await col.doc(exist.data[0]._id).update({
        data: {
          categories,
          updatedAt: now
        }
      })
    } else {
      await col.add({
        data: {
          openId,
          yearMonth,
          categories,
          createdAt: now,
          updatedAt: now
        }
      })
    }

    return { success: true, categories }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '保存失败' }
  }
}
