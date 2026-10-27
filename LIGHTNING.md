# Agent Lightning（原理落地版）：模型代理层 · 轨迹采集 · 奖励 · 训练样本

> 目标能力来自 `microsoft/agent-lightning`（MIT，Python）：在 agent 与底层模型之间插一个
> 代理层，以"旁观者"身份记录每次模型调用与工具使用，在不改 agent 业务代码的前提下，
> 把真实运行轨迹变成强化学习训练样本，用奖励函数驱动策略优化。

## 诚实边界（先说清楚，避免误读）
- **本机不训练任何模型**。Agent Lightning 的 Trainer 是 `verl + vLLM + CUDA`（`uv sync` +
  `scripts/setup_verl.sh`），是 Python + GPU 栈，**装不进这个 Node 项目**。
- 微软公开的 "SWE-bench Verified 47.8% → 61.6%（1.8K 例）"、"Qwen3.5-35B-A3B +14.6pt"
  是**他们的** GPU 环境数据，不是本项目的实测，本项目不声称能复现。
- 本项目实现的是**能在 Node 里真跑的那一半**：代理层 + 轨迹采集 + 奖励计算 + 训练样本导出。
  产物 `data/lightning.jsonl` 可直接喂给外部 RL 训练管线（verl / trl / 自研）。

## 代码
`core/lightning.js`（纯逻辑，零外部依赖）：
- 奖励函数：`task_done` / `no_error` / `fast` / `few_steps` + `composite` 加权。
- Rollout 生命周期：`startRollout` → `recordModelCall` / `recordToolCall` → `endRollout`。
- 代理调用：`proxiedChat`（进程内一行替换）· `proxyRaw`（OpenAI 兼容，进程外零改动）。
- 导出：`getRollout` / `listRollouts` / `dataset` / `datasetJsonl` / `stats`。

存储：轨迹 append-only 写 `data/lightning.jsonl`（超 64MB 轮转 `.1`）；rollout 摘要写
`db.lightningRollouts`。**采集失败绝不阻断 agent 主流程**（写失败吞掉并继续）。

## 旁观者：一次请求 = 一条轨迹（真的零改代码）
`server.js` 对每个 `/v1/*` 请求（除 `/v1/lightning/*`、`/v1/orca/ws`）用
`lightning.withRollout(meta, fn)` 包一层 —— 靠 Node 的 `AsyncLocalStorage` 把上下文传下去，
请求内**任何** `providers.chat()` 调用都会自动被 `observeChat()` 记进同一条 ambient 轨迹。
agent 业务代码一行都不用改，这正是 Agent Lightning「Insert an API Gateway / observer」的做法。

- ambient 轨迹**只写 JSONL**（不落 `db.json`），避免每请求往 JSON 存储里塞记录；
- 采集自身出错一律静默，绝不阻断请求；
- 关闭开关（`lightningCapture=false`）时 `withRollout` 直接放行，零开销。

### 隐私立场（重要）
产品里跑的是**用户真实对话**。所以：
- `lightningCapture`（默认 **开**）：只记 provider / model / 耗时 / 错误 / 长度等**元数据**；
- `lightningCaptureContent`（默认 **关**）：显式打开才把 `messages` / `content` 写进轨迹文件。

要拿真实轨迹去训 RL 时，先打开第二个开关并确认你有相应授权；否则训练样本里只有轨迹形状与奖励。
`GET /v1/lightning/trajectories?limit=` 回放所有轨迹（含 ambient），`POST /v1/lightning/config`
在线切换两个开关。

## 两种接入方式（都不改 agent 业务逻辑）
```js
// A. 进程内：把 providers.chat(...) 换成 lightning.proxiedChat(...)（一行）
const r = await lightning.proxiedChat({ provider: 'deepseek', messages });

// B. 进程外：外部 agent 把 base_url 指到本服务（真正零改动）
//    POST /v1/lightning/v1/chat/completions   （OpenAI 兼容）
//    Header: X-Lightning-Rollout: <id>        （把同一次 rollout 的多次调用归到一个轨迹）
```

## HTTP 端点（全部运营级鉴权，需 `X-Admin-Token`）
| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/v1/lightning/v1/chat/completions` | OpenAI 兼容代理；原样回传上游 JSON 并留痕 |
| POST | `/v1/lightning/rollout` | 开一次 rollout（body `meta`） |
| POST | `/v1/lightning/tool` | 记一次工具调用（`rolloutId, name, args, result, latencyMs`） |
| POST | `/v1/lightning/end` | 结束 rollout 并算奖励（`id, success, signals?, rewardFn?, weights?`） |
| POST | `/v1/lightning/score` | 纯算奖励（`signals, fn?, weights?`），不落库 |
| GET | `/v1/lightning/stats` | 汇总：rollout 数 / open / closed / 奖励函数名 |
| GET | `/v1/lightning/rollouts?limit=` | 列表 |
| GET | `/v1/lightning/rollout?id=` | 单条 + 轨迹事件（从 JSONL 回放） |
| GET | `/v1/lightning/dataset?limit=&format=jsonl` | 训练样本（一条 rollout = 轨迹 + 奖励） |
| GET | `/v1/lightning/trajectories?limit=` | 真实运行轨迹（含 ambient，来自 JSONL） |
| GET/POST | `/v1/lightning/config` | 读写采集开关 `{capture, content}`（改完立即生效） |

```bash
# 纯奖励函数自检
curl -s -X POST http://127.0.0.1:3721/v1/lightning/score \
  -H 'X-Admin-Token: <token>' -H 'Content-Type: application/json' \
  -d '{"signals":{"success":true,"errors":0,"modelCalls":0,"latencyMs":0}}'
# → {"ok":true,"reward":1,"fn":"composite","parts":{...}}

# 导出训练样本
curl -s 'http://127.0.0.1:3721/v1/lightning/dataset?format=jsonl' -H 'X-Admin-Token: <token>'
```

## 测试
```bash
node test/e2e/suites/lightning-e2e.js    # 47 断言：奖励函数 + 轨迹落盘 + 代理留痕 + 真实旁观者采集 + 隐私默认 + HTTP + 鉴权
```
（代理路径用 stub fetch 验证，**不打真网**、不产生费用。）
