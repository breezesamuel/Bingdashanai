# 服务端文件事故：恢复结论与当前状态（2026-10-14）

> 本文替换了此前"服务端文件损坏、不可自动恢复"的旧结论。**服务端已恢复并全绿。**
> 旧结论之所以悲观，是因为当时假设"必须把损坏文件原地反解回来"——那条路确实走不通，
> 但正确解法不是反解，而是**回到干净的 git HEAD + 补齐新增路由**。

## 一、结论速览

| 项 | 状态 |
|---|---|
| `server.js` | **已恢复可用**（干净 git HEAD `128e098` 为基座 + 扩展模块补齐新增端点） |
| `node --check server.js` | 通过 |
| 全量回归 | **35 套件全绿，996 条断言全过**（`node test/e2e/suites/goal-e2e-runner.js` → `ALL SUITES GREEN`）；含本轮新增的 `license`(42) 与 `download`(29) |
| 授权层 | `core/license.js`（Ed25519 授权码）+ `web/activate.html`；打包版默认客户端模式（`BINGDASHAN_CLIENT=1`） |
| 自助下载 | `web/download.html` + `web/releases.json`（`npm run release:make` 扫真实产物生成，SHA256 本地实算） |
| 缺失的 ~50 个路由 | 已用新模块 `core/server-ext-routes.js` 干净重写并接入 |
| 数据 | 未删除、未迁移任何既有数据 |

## 二、事故与根因

- 事故文件：`server.js`（工作副本，含 HEAD 之后未提交的新增路由）。
- 根因：`fix-encoding2.js`（2026-10-14 11:48）用 PowerShell 的 `Get-Content`/`Set-Content`
  读写 UTF-8 文件，中文注释被按 ANSI 解读后回写，全文件编码损坏。
- 损坏范围：**只有 `server.js` 一个文件**。`core/*`、`web/*` 等全部完好。
- 不可原地反解的实证：按字节错位反解后仍剩下 **6000+ 处语法错误点**（字节对齐丢失 + 标点丢失），
  属不可逆损坏。**保存了字节级备份**（`%TEMP%\server.corrupt.bak.js`）与反解参考（`%TEMP%\server.recovered2.js`）。

## 三、恢复方案（已验证）

1. **恢复干净基座**：`git checkout HEAD -- server.js`
   → 208,542 字节、3923 行、`node --check` 为 0。
2. **新增端点单独成模块**：`core/server-ext-routes.js`。
   - 只实现被损坏工作副本新增、而 HEAD 缺失的端点：
     `/mcp`、`/v1/mcp/rpc`、`/v1/mcp-client/*`、`/v1/lightning/*`、`/v1/wled/*`、`/v1/crm/*`、
     `/v1/auth/*`、`/v1/evidence/*`、`/v1/free-tier[/discover]`、`/v1/reviews[/approve|/pending]`、
     `/v1/waitlist`、`/v1/scheduler/{enable,disable}`、`/v1/projects/from-decision`。
   - 纯 ASCII 业务逻辑按反解文件中可读的原逻辑重写；中文提示文案为重建。
   - 所有新增管理端点用 `adminAuthedStrict`（回环也要求 `X-Admin-Token`）。
3. **接入点**（`server.js` `handle()` 顶部）：`EXT_ROUTE_RE` 同步短路 + `handleExtRoutes(ctx)`，
   位置在收费闸门与"非回环变更 403"之前——否则 `/v1/auth/*`、`/v1/reviews`、`/v1/waitlist`
   这些面向公网访客的入口会被变更限权 403 掉。

**注意（防复发的硬规则）**：绝不用 PowerShell 的 `Set-Content` / `>` 重定向写 `server.js`
（会重新编码内容）。用 node 写文件，或 `cmd /c "… > file"`。

## 四、本轮顺带修掉的三个真 bug

