const cloud = require('wx-server-sdk')
const XLSX = require('xlsx')
const axios = require('axios')
const tencentcloud = require('tencentcloud-sdk-nodejs')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const OcrClient = tencentcloud.ocr.v20181119.Client

const EXPENSE_CATEGORIES = ['餐饮', '购物', '居住', '交通', '医疗', '娱乐', '教育', '其他']

function fmtDateLike(s) {
  const t = String(s || '').trim().replace(/[./]/g, '-').replace(/年|月/g, '-').replace(/日/g, '')
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (!m) return ''
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
}

function guessCategory(desc) {
  const text = String(desc || '')
  if (/打车|地铁|公交|滴滴|加油|停车|高铁|机票/.test(text)) return '交通'
  if (/餐|饭|奶茶|外卖|咖啡|买菜/.test(text)) return '餐饮'
  if (/淘宝|京东|拼多多|超市|购物|下单/.test(text)) return '购物'
  if (/房租|房贷|物业|水电|燃气|住宿/.test(text)) return '居住'
  if (/医院|药|看病|体检|牙/.test(text)) return '医疗'
  if (/电影|游戏|旅游|演唱会|KTV/.test(text)) return '娱乐'
  if (/课程|学费|培训|教材|考试/.test(text)) return '教育'
  return '其他'
}

function extractRowsFromCsvOrXlsx(buffer, ext) {
  let rows = []
  if (ext === 'csv') {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const name = wb.SheetNames[0]
    rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' })
  } else {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    wb.SheetNames.forEach((name) => {
      const part = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' })
      rows = rows.concat(part)
    })
  }
  return rows
}

function normalizeTransactionsFromRows(rows) {
  const out = []
  ;(rows || []).forEach((r) => {
    const keys = Object.keys(r || {})
    const get = (...cands) => {
      for (let i = 0; i < cands.length; i++) {
        const k = keys.find((kk) => kk.toLowerCase().includes(cands[i].toLowerCase()))
        if (k && r[k] !== '') return r[k]
      }
      return ''
    }

    const date = fmtDateLike(get('date', '日期', '交易日', '记账日期'))
    const desc = String(get('description', '摘要', '备注', '商户', '项目', '说明') || '').trim()

    const incomeRaw = Number(get('income', '收入', '贷方', '入账', '流入'))
    const expenseRaw = Number(get('expense', '支出', '借方', '出账', '流出'))
    const amountRaw = Number(get('amount', '金额', '交易金额'))

    let type = 'expense'
    let amount = 0
    if (!Number.isNaN(incomeRaw) && incomeRaw > 0) {
      type = 'income'
      amount = incomeRaw
    } else if (!Number.isNaN(expenseRaw) && expenseRaw > 0) {
      type = 'expense'
      amount = expenseRaw
    } else if (!Number.isNaN(amountRaw) && amountRaw !== 0) {
      type = amountRaw > 0 ? 'income' : 'expense'
      amount = Math.abs(amountRaw)
    }

    if (!date || !amount) return

    out.push({
      date,
      description: desc || '导入流水',
      amount: Math.round(amount * 100) / 100,
      type,
      category: type === 'expense' ? guessCategory(desc) : '其他'
    })
  })

  return out
}

function normalizeAssetsFromText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  const assets = []
  const dedupe = new Set()
  const hasAssetKeyword = (s) =>
    /总资产|资产总额|资产总计|资产|余额宝|基金|理财|存款|现金|银行卡|账户|持仓|市值|总额|保障资产|昨日收益|累计收益|可用额度|借呗|花呗|网商贷|信用卡/.test(
      s
    )
  const amountOnly = (s) => /^[-+]?\d[\d,]*(?:\.\d+)?$/.test(String(s || '').replace(/\s/g, ''))
  const parseAmount = (s) => {
    const m = String(s || '').replace(/\s/g, '').match(/[-+]?\d[\d,]*(?:\.\d+)?/)
    if (!m) return NaN
    return Number(String(m[0]).replace(/,/g, ''))
  }
  const pushAsset = (name, value) => {
    const k = `${name}|${value}`
    if (dedupe.has(k)) return
    dedupe.add(k)
    assets.push({ name, value: Math.round(value * 100) / 100 })
  }

  // 场景1：同一行同时出现“名称 + 金额”
  lines.forEach((l) => {
    if (!hasAssetKeyword(l)) return
    const m = l.match(/([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,30}).*?([-+]?\d[\d,]*(?:\.\d+)?)/)
    if (!m) return
    const name = m[1].trim()
    const value = parseAmount(m[2])
    if (!name || Number.isNaN(value) || value === 0) return
    pushAsset(name, Math.abs(value))
  })

  // 场景2：移动端常见排版，“名称”和“金额”分成相邻两行
  for (let i = 0; i < lines.length - 1; i += 1) {
    const a = lines[i]
    const b = lines[i + 1]
    if (!hasAssetKeyword(a)) continue
    if (!amountOnly(b)) continue
    const value = parseAmount(b)
    if (Number.isNaN(value) || value === 0) continue
    pushAsset(a.slice(0, 24), Math.abs(value))
  }

  // 场景3：全局文本兜底，捕捉关键资产字段（例如“总资产(元)247,179.93”）
  const whole = lines.join('')
  const fieldPatterns = [
    ['总资产', /总资产(?:\(元\))?[:：]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/],
    ['余额宝', /余额宝[:：]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/],
    ['基金', /基金[:：]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/],
    ['保障资产', /保障资产[:：]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/]
  ]
  fieldPatterns.forEach(([name, reg]) => {
    const m = whole.match(reg)
    if (!m) return
    const value = parseAmount(m[1])
    if (Number.isNaN(value) || value === 0) return
    pushAsset(String(name), Math.abs(value))
  })

  return assets
}

