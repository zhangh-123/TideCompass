/** 调用模型 HTTP 超时（毫秒）。文本默认 35s，图 45s；可被环境变量覆盖。报错 timeout of 12000ms 多为旧默认过短。 */
function httpTimeoutMs(imageUrl) {
  const rawText = process.env.LLM_HTTP_TIMEOUT_MS
  const rawImg = process.env.LLM_HTTP_TIMEOUT_IMAGE_MS
  const textMs = Number(rawText)
  const imgMs = Number(rawImg)
  const text = Number.isFinite(textMs) && textMs >= 3000 ? Math.min(textMs, 120000) : 35000
  const img = Number.isFinite(imgMs) && imgMs >= 3000 ? Math.min(imgMs, 120000) : 60000
  return imageUrl ? img : text
}

const DEFAULT_SYSTEM_PROMPT =
  '你是专业、温和的中文财务体检助手。目标是通过多轮对话收集完整财务画像并识别未来风险。必须覆盖并尽量量化这7类信息：1) 现金与存款（活期/定期/货基）2) 主要资产（房产、车辆、理财、股票基金等）3) 负债（余额、利率、月供/最低还款、到期时间）4) 稳定收入（税后月收入、是否波动）5) 固定支出（家庭刚性开销）6) 保障情况（医保/商保）7) 未来12个月已知事件（大额支出、收入变化、债务到期）。规则：若用户输入不便或信息较多，主动建议其上传银行/支付宝/微信账单或资产截图，并说明“可在输入框旁点击上传按钮进行OCR识别”；若用户提到未来事件但未给时间，必须追问时间；若金额缺失，优先追问金额或区间。只有当以上信息已覆盖，或用户明确表示“暂不清楚/没有更多可补充”时，才结束并在回复末尾明确写出：感谢您的分享，我将为您生成报告。每轮最多问2个关键问题，语气简洁自然，避免一次性长问卷。'

/** Google Gemini OpenAI 兼容 Chat Completions（与 DashScope 二选一） */
const GOOGLE_OPENAI_CHAT_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

function isGoogleGeminiEndpoint(apiUrl) {
  return /googleapis\.com/i.test(String(apiUrl || ''))
}

function isDashscopeEndpoint(apiUrl) {
  return /dashscope|aliyuncs\.com/i.test(String(apiUrl || ''))
}

