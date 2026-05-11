const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

const DEFAULT_SYSTEM_PROMPT = `你是一名财务信息提取专家。从以下对话中提取用户所有与财务相关的事件，包括：
- 收入变化风险（如裁员、降薪）
- 大额一次性支出（学费、医疗、装修等）
- 债务到期
- 资产锁定（定期存款、理财封闭期）
- 未来规划（转行、买房、创业）
对每个事件，输出 JSON 对象，包含：
- description: 描述
- type: 枚举值（income_loss_risk, lump_sum_expense, debt_maturity, asset_locked, plan_career_change, other）
- time: { relativeMonths: 数字（距离现在的月数）, raw: "用户原话" }
- amount: 数字（元，若没有则为 null）
如果用户没有明确时间，但 AI 追问后用户给出了时间，请使用最终给出的时间。

输出格式：一个数组，例如：
[{"description":"公司下季度可能裁员","type":"income_loss_risk","time":{"relativeMonths":3,"raw":"下季度"},"amount":null}]

当前日期为：2025-05-07`

const ALLOWED_TYPES = new Set([
  'income_loss_risk',
  'lump_sum_expense',
  'debt_maturity',
  'asset_locked',
  'plan_career_change',
  'other'
])

function normalizeDialog(dialogHistory) {
  return (Array.isArray(dialogHistory) ? dialogHistory : [])
    .map((x) => ({
      role: x && (x.role === 'assistant' || x.role === 'system') ? x.role : 'user',
      content: String((x && x.content) || '').trim()
    }))
    .filter((x) => x.content)
}

function extractArrayFromText(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch (e) {}

  const text = String(raw).replace(/```json|```/g, '')
  const i = text.indexOf('[')
  const j = text.lastIndexOf(']')
  if (i >= 0 && j > i) {
    try {
      const parsed2 = JSON.parse(text.slice(i, j + 1))
      if (Array.isArray(parsed2)) return parsed2
    } catch (e2) {}
  }
  return null
}

function sanitizeEvents(events) {
  if (!Array.isArray(events)) return []
  return events
    .map((e) => {
      const type = ALLOWED_TYPES.has(e && e.type) ? e.type : 'other'
      const description = String((e && e.description) || '').trim()
      const raw = String((e && e.time && e.time.raw) || '').trim()
      const relativeMonths = Number(e && e.time && e.time.relativeMonths)
      const amountNum = e && e.amount != null ? Number(e.amount) : null

      return {
        description: description || '未命名事件',
        type,
        time: {
          relativeMonths: Number.isFinite(relativeMonths) ? relativeMonths : null,
          raw: raw || ''
        },
        amount: amountNum != null && Number.isFinite(amountNum) ? amountNum : null
      }
    })
    .filter((e) => e.description)
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  if (!openId) return { success: false, message: '未登录' }

  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) return { success: false, message: '未配置 LLM_API_KEY' }

  const dialogHistory = normalizeDialog(event.dialogHistory)
  const dialogText = dialogHistory.map((m) => `${m.role}: ${m.content}`).join('\n')

  const url =
    process.env.LLM_API_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  const model = process.env.LLM_MODEL || 'qwen-plus'

  let timelineEvents = []
  try {
    const resp = await axios.post(
      url,
      {
        model,
        temperature: 0.1,
        max_tokens: 1800,
        messages: [
          { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
          { role: 'user', content: dialogText || '（空对话）' }
        ]
      },
      {
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    )

    const content =
      resp.data &&
      resp.data.choices &&
      resp.data.choices[0] &&
      resp.data.choices[0].message &&
      resp.data.choices[0].message.content

    const rawEvents = extractArrayFromText(content)
    timelineEvents = sanitizeEvents(rawEvents)
  } catch (e) {
    console.error(
      'extractTimelineEvents llm failed',
      e.response && e.response.data ? e.response.data : e
    )
    return { success: false, message: '时间事件提取失败' }
  }

  try {
    await db.collection('health_reports').add({
      data: {
        openId,
        createdAt: Date.now(),
        timeline_events: timelineEvents,
        source: 'assessment_dialog',
        dialogHistory
      }
    })
  } catch (e) {
    console.error('save timeline_events to health_reports failed', e)
    return { success: false, message: '事件提取成功但入库失败', timeline_events: timelineEvents }
  }

  return { success: true, timeline_events: timelineEvents }
}
