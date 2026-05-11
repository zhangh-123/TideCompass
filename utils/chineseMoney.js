/** 人民币整数金额转中文大写（财务常用） */

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const UNITS = ['', '拾', '佰', '仟']

function fourDigitsToCn(n) {
  let s = ''
  let zeroPending = false
  for (let i = 3; i >= 0; i--) {
    const p = Math.floor(n / 10 ** i) % 10
    const u = UNITS[i]
    if (p === 0) {
      zeroPending = true
      continue
    }
    if (zeroPending && s) s += DIGITS[0]
    zeroPending = false
    s += DIGITS[p] + u
  }
  return s || DIGITS[0]
}

/**
 * @param {number} amount - 元，可为负；按整数处理
 */
function toChineseMoneyUpper(amount) {
  let n = Math.round(Number(amount) || 0)
  if (n === 0) return '零圆整'

  const neg = n < 0
  if (neg) n = -n

  const yi = Math.floor(n / 1e8)
  const wan = Math.floor((n % 1e8) / 1e4)
  const ge = n % 1e4

  let parts = []
  if (yi > 0) {
    parts.push(fourDigitsToCn(yi) + '亿')
  }
  if (wan > 0) {
    parts.push(fourDigitsToCn(wan) + '万')
  }
  if (ge > 0) {
    let geStr = fourDigitsToCn(ge)
    if (wan > 0 && ge < 1000) {
      geStr = DIGITS[0] + geStr
    }
    if (yi > 0 && wan === 0 && ge > 0 && ge < 10000) {
      geStr = DIGITS[0] + geStr
    }
    parts.push(geStr)
  }

  let core = parts.join('')
  core = core.replace(/零+/g, '零').replace(/零万/g, '万').replace(/零亿/g, '亿')
  core = core.replace(/亿万/g, '亿')

  return (neg ? '负' : '') + core + '圆整'
}

module.exports = {
  toChineseMoneyUpper
}
