# Agent Skills 索引

本目录包含从开源社区装载的 Agent Skills（SKILL.md 格式），
覆盖商业闭环全链路：获客 → 转化 → 留存 → 增长 → 变现。

## 装载来源

| 来源 | 协议 | 说明 |
|---|---|---|
| [gtm-agents](https://github.com/gtmagents/gtm-agents) | Apache-2.0 | 67 GTM plugins / 263 skills，装载其中 28 个对口 skills |
| [CLI-Anything](https://github.com/HKUDS/CLI-Anything) | MIT | Agent-Native CLI 生成器（装载中） |

## 商业闭环映射

```
获客 (Acquisition)      → cold-outreach, social-selling, lead-qualification
转化 (Conversion)       → discovery-calls, objection-handling, crm-hygiene, deal-review, forecast-discipline
留存/粘性 (Retention)   → adoption-playbook, retention-dashboard, sentiment-feedback-loop, risk-scoring-framework, save-play-library, activation-map
客户分层 (Segmentation) → segmentation-framework, customer-analytics
增长 (Growth)           → experiment-design-kit, guardrail-scorecard, hypothesis-library
变现 (Monetization)     → pricing-strategy (elasticity-lab, packaging-framework, pricing-governance, value-messaging, enablement-kit)
市场研究 (Research)     → market-scenario-modeler, research-brief-blueprint, participant-operations-hub, insights-repository-kit
客户成功 (CS)           → executive-ebr-kit
```

## 28 个已装载 Skills

| Skill | 维度 | 用途 |
|---|---|---|
| `cold-outreach` | 获客 | 冷启动外联邮件/消息写作与节奏 |
| `social-selling` | 获客 | 社交媒体获客策略 |
| `lead-qualification` | 获客 | 线索资质评估框架 |
| `discovery-calls` | 转化 | 需求发现电话框架 |
| `objection-handling` | 转化 | 异议处理话术 |
| `crm-hygiene` | 转化 | CRM 数据卫生与流程 |
| `deal-review` | 转化 | 单笔交易复盘 |
| `forecast-discipline` | 转化 | 销售预测纪律 |
| `adoption-playbook` | 留存 | 客户采用推进手册 |
| `retention-dashboard` | 留存 | 留存指标看板 |
| `sentiment-feedback-loop` | 留存 | 客户情感反馈闭环 |
| `risk-scoring-framework` | 留存 | 客户风险评分 |
| `save-play-library` | 留存 | 流失挽回剧本库 |
| `activation-map` | 留存 | 激活路径图 |
| `segmentation-framework` | 分层 | 客户分层框架 |
| `experiment-design-kit` | 增长 | 实验设计工具包 |
| `guardrail-scorecard` | 增长 | 护栏指标记分卡 |
| `hypothesis-library` | 增长 | 假设库 |
| `elasticity-lab` | 变现 | 价格弹性实验 |
| `packaging-framework` | 变现 | 套餐打包框架 |
| `pricing-governance` | 变现 | 定价治理 |
| `value-messaging` | 变现 | 价值信息传递 |
| `enablement-kit` | 变现 | 销售赋能工具包 |
| `market-scenario-modeler` | 研究 | 市场情景建模 |
| `research-brief-blueprint` | 研究 | 研究简报蓝图 |
| `participant-operations-hub` | 研究 | 调研参与者运营 |
| `insights-repository-kit` | 研究 | 洞察仓库 |
| `executive-ebr-kit` | 客户成功 | 高管 EBR 工具包 |

## 与证据管线的关系

这些 skills 是**知识/模板**，产出的是话术、框架、分析。
真实证据仍来自 `core/evidence-pipeline.js`（只收录真实触达回复）。

**正确用法**：用 skill 的框架去触达 → 真实回复自动沉淀为 evidence → 证据驱动决策。
**错误用法**：把 skill 模板内容当证据用（那是臆测，不是证据）。

## 使用方式

每个 skill 目录下读 `SKILL.md` 获取完整指令。
本索引供快速发现用途，具体执行读对应 SKILL.md。
