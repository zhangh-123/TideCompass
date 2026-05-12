/**
 * 财务截图识图 → 可编辑表格（含层级）解析与回写对话文案
 */

function strip(s) {
  return String(s || '').trim()
}

const CATEGORY_KEYS = ['asset', 'liability', 'income', 'expense', 'other']

/** 识图模型须严格输出 JSON（不要 Markdown、不要解释） */
const IMAGE_TABLE_VISION_USER_PROMPT = `请识别这张财务类截图中的条目，输出层级关系。

只输出一个 JSON 对象，键名固定如下（不要用 markdown 代码块包裹）：
{"items":[{"id":"字符串唯一","parent_id":null或字符串,"name":"名称","amount_yuan":数字或null,"category":"asset|liability|income|expense|unknown","is_roll_up":布尔}]}

规则：
1) id 在本图内唯一；无父子关系时 parent_id 为 null。
2) **name 必须是截图里的中文名称**（如「余额宝」「招商鑫悦中短债」「总资产」），**绝对不能把数字金额写在 name 里**；所有金额只能写在 amount_yuan。
3) 若「总资产/合计/基金资产」等与下属分项金额呈汇总关系，请将分项的 parent_id 指向该汇总行 id，并把汇总行 is_roll_up 设为 true；无法判断时不要强行挂靠。
4) category：资产类 asset；负债类 liability；收入 income；支出 expense；不确定 unknown。
5) amount_yuan 为人民币元（整数或小数）；看不清填 null。**禁止**单独用一行只表示「元」作为条目。
6) 不要输出任何 JSON 以外的文字。`

const IMAGE_TABLE_VISION_SYSTEM_PROMPT =
  '你是财务 OCR 结构化助手。严格遵守用户要求的 JSON 格式，勿输出解释性文字。'

function unwrapJsonFromReply(reply) {
  let s = strip(reply)
  if (!s) return ''
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(s)
  if (fence) s = strip(fence[1])
  const objStart = s.indexOf('{')
  const objEnd = s.lastIndexOf('}')
  if (objStart >= 0 && objEnd > objStart) return s.slice(objStart, objEnd + 1)
  return s
}

function normalizeCategory(raw) {
  const u = String(raw || '').toLowerCase()
  if (u === 'asset' || u === 'assets') return 'asset'
  if (u === 'liability' || u === 'liabilities' || u === 'debt') return 'liability'
  if (u === 'income' || u === 'revenue') return 'income'
  if (u === 'expense' || u === 'cost' || u === 'spending') return 'expense'
  return 'other'
}

function formatAmountYuan(n) {
  if (n === null || n === undefined || n === '') return ''
  const x = typeof n === 'string' ? parseFloat(String(n).replace(/,/g, '')) : Number(n)
  if (!Number.isFinite(x)) return ''
  if (Math.abs(x - Math.round(x)) < 1e-6) return String(Math.round(x))
  const s = x.toFixed(2).replace(/\.?0+$/, '')
  return s
}

const NUMERIC_LABEL_RE = /^[\d,]+(?:\.\d+)?$/
const NOISE_LABEL_RE = /^(元|￥|¥|块|人民币|-+|—+)$/

function pickRawLabel(it) {
  const v =
    it.name ??
    it.名称 ??
    it.label ??
    it.item ??
    it.title ??
    it.project ??
    it.项目
  return strip(v)
}

function pickRawAmountField(it) {
  const v =
    it.amount_yuan ??
    it.amountYuan ??
    it.金额 ??
    it.amount ??
    it.value ??
    it.money
  if (v === null || v === undefined || v === '') return null
  return v
}

/** 纠正常见错位：金额填进 name、噪声行等 */
function normalizeVisionRow(it, index) {
  const id = strip(it.id) || `row_${index + 1}`
  const parentRaw = it.parent_id ?? it.parentId ?? it['父节点']
  const parentId =
    parentRaw === null || parentRaw === undefined || parentRaw === ''
      ? null
      : strip(String(parentRaw))

  let label = pickRawLabel(it)
  let amount = formatAmountYuan(pickRawAmountField(it))

  if (NUMERIC_LABEL_RE.test(label.replace(/,/g, ''))) {
    if (!amount) {
      amount = formatAmountYuan(parseFloat(label.replace(/,/g, '')))
      label = `条目${index + 1}`
    } else {
      label = `条目${index + 1}`
    }
  }

  if (!strip(label) && amount) {
    label = `条目${index + 1}`
  }

  if (NOISE_LABEL_RE.test(label)) {
    return null
  }

  if (!strip(label) && !strip(amount)) {
    return null
  }

  return {
    id,
    parentId,
    label,
    amount,
    category: normalizeCategory(it.category ?? it.类型 ?? it.kind),
    isTotal: !!(it.is_roll_up ?? it.isRollUp ?? it.roll_up ?? it.汇总)
  }
}

function parseVisionFinancialTableReply(reply) {
  const jsonStr = unwrapJsonFromReply(reply)
  if (!jsonStr || jsonStr[0] !== '{') return []
  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch (e) {
    return []
  }
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : []
  const out = []
  for (let i = 0; i < items.length; i += 1) {
    const row = normalizeVisionRow(items[i] || {}, i)
    if (row) out.push(row)
  }
  return out
}

function remapMergedRows(items, prefix) {
  const idMap = {}
  items.forEach((it, i) => {
    const old = strip(it.id) || `r${i + 1}`
    idMap[old] = `${prefix}_${old}`
  })
  return items.map((it, i) => {
    const oldId = strip(it.id) || `r${i + 1}`
    const pid = it.parentId ? strip(it.parentId) : null
    const mappedParent = pid && idMap[pid] ? idMap[pid] : null
    return {
      ...it,
      id: idMap[oldId],
      parentId: mappedParent
    }
  })
}

