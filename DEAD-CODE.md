# 死代码归档清单（2026-10-14 核实）

核实方式：全仓库扫描 `require()` 引用 + `package.json` scripts + 文档提及。
**未删除任何文件**——它们没有危害，但会影响"这个项目到底有什么"的判断。统一移到 `_archive/`，需要时能找回来。

## 1. `core/monitor.js` — 零引用的死模块

| 项 | 值 |
|---|---|
| 被 `require()` 次数 | **0** |
| 被 package.json scripts 引用 | 否 |
| 内容 | `{ push, checkAndAlert, startInterval }` — 监控告警推送 |
| 状态 | 已被 `core/watchdog.js` 取代（`{ boot, scanNow, patrol, dispatch, status, recentAlerts, recentHeals }` 功能完全覆盖） |
| 风险 | 零。它甚至没被 `layers.js` 的架构探测点到 |

**结论：该模块是早期设计的残留，能力已被 `watchdog` 完整接管。留着会让人以为"还有一套监控没接线"。**

## 2. `web/app.js.orig` — 217KB 的过期同名副本

| 项 | 值 |
|---|---|
| 被引用次数 | 0（唯一提及是 `COMMERCIAL-AUDIT.md` 里的文件名，非 require） |
| 大小 | 217,863 字节 |
| 风险 | **中**。任何"搜 app.js 看逻辑"的人（包括 AI）都可能读到这份过期版本，做出错误判断 |

## 3. 根目录 10 个冒烟脚本 — 已不在 `test/` 内

`test-chat-smoke.js` `test-chat-smoke50.js` `test-free-tier-discover.js` `test-free-tier-e2e.js`
`test-free-tier-http.js` `test-free-tier-rotate.js` `test-free-tier.js` `test_env.js` `test_env2.js` `wf_breaker_test.js`

| 项 | 值 |
|---|---|
| 被其他文件 require | 0 |
| 被 package.json scripts 引用 | 0（`npm test` 走的是 `test/e2e/suites/goal-e2e-runner.js`） |
| 风险 | **高**（误导性）：它们是临时验证脚本，散在根目录会让人以为"这些是测试入口" |

## 为什么归档而不是删

1. 我没有删除用户文件的授权。
2. `test-free-tier*.js` 记录了早期免费额度调试过程，有历史价值。
3. 归档后可 `git log` / 随时找回，但不再出现在"活跃文件"列表里干扰判断。

## 归档后要做的

```bash
mkdir -p _archive
mv core/monitor.js        _archive/
mv web/app.js.orig        _archive/
mv test-*.js wf_breaker_test.js _archive/     # 仅根目录这 10 个
```

归档后 `layers.js` 的架构探测、`capability.js` 的能力盘点、以及任何"这个项目有哪些文件"的回答都会变干净。
