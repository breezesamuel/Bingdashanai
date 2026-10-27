# MCP 协议适配（Model Context Protocol）

标准 MCP（JSON-RPC 2.0）服务端，把本项目的真实能力暴露给任何 MCP 客户端
（Claude Desktop、Cursor、Cline、LibreChat、自研 Agent…）。

> 说明：`core/mcp.js` 与 `/v1/mcp/call` 是**自家 HTTP 包装**，不是 MCP 协议。
> 本文件描述的才是标准 MCP。两者并存，互不影响。

## 协议实现
- 版本：`2025-06-18`（同时兼容 `2025-03-26` / `2024-11-05`，客户端要旧版本会回落）
- 方法：`initialize` · `notifications/initialized` · `ping` · `tools/list` · `tools/call` · `resources/list` · `prompts/list`
- 通知（无 `id`）不返回任何包（协议要求）
- 代码：`core/mcp-protocol.js`（纯协议逻辑）· `mcp-server.js`（stdio）· `server.js`（HTTP 路由）

## 两条传输

### 1）stdio（本地 Agent 挂载）
```bash
node mcp-server.js            # stdout 只出协议帧，日志全走 stderr
```
客户端配置示例：
```json
{
  "mcpServers": {
    "bingdashan": {
      "command": "node",
      "args": ["C:/Users/Think/project/BingDashan/mcp-server.js"]
    }
  }
}
```

### 2）Streamable HTTP（远程）
```
POST /mcp            # 或 /v1/mcp/rpc，等价
Content-Type: application/json
Accept: application/json, text/event-stream
```
- 请求体：一条 JSON-RPC 消息（或数组）；响应：一条 JSON（通知回 `202` 空体）
- `GET /mcp` → `405`（规范要求，声明仅支持 POST）

```bash
curl -s -X POST http://127.0.0.1:3721/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 工具面（真实可用，无占位）
| 工具 | 计费 | 说明 |
|---|---|---|
| `case_search` | 免费 | 检索「活下去手册」案例卡（带水印） |
| `manual_get` | 免费 | 获取手册全文（`no` 1–12 或 `slug`） |
| `decision_deliberate` | ¥0.99/次 | 完整七段推演，需 API key；命中医疗/法律/金融禁区直接拒且不扣费 |
| `business_kpi` | 免费·只读 | 真实经营 KPI（真实到账营收、自测单隔离口径、目标进度） |
| `evidence_status` | 免费·只读 | 商业化证据门禁维度状态 |
| `crm_pipeline` | 免费·只读 | CRM-lite 漏斗摘要（线索/商机/待成交/客户数量、真实到账金额）。**仅聚合计数，不含姓名** |
| `org_brain` | 免费·只读 | 组织大脑概览（在编/在岗、项目数、在跑项目数）。**仅计数，不含人员隐私** |
| `funnel_stats` | 免费·只读 | 获客漏斗各阶段存量 + 真实到账金额。**仅计数，不含线索姓名** |
| `decision_stats` | 免费·只读 | 决策中心统计（累计决策数 + 7 日趋势）。**仅计数，不含决策内容** |
| `lightning_stats` | 免费·只读 | Agent Lightning 轨迹采集统计（rollout 数/成功奖励/调用次数）。**仅计数，不含对话正文** |

只读经营类工具一律只吐**计数与金额**，绝不吐客户/员工姓名或决策正文——公开 MCP 端点不能被
当成客户名单或情报出口。计费工具复用 `core/mcp.js` 的账务红线：必须 API key + 预充值，绝不接受自报金额入账。

## 客户端：接入外部 MCP 服务器（协议适配的另一半）
服务端让别人用我们；客户端让我们用别人。任何 MCP 服务器（stdio 子进程 或 HTTP）都能登记进来当工具用
——这就是"接 instinct / Pipecat / MechAgent / Agent-Reach"的正确姿势：说同一种协议，而不是把 10 套异构栈塞进本项目。

代码：`core/mcp-client.js`（协议客户端）· `core/mcp-hub.js`（注册表 + 连接池）

全部为**运营级**端点（需 `X-Admin-Token`）——登记服务器 = 允许本机起进程/访问任意 URL：

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/v1/mcp-client/servers` | 列出已登记服务器 |
| POST | `/v1/mcp-client/servers` | 登记：`{name, transport:'stdio', command, args}` 或 `{name, transport:'http', url}` |
| POST | `/v1/mcp-client/remove` | 移除：`{id}` |
| GET | `/v1/mcp-client/tools?id=` | 取该服务器工具清单 |
| POST | `/v1/mcp-client/call` | 调用：`{id, name, arguments}` |
| GET | `/v1/mcp-client/health?id=` | 真连健康检查（协议版本 / 工具数 / 延迟） |
| GET | `/v1/mcp-client/selftest` | 连我们自己的 stdio 服务端，端到端自证链路 |

**护栏**：每个请求带超时（默认 20s）；子进程退出/连接断开 → 立即拒绝所有在途请求，绝不永久 pending；
服务器返回的主动请求（sampling 等）回 `-32601`，不吊死连接。

## 测试
```bash
node test/e2e/suites/mcp-protocol-e2e.js   # 23 断言：协议 + 两条传输
node test/e2e/suites/mcp-client-e2e.js     # 20 断言：客户端 + 注册表 + 鉴权
node test/e2e/suites/crm-e2e.js            # 25 断言：CRM-lite 漏斗 + 未确认金额闸门 + 新增只读工具（含不泄漏姓名）
```

## 相关的只读经营视图
- `GET /v1/crm/pipeline` · `/v1/crm/summary` · `/v1/crm/opportunities` · `/v1/crm/customers`
  （`core/crm.js`，运营鉴权；金额只认人工确认真实成交）。是上述 `crm_pipeline` 工具的 HTTP 对应体。

