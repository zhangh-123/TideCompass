/**
 * 规则引擎：从自然语言解析单笔记账（不接大模型）
 * 返回结构与云函数 addTransaction 对齐：type income|expense，category 为预定义中文类别
 */

const CATEGORIES = ['餐饮', '购物', '居住', '交通', '医疗', '娱乐', '教育', '其他']

/** 类别判定顺序：先匹配更具体的，避免「餐」误伤「打车」等 */
const CATEGORY_RULES = [
  ['交通', /打车|地铁|公交|滴滴|加油|停车|高铁|机票|路费|通行费|过路费/],
  ['餐饮', /吃饭|午餐|晚餐|早餐|外卖|咖啡|奶茶|买菜|夜宵|聚餐|饭馆|饿了么|美团点餐/],
  ['购物', /淘宝|京东|购物|买衣服|买鞋|超市|拼多多|下单|便利店/],
  ['居住', /房租|房贷|物业|水电|燃气|网费|住宿费|房租费/],
  ['医疗', /医院|看病|药|挂号|体检|牙科|诊所/],
  ['娱乐', /电影|游戏|KTV|旅游|演唱会|追剧|视频会员/],
  ['教育', /课程|学费|培训|买书|教材|辅导班|考试费/]
]

const INCOME_RE =
  /收入|赚|发工资|发薪|工资到账|月薪|年薪|奖金|收红包|到账|收款|领到|返现|退款到账|津贴|补贴|分红/

const EXPENSE_RE =
  /花|买|付|支出|消费|刷|缴|交|转账给|还款(?!到账)|请客|下单|订购/

function stripForNote(text, amount) {
  let s = text.trim()
  s = s.replace(/\d+(?:\.\d+)?\s*(?:万|千|元|块|块钱|[kK])/g, '')
  s = s.replace(/\d+(?:\.\d+)?/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length ? s.slice(0, 120) : text.trim().slice(0, 120)
}

function extractAmount(str) {
  const candidates = []
  let m

  m = str.match(/([\d.]+)\s*万/)
  if (m) candidates.push(parseFloat(m[1]) * 10000)

  m = str.match(/([\d.]+)\s*[kK]/)
  if (m) candidates.push(parseFloat(m[1]) * 1000)

  m = str.match(/([\d.]+)\s*千/)
  if (m) candidates.push(parseFloat(m[1]) * 1000)

  const yuanIter = str.matchAll(/([\d.]+)\s*(?:元|块|块钱)/g)
  for (const x of yuanIter) {
    const n = parseFloat(x[1])
    if (!Number.isNaN(n) && n > 0) candidates.push(n)
  }

  m = str.match(/(\d+(?:\.\d+)?)\s*$/)
  if (m) {
    const n = parseFloat(m[1])
    if (!Number.isNaN(n) && n > 0) candidates.push(n)
  }

  const globalNums = []
  const re = /\d+(?:\.\d+)?/g
  while ((m = re.exec(str)) !== null) {
    const n = parseFloat(m[0])
    if (!Number.isNaN(n) && n >= 0.01 && n < 1e9) globalNums.push(n)
  }

  if (!candidates.length && globalNums.length) {
    const filtered = globalNums.filter(
      (n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100)
    )
    const pool = filtered.length ? filtered : globalNums
    candidates.push(pool[pool.length - 1])
  }

  if (!candidates.length) return null

  const amt = Math.max(...candidates.filter((n) => n > 0))
  return amt > 0 ? Math.round(amt * 100) / 100 : null
}

function detectType(text) {
  const inc = INCOME_RE.test(text)
  const exp = EXPENSE_RE.test(text)
  if (inc && !exp) return 'income'
  if (exp && !inc) return 'expense'
  if (inc && exp) {
    if (/发工资|发薪|奖金|分红|到账|收款|收入|补贴|津贴/.test(text)) return 'income'
    return 'expense'
  }
  return 'expense'
}

function detectCategory(text) {
  for (let i = 0; i < CATEGORY_RULES.length; i++) {
    const [cat, regex] = CATEGORY_RULES[i]
    if (regex.test(text)) return cat
  }
  return '其他'
}

/**
 * @param {string} text
 * @returns {{ success: true, data: { type, category, amount, note } } | { success: false, message: string }}
 */
function parseTransaction(text) {
  const raw = (text || '').trim()
  if (!raw) {
    return { success: false, message: '请输入内容' }
  }

  const amount = extractAmount(raw)
  if (amount == null || amount <= 0) {
    return {
      success: false,
      message:
        '未能识别金额或类别，请重新输入，例如‘打车花了35元’'
    }
  }

  const type = detectType(raw)
  const category = detectCategory(raw)

  if (!CATEGORIES.includes(category)) {
    return {
      success: false,
      message:
        '未能识别金额或类别，请重新输入，例如‘打车花了35元’'
    }
  }

  const note = stripForNote(raw, amount)

  return {
    success: true,
    data: {
      type,
      category,
      amount,
      note
    }
  }
}

module.exports = {
  parseTransaction,
  CATEGORIES
}
