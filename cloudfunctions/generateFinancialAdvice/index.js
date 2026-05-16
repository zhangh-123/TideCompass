const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

function fmtList(rows) {
  if (!rows || !rows.length) return '（无明细）'
  return rows
    .map((r) => {
      const name = String(r.name || r.type || '项目').trim() || '项目'
      const val = Math.round((Number(r.value) || 0) * (Number(r.count) || 1))
      return `${name} ${val}元`
    })
    .join('；')
}

function fmtTimeline(events) {
  if (!events || !events.length) return '（暂无）'
  return events
    .slice(0, 8)
    .map((ev) => {
      const desc = String(ev.description || ev.title || ev.type || '事件').trim()
      const amt = Number(ev.amount)
      const amtStr = Number.isFinite(amt) && amt > 0 ? `，约${Math.round(amt)}元` : ''
      const when = ev.date || ev.month || ev.time || ''
      return `${when ? when + '：' : ''}${desc}${amtStr}`
    })
    .join('；')
}

function buildPrompt(ctx) {
  return `你是一位资深财务规划师。请根据以下用户数据，生成一段针对其财务状况的个性化分析报告（不少于200字）。

用户信息：
- 职业状态：${ctx.jobStatus}
- 家庭结构：${ctx.familyStructure}
- 月收入：${ctx.monthlyIncome} 元
- 月支出：${ctx.monthlyExpense} 元
- 总资产：${ctx.totalAssets} 元（明细：${ctx.assetsList}）
- 总负债：${ctx.totalLiabilities} 元（明细：${ctx.liabilitiesList}）
- 净资产：${ctx.netWorth} 元
- 近期财务相关事件：${ctx.timelineEvents}
- 核心技能/职业相关：${ctx.coreSkill || '未说明'}
- 用户主要担忧：${ctx.biggestWorry || '未说明'}

要求：
1. 首先评价其净资产状况和负债水平。
2. 指出现金流健康度（月收入减月支出）。
3. 给出1-2条切实可行的改善建议。
4. 语气专业、温暖，对财务状况好的用户予以肯定，对差的用户给予鼓励而不批评。
5. 最后以一句积极的寄语结尾。

请直接输出分析报告文本，不要输出任何额外说明或JSON。`
}

function buildFallback(ctx) {
  const nw = Number(ctx.netWorth) || 0
  const cf = Number(ctx.monthlyIncome) - Number(ctx.monthlyExpense)
  const lines = []

  if (nw > 0) {
    lines.push(
      `从本次体检数据来看，您的净资产约为 ${ctx.netWorth} 元，总资产 ${ctx.totalAssets} 元高于总负债 ${ctx.totalLiabilities} 元，整体资产负债结构相对稳健。`
    )
  } else if (nw < 0) {
    lines.push(
      `本次识别到您的净资产约为 ${ctx.netWorth} 元，负债规模高于资产。请不要焦虑，很多人通过有计划的还款与储蓄可以逐步改善，关键是先稳住现金流。`
    )
  } else {
    lines.push(
      '本次体检显示您的资产与负债规模接近，处于需要精细管理现金流的阶段。建议优先厘清每一笔负债的成本与期限。'
    )
  }

  if (cf > 0) {
    lines.push(
      `按月收入 ${ctx.monthlyIncome} 元、月支出 ${ctx.monthlyExpense} 元估算，月度结余约 ${cf} 元，现金流为正。可考虑将结余的一部分用于应急金或优先偿还高息负债。`
    )
  } else if (ctx.monthlyIncome > 0) {
    lines.push(
      `当前月收入 ${ctx.monthlyIncome} 元、月支出 ${ctx.monthlyExpense} 元，月度现金流为负或偏紧。建议先梳理非必要开支，并避免新增高息负债。`
    )
  } else {
    lines.push(
      '月收入或月支出信息尚不完整，建议补充稳定收入与固定支出数据，以便更准确评估现金流健康度。'
    )
  }

  if (ctx.biggestWorry) {
    lines.push(
      `结合您提到的担忧「${String(ctx.biggestWorry).slice(0, 40)}」，建议预留 3–6 个月刚性支出作为安全垫，并关注近期已识别的时间节点事件。`
    )
  }

  lines.push(
    '可执行建议：① 列出负债利率从高到低，优先偿还成本最高的欠款；② 建立自动转账储蓄习惯，哪怕每月金额不大，也能逐步增厚净资产。'
  )
  lines.push('财务改善是一场马拉松，您已经迈出盘点家底的重要一步，请继续保持节奏，小步快跑也会看见变化。')

  return lines.join('\n\n')
}

function cloudSafe(payload) {
  try {
    return JSON.parse(JSON.stringify(payload))
  } catch (e) {
    console.error('[generateFinancialAdvice] cloudSafe failed', e)
    return { success: false, message: '返回数据序列化失败' }
  }
}

