const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

function lineValue(item) {
  if (!item || typeof item !== 'object') return 0
  const v = Number(item.value) || 0
  if (Object.prototype.hasOwnProperty.call(item, 'name') && item.name != null) {
    return v
  }
  const c = Number(item.count) || 1
  return v * c
}

function lineKey(item) {
  const n = (item.name || item.type || '').trim()
  return n || '__empty__'
}

function normalizeLines(list) {
  return (list || []).map((item) => ({
    name: (item.name || item.type || '项目').trim() || '项目',
    value: lineValue(item)
  }))
}

function recalc(assets, liabilities) {
  const totalAssets = assets.reduce((s, a) => s + (Number(a.value) || 0), 0)
  const totalLiabilities = liabilities.reduce(
    (s, a) => s + (Number(a.value) || 0),
    0
  )
  return {
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities
  }
}

function mergeByName(existing, incoming) {
  const map = {}
  ;(existing || []).forEach((row) => {
    const k = lineKey(row)
    map[k] = {
      name: row.name,
      value: Number(row.value) || 0
    }
  })
  ;(incoming || []).forEach((row) => {
    const k = lineKey(row)
    const val = Number(row.value) || 0
    if (map[k]) {
      map[k] = { name: map[k].name, value: map[k].value + val }
    } else {
      map[k] = { name: row.name, value: val }
    }
  })
  return Object.values(map)
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const op = event.op

  const col = db.collection('balance_snapshot')

  async function loadDoc() {
    const r = await col.where({ openId }).limit(1).get()
    if (r.data && r.data.length) return r.data[0]
    await col.add({
      data: {
        openId,
        assets: [],
        liabilities: [],
        netWorth: 0,
        totalAssets: 0,
        totalLiabilities: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    })
    const r2 = await col.where({ openId }).limit(1).get()
    return r2.data[0]
  }

  if (!op) {
    return { success: false, message: '缺少 op' }
  }

  try {
    let doc = await loadDoc()
    let assets = normalizeLines(doc.assets || [])
    let liabilities = normalizeLines(doc.liabilities || [])

    switch (op) {
      case 'addAsset': {
        const name = (event.name || '').trim()
        const value = Number(event.value) || 0
        if (!name) return { success: false, message: '名称不能为空' }
        if (value < 0) return { success: false, message: '金额无效' }
        assets.push({ name, value })
        break
      }
      case 'updateAsset': {
        const idx = Number(event.index)
        const name = (event.name || '').trim()
        const value = Number(event.value) || 0
        if (!Number.isInteger(idx) || idx < 0 || idx >= assets.length) {
          return { success: false, message: '资产索引无效' }
        }
        if (!name) return { success: false, message: '名称不能为空' }
        if (value < 0) return { success: false, message: '金额无效' }
        assets[idx] = { name, value }
        break
      }
      case 'deleteAsset': {
        const idx = Number(event.index)
        if (!Number.isInteger(idx) || idx < 0 || idx >= assets.length) {
          return { success: false, message: '资产索引无效' }
        }
        assets.splice(idx, 1)
        break
      }
      case 'addLiability': {
        const name = (event.name || '').trim()
        const value = Number(event.value) || 0
        if (!name) return { success: false, message: '名称不能为空' }
        if (value < 0) return { success: false, message: '金额无效' }
        liabilities.push({ name, value })
        break
      }
      case 'updateLiability': {
        const idx = Number(event.index)
        const name = (event.name || '').trim()
        const value = Number(event.value) || 0
        if (!Number.isInteger(idx) || idx < 0 || idx >= liabilities.length) {
          return { success: false, message: '负债索引无效' }
        }
        if (!name) return { success: false, message: '名称不能为空' }
        if (value < 0) return { success: false, message: '金额无效' }
        liabilities[idx] = { name, value }
        break
      }
      case 'deleteLiability': {
        const idx = Number(event.index)
        if (!Number.isInteger(idx) || idx < 0 || idx >= liabilities.length) {
          return { success: false, message: '负债索引无效' }
        }
        liabilities.splice(idx, 1)
        break
      }
      case 'importFromReport': {
        const hr = await db
          .collection('health_reports')
          .where({ openId })
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get()

        if (!hr.data || !hr.data.length) {
          return { success: false, message: '暂无体检报告可导入' }
        }

        const rep = hr.data[0]
        const impA = normalizeLines(rep.assets || [])
        const impL = normalizeLines(rep.liabilities || [])
        assets = mergeByName(assets, impA)
        liabilities = mergeByName(liabilities, impL)
        break
      }
      default:
        return { success: false, message: '未知操作类型' }
    }

    const totals = recalc(assets, liabilities)

    await col.doc(doc._id).update({
      data: {
        assets,
        liabilities,
        netWorth: totals.netWorth,
        totalAssets: totals.totalAssets,
        totalLiabilities: totals.totalLiabilities,
        updatedAt: Date.now()
      }
    })

    return {
      success: true,
      assets,
      liabilities,
      netWorth: totals.netWorth,
      totalAssets: totals.totalAssets,
      totalLiabilities: totals.totalLiabilities
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '更新失败' }
  }
}
