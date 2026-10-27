# skills/ 来源与核验（SOURCES）

本目录是从 GitHub 引进的**第三方 skill（方法论 / 提示词文本）**。它们不参与运行时逻辑，
只作为"商业化与上架"的判断依据与文案来源；产品代码只在
`core/commercial-loop.js` 里按名字读取 `skills/agent-skills/<name>/SKILL.md`。

> 核验时间：**2026-10-14**（UTC）。核验方式：GitHub REST API 实拉
> `GET /repos/{owner}/{repo}` + `GET /repos/{owner}/{repo}/commits/{default_branch}`，
> 逐包比对许可证、默认分支与 HEAD 提交号。下表 SHA 均为**实测返回**，非抄写。

---

## 1. 一览

| 目录 | 上游仓库 | 许可证 | 锁定提交（clone 时 HEAD） | 解决本产品的什么问题 |
|---|---|---|---|---|
| `haiming-app-monetization/` | [HammingDev/haiming-app-monetization](https://github.com/HammingDev/haiming-app-monetization) | MIT | `271d8ab`（main，2026-09-10） | 下载版 App 的**付费墙 / onboarding / 套餐定价**：把"怎么让用户先感知价值再付费"变成可执行方案——直接对应本次修的"下载版没有收费墙"缺口 |
| `app-store-preflight-skills/` | [truongduy2611/app-store-preflight-skills](https://github.com/truongduy2611/app-store-preflight-skills) | MIT | `e52e007`（main，2026-05-29） | **iOS 上架被拒的常见项**（订阅说明、最低功能性、隐私清单、元数据）——iOS/App Store 上架前的自查清单 |
| `greenlight/` | [RevylAI/greenlight](https://github.com/RevylAI/greenlight) | MIT | `fcb36e3`（main，2026-08-05） | **App Store + Google Play 合规扫描器**（Go 工具 + skill），上架前的机器化检查 |
| `claude-skills-founder/` | [emotixco/claude-skills-founder](https://github.com/emotixco/claude-skills-founder) | MIT | `0602cad`（main，2026-10-14） | **定价策略 / 落地页 / GTM / 指标看板 / MVP 范围**——商业闭环与对外发布阶段的判断框架 |
| `marketingskills/` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT | `c7d7dfb`（main，2026-10-14） | **ASO / 冷邮件 / CRO / 留存 / 归因 / 付费墙文案**（含 `skills/aso`、`skills/churn-prevention`、`skills/cro`） |
| `agent-device/` | [callstack/agent-device](https://github.com/callstack/agent-device) | MIT | main（只取 4 个 `SKILL.md`，blob 已校验；核验时树版本 `3d48bb9`） | **真机/模拟器验证**：在 iOS/Android 上跑起来、装得上、点得动——对应"iOS/Android 壳"这条交付线 |
| `agent-skills/`（29 个） | [gtmagents/gtm-agents](https://github.com/gtmagents/gtm-agents) | Apache-2.0 | `78e0419`（main，2026-04-03） | 定价治理 / 激活 / 续费 / 流失挽回 / 冷启动 GTM / 线索资格——`core/commercial-loop.js` 各阶段的判断依据 |

许可证文件已随包落地：`agent-device/LICENSE`（上游 MIT 原文）、`agent-skills/LICENSE`（Apache-2.0 全文）。
其余包自带 `LICENSE`。

---

## 2. `agent-device` 的特殊处理（为什么没有仓库级 SHA）

`callstack/agent-device` 是 **monorepo（约 185MB）**，整仓 clone 会把无关工程拖进本仓库。
因此只取 4 个技巧文件，并用 **git blob SHA** 逐字节核对是否与上游一致（比"记一个提交号"更能证明内容未改）：

| 本地文件 | blob SHA | 与上游 main 比对 |
|---|---|---|
| `skills/agent-device/agent-device/SKILL.md` | `a2447b3e…` | ✅ 一致（1915B） |
| `skills/agent-device/android-emulator/SKILL.md` | `59d4b54f…` | ✅ 一致（1668B） |
| `skills/agent-device/ios-simulator/SKILL.md` | `2a779841…` | ✅ 一致（1651B） |
| `skills/agent-device/dogfood/SKILL.md` | `4e2b9117…` | ✅ 一致（1364B） |

> 更正记录：早前记录里出现过 `128e098` 被当成 agent-device 的提交号。
> 实测 `GET /repos/callstack/agent-device/commits/128e098` 返回 **422 No commit found**——
> 那是我方仓库自己恢复 `server.js` 的提交号，串了。此处以上表的 blob 校验为准。

---

## 3. 这些 skill 在本产品里怎么用

- **运行时只读文本**：`core/commercial-loop.js` 的 `STAGES` 用 `skills: ['activation-map', …]`
  指向 `skills/agent-skills/<name>/`，再用 `readSkill(name)` 读 `SKILL.md` 的 `description`。
  **skill 不执行任何代码**，不存在"第三方脚本自动跑"的供应链执行面。
- **人工/自助引进**：`POST /v1/skills/download { repo, dir }`（`core/skills.js` 的 `downloadRepo`）
  可从 GitHub 拉取新 skill；`GET /v1/skills/verify` 可核对已装载项。
- **不自动外发**：所有冷邮件/触达类 skill 只提供方法论；产品**不会**在无同意的情况下对外发送
  邀请、报价或消息（合规红线，见 `core/` 内的同意与审计约束）。

---

## 4. 升级与复核（照着做）

```powershell
# 1) 记录当前锁定提交（示例）
curl -s https://api.github.com/repos/coreyhaines31/marketingskills/commits/main | findstr sha

# 2) 拉取新版本到某目录后对比差异，再覆盖；不要直接覆盖后不记录
#    覆盖后必须更新本文件的 SHAs，并重跑：
npm test
```

纪律：

1. **先记 SHA 再覆盖**：没有提交号的"引进"无法复核，等于把不可信内容当事实。
2. **许可证先看**：本目录现存包全部 MIT / Apache-2.0。引入 GPL/AGPL 前必须先确认分发影响
   （本项目是要打包进安装包分发的）。
3. **只当方法论文本**：不把 skill 里的数字、承诺、案例当成事实引用；对外文案里的任何
   数据都必须来自本产品自己的真实记录（见 `SERVER-STATUS.md` 的诚实红线）。
