const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function nextExpireAt(currentExpireAt, addDays) {
  const now = Date.now()
  const base = currentExpireAt && currentExpireAt > now ? currentExpireAt : now
  return base + addDays * 24 * 60 * 60 * 1000
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const orderId = event.orderId
  const orderNo = event.orderNo
  const payResult = event.payResult || 'success'

  if (!orderId && !orderNo) {
    return { success: false, message: '缺少订单标识' }
  }

  try {
    const orderCol = db.collection('orders')
    const q = orderId
      ? await orderCol.doc(orderId).get()
      : await orderCol.where({ openId, orderNo }).limit(1).get()

    const order = orderId ? q.data : q.data && q.data[0]
    if (!order) return { success: false, message: '订单不存在' }
    if (order.openId !== openId) return { success: false, message: '无权操作该订单' }

    if (order.status === 'success') {
      const userRes = await db.collection('users').where({ openId }).limit(1).get()
      const user = userRes.data && userRes.data[0]
      return {
        success: true,
        orderId: order._id,
        vipExpireAt: user && user.vipExpireAt,
        alreadyPaid: true
      }
    }

    if (payResult !== 'success') {
      await orderCol.doc(order._id).update({
        data: {
          status: 'failed',
          updatedAt: Date.now(),
          failReason: event.failReason || 'payment_failed'
        }
      })
      return { success: false, message: '支付失败' }
    }

    await orderCol.doc(order._id).update({
      data: {
        status: 'success',
        paidAt: Date.now(),
        updatedAt: Date.now(),
        transactionId: event.transactionId || `mock_txn_${Date.now()}`
      }
    })

    const userRes = await db.collection('users').where({ openId }).limit(1).get()
    const user = userRes.data && userRes.data[0]
    if (!user) return { success: false, message: '用户不存在' }

    const durationDays = Number(order.durationDays) || 30
    const vipExpireAt = nextExpireAt(user.vipExpireAt, durationDays)

    await db.collection('users').doc(user._id).update({
      data: {
        isVip: true,
        vipExpireAt,
        vipUpdatedAt: Date.now(),
        vipPlanType: order.planType
      }
    })

    return {
      success: true,
      orderId: order._id,
      vipExpireAt
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '回调处理失败' }
  }
}
