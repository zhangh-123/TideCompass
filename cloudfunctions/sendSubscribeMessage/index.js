const cloud = require('wx-server-sdk')
const { TEMPLATE_ID: DEFAULT_TEMPLATE_ID } = require('./config')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

/**
 * event:
 * - templateId?: string
 * - page?: string  点击消息打开的小程序路径
 * - data: Record<string, { value: string }>  与模板字段一致
 * - miniprogramState?: 'developer' | 'trial' | 'formal'
 */
exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const templateId = event.templateId || DEFAULT_TEMPLATE_ID

  if (!templateId || templateId.indexOf('REPLACE_') === 0) {
    return {
      success: false,
      skipped: true,
      message: '未配置有效订阅消息模板 ID'
    }
  }

  const page = event.page || 'pages/budget/budget'
  const data = event.data || {}
  const miniprogramState = event.miniprogramState || 'formal'

  try {
    const result = await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page,
      lang: 'zh_CN',
      data,
      miniprogramState
    })
    return { success: true, result }
  } catch (e) {
    console.error('subscribeMessage.send failed', e)
    return {
      success: false,
      message: e.message || String(e),
      errCode: e.errCode
    }
  }
}