async function callImageOCR(buffer) {
  const sid = process.env.TENCENT_SECRET_ID
  const skey = process.env.TENCENT_SECRET_KEY
  if (!sid || !skey) {
    return { success: false, message: '未配置 OCR 密钥，走文本兜底解析' }
  }

  const client = new OcrClient({
    credential: { secretId: sid, secretKey: skey },
    region: process.env.TENCENT_OCR_REGION || 'ap-beijing',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } }
  })

  try {
    const rsp = await client.GeneralBasicOCR({ ImageBase64: buffer.toString('base64') })
    const text = (rsp.TextDetections || []).map((x) => x.DetectedText || '').join('\n')
    return { success: true, text }
  } catch (e) {
    console.error('OCR failed', e)
    return { success: false, message: e.message || 'OCR failed' }
  }
}

function safeJsonParseMaybe(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (e) {}

  const s = raw.indexOf('```') >= 0 ? raw.replace(/```json|```/g, '') : raw
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(s.slice(i, j + 1))
    } catch (e) {}
  }
  return null
}

async function callLLMToStructure(payload) {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) return null

  const baseURL = process.env.LLM_API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  const model = process.env.LLM_MODEL || 'qwen-plus'

  const prompt = `你是财务票据解析助手。请从输入内容里提取结构化 JSON，不要输出任何解释。
输出格式严格如下：
{
  "kind": "transactions" | "assets",
  "transactions": [{"date":"YYYY-MM-DD","description":"","amount":123.45,"type":"expense|income","category":"餐饮|购物|居住|交通|医疗|娱乐|教育|其他"}],
  "assets": [{"name":"","value":123.45}]
}
规则：
1) 如果是流水表/明细，kind=transactions；如果是资产截图/资产清单，kind=assets。
2) 无法判断时优先 assets（尤其当出现“总资产/余额宝/基金/持仓/市值/存款”等关键词）。
3) 日期必须 YYYY-MM-DD。
4) 金额为正数。`

  try {
    const requestPromise = axios.post(
      baseURL,
      {
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(payload).slice(0, 12000) }
        ],
        temperature: 0.1
      },
      {
        timeout: 9000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    )
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM parse timeout')), 10000)
    )
    const resp = await Promise.race([requestPromise, timeoutPromise])

    const txt =
      resp.data &&
      resp.data.choices &&
      resp.data.choices[0] &&
      resp.data.choices[0].message &&
      resp.data.choices[0].message.content
    return safeJsonParseMaybe(txt)
  } catch (e) {
    console.error('LLM parse failed', e.response && e.response.data ? e.response.data : e)
    return null
  }
}

function sanitizeModelResult(result) {
  if (!result || typeof result !== 'object') return null
  const kind = result.kind === 'assets' ? 'assets' : 'transactions'

  const tx = Array.isArray(result.transactions)
    ? result.transactions
        .map((x) => ({
          date: fmtDateLike(x.date),
          description: String(x.description || '').trim().slice(0, 80) || '导入流水',
          amount: Math.abs(Number(x.amount) || 0),
          type: x.type === 'income' ? 'income' : 'expense',
          category: EXPENSE_CATEGORIES.includes(x.category) ? x.category : '其他'
        }))
        .filter((x) => x.date && x.amount > 0)
    : []

  const assets = Array.isArray(result.assets)
    ? result.assets
        .map((x) => ({
          name: String(x.name || '').trim().slice(0, 40),
          value: Math.abs(Number(x.value) || 0)
        }))
        .filter((x) => x.name && x.value > 0)
    : []

  return { kind, transactions: tx, assets }
}

