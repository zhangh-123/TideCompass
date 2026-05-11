const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

/** 与记账联动更新的资产项名称（需与产品约定一致） */
const CASH_NAME = '现金及存款'

function lineValue(a) {
  if (!a || typeof a !== 'object') return 0
  const v = Number(a.value) || 0
  if (Object.prototype.hasOwnProperty.call(a, 'name') && a.name != null && a.name !== '') {
    return v
  }
  const c = Number(a.count) || 1
  return v * c
}

function sumAssets(assets) {
  return (assets || []).reduce((s, a) => s + lineValue(a), 0)
}

function sumLiab(liabs) {
  return (liabs || []).reduce((s, a) => s + lineValue(a), 0)
}

function cashKey(a) {
  return (a.name || a.type || '').trim()
}

/**
 * @param {number} event.deltaCash 现金资产变动（收入为正，支出为负）
 */
exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const deltaCash = Number(event.deltaCash)

  if (Number.isNaN(deltaCash)) {
    return { success: false, message: 'deltaCash 无效' }
  }

  const col = db.collection('balance_snapshot')
  const res = await col.where({ openId }).limit(1).get()

  if (!res.data || !res.data.length) {
    const cashVal = Math.max(0, deltaCash)
    const assets = [{ name: CASH_NAME, value: cashVal }]
    const liabilities = []
    const totalAssets = cashVal
    const totalLiabilities = 0
    await col.add({
      data: {
        openId,
        assets,
        liabilities,
        netWorth: totalAssets - totalLiabilities,
        totalAssets,
        totalLiabilities,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    })
    return { success: true }
  }

  const doc = res.data[0]
  const assets = JSON.parse(JSON.stringify(doc.assets || []))
  const liabilities = doc.liabilities || []

  let idx = assets.findIndex((a) => cashKey(a) === CASH_NAME)
  const cur = idx >= 0 ? lineValue(assets[idx]) : 0
  let newVal = cur + deltaCash
  if (newVal < 0) newVal = 0

  if (idx >= 0) {
    assets[idx] = { name: CASH_NAME, value: newVal }
  } else {
    assets.push({ name: CASH_NAME, value: newVal })
  }

  const totalAssets = sumAssets(assets)
  const totalLiabilities = sumLiab(liabilities)
  const netWorth = totalAssets - totalLiabilities

  await col.doc(doc._id).update({
    data: {
      assets,
      netWorth,
      totalAssets,
      totalLiabilities,
      updatedAt: Date.now()
    }
  })

  return { success: true }
}
