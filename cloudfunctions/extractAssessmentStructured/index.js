const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

function httpTimeoutMs() {
  const raw = process.env.LLM_HTTP_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 5000 ? Math.min(n, 120000) : 45000
}

const STRUCTURED_SYSTEM_PROMPT = `你是财务信息结构化抽取助手。请根据完整体检对话输出结构化数据。

**优先数据源**：对话末尾助手（assistant）已向用户确认或汇总的「资产 / 负债 / 收支」结论（如「资产方面」「收支方面」「月支出约 X 万」）。该汇总代表用户确认后的体检结果，应优先采用。
**校验**：用户（user）原话用于核对；若汇总与用户明确更正冲突，以用户最终表述为准。
禁止编造对话中未出现的金额。

必须只输出一个 JSON 对象，不要用 markdown 包裹，不要解释。键如下：
{
  "assets":[{"name":"条目中文名","value_yuan":数字}],
  "liabilities":[{"name":"条目中文名","value_yuan":数字}],
  "monthly_income_yuan":数字或null,
  "monthly_expense_yuan":数字或null,
  "core_skill":"短文本或空字符串",
  "max_worry":"短文本或空字符串"
}

规则：
1) 金额一律为人民币「元」的整数；用户说「万」请换算为元。
2) 房贷剩余本金、车贷余额、信用卡欠款等写入 liabilities；房产市值、基金份额、存款等写入 assets。不要把房贷本金放进 assets。
3) 昨日收益、持仓收益、累计盈亏、分红到账等**流动性盈亏**不要写入 assets（省略该条目）。
4) 月薪、家庭月总收入写入 monthly_income_yuan；**固定月支出合计**（含房贷月供、日常、教育、赡养等分项之和）写入 monthly_expense_yuan；不清楚填 null。未来一次性大额支出（如择校费、首付）不得写入 monthly_income_yuan，也不得当作 monthly_expense_yuan（月供才可计入月支出）。
5) 若整条对话没有任何可用金额，assets、liabilities 可为空数组。
6) name 须简短（≤24字），使用用户原词或通用类目（如「货币基金」「余额宝」「房贷」）。`

function normalizeDialog(dialogHistory) {
  return (Array.isArray(dialogHistory) ? dialogHistory : [])
    .map((x) => ({
      role: x && (x.role === 'assistant' || x.role === 'system') ? x.role : 'user',
      content: String((x && x.content) || '').trim()
    }))
    .filter((x) => x.content)
}

function extractJsonObject(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(s)
  if (fence) s = fence[1].trim()
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try {
    return JSON.parse(s.slice(i, j + 1))
  } catch (e) {
    return null
  }
}

function roundMoney(n) {
  const x = Number(n)
  if (!Number.isFinite(x) || x <= 0) return 0
  return Math.min(Math.round(x), 1e13)
}

function sanitizeRows(rows, side) {
  const NOISE = /收益|盈亏|涨跌额|昨日收益|持仓收益|累计收益|万份收益|七日年化|分红到账|利息到账/i
  const out = []
  if (!Array.isArray(rows)) return out
  for (const r of rows) {
    const name = String((r && (r.name || r.label || r.item)) || '')
      .trim()
      .slice(0, 48)
    const value = roundMoney(r && (r.value_yuan ?? r.value ?? r.amount_yuan ?? r.amount))
    if (!name || value <= 0) continue
    if (side === 'asset' && NOISE.test(name)) continue
    if (side === 'liability') {
      if (/房贷|按揭/.test(name) && value < 1000) continue
      if (value < 10 && !/信用卡/.test(name)) continue
    }
    out.push({ name, value })
  }
  return out
}

function buildPayloadFromParsed(parsed) {
  const assets = sanitizeRows(parsed && parsed.assets, 'asset')
  const liabilities = sanitizeRows(parsed && parsed.liabilities, 'liability')
  const mi = parsed && parsed.monthly_income_yuan != null ? roundMoney(parsed.monthly_income_yuan) : 0
  const me = parsed && parsed.monthly_expense_yuan != null ? roundMoney(parsed.monthly_expense_yuan) : 0
  const coreSkill = String((parsed && parsed.core_skill) || '').trim().slice(0, 80)
  const maxWorry = String((parsed && parsed.max_worry) || '').trim().slice(0, 160)

  return {
    assets,
    liabilities,
    monthlyIncome: mi > 5e6 ? 0 : mi,
    monthlyExpense: me > 2e6 ? 0 : me,
    coreSkill,
    maxWorry
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  if (!wxContext.OPENID) {
    return { success: false, message: '未登录' }
  }

  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) {
    return { success: false, message: '未配置 LLM_API_KEY' }
  }

  const dialogHistory = normalizeDialog(event.dialogHistory)
  const dialogText = dialogHistory.map((m) => `${m.role}: ${m.content}`).join('\n\n')

  const url =
    process.env.LLM_API_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  const model = process.env.LLM_MODEL || 'qwen-plus'

  try {
    const resp = await axios.post(
      url,
      {
        model,
        temperature: 0.05,
        max_tokens: 2500,
        messages: [
          { role: 'system', content: STRUCTURED_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `以下为财务体检对话全文，请抽取结构化 JSON：\n\n${dialogText || '（空）'}`
          }
        ]
      },
      {
        timeout: httpTimeoutMs(),
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

    const parsed = extractJsonObject(content)
    if (!parsed) {
      return { success: false, message: '模型返回无法解析为 JSON' }
    }

    const payload = buildPayloadFromParsed(parsed)
    return { success: true, payload }
  } catch (e) {
    console.error(
      'extractAssessmentStructured failed',
      e.response && e.response.data ? e.response.data : e.message || e
    )
    const vendorMsg =
      (e.response &&
        e.response.data &&
        (e.response.data.message || e.response.data.error || e.response.data.msg)) ||
      ''
    return {
      success: false,
      message: String(vendorMsg || e.message || '结构化抽取失败').slice(0, 300)
    }
  }
}
