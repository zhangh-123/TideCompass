/**
 * 图片/识图结果在展示给用户前：去客套、去重、去掉明显与资产负债无关的行。
 */

function strip(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .trim()
}

const BOILERPLATE_LINE =
  /^(以上是|综上|总结[:：]|希望对你|如有疑问|请注意|免责声明|本识别|仅供参考|谢谢|您好|好的|根据您|根据截图|从图中|如图所示)/

function lineLooksFinancial(line) {
  const t = strip(line)
  if (!t) return false
  if (/^【图片\s*\d+/.test(t)) return true
  if (/部分字段|不清晰|无法识别|识别失败|未能识别/.test(t)) return true
  if (/\d/.test(t)) {
    if (
      /[万亿千百元块￥¥]|资产|负债|存款|理财|基金|股票|房贷|车贷|信用卡|余额|合计|总计|收入|支出|月供|欠款|贷款|活期|定期|按揭|借呗|花呗|白条|净值|市值|持仓|份额|本金|利息/.test(
        t
      )
    ) {
      return true
    }
  }
  if (/\d[\d,]*(?:\.\d+)?\s*(?:万|千|亿|百万|元)/.test(t)) return true
  return false
}

function removeBoilerplateLines(lines) {
  return lines.filter((raw) => {
    const t = strip(raw)
    if (!t) return false
    if (BOILERPLATE_LINE.test(t)) return false
    if (/^#{1,6}\s/.test(t)) return false
    return true
  })
}

function dedupeLinesGlobal(lines) {
  const out = []
  const seen = new Set()
  for (const raw of lines) {
    const t = strip(raw)
    if (!t) continue
    const key = t.replace(/\s+/g, '')
    if (key.length < 2) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * @param {string} text 多图时可能含「【图片 n】」分段
 * @returns {string}
 */
function sanitizeOcrReviewText(text) {
  const raw = String(text || '')
  if (!strip(raw)) return ''

  const lines = raw.split(/\n/)
  let cleaned = removeBoilerplateLines(lines)
  cleaned = cleaned.filter(lineLooksFinancial)
  cleaned = dedupeLinesGlobal(cleaned)

  let out = cleaned.join('\n').trim()
  out = out.replace(/\n{3,}/g, '\n\n')
  return out
}

module.exports = {
  sanitizeOcrReviewText
}