/** OpenAI 兼容形态的中转（API易、OpenRouter、自建反代等）：非阿里云、非 Google 官方直连域名 */
function isOpenAiRelayEndpoint(apiUrl) {
  const u = String(apiUrl || '').trim()
  if (!/^https?:\/\//i.test(u)) return false
  if (isDashscopeEndpoint(u) || isGoogleGeminiEndpoint(u)) return false
  return true
}

/** 未配置 LLM_VISION_MODEL 时，按接口域名选择可用的默认视觉模型 */
function defaultVisionModel(apiUrl) {
  if (isGoogleGeminiEndpoint(apiUrl)) return 'gemini-2.5-flash'
  if (isDashscopeEndpoint(apiUrl)) return 'qwen-vl-plus'
  if (isOpenAiRelayEndpoint(apiUrl)) {
    const relayDefault = String(process.env.LLM_OPENAI_RELAY_VISION_DEFAULT || '').trim()
    return relayDefault || 'gemini-2.5-flash-image'
  }
  return 'qwen-vl-plus'
}

function visionFailureHint(apiUrl) {
  if (isDashscopeEndpoint(apiUrl)) {
    return '请确认 LLM_VISION_MODEL 为阿里云 VL（如 qwen-vl-plus），且 LLM_API_BASE_URL 为 DashScope 兼容地址。'
  }
  if (isGoogleGeminiEndpoint(apiUrl)) {
    return `请确认 Google Key 与模型已开通；接口应为 ${GOOGLE_OPENAI_CHAT_URL}。`
  }
  return (
    '若为 API易等 OpenAI 兼容中转：请使用控制台提供的 Base URL（通常以 …/v1/chat/completions 结尾）、中转 API Key，' +
    '并设置 LLM_VISION_MODEL 与控制台一致的模型名（如 gemini-2.5-flash-image）。账单类 OCR 也可尝试 gemini-2.5-flash。'
  )
}

/**
 * 模型名与 Endpoint 明显不匹配时提前报错（常见于 Gemini 模型名 + 阿里云 URL）。
 */
function describeEndpointModelMismatch(apiUrl, modelName, imageUrl) {
  const u = String(apiUrl || '')
  const m = String(modelName || '').toLowerCase()
  if (!imageUrl) return null
  if (/gemini/.test(m) && isDashscopeEndpoint(u)) {
    return (
      '模型名为 Gemini，但 LLM_API_BASE_URL 指向阿里云 DashScope。请任选其一：① 改 LLM_VISION_MODEL 为 qwen-vl-plus；' +
      '② 换 Google 官方地址与 Key（见环境说明）；③ 使用 API易等中转提供的 Base URL + Key + Gemini 模型名（勿填阿里云地址）。'
    )
  }
  if ((/qwen|通义/.test(m) || m.includes('vl')) && isGoogleGeminiEndpoint(u) && !/gemini/.test(m)) {
    return (
      '当前接口地址为 Google Gemini，但模型名为阿里云千问系。请将 LLM_VISION_MODEL 改为 Gemini 多模态模型（如 gemini-2.5-flash），' +
      '或将 LLM_API_BASE_URL 改回阿里云兼容地址并配套 Key。'
    )
  }
  return null
}

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

/** 微信云控制台「返回结果」需为可 JSON 序列化的纯对象，避免出现 (空) */
function cloudSafe(payload) {
  try {
    return JSON.parse(JSON.stringify(payload))
  } catch (e) {
    console.error('[chatCompletion] cloudSafe failed', e)
    return { success: false, message: '返回数据序列化失败，请重试' }
  }
}

function invokeRequestId(context) {
  const c = context || {}
  return (
    c.request_id ||
    c.invoke_request_id ||
    c.REQUEST_ID ||
    c.requestId ||
    c.awsRequestId ||
    undefined
  )
}

async function runChatCompletion(event = {}, context) {
  console.log('[chatCompletion] enter', {
    reqId: invokeRequestId(context),
    hasImage: !!(event && event.imageUrl),
    hasMessages: !!(event && event.messages && event.messages.length)
  })

    let axios
    try {
      axios = require('axios')
    } catch (loadAxios) {
      console.error('[chatCompletion] axios missing', loadAxios)
      return {
        success: false,
        message:
          '云函数未包含 axios 依赖。请在微信开发者工具中对 chatCompletion 选择「上传并部署：云端安装依赖」，或在函数目录执行 npm install 后重新上传。'
      }
    }

    const apiKey = process.env.LLM_API_KEY
    if (!apiKey) {
      return { success: false, message: '未配置 LLM_API_KEY' }
    }

    const url =
      process.env.LLM_API_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    const imageUrl = String(event.imageUrl || '').trim()
    const textModel = process.env.LLM_MODEL || 'qwen-plus'
    /**
     * 识图：必须用支持 multimodal 的模型。
     * - 阿里云： LLM_VISION_MODEL 如 qwen-vl-plus（未配置时默认）。
     * - Google 官方： LLM_API_BASE_URL 指向 googleapis OpenAI 兼容地址。
     * - API易等 OpenAI 兼容中转： LLM_API_BASE_URL 填中转商给的完整 chat/completions URL，LLM_VISION_MODEL 填控制台模型名。
     *   gemini-2.5-flash-image 偏图像能力；纯账单 OCR 可试 gemini-2.5-flash。
     */
    const visionModel =
      String(process.env.LLM_VISION_MODEL || '').trim() || defaultVisionModel(url)
    const model = imageUrl ? visionModel : textModel

    const mismatch = describeEndpointModelMismatch(url, model, !!imageUrl)
    if (mismatch) {
      return { success: false, message: mismatch.slice(0, 450) }
    }
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
      console.log('[chatCompletion] llm_request', {
        model,
        hasImage: !!imageUrl,
        timeoutMs: httpTimeoutMs(imageUrl)
      })
      const resp = await axios.post(
        url,
        {
          model,
          temperature: 0.5,
          max_tokens: 2048,
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
      const data = e && e.response && e.response.data
      const nestedErr = data && data.error && typeof data.error === 'object' ? data.error : null
      const vendorError =
        nestedErr ||
        (data && (data.error || data.message || data.msg || data)) ||
        null
      console.error('chatCompletion failed', vendorError || (e && e.message) || e)
      let vendorMsg = ''
      if (vendorError && typeof vendorError === 'object') {
        vendorMsg =
          vendorError.message ||
          vendorError.msg ||
          (vendorError.code != null ? String(vendorError.code) : '') ||
          ''
        if (!vendorMsg) {
          try {
            vendorMsg = JSON.stringify(vendorError)
          } catch (_) {
            vendorMsg = 'upstream_error'
          }
        }
      } else if (typeof vendorError === 'string') {
        vendorMsg = vendorError
      }
      if (
        imageUrl &&
        /multimodal|vision|image|不支持|not support|invalid_model|404|401|403/i.test(String(vendorMsg))
      ) {
        vendorMsg = `${vendorMsg || '识图调用失败'}。${visionFailureHint(url)}`
      }
      return {
        success: false,
        message: (vendorMsg || (e && e.message) || '模型调用失败').slice(0, 400)
      }
    }
}

exports.main = async (event, context) => {
  try {
    return cloudSafe(await runChatCompletion(event, context))
  } catch (fatal) {
    console.error('[chatCompletion] fatal', fatal && fatal.stack ? fatal.stack : fatal)
    return cloudSafe({
      success: false,
      message: `云函数执行异常（多为初始化失败或未安装依赖）：${fatal && fatal.message ? fatal.message : String(fatal)}`.slice(
        0,
        450
      )
    })
  }
}
