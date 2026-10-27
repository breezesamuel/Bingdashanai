# SKILL-INTEGRATION-PLAN.md
> 决策中心 · 外部决策技能集成方案（2026-09-29）
> 配套：DECISION-SKILLS-CATALOG.md（49 仓库 / 300+ 技能来源）

---

## 1. 现状衔接（已实测确认）

| 组件 | 状态 | 衔接点 |
|------|------|--------|
| `core/decision.js` | 61 种真实可执行决策框架 | 新技能按 frameworks 结构托管或独立模块 |
| `core/decision_engine.js` | colibri 式 JIT 路由（routeScores/Union/Place/Overlap/Learn） | 外部技能一并进评分路由（框架 = 专家） |
| `core/skills.js` | GitHub 技能下载/调用/审计（`downloadRepo` 实测 OK） | 决策技能作为 skills 的一个新分类加载 |
| `web/app.js` 决策中心 tab | 56 框架 + 导出 CSV + 决策趋势 | 追加「外部决策技能」区块 |
| `/v1/skills/:id/invoke` | 执行即审计 | 决策技能统一走此路由 |

## 2. 集成架构（三层）

```
决策中心决策 Tab
   │
   ├── SkillRegistry ──── 挂载点：core/skills.js registry + 新增 DECISION 分类
   │      ├── Tier1 内嵌型  → 直接移植 SKILL.md 为 decision.FRAMEWORKS 条目（零外部依赖）
   │      ├── Tier2 下载型  → git clone 到 SKILL_ROOT + invoke 时读 SKILL.md 跑流程（需 key）
   │      └── Tier3 引擎型  → 独立子进程/脚本（python），skills.js 调 execFile（现有安全沙箱）
   │
   ├── DataAdapters ──── 决策中心数据底座（首期 4 个）
   │      ├── finskills  (大宗信号：commodity/prices + history + IMF + FRED)
   │      ├── grid402    (电力：/mix//live /spot//live /emissions//live)
   │      ├── alt       (加密情绪：RSS 聚合打分 -1..+1)
   │      └── presage    (预测市场：analyzeMarkets/findOpportunities)
   │
   └── ExecutionLayer → DecisionEngine ──── 复用既有 decision_engine（routeScores）
          ├── 聚合算法：抄 No-Stream 条件栈（模型一致取中位，分歧 stacker 改写）
          ├── 权重：抄 vox logit 空间加权（market_prior 1.5x）
          └── 校准：抄 deusyu superforecasting Brier 结算（概率必须有期限+判定标准，禁止事后改写）
```

## 3. 首期装配序（10 个技能落地）

| # | 技能 | 来源 | 层 | 落地路径 | 依赖 |
|---|------|------|----|----------|------|
| 1 | commodity-macro-signal | finskills | Tier2 | downloadRepo → SKILL_ROOT → invoke 流程 | FINSKILLS_API_KEY(免费) |
| 2 | SKTPG | New1Direction | Tier1 | 移植为 decision.FRAMEWORKS「趋势前瞻」条目 | 无 |
| 3 | superforecasting-skill | deusyu | Tier1 | 8 门流程固化为 frameworks；Brier 台账入 store | 无 |
| 4 | smard-price-watch | smard-cli | Tier2 | downloadRepo + python CLI 封装 | 无（smard 开放 API） |
| 5 | market-skills (L1/L2/L3) | krzysu | Tier1/3 | 指标层纯 math 内嵌；策略层脚本化 | 无 |
| 6 | bdistill-predict | francyjglisboa | Tier1 | 4 阶段结构化预测卡 | 无 |
| 7 | alpha-skills 精选 20 | mphinance | Tier3 | 精选：edge-* 流水线 / stanley-druckenmiller | FMP_API_KEY |
| 8 | ai-crypto-claude | zubair-trabzada | Tier2 | 15 技能按 /crypto 命令挂载 | LLM key |
| 9 | TradingAgents | TauricResearch | Tier3 | LangGraph 子进程包装 | LLM key |
| 10 | forecasting-tools | Metaculus | Tier3 | 聚合引擎独立进程 | LLM + search key |

## 4. 分阶段交付

### Phase 1（本周，无 key，纯内嵌）
- Tier1 全量装：SKTPG / bdistill-predict / superforecasting 8门
- smard-cli 3 技能适配（python CLI 探通）
- 决策中心 tab 追加「外部技能」区块 + 装配状态角标

### Phase 2（下周，免费 key）
- finskills commodity-macro-signal **端到端首单验证**（真实调用 /v1/skills/:id/invoke 得宏观信号 JSON）
- grid402 电力数据适配器
- DecisionEngine 聚合：条件栈 + logit 加权首版

### Phase 3（月底）
- alpha-skills 精选 20 + ai-crypto-claude + TradingAgents
- Metaculus 聚合引擎接入；KPI 记分盘（决策健康度、采纳率、Brier 校准曲线）

## 5. 风险与护栏

| 风险 | 措施 |
|------|------|
| 外部技能含敏感/恶意代码 | 沿用 skills.js 现有 git 白名单 + execFile 数组参数 + 下载至 tmp 隔离 |
| SKILL.md 流程与现有决策路由语义冲突 | 新技能统一作为「决策中心-外部」分类，不污染既有 61 框架路由 |
| LLM 生成概率不可信 | 抄 superforecasting 纪律：无期限+判定标准不登记；Brier 自动结算 |
| 预测市场赔率被当事实 | 全场强制「预测市场当前定价 X%，非 X 会发生」表述（抄 AIsa trend-forecast 规则） |
| Python 依赖（smard/alpha） | 独立 venv + menu 式探测；缺依赖该技能标灰不可用，不阻塞其他技能 |

## 6. 验证口径
- `verify-decision-skills.js`：对每个已装技能跑固定输入断言（如 commodity-macro-signal 必须输出 ENERGY/METALS/AGRICULTURAL/IMPORT 四段 + COPPER 信号）
- 回归：`node test/e2e/suites/sec-e2e.js` 必须仍 37 PASS / 0 FAIL（决策技能不得动既有安全面）
- 前端：`shot-decision.js` 截图确认「外部技能」区块 + 装配状态可见