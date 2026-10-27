# 成熟度标签 + Blueprint + 权限边界 — 落地报告
**日期：2026-10-23**
**来源：ai-dots.org 逆向借鉴**

---

## 落地了什么

### 1. 能力成熟度标签（Maturity）
每个收费分区（SECTIONS）新增 `maturity` 字段：
- `tested`（✅ 实测稳定）：chatdeep / decision / warboard
- `beta`（🔄 可用）：skill / agent / studio / org / evolve
- `experimental`（⚠️ 实验性）：leadgen / game / music

前端渲染在订阅墙的额度表卡片中，每个功能旁显示对应标签。

### 2. Blueprint 结构化说明
每个分区新增 `blueprint` 对象，5 个字段：
- **Goal**：这个功能做什么
- **Inputs**：需要什么输入
- **Controls**：有哪些控制/限制
- **Output**：产出什么
- **On failure**：失败时表现

以 `<details>` 可展开卡片呈现，点击才展开，避免订阅墙变长。

### 3. 权限边界声明
每个分区新增两个字段：
- **dataScope**：该模块可访问什么数据（B2B 合规刚需）
- **humanReview**（bool）：是否需要人工审批（leadgen / org = true，其余 = false）

---

## 代码改动位置

| 文件 | 改动 |
|------|------|
| `core/paywall.js` | SECTIONS 每个分区加 `maturity` / `blueprint` / `dataScope` / `humanReview`；`quotaInfo()` 导出新字段 + `maturityNote` 说明 |
| `web/biz.js` | PL zh/en/ar 三语各加 14 个键（`matHead` `matTested` `matBeta` `matExperimental` `bpGoal` `bpInputs` `bpControls` `bpOutput` `bpFailure` `bpScope` `bpReview` `bpOpened` `bpReviewYes` `bpReviewNo`）；`renderQuotaTable` 增加成熟度卡片 + Blueprint details 渲染 |
| `web/index.html` | biz.js 版本 bump → `v=20261023b` |
| `tests/regress_zero_touch.js` | 版本号同步 |
| `tests/regress_features_meta.js` | 新增 197 条断言的回归测试 |

---

## 回归验证

| 测试 | 结果 |
|------|------|
| regress_features_meta | **197/197 PASS**（本地 + 线上） |
| regress_quota_toast | **16/16 PASS** |
| regress_zero_touch | **32/32 PASS** |
| regress_manual_full | **21/21 PASS** |
| regress_gatepool_provisional | **6/6 PASS** |

---

## 线上验证（curl 输出）

```
maturityNote_present: True
free[0] key: chatdeep | maturity: tested
free[0] blueprint.goal: 对复杂问题给出带推理链条的结构化判断
free[0] humanReview: False
```

---

## 后续可做的事

1. **成熟度定期校准**：每 2-4 周根据实际故障率/用户反馈调整 maturity 等级（写一个 ops 脚本读钱账本/故障日志）
2. **Blueprint 扩展**：game/music/experimental 分区目前 blueprint 字段偏简，等有实际客户使用后可补充真实 case study
3. **landing 页显示成熟度**：把成熟度标签也展示在 landing.html（当前只在订阅墙里）
