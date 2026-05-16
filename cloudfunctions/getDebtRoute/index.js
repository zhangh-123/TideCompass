const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function parseApr(rec) {
  let raw = rec.apr
  if (raw == null) raw = rec.aprRate
  if (raw == null) raw = rec.interestRate
  if (raw == null) raw = rec.yearRate
  let n = toNum(raw)
  if (n > 0 && n < 1) n = n * 100
  return n
}

function parseRemainingMonths(rec) {
  const rm = toNum(rec.remainingMonths)
  if (rm > 0) return Math.round(rm)
  const md = String(rec.maturityDate || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(md)) return null
  const due = new Date(`${md}T00:00:00+08:00`)
  if (Number.isNaN(due.getTime())) return null
  const now = new Date()
  const months =
    (due.getFullYear() - now.getFullYear()) * 12 + (due.getMonth() - now.getMonth()) + (due.getDate() >= now.getDate() ? 0 : -1)
  return Math.max(0, months)
}

function parseBalance(rec) {
  return toNum(rec.balance || rec.amount || rec.principal || rec.remainAmount || rec.remaining || rec.value)
}

function isCollectionMissingError(err) {
  const msg = String((err && err.message) || (err && err.errMsg) || err || '')
  return /502005|DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist/i.test(msg)
}

/** 优先 debt_records；集合未建时回退 balance_snapshot.liabilities（资产负债表） */
async function loadDebtRows(openId) {
  try {
    const res = await db.collection('debt_records').where({ openId }).limit(500).get()
    return res.data || []
  } catch (e) {
    if (!isCollectionMissingError(e)) throw e
    console.warn('[getDebtRoute] debt_records missing, fallback to balance_snapshot')
  }

  try {
    const snapRes = await db.collection('balance_snapshot').where({ openId }).limit(1).get()
    const snap = snapRes.data && snapRes.data[0]
    const lines = (snap && snap.liabilities) || []
    return lines.map((item, i) => ({
      _id: `snap_liability_${i}`,
      name: (item && (item.name || item.type)) || '负债项',
      balance: item && item.value,
      amount: item && item.value,
      apr: item && item.apr,
      maturityDate: item && item.maturityDate
    }))
  } catch (e2) {
    if (isCollectionMissingError(e2)) return []
    throw e2
  }
}

exports.main = async (event = {}) => {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { success: false, message: '未登录' }

  const sortMode = String(event.sortMode || 'avalanche')
  const rows = await loadDebtRows(openId)

  const list = rows.map((r) => {
    const apr = parseApr(r)
    const remainingMonths = parseRemainingMonths(r)
    const weight = remainingMonths == null ? 0 : Math.max(0, (12 - remainingMonths) / 12) * 0.5
    const urgencyScore = apr * (1 + weight)
    return {
      _id: r._id,
      name: r.name || r.platform || r.type || '债务项',
      apr,
      balance: parseBalance(r),
      maturityDate: r.maturityDate || '',
      remainingMonths,
      urgencyScore,
      isUrgent: remainingMonths != null && remainingMonths <= 3
    }
  })

  const urgentDebts = list.filter((x) => x.isUrgent).sort((a, b) => (a.remainingMonths || 99) - (b.remainingMonths || 99))

  const sorted = list.slice().sort((a, b) => {
    if (sortMode === 'maturity') {
      const am = a.remainingMonths == null ? 999 : a.remainingMonths
      const bm = b.remainingMonths == null ? 999 : b.remainingMonths
      if (am !== bm) return am - bm
      return b.apr - a.apr
    }
    // 雪崩法主排序仍按 APR，不改变原有逻辑；紧迫度得分仅用于展示
    if (b.apr !== a.apr) return b.apr - a.apr
    return (b.urgencyScore || 0) - (a.urgencyScore || 0)
  })

  return {
    success: true,
    sortMode,
    routeList: sorted,
    urgentDebts
  }
}
