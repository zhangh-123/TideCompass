function nowDateText() {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const raw = String(text || '')
  let line = ''
  let row = 0
  for (let i = 0; i < raw.length; i++) {
    const test = line + raw[i]
    if (ctx.measureText(test).width > maxWidth) {
      ctx.fillText(line, x, y + row * lineHeight)
      row += 1
      line = raw[i]
      if (row >= maxLines - 1) break
    } else {
      line = test
    }
  }
  if (row < maxLines) {
    ctx.fillText(line, x, y + row * lineHeight)
  }
}

function drawHeader(ctx, width, title) {
  const g = ctx.createLinearGradient(0, 0, width, 220)
  g.addColorStop(0, '#0f1f3d')
  g.addColorStop(1, '#2563eb')
  ctx.setFillStyle(g)
  ctx.fillRect(0, 0, width, 220)

  ctx.setFillStyle('#ffffff')
  ctx.setFontSize(28)
  ctx.fillText('财富罗盘', 26, 50)
  ctx.setFontSize(18)
  ctx.setFillStyle('rgba(255,255,255,0.9)')
  ctx.fillText('让财务决策更有方向', 26, 80)
  ctx.setFontSize(26)
  ctx.setFillStyle('#ffffff')
  ctx.fillText(title, 26, 130)
  ctx.setFontSize(16)
  ctx.setFillStyle('rgba(255,255,255,0.82)')
  ctx.fillText(nowDateText(), 26, 160)
}

function drawFooter(ctx, width, height) {
  ctx.setFillStyle('#f8fafc')
  ctx.fillRect(0, height - 150, width, 150)
  ctx.setFillStyle('#334155')
  ctx.setFontSize(18)
  ctx.fillText('扫码体验：财富罗盘小程序', 24, height - 95)
  ctx.setFillStyle('#94a3b8')
  ctx.setFontSize(14)
  ctx.fillText('（可替换为小程序码图片）', 24, height - 65)
}

function drawCore(ctx, type, data) {
  ctx.setFillStyle('#0f172a')
  ctx.setFontSize(22)
  let y = 260

  if (type === '体检报告') {
    ctx.fillText(`病历号：${data.caseNoMasked || 'TC-****'}`, 26, y)
    y += 44
    ctx.setFontSize(20)
    ctx.setFillStyle('#475569')
    ctx.fillText(`财务净值：${data.netWorth || '-'}`, 26, y)
    y += 40
    ctx.setFillStyle('#0f172a')
    ctx.setFontSize(20)
    ctx.fillText('最突出洞察：', 26, y)
    y += 30
    ctx.setFillStyle('#334155')
    ctx.setFontSize(18)
    wrapText(ctx, data.keyInsight || '持续关注现金流安全与风险缓冲。', 26, y, 450, 28, 5)
    return
  }

  if (type === '年度报告') {
    ctx.fillText(`年度结余：${data.annualBalance || '-'}`, 26, y)
    y += 44
    ctx.setFillStyle('#475569')
    ctx.setFontSize(20)
    ctx.fillText(`最大支出类别：${data.topExpenseCategory || '暂无'}`, 26, y)
    y += 40
    ctx.setFillStyle('#334155')
    ctx.setFontSize(18)
    wrapText(ctx, data.tip || '建议优先优化最大支出类别预算。', 26, y, 450, 28, 5)
    return
  }

  ctx.fillText(`方案：${data.planName || '模拟方案'}`, 26, y)
  y += 44
  ctx.setFillStyle('#475569')
  ctx.setFontSize(20)
  ctx.fillText(`12个月净值变化：${data.delta || '-'}`, 26, y)
  y += 40
  ctx.setFillStyle('#334155')
  ctx.setFontSize(18)
  wrapText(ctx, data.summary || 'AI建议已生成，可查看完整诊断报告。', 26, y, 450, 28, 6)
}

function drawReportCard(pageCtx, canvasId, data, type) {
  return new Promise((resolve, reject) => {
    const width = 500
    const height = 800
    const ctx = wx.createCanvasContext(canvasId, pageCtx)

    ctx.setFillStyle('#ffffff')
    ctx.fillRect(0, 0, width, height)
    drawHeader(ctx, width, type)
    drawCore(ctx, type, data || {})
    drawFooter(ctx, width, height)

    ctx.draw(false, () => {
      wx.canvasToTempFilePath(
        {
          canvasId,
          x: 0,
          y: 0,
          width,
          height,
          destWidth: 1000,
          destHeight: 1600,
          success: (res) => resolve(res.tempFilePath),
          fail: (e) => reject(e)
        },
        pageCtx
      )
    })
  })
}

module.exports = {
  drawReportCard
}
