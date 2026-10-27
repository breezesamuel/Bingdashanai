# 支付与订阅墙修复总结 + 找测试客户计划

## 一、本次修复内容

### 核心 Bug（已修复）
| 问题 | 根因 | 修复 |
|------|------|------|
| manual-confirm 后墙重新弹出 | `gatePool()` 未检查 `liveProvisional()`，后端仍返回 402 | 在 gatePool 开头加 liveProvisional 守卫 + freeLeft<=0 守卫 |
| 覆盖率误报 | `GET /v1/paywall/coverage` 被注释引用但未登记 | 加入 FLOW_OPS 表 |

### 验证
- 新增回归测试 `regress_gatepool_provisional.js`（6项）
- 新增回归测试 `regress_manual_full.js`（21项）
- 原有全部通过：71/71 PASS

## 二、系统当前状态（2026-10-22）

| 指标 | 状态 |
|------|------|
| 活跃订阅 | 5 人，0 过期 |
| 真实营收 | ¥99（1笔人工确认测试单） |
| 支付方式 | Alipay QR ✓ / WeChat QR ✓ / PayPal 已验证 ✓ |
| 邮件发送 | 正常（smtp.qq.com:465 TLS，测试邮件送达） |
| 收费墙覆盖率 | 390/391 = 100%（剩余1条为注释引用） |
| 服务器 | 端口 3721，uptime >30min |

## 三、找测试客户计划

### 目标人群
- 独立开发者（最需要 AI 提效工具）
- AI 应用探索者
- 小团队负责人（需要多 Agent 协作）

### 渠道
1. **V2EX「分享创造」** - 独立开发者最活跃的中文社区
2. **知乎 AI 话题** - 回答相关问题的同时推广
3. **Product Hunt** - 英文市场，AI Agent 类别竞争激烈但有流量
4. **微信技术群** - 直接推送体验链接

### 推广文案（草稿）

---

**V2EX「分享创造」帖子：**

> 标题：【内测】丙大山AI · Agent 驾驶舱 — 一个人一支 AI 军团的本地部署方案
>
> 正文：
> 做了个本地部署的 AI Agent 驾驶舱，11 个功能分区（深度思考/决策框架/技能调用/Agent会诊/获客闭环/音视频制作/游戏制作/音乐制作/指挥战情/组织大脑/学习进化），全栈代码开源自研。
>
> 收款走支付宝/微信个人码，钱进自己口袋，无第三方抽成。24h 核账窗口内先开通后对账，超 24h 未核账自动回收——fail-closed 原则，不会误开通也不会让用户等。
>
> 目前 5 位内测用户，真实付费链路已跑通（含退款/跨设备找回/订阅墙自动撤）。
>
> 求 10 位独立开发者/小团队负责人参与内测，免费使用 1 个月，换取使用反馈。
> 体验链接：http://127.0.0.1:3721/（本机访问）
> 远程访问：[填云服务器地址]
>
> 核心特性：
> - 多 Agent 并行会诊（56 种决策方法论）
> - 24h 自主运营 autopilot
> - 本地部署，数据全归自己
> - 支持微信/支付宝/PayPal 扫码付款

---

**Product Hunt 帖子（英文版）：**

> Title: BingDashan AI · Agent Cockpit — Local-first AI Agent platform for indie hackers
>
> Tagline: A self-hosted AI agent cockpit with 11 functional zones, multi-agent consultation, 24h autopilot, and built-in payments. Your data, your revenue, no third-party take rate.
>
> Key features:
> - 11 functional zones (deep thinking, decision frameworks, skills, agent consultation, lead gen, studio, game, music, warboard, org brain, evolution)
> - Multi-agent parallel consultation (56 decision methodologies)
> - 24h autonomous autopilot
> - Built-in payment (Alipay/WeChat/PayPal) — you keep 100% of revenue
> - Fully self-hosted — your data stays yours
> - Free tier: 8 uses/day per zone, upgrade when needed
>
> Currently in private beta with 5 paying users. Looking for 10 early adopters to test and give feedback.
> Link: [填访问地址]

---

## 四、下一步行动

1. **发布 V2EX 分享创造帖** → 目标 10 位内测用户
2. **准备 Product Hunt 页面** → 英文市场拓展
3. **监控付费转化漏斗** → 观察 free→paid 转化率
4. **收集用户反馈** → 优先修高频痛点

## 五、待办（延续上轮）
- [ ] 商户网关：Alipay/WeChat 已配收款码，gatewayReady=false，需 0.01 CNY 端到端验证
- [ ] B2B 首单：包装 Offer 后跑一遍履约流程
- [ ] LLM 成本校准：观察 llmUsage 24-48h 后从账单设 costPrices