function depthOfRow(id, byId, memo) {
  const m = memo || {}
  if (!id) return 0
  if (m[id] != null) return m[id]
  const row = byId.get(id)
  if (!row || !row.parentId || !byId.has(row.parentId)) {
    m[id] = 0
    return 0
  }
  m[id] = 1 + depthOfRow(row.parentId, byId, m)
  return m[id]
}

/** 为表格渲染附加 depth / padRpx */
function annotateReviewRows(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.id) : []
  const byId = new Map(list.map((r) => [r.id, r]))
  return list.map((r) => {
    const depth = depthOfRow(r.id, byId)
    return {
      ...r,
      depth,
      padRpx: depth * 28,
      categoryIndex: Math.max(0, CATEGORY_KEYS.indexOf(r.category || 'other'))
    }
  })
}

function categoryLabel(key) {
  const m = {
    asset: '资产',
    liability: '负债',
    income: '收入',
    expense: '支出',
    other: '其他'
  }
  return m[key] || '其他'
}

/** 按层级顺序输出（父在前），便于阅读 */
function sortRowsHierarchy(rows) {
  const list = [...rows]
  const byId = new Map(list.map((r) => [r.id, r]))
  const memo = {}
  const depth = (id) => depthOfRow(id, byId, memo)

  list.sort((a, b) => {
    const da = depth(a.id)
    const db = depth(b.id)
    if (da !== db) return da - db
    const ai = list.indexOf(a)
    const bi = list.indexOf(b)
    return ai - bi
  })

  const seen = new Set()
  const ordered = []
  const visit = (id) => {
    const row = byId.get(id)
    if (!row || seen.has(id)) return
    seen.add(id)
    ordered.push(row)
    list
      .filter((r) => r.parentId === id)
      .forEach((ch) => visit(ch.id))
  }
  list.filter((r) => !r.parentId).forEach((r) => visit(r.id))
  list.forEach((r) => {
    if (!seen.has(r.id)) ordered.push(r)
  })
  return ordered
}

/**
 * 转为发送给对话助手的内容（带层级缩进；名称尽量贴近 extractHelper 的关键词习惯）
 */
function serializeReviewRowsForChat(rows) {
  const valid = (rows || []).filter((r) => strip(r.label))
  const annotated = annotateReviewRows(valid)
  const ordered = sortRowsHierarchy(annotated)
  const lines = ordered.map((r) => {
    const indent = '　'.repeat(Math.min(8, Number(r.depth) || 0))
    const amt = strip(r.amount)
    const lab = strip(r.label)
    const totalMark = r.isTotal ? '（汇总）' : ''
    const cat = categoryLabel(r.category)
    if (!amt) return `${indent}【${cat}】${lab}${totalMark}：（金额待填）`
    return `${indent}【${cat}】${lab}${totalMark}：${amt}元`
  })
  return lines.join('\n')
}

/** 非 JSON 时的兜底：把「名称：金额」行变成扁平表 */
function rowsFromPlainFinancialLines(text) {
  const raw = strip(text)
  if (!raw) return []
  const lines = raw.split(/\n/).map(strip).filter(Boolean)
  const rows = []
  let seq = 0

  const pushRow = (labelLine, numPart, unitRaw) => {
    let amountStr = numPart.replace(/,/g, '')
    const unit = unitRaw || '元'
    if (unit === '万') amountStr = String(Math.round(parseFloat(amountStr) * 10000))
    else if (unit === '千') amountStr = String(Math.round(parseFloat(amountStr) * 1000))
    else if (unit === '百万') amountStr = String(Math.round(parseFloat(amountStr) * 1000000))
    else if (unit === '亿') amountStr = String(Math.round(parseFloat(amountStr) * 100000000))
    else amountStr = String(Math.round(parseFloat(amountStr)))
    const lab = strip(labelLine).replace(/^[・•\-\*]\s*/, '')
    if (NOISE_LABEL_RE.test(lab)) return
    seq += 1
    rows.push({
      id: `plain_${seq}`,
      parentId: null,
      label: lab || `条目${seq}`,
      amount: amountStr,
      category: 'other',
      isTotal: /合计|总计|总资|汇总/.test(`${labelLine}${numPart}`)
    })
  }

  for (const line of lines) {
    if (/^【图片/.test(line)) continue
    let m = line.match(/^(.+?)[:：]\s*([\d,]+(?:\.\d+)?)\s*(万|千|亿|百万|元)?/)
    if (m) {
      pushRow(m[1], m[2], m[3])
      continue
    }
    m = line.match(/^([\d,]+(?:\.\d+)?)\s*(万|千|亿|百万|元)?$/)
    if (m) {
      pushRow(`条目${seq + 1}`, m[1], m[2])
      continue
    }
    m = line.match(/^(.+?)\s+([\d,]+(?:\.\d+)?)\s*(万|千|亿|百万|元)?$/)
    if (m && !NUMERIC_LABEL_RE.test(strip(m[1]).replace(/,/g, ''))) {
      pushRow(m[1], m[2], m[3])
    }
  }
  return rows
}

function makeReviewRowId() {
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

module.exports = {
  IMAGE_TABLE_VISION_USER_PROMPT,
  IMAGE_TABLE_VISION_SYSTEM_PROMPT,
  parseVisionFinancialTableReply,
  remapMergedRows,
  annotateReviewRows,
  serializeReviewRowsForChat,
  rowsFromPlainFinancialLines,
  categoryLabel,
  CATEGORY_KEYS,
  makeReviewRowId
}
