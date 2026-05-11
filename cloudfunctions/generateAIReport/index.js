const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function buildPrompt(ctx) {
  return `你是一位资深财务规划师，根据以下用户数据生成详细财务诊断报告。
请使用中文 Markdown 输出，结构必须包含：
1. 核心结论（3-5条）
2. 风险评估（短期/中期）
3. 机会点（可执行）
4. 未来12个月行动计划（按月或按阶段）
5. 推荐学习资源（技能、职业与财务管理）
6. 关键监控指标（至少5项）

用户数据：
- 资产负债：${JSON.stringify(ctx.snapshot)}
- 模拟参数：${JSON.stringify(ctx.params)}
- 模拟结果（未来12个月净值）：${JSON.stringify(ctx.result && ctx.result.monthlyNetWorth)}
- 用户担忧：${ctx.biggestWorry || '未知'}
- 核心技能：${ctx.coreSkill || '未知'}

要求：
- 结论务实，不空泛
- 每个建议要有“为什么 + 怎么做 + 可衡量目标”
- 给出至少2个保守方案与1个进取方案的建议对比
- 避免免责声明式废话`
}

async function callLLM(prompt) {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      text: '',
      message: '未配置 LLM_API_KEY'
    }
  }
  const url =
    process.env.LLM_API_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  const model = process.env.LLM_MODEL || 'qwen-plus'

  try {
    const requestPromise = axios.post(
      url,
      {
        model,
        temperature: 0.7,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: '你是资深财务规划顾问。' },
          { role: 'user', content: prompt }
        ]
      },
      {
        timeout: 10000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    )
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM client timeout')), 11000)
    )
    const resp = await Promise.race([requestPromise, timeoutPromise])

    const text =
      resp.data &&
      resp.data.choices &&
      resp.data.choices[0] &&
      resp.data.choices[0].message &&
      resp.data.choices[0].message.content

    if (!text) return { ok: false, text: '', message: '模型返回为空' }
    return { ok: true, text }
  } catch (e) {
    console.error('generateAIReport llm error', e.response && e.response.data ? e.response.data : e)
    return { ok: false, text: '', message: e.message || '模型调用失败' }
  }
}

function fallbackReport(simDoc, health, snap) {
  const arr = (simDoc.result && simDoc.result.monthlyNetWorth) || []
  const start = arr.length ? arr[0] : 0
  const end = arr.length ? arr[arr.length - 1] : 0
  const delta = end - start
  return `# AI财务诊断报告（降级版）

## 核心结论
- 当前模拟方案「${simDoc.name}」下，12个月净值变化约为 **${Math.round(delta)} 元**。
- 若失业期较长，现金流压力主要集中在前 ${simDoc.params.unemploymentMonths || 0} 个月。
- 建议优先优化固定支出与应急金储备，避免一次性投入过大。

## 风险评估
- 短期风险：失业期收入中断导致净值快速下滑。
- 中期风险：若新收入低于原收入且支出恢复过快，净值修复速度慢。

## 机会点
- 通过降低非必要支出（10%-20%）可明显延长现金流安全期。
- 将培训投资分期，可降低前3个月资金压力。

## 未来12个月行动计划
1. 第1-2个月：盘点固定支出，建立应急预算。
2. 第3-6个月：执行收入替代计划（副业/岗位转型）。
3. 第7-12个月：恢复长期投资，但控制风险敞口。

## 推荐学习资源
- 个人现金流管理与预算方法
- 职业技能升级（与核心技能“${health.coreSkill || '待识别'}”相关）
- 基础风险管理与保险配置

## 关键监控指标
- 月结余率
- 应急金覆盖月数
- 资产负债率
- 失业期实际支出偏差
- 新收入恢复进度

> 备注：当前为模型不可用时的降级报告。请配置 LLM_API_KEY 获取更个性化建议。`
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const simulationId = event.simulationId

  if (!openId) return { success: false, message: '缺少 openId' }
  if (!simulationId) return { success: false, message: '缺少 simulationId' }

  try {
    const [uRes, simRes, hrRes, snapRes] = await Promise.all([
      db.collection('users').where({ openId }).limit(1).get(),
      db.collection('simulations').doc(simulationId).get(),
      db.collection('health_reports').where({ openId }).orderBy('createdAt', 'desc').limit(1).get(),
      db.collection('balance_snapshot').where({ openId }).limit(1).get()
    ])

    const user = uRes.data && uRes.data[0]
    const isVip = !!(user && user.isVip && Number(user.vipExpireAt) > Date.now())
    if (!isVip) return { success: false, message: '会员专属功能，请先开通会员' }

    const simDoc = simRes.data
    if (!simDoc || simDoc.openId !== openId) {
      return { success: false, message: '模拟方案不存在或无权限' }
    }

    const health = (hrRes.data && hrRes.data[0]) || {}
    const snap = (snapRes.data && snapRes.data[0]) || {}

    const prompt = buildPrompt({
      snapshot: {
        totalAssets: snap.totalAssets || 0,
        totalLiabilities: snap.totalLiabilities || 0,
        netWorth: snap.netWorth || 0,
        assets: snap.assets || [],
        liabilities: snap.liabilities || []
      },
      params: simDoc.params || {},
      result: simDoc.result || {},
      biggestWorry: health.biggestWorry || '',
      coreSkill: health.coreSkill || ''
    })

    const llm = await callLLM(prompt)
    const reportText = llm.ok
      ? String(llm.text).trim()
      : fallbackReport(simDoc, health, snap)

    await db.collection('simulations').doc(simulationId).update({
      data: {
        reportText,
        reportUpdatedAt: Date.now(),
        reportModel: llm.ok ? (process.env.LLM_MODEL || 'qwen-plus') : 'fallback'
      }
    })

    return {
      success: true,
      reportText,
      usedFallback: !llm.ok,
      fallbackReason: llm.ok ? '' : llm.message || ''
    }
  } catch (e) {
    console.error(e)
    return { success: false, message: e.message || '生成失败' }
  }
}