1. **`isLoopback()` 不认代理头（部署安全·关键）**
   经 nginx/caddy 反代后所有请求 `remoteAddress` 都是 `127.0.0.1`，公网任意访客都会被判成
   "本机运营"——运营接口与收费墙对全世界敞开。现在：带 `X-Forwarded-For` / `X-Real-IP` /
   `X-Forwarded-Host` 一律不认回环，必须走管理令牌。
2. **`/v1/report/seven` 未在 `PUBLIC_MUTATE`**
   公网访客的 POST 会先被"变更限权"挡成 403，端点内部的 402 收费墙根本轮不到 → 付费转化链在公网是断的。
   已加入白名单（`sec` 套件 52/0 验证）。
3. **Node http 的"GET 带 body + 处理函数先 await"陷阱**
   在 `handle()` 里无条件 `await` 会让"GET 请求带 body"被 Node 以 400 关闭连接
   （`sec` 套件用 `GET /v1/subs/pay-config` 带 `{}` body 命中过）。改为**只对扩展端点路径**
   同步短路进入异步处理，普通请求的响应时序与改动前一致（`biz` 32/0、`sec` 52/0 验证）。

## 五、回归结果（本机实测）

```
[runner] ALL SUITES GREEN
35 套件全绿 / 996 条断言全过
war 27 · new 13 · biz 32 · sec 52 · autopilot 34 · autoloop 27 · leadfunnel 37 · money 27
fee 21 · outreach 33 · fulfillment 32 · materials 59 · crawler 7 · deepen 14 · notifyverify 11
pay 19 · pay-fund-safety 25 · refund 29 · adoption 39 · harness 18 · ssrf 11 · honesty 17
deliberation 44 · settle 65 · checkout 18 · mcp-protocol 23 · mcp-client 20 · crm 25
delivery-spec 32 · tenancy 27 · license 42 · download 29 · lightning 47 · wled 37 · orca-ws 3
```

运行：`node test/e2e/suites/goal-e2e-runner.js`（或 `npm test`）。

## 六、现在真正的瓶颈（不是代码）

服务端与回归已经不再是瓶颈。剩下的都是**外部许可/真实经营**，只能由你提供：

1. **支付宝直连**：当前 `isv.invalid-signature`（无有效密钥对）→ 不具备在线自动收款能力。
   线上收款目前走"收款码 + 人工/对账确认"这条真实可行路径。
2. **真实客户与营收 = 0**：`loopHealth` 保持 `0`，直到有真实营收才允许 >0（诚实红线，`core/commercial-loop.js`）。
3. **对外分发**：macOS/iOS 需 Apple 硬件与开发者账号；Android 签名需 keystore。
   多平台交付路径与 CI 见 `CROSS-PLATFORM.md`。

---

## 七、本轮新增：授权层 + 客户自助下载（恢复正常之后）

> 本节是**恢复之后**新增的能力，与上文并列。若本节数字与上文冲突，**以本节为准**（本节是本轮最后一次实测）。

### 7.1 修掉"下载版根本没有收费墙"的设计缺口

内置服务只监听 `127.0.0.1`，所有请求都是回环；装到用户机器上以后，原来的"按访客判定"收费墙
等于不存在——用户既是本机运营、又能自己改设置。修法两层：

| 模式 | 触发方式 | 收费墙位置 | 能否绕过 |
|---|---|---|---|
| **客户端模式**（打包默认） | `BINGDASHAN_CLIENT=1` | 本机，用 Ed25519 授权码换权益 | 改本机程序可绕过（离线 DRM 通病，**如实说明**） |
| **托管模式**（不可绕过） | `BINGDASHAN_SERVER_URL=https://域名` | 运营方服务器，看订阅表 | 绕不过；App 只当纯客户端，**不启动本机服务** |

- `core/license.js`：Ed25519 签发/验签/机器绑定/反重用/到期/解绑；客户端**只内置公钥** `license.pub`，
  能验签、**无法伪造**授权码。
- `core/server-ext-routes.js`：`/v1/license/{status,inspect,activate,deactivate,issue,config}`；
  无私钥时 `issue` 返回 **400 `NO_PRIVKEY`**（不是 500）。
