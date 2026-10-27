# 支付/订阅墙 Bug 全面修复 + ai-dots.org 逆向借鉴报告
**日期：2026-10-22**

---

## 一、本轮修复的 Bug（3 个）

### Bug A（已修复，上轮）：quotaDaily* 键名泄漏
- **现象**：toast 显示 `「decision」quotaDailyDone (10/10) quotaDailyHint`
- **根因**：`hookWall` 用 `PT()` 查 `PL` 词典，但 PL.zh/en 缺失 quota* 键，兜底返回键名
- **修复**：在 PL.zh / PL.en 中补齐 `quotaDailyDone`、`quotaDailyHint`、`quotaFreeHead`、`quotaHeavyTag`、`quotaUnlimitedTag`、`quotaTrialTag`

### Bug B（已修复，上轮）：toast 连环轰炸
- **现象**：已订阅用户撞重值分区日限后，后台轮询每 5 秒刷一条 toast
- **根因**：每条 402 独立 toast，无节流
- **修复**：两级节流
  - ① 同分区 90s 静默期（首次立即提示，后续静默）
  - ② 5s 合并窗口（多分区合并为一条 toast）

### Bug C（本次修复）：多分区合并丢失用量数据
- **现象**：多个分区同时撞限，toast 只展示第一个分区的 used/quota，其他分区数据丢弃
- **根因**：`quotaToast` 合并时用 `pend[secs[0]]` 只取第一个分区
- **修复**：多分区时统一显示"每项额度已用完"（不显示具体数字，避免误导）

---

## 二、验证结果

| 测试套件 | 结果 |
|---------|------|
| regress_quota_toast | 16/16 PASS |
| regress_zero_touch | 32/32 PASS |
| regress_manual_full | 21/21 PASS |
| regress_gatepool_provisional | 6/6 PASS |
| regress_receipt_refund | 16/16 PASS |
| regress_recover_cross_device | 17/17 PASS |
| **合计** | **71/71 PASS** |

---

## 三、ai-dots.org 逆向分析

### 3.1 项目定位
独立评测站，对比 OpenAI Dots 和 Meta Muse 两个 AI Agent 产品。
核心差异化：**证据导向**（Official / Verified / Unknown / Not tested）

### 3.2 可借鉴的设计模式

#### 模式 1：证据分级标签（可用于功能状态标识）
ai-dots.org 对每个功能标注可信度：
- **Official** — 厂商官方文档声称
- **Verified** — AI Dots 实测通过
- **Unknown** — 证据不足，不宣称
- **Not tested** — 未测

**→ 可融入 BingDashan**：为各功能分区（chatdeep/decision/agent 等）标注"能力成熟度"：
- ✅ **实测可用** — 已上线并有真实使用记录
- 🔄 **Beta** — 功能存在，部分场景有 bug
- ⚠️ **实验性** — 架构有，但未见真实产出
- ❌ **未就绪** — 仅接口定义，无实现

可以在 `/v1/features/status` 接口返回各分区的能力成熟度，前端展示在分区图标旁。

#### 模式 2：Blueprint 结构化工作流
ai-dots.org 的 workflow blueprint 包含：
- **Goal**：这个工作流要产出什么
- **Inputs**：需要什么输入（GitHub issues / 网页 URL）
- **Controls**：权限边界（只读 / 需人工审批）
- **Output**：最终交付物格式
- **Failure behavior**：出错了怎么办

**→ 可融入 BingDashan**：为每个功能分区提供"使用蓝图"面板，展示：
```
【深度思考 chatdeep】
  Goal: 结构化的复杂问题分析与决策支持
  Inputs: 问题描述 / 上下文文档
  Controls: 每次调用计费；每日 8 次免费，订阅后 50 次
  Output: Markdown 结构化分析报告
  Failure: 额度耗尽 → 次日 0 点重置；订阅升级可即时扩大
```

这比当前单纯显示"每日免费 8 次"更清晰，帮助用户建立正确预期。

#### 模式 3：对比页面（无倾向性）
ai-dots.org 的 "OpenAI Dots vs Meta Muse" 对比表：
- 列：架构、应用接入、审批流程、可用性
- 行：每个产品
- 无 winner label，无 synthetic score
- 每个格子里是事实陈述，不是推荐

**→ 可融入 BingDashan**：如果未来有竞品对标需求，可建立类似的对比框架。但目前更适合用来展示**自己产品各分区之间的对比**（帮助用户理解该买哪个套餐）。

#### 模式 4：定价透明分层
ai-dots.org 的定价结构：
- **FREE $0**：公开指南 + 3 个完整 Blueprint + 基础 Builder
- **PRO $79/年**：Premium Blueprint 库 + 无限模板
- **FOUNDING LIFETIME $149**：终身权益

关键设计：**免费层真的有价值**（不是只有 landing page 的假免费），让人先体验再付费。

**→ BingDashan 现有定价已有类似结构**，但免费额度透明度可以提升（当前"每日免费 N 次"已经够清晰）。

#### 模式 5：清晰的权限边界声明
ai-dots.org 强调每个 workflow 的权限边界：
```
GitHub access, with boundaries
ACCESS  Read first
OUTPUT  Reviewable draft
WRITE   Human approval
COMPATIBILITY  Not tested
```

**→ 可融入 BingDashan**：在收费墙或功能说明页，明确标注每个分区的"权限边界"：
- 数据访问范围（本地 / 云 / 外部 API）
- 是否需要人工审批才能执行
- 输出是否可审核

这对 B2B 客户尤其重要（合规审计需求）。

---

## 四、建议的后续行动

### 高优先级（影响用户体验）
1. **为各分区添加"能力成熟度"标签** — 在功能卡片上显示 ✅/🔄/⚠️
2. **添加 Blueprint 式使用说明** — 点击分区后展示 Goal/Inputs/Output/Failure 结构

### 中优先级（品牌差异化）
3. **创建"丙大山 vs 竞品"对比页** — 如果未来有明确竞品（如 Coze/Dify）
4. **优化免费额度展示** — 在首页显著位置展示"今日剩余次数"，参考 ai-dots.org 的透明风格

### 低优先级（文档/研究）
5. **建立功能证据库** — 记录每个功能的实测状态（参考 ai-dots.org 的证据分级）
6. **完善权限边界说明** — 特别是对外部数据访问的说明（合规需求）

---

## 五、已部署的变更

- **文件**：`web/biz.js`
- **线上状态**：sha256 `b5f625a15038504cc4ae29c1f5261e4681dca1ce813bd3ad0408799072d99ad0`
- **验证**：`https://bingdashanai.highkingflower.com/biz.js` 已返回修复版
- **备份**：`/opt/releases/pre-quota-fix-20261022203536/web_biz.js`
