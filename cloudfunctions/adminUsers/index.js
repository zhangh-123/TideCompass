const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

/** 与小程序端 utils/admin.js 保持一致 */
const ADMIN_PHONE = '19999999999'

function normalizePhone(phone) {
  return String(phone == null ? '' : phone)
    .replace(/\s/g, '')
    .trim()
}

async function assertAdmin(openId) {
  if (!openId) {
    return { ok: false, message: '未登录' }
  }
  const r = await db.collection('users').where({ openId }).limit(1).get()
  const u = r.data && r.data[0]
  if (!u || normalizePhone(u.phone) !== ADMIN_PHONE) {
    return { ok: false, message: '无管理员权限' }
  }
  return { ok: true }
}

/** 与本项目业务集合保持一致（均含 openId 字段） */
const OPENID_COLLECTIONS = [
  'transactions',
  'balance_snapshot',
  'health_reports',
  'budgets',
  'simulations',
  'orders'
]

const BATCH = 100
const MAX_LOOPS = 500

async function removeDocsWhere(collectionName, whereClause, label) {
  const col = db.collection(collectionName)
  let loops = 0
  while (loops++ < MAX_LOOPS) {
    const batch = await col.where(whereClause).limit(BATCH).get()
    const rows = batch.data || []
    if (rows.length === 0) return
    for (const doc of rows) {
      await col.doc(doc._id).remove()
    }
    if (rows.length < BATCH) return
  }
  console.error(`[adminUsers] removeDocsWhere ${label}: exceeded MAX_LOOPS`)
}

/** upload_files 含云存储 fileID，需一并删除文件 */
async function removeUploadFilesForOpenId(targetOpenId) {
  const col = db.collection('upload_files')
  let loops = 0
  while (loops++ < MAX_LOOPS) {
    const batch = await col.where({ openId: targetOpenId }).limit(50).get()
    const rows = batch.data || []
    if (rows.length === 0) return

    const fileList = rows.map((d) => d.fileID).filter(Boolean)
    if (fileList.length) {
      try {
        await cloud.deleteFile({ fileList })
      } catch (e) {
        console.warn('[adminUsers] deleteFile partial fail', e)
      }
    }
    for (const doc of rows) {
      await col.doc(doc._id).remove()
    }
    if (rows.length < 50) return
  }
}

async function purgeAllUserData(targetOpenId, phoneRaw) {
  await removeUploadFilesForOpenId(targetOpenId)

  for (const name of OPENID_COLLECTIONS) {
    try {
      await removeDocsWhere(name, { openId: targetOpenId }, name)
    } catch (e) {
      console.error(`[adminUsers] purge ${name}`, e)
      throw e
    }
  }

  const phone = normalizePhone(phoneRaw)
  if (phone) {
    try {
      await removeDocsWhere('sms_codes', { phone }, 'sms_codes')
    } catch (e) {
      console.warn('[adminUsers] purge sms_codes', e)
    }
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const action = event.action || ''

  const auth = await assertAdmin(openId)
  if (!auth.ok) {
    return { success: false, message: auth.message }
  }

  if (action === 'listUsers') {
    const limit = Math.min(Number(event.limit) || 500, 500)
    const res = await db.collection('users').limit(limit).get()
    const list = (res.data || []).map((doc) => ({
      _id: doc._id,
      openId: doc.openId || '',
      phone: doc.phone || '',
      createdAt: doc.createdAt || null
    }))
    list.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    return { success: true, list }
  }

  if (action === 'deleteUser') {
    const userId = event.userId
    if (!userId || typeof userId !== 'string') {
      return { success: false, message: '缺少 userId' }
    }

    let target
    try {
      const docRes = await db.collection('users').doc(userId).get()
      target = docRes.data
    } catch (e) {
      console.error(e)
      return { success: false, message: '用户不存在' }
    }
    if (!target) {
      return { success: false, message: '用户不存在' }
    }
    if (normalizePhone(target.phone) === ADMIN_PHONE) {
      return { success: false, message: '管理员账号不可删除' }
    }
    if (target.openId === openId) {
      return { success: false, message: '不能删除当前登录管理员账号' }
    }

    const targetOpenId = target.openId
    if (!targetOpenId) {
      await db.collection('users').doc(userId).remove()
      return { success: true }
    }

    await purgeAllUserData(targetOpenId, target.phone)
    await db.collection('users').doc(userId).remove()
    return { success: true }
  }

  return { success: false, message: '未知操作' }
}