- 客户端模式下**禁止**关闭收费墙、**禁止**从系统设置里读公钥（否则用户塞自己的公钥即可自签自验）。
- `web/activate.html`：状态 / 到期 / 剩余天数 / 机器码（可复制）/ 解绑；每个失败码
  （`BAD_SIGN` `EXPIRED` `FP_MISMATCH` `REUSED` `NO_PUBKEY`）都有中文处置说明。
- `scripts/gen-license.js`：`keygen | issue | verify | fp | pub | signing`。
- 私钥放**数据目录**（`data/license.key`，0600、已 gitignore，**务必备份**——丢了所有已发授权码作废）；
  公钥 `license.pub` 在仓库根并打进安装包。

### 7.2 客户自助下载

- `web/download.html`：自动识别来访系统、按平台给按钮、显示真实大小与**真实 SHA256**；
  **没有产出的平台照实写"尚未产出 + 原因"**，绝不放会 404 的假链接。
- `web/releases.json`：`scripts/make-release.js` 扫真实产物生成（`npm run release:make`、
  `-- --copy`、`-- --base <url>`、`--tag`、`--out`）。
- `.github/workflows/release.yml`：打 tag（`v*`）→ 3 家 runner + Android 构建 → **清单里 0 产物则拒绝发布**
  → 挂到 GitHub Release。
- 静态层为 `.exe/.dmg/.apk/.deb/.AppImage/.zip` 补了二进制 MIME + `Content-Disposition: attachment`
  （并过滤文件名，防响应头注入）；Service Worker **不缓存** `/releases.json` 与 `/downloads/*`。

### 7.3 本轮又修掉的一个打包真 bug（会"发出去就是残的"）

`package.json` 的 `build.files` 里有 `"!**/*.md"`，而商务闭环运行时恰好读的是
`skills/agent-skills/<name>/SKILL.md`（`core/commercial-loop.js` 的 `readSkill`/`listSkills`）。
结果：**装到用户机器上的安装包里一个 skill 都没有**，`GET /v1/commercial-loop/skills` 永远返回 `[]`——
文档里写"已装载 29 个方法论包"，用户那里是空的。已加 `"skills/agent-skills/**/*"`（放在
`!**/*.md` **之后**，后置规则覆盖前置排除）。

实测（重新打包后 `asar list`）：

```
skills files in asar: 68
\skills\agent-skills\SKILL.md · \skills\agent-skills\LICENSE · \skills\agent-skills\activation-map\…
.env / license.key 命中：0   ← 机密未进包
```

### 7.3.1 打包纪律（新增）

- `!**/*.md` 这类"一刀切排除"会**连运行时要读的 .md 一起排掉**。凡新增运行时读取的文本资源，
  必须同时在 `build.files` 里加一条**后置**的 include，并用 `asar list` 验证过一次。
- 每次发版前必做：`asar list` 查 `license.pub`、`core/license.js`、`skills/agent-skills/`，
  并确认 `.env` 与 `license.key` **不在**包里。

### 7.4 本轮实测

```
[runner] ALL SUITES GREEN
35 套件全绿 / 996 条断言全过
（新增：license 42 · download 29）
```

- `npm run platform:check` → 本地可验证项全 OK（macOS/iOS/鸿蒙 明确 SKIP 并写明原因）。
- 打包产物 `app/BingDashanAI-2026.0.1-win-x64.exe` 经 `asar` 逐项核对：
  `license.pub` 与仓库内公钥 **SHA256 完全一致**（`223d0a97…`）→ 用本机私钥签发的授权码在该包里可验签。

### 7.5 仍然是"外部许可"而非代码（红线不变）

- **0 客户 / 0 营收**：`loopHealth` 保持 `0`，直到有真实营收才允许 >0。
- 支付宝直连 `isv.invalid-signature` → 不具备在线自动收款能力；线上收款走"收款码 + 人工确认"。
- macOS/iOS 原生包需 Apple 硬件与账号；Android 签名需 keystore；鸿蒙 HAP 需 DevEco（本机不产出，避免伪造）。