function httpTimeoutMs() {
  const raw = Number(process.env.LLM_HTTP_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 5000 ? Math.min(raw, 55000) : 45000
}

function vendorErrorMessage(e) {
  const vendorError = e && e.response && e.response.data
  if (vendorError && typeof vendorError === 'object') {
    const err = vendorError.error || vendorError
    if (err && err.message) return String(err.message)
    try {
      return JSON.stringify(vendorError).slice(0, 400)
    } catch (_) {
      return 'upstream_error'
    }
  }
  return (e && e.message) || '模型调用失败'
}

async function callLLM(axios, prompt) {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) {
    return { ok: false, message: '未配置 LLM_API_KEY（请在云开发环境变量中配置，与 chatCompletion 相同）' }
  }

  const url =
    process.env.LLM_API_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  const model = process.env.LLM_MODEL || process.env.LLM_ADVICE_MODEL || 'qwen-plus'

  try {
    const resp = await axios.post(
      url,
      {
        model,
        temperature: 0.65,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: '你是专业、温暖的中文财务规划师，只输出分析报告正文。' },
          { role: 'user', content: prompt }
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
    const text =
      resp.data &&
      resp.data.choices &&
      resp.data.choices[0] &&
      resp.data.choices[0].message &&
      resp.data.choices[0].message.content
    if (!text || String(text).trim().length < 80) {
      return { ok: false, message: '模型返回过短' }
    }
    return { ok: true, text: String(text).trim() }
  } catch (e) {
    console.error(
      '[generateFinancialAdvice] llm failed',
      e.response && e.response.data ? e.response.data : e
    )
    return { ok: false, message: vendorErrorMessage(e).slice(0, 400) }
  }
}

async function runGenerateFinancialAdvice(event = {}, context) {
  const reqId =
    (context && (context.request_id || context.requestId || context.REQUEST_ID)) || 'unknown'
  console.log('[generateFinancialAdvice] enter', { reqId })

  const wxContext = cloud.getWXContext()
  if (!wxContext.OPENID) {
    return { success: false, message: '未登录', source: 'error' }
  }

  let axios
  try {
    axios = require('axios')
  } catch (loadErr) {
    console.error('[generateFinancialAdvice] axios missing', loadErr)
    return {
      success: false,
      message:
        '云函数未包含 axios。请在开发者工具中对 generateFinancialAdvice 选择「上传并部署：云端安装依赖」。',
      source: 'error'
    }
  }

  const input = event.report && typeof event.report === 'object' ? event.report : event
  const assets = Array.isArray(input.assets) ? input.assets : []
  const liabilities = Array.isArray(input.liabilities) ? input.liabilities : []
  const monthlyIncome = Math.max(0, Math.round(Number(input.monthlyIncome) || 0))
  const monthlyExpense = Math.max(0, Math.round(Number(input.monthlyExpense) || 0))

  const sumSide = (rows) =>
    rows.reduce((s, r) => s + Math.round((Number(r.value) || 0) * (Number(r.count) || 1)), 0)

  const totalAssets =
    typeof input.totalAssets === 'number' ? Math.round(input.totalAssets) : sumSide(assets)
  const totalLiabilities =
    typeof input.totalLiabilities === 'number'
      ? Math.round(input.totalLiabilities)
      : sumSide(liabilities)
  const netWorth =
    typeof input.netWorth === 'number' ? Math.round(input.netWorth) : totalAssets - totalLiabilities

  const profile = input.profile && typeof input.profile === 'object' ? input.profile : {}

  const ctx = {
    jobStatus: input.jobStatus || profile.jobStatus || '未填写',
    familyStructure: input.familyStructure || profile.familyStructure || '未填写',
    monthlyIncome: monthlyIncome > 0 ? monthlyIncome : '（未提供，分析时跳过精确现金流）',
    monthlyExpense: monthlyExpense > 0 ? monthlyExpense : '（未提供）',
    totalAssets,
    totalLiabilities,
    netWorth,
    assetsList: fmtList(assets),
    liabilitiesList: fmtList(liabilities),
    timelineEvents: fmtTimeline(input.timeline_events || input.timelineEvents),
    coreSkill: input.coreSkill || '',
    biggestWorry: input.biggestWorry || input.maxWorry || ''
  }

  const prompt = buildPrompt(ctx)
  const llm = await callLLM(axios, prompt)

  if (llm.ok) {
    console.log('[generateFinancialAdvice] llm ok', { reqId, len: llm.text.length })
    return {
      success: true,
      analysis: llm.text,
      fromFallback: false,
      source: 'llm',
      message: ''
    }
  }

  console.warn('[generateFinancialAdvice] llm fallback', { reqId, reason: llm.message })
  return {
    success: true,
    analysis: buildFallback(ctx),
    fromFallback: true,
    source: 'rule_fallback',
    message: llm.message || ''
  }
}

exports.main = async (event, context) => {
  try {
    return cloudSafe(await runGenerateFinancialAdvice(event, context))
  } catch (fatal) {
    console.error(
      '[generateFinancialAdvice] fatal',
      fatal && fatal.stack ? fatal.stack : fatal
    )
    return cloudSafe({
      success: false,
      source: 'error',
      message: `云函数执行异常：${fatal && fatal.message ? fatal.message : String(fatal)}`.slice(
        0,
        450
      )
    })
  }
}
