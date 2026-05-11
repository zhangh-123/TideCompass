const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const PLAN_MAP = {
  monthly: { label: '月度会员', days: 30, priceFen: 1900 },
  yearly: { label: '年度会员', days: 365, priceFen: 19900 }
}

function genOrderNo() {
  const t = Date.now()
  const r = Math.floor(Math.random() * 1000000)
  return `VIP${t}${String(r).padStart(6, '0')}`
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const planType = event.planType
  const customPriceFen = Number(event.priceFen)

  if (!PLAN_MAP[planType]) {
    return { success: false, message: '套餐类型无效' }
  }

  const plan = Object.assign({}, PLAN_MAP[planType])
  if (!Number.isNaN(customPriceFen) && customPriceFen > 0) {
    plan.priceFen = Math.floor(customPriceFen)
  }

  const now = Date.now()
  const orderNo = genOrderNo()
  const payMode = process.env.PAY_MODE || 'mock'

  try {
    const add = await db.collection('orders').add({
      data: {
        openId,
        orderNo,
        planType,
        planLabel: plan.label,
        amountFen: plan.priceFen,
        durationDays: plan.days,
        status: 'pending',
        payMode,
        createdAt: now,
        updatedAt: now,
        paidAt: null
      }
    })

    if (payMode === 'mock') {
      return {
        success: true,
        mock: true,
        orderId: add._id,
        orderNo,
        amountFen: plan.priceFen,
        paymentParams: {
          timeStamp: `${Math.floor(now / 1000)}`,
          nonceStr: `mock_${now}`,
          package: `prepay_id=mock_${orderNo}`,
          signType: 'MD5',
          paySign: 'MOCK_SIGN'
        }
      }
    }

    // 预留真实支付接入点（商户号/证书/签名）
    return {
      success: false,
      message: '当前环境未开启真实支付，请先使用 mock 模式测试',
      orderId: add._id,
      orderNo
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '创建订单失败' }
  }
}
