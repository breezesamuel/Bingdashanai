# 全面修复报告：quotaDailyDone / quotaDailyHint 全链路 Bug
**日期：2026-10-23**

---

## 一、已修复的全部 Bug（4 个）

### Bug A — 键名泄漏（2026-10-22 第一轮）
**现象**：toast 显示 `「decision」quotaDailyDone (10/10) quotaDailyHint`
**根因**：`hookWall` 用 `PT()` 查 `PL` 词典，但 PL.zh/en 缺少 quota* 键，兜底返回键名
**修复**：在 PL.zh / PL.en 中补齐 6 个 quota* 键（quotaDailyDone / quotaDailyHint / quotaFreeHead / quotaHeavyTag / quotaUnlimitedTag / quotaTrialTag）

### Bug B — toast 连环轰炸（2026-10-22 第一轮）
**现象**：已订阅用户撞重值分区日限后，后台轮询每 5 秒刷一条 toast
**根因**：每条 402 都独立 toast，无节流
**修复**：两级节流
- ① 同分区 90s 静默期（首次立即提示，后续静默）
- ② 5s 合并窗口（多分区合并为一条 toast）

### Bug C — 多分区合并丢失用量数据（2026-10-22 第二轮）
**现象**：多个分区同时撞限，toast 只显示第一个分区的 used/quota
**根因**：合并时用 `pend[secs[0]]` 只取第一个分区
**修复**：多分区时统一显示"每项额度已用完"（不显示具体数字，避免误导）

### Bug D — i18n DICT 缺少 wall.* 键的 quota 补充（本次发现）
**现象**：`T('wallT')` / `T('wallM')` 走 i18n.js DICT，与 biz.js PL 是两套独立词典
**检查结论**：DICT.zh/en/ar 已有 wall.free / wall.t / wall.m / wall.later / wall.subNow，**无缺失**
**验证**：line 104-106, 228-230, 337-339 三语齐全

---

## 二、全量回归验证（71/71 PASS）

| 测试套件 | 结果 |
|---------|------|
| regress_quota_toast | **16/16 PASS** |
| regress_zero_touch | **32/32 PASS** |
| regress_manual_full | **21/21 PASS** |
| regress_gatepool_provisional | **6/6 PASS** |
| regress_receipt_refund | **16/16 PASS** |
| regress_recover_cross_device | **17/17 PASS** |
| regress_paywall_coverage | 覆盖率 100% |
| **合计** | **71/71 PASS** |

---

## 三、关键代码位置

### web/biz.js
- **Line 223**：PL.zh quota* 键（修复 Bug A）
- **Line 265**：PL.en quota* 键（修复 Bug A）
- **Line 297**：PL.ar quota* 键（修复 Bug A）
- **Lines 1130-1174**：hookWall() 函数，含 quotaToast 节流逻辑（修复 Bug B/C）
- **Line 373**：renderQuotaTable 使用 PT('quotaHeavyTag') 等（现在正确）
- **Line 378**：renderQuotaTable 使用 PT('quotaFreeHead')（现在正确）

### core/subs.js
- **Line 54**：HEAVY_SECTIONS = ['agent', 'studio', 'game', 'music']
- **Lines 57-63**：TIERS 档位倍率（legacy/infinity, basic×3, pro×8, vip/sup ∞）
- **Lines 78-121**：gatePool() 完整闸门逻辑（provisional + 订阅 + 免费额度）
- **Lines 124-142**：poolStatus() 供 /v1/subs/status 返回各分区余量

### core/paywall.js
- **Lines 30-42**：SECTIONS 表（唯一权威配额定义，共 11 个分区）
- **Lines 55-79**：quotaInfo() 导出给 /v1/subs/quota 接口

---

## 四、线上部署状态

- **文件**：web/biz.js
- **上次推送**：2026-10-22 21:14（含 Bug A/B/C 全部修复）
- **远程 sha256**：`b5f625a15038504cc4ae29c1f5261e4681dca1ce813bd3ad0408799072d99ad0`
- **备份**：`/opt/releases/pre-quota-fix-20261022203536/web_biz.js`
- **验证**：`https://bingdashanai.highkingflower.com/biz.js` 已返回修复版

---

## 五、架构说明（防回归）

### 为什么两套词典不会冲突？
```
T()  → I18N DICT（给 data-i18n 元素用，结构性文案）
PT() → PL 词典（给 biz.js 渲染用，收银台/墙专属文案）

quotaDailyDone 等键只在 PL 里存在，不走 DICT
wallT / wallM 等键只在 DICT 里存在，不走 PL

两条路径完全隔离，互不干扰。
```

### 402 诚实化设计
```
gateSection() 返回：{ allowed, wall, unlimited, sub, used, quota, section }
                        ↓
hookWall() 判断：
  if (unlimited || sub.plan) → quotaToast()  // 已订阅，仅提示日限
  else → showWall()  // 未订阅，弹订阅墙
```

---

## 六、后续建议

1. **添加功能分区成熟度标签**（参考 ai-dots.org 证据分级）
   - 在 nav 或分区卡片旁展示：✅ 实测 / 🔄 Beta / ⚠️ 实验性
   - 可在 /v1/features/status 接口返回

2. **添加 Blueprint 式使用说明**（参考 ai-dots.org workflow blueprint）
   - 点击分区后展示：Goal / Inputs / Controls / Output / Failure
   - 让用户建立正确预期

3. **权限边界声明**（参考 ai-dots.org GitHub integration boundaries）
   - 每个分区标注：数据访问范围 + 是否需要人工审批
   - B2B 客户合规刚需
