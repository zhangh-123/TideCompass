# TideCompass（财富罗盘）

微信小程序「财富罗盘」的源代码仓库：面向个人财务场景的记账、预算、负债梳理与可视化报告，并接入云端能力与 AI 相关能力（对话记账、报告生成、文件解析等）。

## 功能概览

| 模块 | 说明 |
|------|------|
| 账号与安全 | 登录、手机号绑定、用户资料 |
| 财务体检 / 评估 | 引导式评估、`pages/assessment`；支持多图依次 OCR，识图后弹窗会提示核对并自动清洗无关/重复句（`utils/ocrReviewText.js`）；输入框固定单行高度、对话区自动滚底；用户画像拼入 system 提示词见 `utils/assessmentUserContext.js`；对话解析见 `utils/extractHelper.js` |
| 报告 | 报告生成流程、双表诊断页 `pages/report`（四维雷达 + 分数说明文案）、详情与图表（含 ECharts） |
| 首页与导航 | `pages/index`、引导页 `carousel` |
| 收支 | 手动记账、流水列表、对话式记账（`chat_add`） |
| 资产与现金流 | 余额快照、`balance`，预算 `budget` |
| 负债 | 负债罗盘 `debt_compass` |
| 分析与仿真 | 压力测试、现金流仿真、AI 报告页 |
| 年费 / 会员 | VIP 与订单相关页面及云函数回调 |
| 运营 | 管理后台入口 `admin` |
| 其他 | 年度账单、文件上传与解析等 |

详细页面路由见根目录 `app.json` 的 `pages` 列表。

## 技术栈

- **客户端**：微信小程序（WXML / WXSS / JS）
- **图表**：ECharts（`echarts`、`echarts-for-weixin`，小程序内使用 `components/ec-canvas`）
- **服务端**：微信云开发 **云函数**（目录 `cloudfunctions/`，含记账、预算提醒、短信、订阅消息、AI 对话 `chatCompletion`、解析 `parseFile`、报告生成等）

## 仓库结构（简要）

```
├── app.js / app.json / app.wxss   # 小程序入口与全局配置
├── pages/                         # 各业务页面
├── components/                    # 公共组件（含 ec-canvas）
├── utils/                         # 工具与状态机等（含 `ocrReviewText.js` 识图结果清洗）
├── cloudfunctions/                # 云函数（每个子目录独立部署）
├── ui-prototypes/                 # 原型或静态 HTML 实验页（非小程序运行时）
├── project.config.json            # 微信开发者工具工程配置
└── package.json                   # 前端依赖（如 ECharts）
```

## 本地开发说明

1. 使用 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) 打开本仓库根目录。
2. 在工具中配置小程序 AppID，并关联 **云开发** 环境（云函数需在对应环境中上传部署）。
3. 根目录执行 `npm install`（如需构建或安装 `echarts` 等依赖；具体以团队约定为准）。
4. **切勿**将 API 密钥、支付密钥、数据库连接串等写入仓库；敏感配置使用云函数环境变量或本地/private 配置（并已加入 `.gitignore`）。
5. 管理员在云库删除用户后，同一微信再次登录会重建账号：客户端会清理本地体检缓存（含 `assessmentData`），路由侧也会丢弃「完成时间早于当前账号创建时间」的残留报告数据，避免直接进入诊断报告页。

## 文档与版本维护约定

- **对本项目有较大改动时**（例如：新增核心业务模块、修改云函数架构、变更主要数据流或对外接口）：应同步更新本 `README.md`（功能列表、结构说明、部署注意事项等），并 **提交 Git 并推送到远程**，便于协作者与后续迭代对齐现状。
- 较小改动（单页文案、样式微调）可按需要决定是否更新 README。

---

仓库：[zhangh-123/TideCompass](https://github.com/zhangh-123/TideCompass)
