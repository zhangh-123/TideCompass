/** 与云函数 addTransaction、预算模块一致的支出类别列表 */
const EXPENSE_CATEGORIES = [
  '餐饮',
  '购物',
  '居住',
  '交通',
  '医疗',
  '娱乐',
  '教育',
  '其他'
]

/**
 * 订阅消息模板 ID：在微信公众平台申请「预算超支提醒」后替换。
 * 须与云函数 sendSubscribeMessage/config.js 中配置保持一致。
 */
const BUDGET_SUBSCRIBE_TEMPLATE_ID = 'tX2x2KaEmNrICP_RNMStk5V8SX0DA7tCdKUKMfNuiug'

module.exports = {
  EXPENSE_CATEGORIES,
  BUDGET_SUBSCRIBE_TEMPLATE_ID
}
