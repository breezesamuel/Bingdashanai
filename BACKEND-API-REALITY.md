# 后台与 API 实况盘点（2026-10-14 实测）

用户要求"后台 + API 可视化""后端运行、前端不展示、隐藏功能"。
**先说诚话：我不打算给你造一个"隐藏功能"清单来显得神秘。** 下面每一个都是代码里真实存在的，
并标明"是否已鉴权""是否对买家可见"。凭空编的隐藏功能比没有更糟。

---

## 一、API 总量与鉴权分层（实测）

| 项 | 实测值 |
|---|---|
| `/v1/*` 路由总数 | **408 个**（`grep -c "p === '/v1"` server.js） |
| 运营级鉴权（`adminAuthedStrict`） | 资金/密钥/闪电层：`/v1/subs/confirm`、`/v1/subs/rotate-admin-token`、`/v1/pay/*`、`/v1/mcp-client/*`、`/v1/lightning/*`、`/v1/wled/*` |
| 运营鉴权（`adminAuthed`） | `/v1/crm/*`、`/v1/settings/*` |
| 回环即放行 | `isLoopback()` — 本机 127.0.0.1 免令牌 |
| 买家可达（公开/付费墙） | `/v1/subs/order`、`/v1/report/seven`（402 付费墙）、`/v1/chat` 等 |

### ⚠️ 一个必须说的风险

**408 个路由本身是商业负债，不是资产。** 审计结论见 `COMMERCIAL-AUDIT.md`：
买家问"我到底买到什么"，408 个路由给不出一个答案。**数量不等于能力，聚焦才是。**

---

## 二、真实存在的"后端运行、前端不展示"的模块

这些不是隐藏功能，是**正确的架构分层**——后台自主跑，驾驶舱只读摘要：

| 模块 | 后端做什么 | 前端展示 |
|---|---|---|
| `core/watchdog.js` | 24h 巡检异常 + 自动修复（`boot/scanNow/patrol/dispatch`） | `/v1/watch` 摘要 |
| `core/self-heal.js` | 诊断→处置→复检闭环（`runOnce/coverage/CATALOG`） | `/v1/settings/health` |
| `core/autopilot.js` | 24h 自主运营轮次（`boot/runOnce/runStep/optimize`） | `/v1/autopilot/status` |
| `core/scheduler.js` | 跟进/触达限流（`tick/followUp/start`，`HOURLY_CAP`/`DAILY_CAP`） | 不单独展示 |
| `core/crawler.js` | 24h 蜘蛛入料（`harvestOnce/ingest/bank`） | `/v1/crawler` |
| `core/memory-hub.js` | 跨模块记忆汇总（`entries/dashboard/counts`） | 大脑面板 |
| `core/lightning.js` | 模型代理层采轨迹 + 奖励 + JSONL 导出 | `/v1/lightning/*`（运营级） |
| `core/wled.js` | 真实成交的物理通知 | `/v1/wled/*`（运营级） |
| `core/free-tier.js` | 10+ 家官方免费额度聚合轮换 | 模型下拉"可用"标记 |

**这些的共同点：后端真在跑，前端只读。这就是你要的形态，而且已经在了。**

---

## 三、诚实边界（重要）

**以下是我不会做的：**

1. **不会为了"神秘感"造隐藏功能。** 没有的东西写进清单 = 幻觉，正是你警告过的。
2. **不会说有"逆向工程/REA/爬虫复制数据"的隐藏管线。** 代码里没有。要有就得真写、真测、真留证据。
3. **不会把 408 个路由说成 408 个能力。** 其中大量是内部管理端点，与买家无关。

**你提到的那些技术名词，实测结论：**

| 名词 | 实测结论 |
|---|---|
| REA / Replica AI 逆向 | 仓库核实结果见 `COMMERCIAL-AUDIT.md` 第 10 节。`replica-skill` 是**逆向工程的方法论 skill 包**，不是可调用的服务 |
| musclemimic / exo | 真实存在但属具身AI/分布式推理，与本项目商业闭环无关 |
| dsh-our-free-model | **唯一直接相关的**：MIT，14,579★，做的正是 `core/free-tier.js` 已在做的事 |
| rf-detr / sam3d body | 视觉模型，真实但无关 |
| 网页爬虫 | `core/crawler.js` + `core/firecrawl.js` 真实存在，已接 GitHub 探测 + 深爬入库 |

---

## 四、下一步（真正能提升"可视化"的）

不是加更多隐藏功能，而是把**已有的**变成买家看得懂的一页：
1. `/v1/architecture`（已有 `core/layers.js`）做成对外可读的"这个系统由什么组成"一页。
2. 后台四引擎（watchdog/self-heal/autopilot/scheduler）的**真实运行证据**汇成一个"系统还活着"的公开状态页。
3. 精简路由：把 408 个收敛到"买家能用的十几个 + 运营用的几十个"，其余标 internal。

---

*本文所有数字为当日代码实测。未列出的功能即不存在，不补白。*