function fallbackFromPlainText(text) {
  const assets = normalizeAssetsFromText(text)
  if (assets.length >= 1) {
    return { kind: 'assets', transactions: [], assets }
  }

  const tx = []
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const l = line.trim()
      if (!l) return
      const d = l.match(/(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2})/)
      const a = l.match(/([\-+]?[\d,]+(?:\.\d+)?)/g)
      const date = d ? fmtDateLike(d[1]) : ''
      if (!date || !a || !a.length) return
      const amount = Math.abs(Number(String(a[a.length - 1]).replace(/,/g, '')))
      if (!amount) return
      const type = /收入|入账|收款|工资|奖金/.test(l) ? 'income' : 'expense'
      tx.push({
        date,
        description: l.slice(0, 80),
        amount,
        type,
        category: type === 'expense' ? guessCategory(l) : '其他'
      })
    })

  const t = String(text || '')
  if (/总资产|资产总额|余额宝|基金|理财|持仓|市值|存款|保障资产/.test(t)) {
    return { kind: 'assets', transactions: [], assets: [] }
  }
  return { kind: 'transactions', transactions: tx, assets: [] }
}

function inferAssetByKeywordAndMaxNumber(text) {
  const raw = String(text || '')
  if (!raw) return null
  const hasAssetHint = /总资产|资产总额|资产|余额宝|基金|理财|持仓|市值|存款|保障资产|我的额度/.test(raw)
  if (!hasAssetHint) return null
  const nums = raw.match(/[-+]?\d[\d,]*(?:\.\d+)?/g) || []
  const values = nums
    .map((x) => Number(String(x).replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (!values.length) return null
  const maxValue = Math.max(...values)
  if (!Number.isFinite(maxValue) || maxValue <= 0) return null
  return { name: '总资产（兜底识别）', value: Math.round(maxValue * 100) / 100 }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const { fileID, fileName = '', action = 'parse' } = event

  if (!fileID) return { success: false, message: '缺少 fileID' }

  const upCol = db.collection('upload_files')

  if (action === 'get') {
    const ex = await upCol.where({ openId, fileID }).orderBy('createdAt', 'desc').limit(1).get()
    if (ex.data && ex.data.length) return { success: true, record: ex.data[0] }
    return { success: false, message: '未找到解析记录' }
  }

  const now = Date.now()
  let recId = ''
  try {
    const add = await upCol.add({
      data: {
        openId,
        fileID,
        fileName,
        status: 'processing',
        createdAt: now,
        updatedAt: now,
        // 不能用 null，后续更新 parsedResult.assets/transactions 会触发字段类型冲突
        parsedResult: {},
        parseError: ''
      }
    })
    recId = add._id
  } catch (e) {
    console.error('add upload_files failed', e)
  }

  try {
    const down = await cloud.downloadFile({ fileID })
    const buffer = down.fileContent
    const lower = String(fileName || fileID).toLowerCase()
    const ext = lower.endsWith('.xlsx') ? 'xlsx' : lower.endsWith('.csv') ? 'csv' : 'image'

    let payload = { kind: 'transactions', transactions: [], assets: [] }
    let rawText = ''

    if (ext === 'csv' || ext === 'xlsx') {
      const rows = extractRowsFromCsvOrXlsx(buffer, ext)
      payload.transactions = normalizeTransactionsFromRows(rows)
      payload.kind = 'transactions'
      rawText = JSON.stringify(rows).slice(0, 8000)
    } else {
      const ocr = await callImageOCR(buffer)
      if (!ocr.success) {
        throw new Error(`OCR服务不可用：${ocr.message || '请开通腾讯云OCR服务'}`)
      }
      rawText = String(ocr.text || '').trim()
      if (!rawText) {
        throw new Error('OCR未识别到文本，请更换更清晰截图后重试')
      }
      payload = fallbackFromPlainText(rawText)
    }

    const llmResult = await callLLMToStructure({ fileName, ext, rawText, preliminary: payload })
    const structured = sanitizeModelResult(llmResult) || payload

    if ((!structured.transactions || !structured.transactions.length) && (!structured.assets || !structured.assets.length)) {
      const fb = fallbackFromPlainText(rawText)
      structured.kind = fb.assets.length ? 'assets' : structured.kind
      structured.transactions = structured.transactions && structured.transactions.length ? structured.transactions : fb.transactions
      structured.assets = structured.assets && structured.assets.length ? structured.assets : fb.assets
    }

    // 兜底策略：文本包含资产关键词但仍未识别出 assets 时，取最大金额作为总资产
    if (!structured.assets || !structured.assets.length) {
      const fallbackAsset = inferAssetByKeywordAndMaxNumber(rawText)
      if (fallbackAsset) {
        structured.assets = [fallbackAsset]
      }
    }

    if (Array.isArray(structured.assets) && structured.assets.length > 0) {
      structured.kind = 'assets'
    }

    if (recId) {
      await upCol.doc(recId).update({
        data: {
          status: 'done',
          parsedResult: structured,
          updatedAt: Date.now(),
          parseError: ''
        }
      })
    }

    return {
      success: true,
      recordId: recId,
      parsedResult: structured
    }
  } catch (e) {
    console.error(e)
    if (recId) {
      await upCol.doc(recId).update({
        data: {
          status: 'failed',
          updatedAt: Date.now(),
          parseError: e.message || String(e)
        }
      })
    }
    return { success: false, message: e.message || '解析失败', recordId: recId }
  }
}
