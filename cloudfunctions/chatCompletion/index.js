const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

/** 调用模型 HTTP 超时（毫秒）。文本默认 35s，图 45s；可被环境变量覆盖。报错 timeout of 12000ms 多为旧默认过短。 */
function httpTimeoutMs(imageUrl) {
  const rawText = process.env.LLM_HTTP_TIMEOUT_MS
  const rawImg = process.env.LLM_HTTP_TIMEOUT_IMAGE_MS
  const textMs = Number(rawText)
  const imgMs = Number(rawImg)
  const text = Number.isFinite(textMs) && textMs >= 3000 ? Math.min(textMs, 120000) : 35000
  const img = Number.isFinite(imgMs) && imgMs >= 3000 ? Math.min(imgMs, 120000) : 45000
  return imageUrl ? img : text
}

const DEFAULT_SYSTEM_PROMPT =
  '你是专业、温和的中文财务体检助手。目标是通过多轮对话收集完整财务画像并识别未来风险。必须覆盖并尽量量化这7类信息：1) 现金与存款（活期/定期/货基）2) 主要资产（房产、车辆、理财、股票基金等）3) 负债（余额、利率、月供/最低还款、到期时间）4) 稳定收入（税后月收入、是否波动）5) 固定支出（家庭刚性开销）6) 保障情况（医保/商保）7) 未来12个月已知事件（大额支出、收入变化、债务到期）。规则：若用户输入不便或信息较多，主动建议其上传银行/支付宝/微信账单或资产截图，并说明“可在输入框旁点击上传按钮进行OCR识别”；若用户提到未来事件但未给时间，必须追问时间；若金额缺失，优先追问金额或区间。只有当以上信息已覆盖，或用户明确表示“暂不清楚/没有更多可补充”时，才结束并在回复末尾明确写出：感谢您的分享，我将为您生成报告。每轮最多问2个关键问题，语气简洁自然，避免一次性长问卷。'

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return []
  const hasContent = (c) => {
    if (Array.isArray(c)) return c.length > 0
    if (typeof c === 'string') return !!c.trim()
    if (c && typeof c === 'object') return true
    return false
  }
  return messages
    .map((m) => ({
      role: m && (m.role === 'assistant' || m.role === 'system') ? m.role : 'user',
      content:
        Array.isArray(m && m.content) || (m && typeof m.content === 'object')
          ? m.content
          : String((m && m.content) || '').trim()
    }))
    .filter((m) => hasContent(m.content))
}

exports.main = async (event = {}) => {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) {
    return { success: false, message: '未配置 LLM_API_KEY' }
  }

  const url =
    process.env.LLM_API_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  const imageUrl = String(event.imageUrl || '').trim()
  const textModel = process.env.LLM_MODEL || 'qwen-plus'
  const visionModel = process.env.LLM_VISION_MODEL || textModel
  const model = imageUrl ? visionModel : textModel
  const inputMessages = normalizeMessages(event.messages)
  const systemPrompt = String(event.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim()

  const messages = [{ role: 'system', content: systemPrompt }]
  if (imageUrl) {
    const userPrompt = String(event.userPrompt || '请识别图片中的关键信息').trim()
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    })
  } else {
    messages.push(...inputMessages)
  }

  try {
    const resp = await axios.post(
      url,
      {
        model,
        temperature: 0.5,
        max_tokens: 1200,
        messages
      },
      {
        timeout: httpTimeoutMs(imageUrl),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    )

    const reply =
      resp.data &&
      resp.data.choices &&
      resp.data.choices[0] &&
      resp.data.choices[0].message &&
      resp.data.choices[0].message.content

    if (!reply) return { success: false, message: '模型未返回内容' }
    return { success: true, reply: String(reply).trim() }
  } catch (e) {
    const vendorError =
      (e &&
        e.response &&
        e.response.data &&
        (e.response.data.error || e.response.data.message || e.response.data)) ||
      null
    console.error('chatCompletion failed', vendorError || e)
    const vendorMsg =
      (vendorError &&
        (vendorError.message || vendorError.msg || vendorError.code || JSON.stringify(vendorError))) ||
      ''
    return {
      success: false,
      message: (vendorMsg || (e && e.message) || '模型调用失败').slice(0, 300)
    }
  }
}
