# WLED 物理通知桥

## 它是什么（以及它**不是**什么）

[WLED](https://github.com/wled/WLED) 是一个**独立存在的开源项目**（EUPL-1.2，约 1.9 万 star，ESP32/ESP8266
驱动 WS2812B 等数字 RGB 灯带的固件）。

- ✅ **真实存在**：`wled/WLED`，最后提交时间 2026-10，未归档。
- ✅ **真实可对接**：它有一个本地 JSON HTTP API，本文档中的每个字段都在 2026-10 实际抓取
  [官方 JSON API 文档](https://kno.wled.ge/interfaces/json-api/) 核对过。
- ❌ **不是本项目的依赖**：它是 C++ 微控制器固件，无法 `npm install` 进 Node。
  本项目**不引用、不打包、不修改**它的任何代码。
- ❌ **不是收入，不是证据，不是"成交通知"**：灯亮一下只是给自己/团队的一个物理反馈。
  任何情况下都不允许用它冒充"客户付款了"或制造"业务很火"的假象。

## 对接的 API（已核对）

| 方法 | 端点 | 作用 |
|---|---|---|
| `GET` | `/json/info` | 读设备信息：`ver` / `name` / `leds.count` / `arch` / `mac` |
| `POST` | `/json/state` | 下发状态。成功返回 `{"success":true}` |

`POST /json/state` 的负载（本项目实际发出的）：

```json
{ "on": true, "bri": 255, "transition": 4, "seg": [{ "col": [[0, 255, 80]] }] }
```

- `transition` 的单位是 **100ms**（`4` = 淡入 0.4 秒），避免深夜一亮刺眼。
- `col` 是颜色列表，每项是 `[r,g,b]` 或十六进制字符串；这里只点亮第一段的第一色。

## 安装（需要真实硬件才有效）

1. 给 ESP32 刷 [WLED 固件](https://install.wled.me/)，连上你的 WiFi。
2. 记下它的局域网地址（例如 `192.168.1.50`）。
3. 在驾驶舱/接口里配置（**没有硬件的人会得到诚实的失败，而不是假成功**）：

```bash
curl -X POST http://127.0.0.1:3721/v1/wled/config \
  -H 'X-Admin-Token: <运营令牌>' -H 'Content-Type: application/json' \
  -d '{"enabled":true,"host":"192.168.1.50","port":80,"brightness":255}'
```

## 接口（全部运营级鉴权）

| 方法 | 端点 | 说明 |
|---|---|---|
| `GET` | `/v1/wled/config` | 看当前配置 + API 说明 + 预设清单 |
| `POST` | `/v1/wled/config` | `{enabled,host,port,brightness}` 保存 |
| `POST` | `/v1/wled/test` | 连接测试：能拿到 `ver`/`name` 才算通 |
| `POST` | `/v1/wled/notify` | `{kind}` 手动触发一个预设 |
| `POST` | `/v1/wled/apply` | `{state}` 下发任意 WLED state |

预设（`kind`）：`deal` 真实成交=绿 `[0,255,80]` · `payment` 真实到账=金 `[255,180,0]`
· `alert` 告警=红 `[255,0,0]` · `info` 信息=蓝 `[0,140,255]`。未知 `kind` 落到 `info`，不报错。

## 已接入的真实事件

只有**非自测**的钱，才会触发：

- `core/subs.js` `settleEffects()` — 真实付费客户完成订阅确认时（`isReal === true`）。
- `core/money.js` `settle()` — 真实回款结算到账时（`isSelfTest() === false`）。

**不会亮灯**的情况（刻意如此）：

- 金额 `<= 0`（不拿空单制造仪式感）
- 自测单 / 自造营收（自测不配庆祝）
- `wledEnabled=false`（默认也是关的 —— 绝不默认对外发请求）

## 设计原则：旁观者

和 `core/lightning.js` 一样，WLED 桥是**旁观者**：

- 设备不可达 / 未配置 → 返回 `{ok:false,error}`，HTTP 仍是 200，**绝不抛异常、绝不阻断结算**。
- 看不到"实时通知"或"实时信号"这类说法——没有的东西不编。
- 关掉它，主流程一行都不会变。

## 测试说明（诚实边界）

`test/e2e/suites/wled-e2e.js` 用一个**模拟设备**（本地起一个 HTTP server，只实现
`/json/info` 与 `/json/state`）验证桥本身的接线是否正确。

> 这**不**证明我们卖出了任何东西 —— 本机既没有 WLED 硬件，也没有真实买家。
> 套件里有一条断言专门守这件事：点完灯，`/v1/money/kpi` 的 `revenue` 必须仍是 `0`。
> **灯亮不是钱。**
