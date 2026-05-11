const { TEMPLATE_ID } = require('../sendSubscribeMessage/config')

module.exports = {
  TEMPLATE_ID,

  /**
   * 构造订阅消息 data，keyword 名称必须与所选模板一致，否则会发送失败。
   * 默认示例对应常见「类目 / 已花费 / 预算额 / 备注」四类占位。
   */
  buildBudgetOverrunData(category, spentYuan, budgetYuan) {
    const c = String(category || '支出').slice(0, 20)
    return {
      thing1: { value: c },
      amount3: { value: String(Math.round(spentYuan)) },
      amount4: { value: String(Math.round(budgetYuan)) },
      thing5: { value: '该类本月支出已超过预算' }
    }
  }
}
