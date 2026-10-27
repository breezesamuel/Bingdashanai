# server.js 恢复补丁（仅 4 处微创改动）

> 原文件被 shell 命令误改编码导致全量损坏。核心模块、测试套件、文档、前端均**完好无损**。仅丢失最近 4 处微创改动。
> 请先从备份恢复 server.js（或重装干净版），再按顺序应用下列 4 处补丁。

---

## 补丁 1：WLED 物理通知桥路由

**位置**：插在 `/v1/lightning/*` 块的结束大括号之后、`// ===== 24h 监控哨兵 =====` 之前

```javascript
  // ===== WLED 物理通知桥（独立开源固件 wled/WLED；只走其本地 JSON API） =====
  // 诚实边界：灯亮不是收入、不是证据，只是把「真实成交/真实到账」变成一个物理反馈。
  // 全部运营级鉴权；设备不可达时如实返回 ok:false，绝不阻断结算，也绝不伪造"成交通知"。
  if (p.startsWith('/v1/wled/')) {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：WLED 通知桥为运营级配置' });
    const wled = require('./core/wled');
    if (p === '/v1/wled/config') {
      if (req.method === 'GET') return json(res, 200, wled.describe());
      const b = await readBody(req);
      // 先保存再 describe：否则拿到的 baseUrl/config 是改之前的旧值（已实测踩到）
      const saved = wled.saveConfig(b || {});
      return json(res, 200, Object.assign({ ok: true }, wled.describe(), { saved }));
    }
    if (p === '/v1/wled/test' && req.method === 'POST') {
      return json(res, 200, await wled.info());
    }
    if (p === '/v1/wled/notify' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, await wled.notify(String((b && b.kind) || 'info')));
    }
    if (p === '/v1/wled/apply' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, await wled.apply((b && b.state) || {}));
    }
    return json(res, 404, { ok: false, error: '未知 WLED 端点：' + p });
  }
```

---

## 补丁 2：`/v1/report/seven` 调用传入 visitor

**原位置**：`/v1/report/seven` POST 处理器内（约原 3230 行）

**改前**：
```javascript
try { return json(res, 200, { ok: true, report: report.seven(b.topic, b.answer) }); }
```

**改后**：
```javascript
try { return json(res, 200, { ok: true, report: report.seven(b.topic, b.answer, visitorOf(req, q, res)) }); }
```

---

## 补丁 3：`/v1/lessons` POST 调用传入 visitor

**原位置**：`/v1/lessons` POST 处理器内（约原 1767 行）

**改前**：
```javascript
const r = lessons.add(body || {});
```

**改后**：
```javascript
const r = lessons.add(body || {}, visitorOf(req, q, res));
```

---

## 补丁 4：`/v1/my/assets` 端点返回所有 5 个可归属集合

**原位置**：`/v1/my/assets` GET 处理器（原只有 decisions）

**替换为**：
```javascript
// 我的沉淀（数据归属 + 复购价值锚点）——返回所有可归属集合的详情
if (p === '/v1/my/assets' && req.method === 'GET') {
  try {
    const vid = visitorOf(req, q, res);
    const t = require('./core/tenancy');
    const collections = ['decisions', 'knowledge', 'reports', 'messages', 'lessons'];
    const details = {};
    for (const c of collections) details[c] = t.ownedBy(c, vid, 50);
    return json(res, 200, { ok: true, summary: t.myDataSummary(vid), ...details });
  } catch (e) { return err(res, 200, e.message); }
}
```

---

## 验证清单（应用后跑一次）

```bash
# 1. 语法检查
node --check server.js

# 2. 单套件验证（需要先启动沙箱）
node C:\Users\Think\AppData\Local\Temp\focus-run.js tenancy-e2e.js
# 应输出 27 PASS / 0 FAIL（含 reports/lessons 归属）

node C:\Users\Think\AppData\Local\Temp\focus-run.js wled-e2e.js
# 应输出 37 PASS / 0 FAIL

# 3. 全量回归
$env:BINGDASHAN_E2E_DUMP="C:\Users\Think\AppData\Local\Temp\e2edumpX"; node test/e2e/suites/goal-e2e-runner.js
# 应输出 32 suites, 885+ PASS, 0 FAIL
```

---

## 其余文件**完好无损**，无需动作

| 文件 | 状态 |
|---|---|
| core/wled.js | ✅ 新增，已测 |
| core/tenancy.js | ✅ 修复 renewAnchor 假威胁、已测 |
| core/report.js | ✅ seven() 接受 visitor、已测 |
| core/lessons.js | ✅ add() 接受 visitor、已测 |
| core/subs.js | ✅ 真实成交钩子 WLED、已测 |
| core/money.js | ✅ 真实到账钩子 WLED、已测 |
| core/commercial-loop.js | ✅ loopHealth 诚实口径、nextAction 诚实 |
| core/settings-registry.js | ✅ 新增 8 个 BYOK 密钥项 |
| core/providers.js | ✅ getKey 优先读 store 实现 BYOK |
| web/biz.js | ✅ refreshMyAssets、面板标题诚实 |
| web/index.html | ✅ 面板标题 "到期不清空" |
| web/landing.html | ✅ 无虚假团队档 |
| web/landing-i18n.js | ✅ 同步 |
| README.md | ✅ 增补诚实口径说明 + WLED.md + COMMERCIAL-AUDIT.md 链接 |
| WLED.md | ✅ 新增诚实文档 |
| COMMERCIAL-AUDIT.md | ✅ 新增全量体检 |
| test/e2e/suites/tenancy-e2e.js | ✅ 含 reports/lessons 断言（27 条） |
| test/e2e/suites/wled-e2e.js | ✅ 37 条断言 |
| test/e2e/suites/goal-e2e-runner.js | ✅ 已注册 tenancy/wled |

---

## 恢复后即可验证的新功能

1. **WLED 物理通知**：`POST /v1/wled/config` → `POST /v1/wled/test` → `POST /v1/wled/notify`
2. **十方归属**：`reports`/`lessons` 写入即带 visitor，`/v1/my/assets` 返回 5 类详情
3. **BYOK（自带密钥）**：设置页自动出现 8 个 secret 输入框，保存即生效，模型下拉自动灰显未配置项
4. **诚实续费话术**：`/v1/my/assets` 的 `renewAnchor` 不再出现"保住/失去/删除"