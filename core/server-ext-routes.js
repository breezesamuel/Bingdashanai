'use strict';
// server-ext-routes.js
// 补齐 server.js（HEAD 干净版）缺失的扩展路由。
// 这些路由来自被编码事故损坏、不可直接恢复的工作副本：其业务逻辑（纯 ASCII 代码）
// 在反解文件中基本完好，这里按原逻辑重写为干净源码；仅中文提示文案为重建。
//
// 覆盖端点：
//   POST /mcp, POST /v1/mcp/rpc           —— MCP JSON-RPC 2.0（Streamable HTTP）
//   GET  /v1/mcp-client/*                 —— 外部 MCP 服务器注册/工具/健康/自检
//   /v1/lightning/*                       —— Agent Lightning RL 轨迹/评分/数据集
//   /v1/wled/*                            —— WLED 灯带联动（付费成功才触发）
//   GET  /v1/crm/*                        —— CRM-lite 漏斗
//   /v1/auth/*                            —— 邮箱/手机验证码登录与绑定
//   /v1/evidence/{capture,confirm,list}   —— 证据管线
//   /v1/free-tier[/discover]              —— 免费额度（订阅墙前置）
//   /v1/reviews[/approve|/pending]        —— 经同意的真实评价
//   /v1/waitlist                          —— 候补邮箱（需显式同意）
//   /v1/scheduler/{enable,disable}        —— 触达调度开关
//   POST /v1/projects/from-decision       —— 决策转项目
//
// 返回 true 表示已命中并已结束响应；false 表示未命中，交回主路由链。

module.exports = async function handleExtRoutes(ctx) {
  const { p, q, req, res, json, err, readBody, adminAuthed, adminAuthedStrict, visitorOf, gateSection, store } = ctx;

  // ===== 授权码 / 离线激活（桌面版与原生壳的"订阅墙"落点）=====
  // 为什么在这里：交付给客户的桌面/原生 App 跑在用户自己机器上，请求全来自 127.0.0.1，
  // 公网那套"按访客计费 + 运营确认到账"在本机既无法阻止重置、也无法拦住改墙。
  // 因此客户端版本唯一的权益来源是**运营方私钥签发的授权码**（Ed25519，客户端只有公钥）。
  if (p.startsWith('/v1/license/')) {
    const lic = require('./license');
    // 简易限流：验签是 CPU 操作，防止被当成免费算力刷（按来源 IP 计数）。
    if (!handleExtRoutes._licRl) handleExtRoutes._licRl = new Map();
    const rl = (k, cap, win) => {
      const now = Date.now(), m = handleExtRoutes._licRl;
      if (m.size > 2000) for (const [kk, vv] of m) if (now - vv.at > win) m.delete(kk);
      const cur = m.get(k);
      if (!cur || now - cur.at > win) { m.set(k, { n: 1, at: now }); return true; }
      if (cur.n >= cap) return false;
      cur.n++; return true;
    };
    const srcIp = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'anon').trim();

    if (p === '/v1/license/status' && req.method === 'GET') {
      return json(res, 200, lic.status(visitorOf(req, q, res)));
    }
    if (p === '/v1/license/inspect' && req.method === 'POST') {
      if (!rl('lic-i:' + srcIp, 30, 60000)) return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      const b = await readBody(req);
      try {
        const i = lic.inspect(b && b.key);
        return json(res, 200, { ok: true, payload: i.payload, expired: i.expired, daysLeft: i.daysLeft, fpMatch: i.fpMatch, fingerprint: lic.machineFingerprint() });
      } catch (e) { return json(res, 400, { ok: false, error: e.message, code: e.code || null }); }
    }
    if (p === '/v1/license/activate' && req.method === 'POST') {
      if (!rl('lic-a:' + srcIp, 10, 60000)) return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      const b = await readBody(req);
      try { return json(res, 200, lic.activate(b && b.key, visitorOf(req, q, res))); }
      catch (e) { return json(res, 400, { ok: false, error: e.message, code: e.code || null }); }
    }
    if (p === '/v1/license/deactivate' && req.method === 'POST') {
      return json(res, 200, lic.deactivate(visitorOf(req, q, res)));
    }
    if (p === '/v1/license/config') {
      // 运营端配置"签发公钥"。客户端版本一律拒绝——否则用户写入自己的公钥即可自签自验，机制归零。
      if (lic.isClientMode()) return json(res, 403, { ok: false, error: '客户端版本不接受公钥配置（防止写入自签公钥绕过收费墙）' });
      if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：授权公钥配置仅限运营端' });
      if (req.method === 'GET') return json(res, 200, { ok: true, publicKey: store.getSetting('licensePublicKey') || null, configured: lic.pubConfigured(), pubSources: lic.pubSources(), signingReady: lic.signingReady(), signingSource: lic.signingSource() });
      if (req.method === 'POST') {
        const b = await readBody(req);
        const pk = b && b.publicKey ? String(b.publicKey).trim() : '';
        if (!pk) return json(res, 400, { ok: false, error: '缺少 publicKey' });
        try { require('crypto').createPublicKey({ key: Buffer.from(pk, 'base64url'), format: 'der', type: 'spki' }); }
        catch (e) { return json(res, 400, { ok: false, error: 'publicKey 不是合法的 Ed25519 公钥' }); }
        store.setSetting('licensePublicKey', pk);
        store.push('audit', { action: '授权公钥配置', detail: '运营端设置了签发公钥' }, null, null);
        return json(res, 200, { ok: true, configured: true });
      }
    }
    if (p === '/v1/license/issue' && req.method === 'POST') {
      // 发码机能力：必须有私钥 + 运营令牌；客户端版本（BINGDASHAN_CLIENT=1）一律拒绝，
      // 因为客户端包里没有私钥，也不应存在"本机自签自用"的路径。
      if (lic.isClientMode()) return json(res, 403, { ok: false, error: '客户端版本不提供签发能力（无私钥）' });
      if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：签发授权码仅限运营端' });
      const b = await readBody(req);
      try {
        const out = lic.issue({ plan: b && b.plan, days: b && b.days, fp: b && b.fp, who: b && b.who, id: b && b.id });
        store.push('audit', { action: '授权码签发', detail: 'plan=' + out.payload.plan + ' id=' + out.payload.id + (out.payload.who ? ' who=' + out.payload.who : '') }, null, null);
        return json(res, 200, { ok: true, key: out.key, payload: out.payload });
      } catch (e) {
        // 缺私钥是"没配置好"，不是服务器故障：给 400 + 可执行指引，别让运营端对着 500 猜。
        if (e && e.code === 'NO_PRIVKEY') return json(res, 400, { ok: false, error: e.message, code: 'NO_PRIVKEY' });
        return json(res, 500, { ok: false, error: '签发失败：' + e.message });
      }
    }
    return json(res, 404, { ok: false, error: '未知的授权接口' });
  }

  // ===== MCP JSON-RPC 2.0（Streamable HTTP）=====
  if ((p === '/mcp' || p === '/v1/mcp/rpc') && req.method === 'POST') {
    const mcpProto = require('./mcp-protocol');
    const b = await readBody(req);
    const out = Array.isArray(b)
      ? b.map(m => { try { return mcpProto.handle(m); } catch (e) { return null; } }).filter(Boolean)
      : (() => { try { return mcpProto.handle(b); } catch (e) { return { jsonrpc: '2.0', id: (b && b.id) || null, error: { code: -32603, message: String(e.message || e) } }; } })();
    if (out && (!Array.isArray(out) || out.length)) return json(res, 200, out);
    res.writeHead(202, { 'Access-Control-Allow-Origin': '*' }); return res.end(); // 通知类无响应
  }
  if ((p === '/mcp' || p === '/v1/mcp/rpc') && req.method === 'GET') {
    const mcpProto = require('./mcp-protocol');
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', Allow: 'POST' });
    return res.end(JSON.stringify({ ok: false, error: 'MCP 端点仅接受 POST（Streamable HTTP）', serverInfo: mcpProto.SERVER_INFO, protocolVersion: mcpProto.PROTOCOL_VERSION }));
  }

  // ===== MCP 客户端：连接外部 MCP 服务器 =====
  if (p.startsWith('/v1/mcp-client/')) {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：MCP 客户端管理仅限本机/管理令牌' });
    const mcpHub = require('./mcp-hub');
    try {
      if (p === '/v1/mcp-client/servers' && req.method === 'GET') {
        return json(res, 200, { ok: true, servers: mcpHub.getServers().map(mcpHub._public) });
      }
      if (p === '/v1/mcp-client/servers' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, mcpHub.addServer(b));
      }
      if (p === '/v1/mcp-client/remove' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, mcpHub.removeServer(String(b.id || '')));
      }
      if (p === '/v1/mcp-client/tools' && req.method === 'GET') {
        const id = String(q.get('id') || '').trim();
        if (id) return json(res, 200, { ok: true, tools: await mcpHub.listTools(id) });
        return json(res, 200, { ok: true, servers: mcpHub.getServers().map(mcpHub._public), hint: '传 id=<服务器id> 可列出该服务器的工具' });
      }
      if (p === '/v1/mcp-client/call' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await mcpHub.callTool(String(b.id || ''), String(b.name || ''), b.arguments || {});
        return json(res, 200, { ok: true, result: r });
      }
      if (p === '/v1/mcp-client/health' && req.method === 'GET') {
        const id = String(q.get('id') || '').trim();
        if (!id) return json(res, 200, { ok: false, error: '缺少 id' });
        return json(res, 200, await mcpHub.health(id));
      }
      if (p === '/v1/mcp-client/selftest' && req.method === 'GET') {
        return json(res, 200, await mcpHub.selftest());
      }
      return json(res, 404, { ok: false, error: '未知 MCP 客户端端点：' + p });
    } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
  }

  // ===== Agent Lightning：RL 轨迹采集 / 评分 / 数据集 =====
  if (p.startsWith('/v1/lightning/')) {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：Agent Lightning 仅限本机/管理令牌' });
    const lightning = require('./lightning');
    try {
      if (p === '/v1/lightning/v1/chat/completions' && req.method === 'POST') {
        const b = await readBody(req);
        const rid = String(req.headers['x-lightning-rollout'] || '').trim() || null;
        const j = await lightning.proxyRaw(b, rid);
        return json(res, 200, j);
      }
      if (p === '/v1/lightning/rollout' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, lightning.startRollout(b && (b.meta || b)));
      }
      if (p === '/v1/lightning/tool' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { ok: true, event: lightning.recordToolCall(b || {}) });
      }
      if (p === '/v1/lightning/end' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, lightning.endRollout(String(b.id || ''), b));
      }
      if (p === '/v1/lightning/score' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, Object.assign({ ok: true }, lightning.scoreSignals(b.signals || {}, { fn: b.fn, weights: b.weights })));
      }
      if (p === '/v1/lightning/stats' && req.method === 'GET') {
        return json(res, 200, lightning.stats());
      }
      if (p === '/v1/lightning/rollouts' && req.method === 'GET') {
        return json(res, 200, { ok: true, rollouts: lightning.listRollouts(Number(q.get('limit') || 50)) });
      }
      if (p === '/v1/lightning/rollout' && req.method === 'GET') {
        const r = lightning.getRollout(String(q.get('id') || ''));
        return json(res, 200, r ? { ok: true, rollout: r } : { ok: false, error: 'rollout 不存在' });
      }
      if (p === '/v1/lightning/dataset' && req.method === 'GET') {
        const lim = Number(q.get('limit') || 200);
        if (q.get('format') === 'jsonl') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          return res.end(lightning.datasetJsonl(lim));
        }
        return json(res, 200, { ok: true, samples: lightning.dataset(lim) });
      }
      if (p === '/v1/lightning/trajectories' && req.method === 'GET') {
        return json(res, 200, {
          ok: true, captureEnabled: lightning.captureEnabled(), captureContent: lightning.captureContent(),
          trajectories: lightning.trajectories(Number(q.get('limit') || 100))
        });
      }
      if (p === '/v1/lightning/config') {
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, capture: lightning.captureEnabled(), content: lightning.captureContent() });
        }
        const b = await readBody(req);
        if (b && b.capture !== undefined) store.setSetting('lightningCapture', b.capture === true);
        if (b && b.content !== undefined) store.setSetting('lightningCaptureContent', b.content === true);
        return json(res, 200, Object.assign({ ok: true }, lightning.refreshSettings()));
      }
      return json(res, 404, { ok: false, error: '未知 Agent Lightning 端点：' + p });
    } catch (e) {
      const code = e && e.status ? e.status : 200;
      return json(res, code, { ok: false, error: String((e && e.message) || e) });
    }
  }

  // ===== WLED 灯带联动（仅真实付费成功才触发，非自测）=====
  if (p.startsWith('/v1/wled/')) {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：WLED 配置仅限本机/管理令牌' });
    const wled = require('./wled');
    if (p === '/v1/wled/config') {
      if (req.method === 'GET') return json(res, 200, wled.describe());
      const b = await readBody(req);
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

  // ===== CRM-lite（只读漏斗，运营令牌）=====
  if (p.indexOf('/v1/crm/') === 0 && req.method === 'GET') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限：CRM 数据仅限本机/管理令牌' });
    const crm = require('./crm');
    if (p === '/v1/crm/pipeline') return json(res, 200, crm.pipeline());
    if (p === '/v1/crm/summary') return json(res, 200, crm.summary());
    if (p === '/v1/crm/opportunities') return json(res, 200, { ok: true, opportunities: crm.opportunities() });
    if (p === '/v1/crm/customers') return json(res, 200, { ok: true, customers: crm.customers() });
    return json(res, 404, { ok: false, error: '未知 CRM 端点：' + p });
  }

  // ===== 账号：邮箱/手机验证码登录与绑定（公开入口，自行限流）=====
  if (p === '/v1/auth/send-code' && req.method === 'POST') {
    const auth = require('./auth');
    const b = await readBody(req);
    const target = String(b.target || '').trim();
    const type = String(b.type || '').toLowerCase();
    const ip = String(req.socket.remoteAddress || 'anon').replace(/^::ffff:/, '');
    if (!target || !['email', 'phone'].includes(type)) {
      return json(res, 400, { ok: false, error: '参数不完整：target（邮箱/手机号）与 type(email|phone) 必填' });
    }
    if (type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
      return json(res, 400, { ok: false, error: '邮箱格式不正确' });
    }
    if (type === 'phone' && !/^1\d{10}$/.test(target)) {
      return json(res, 400, { ok: false, error: '手机号格式不正确（11 位数字）' });
    }
    // 【2026-10-21 限流】原来只有"同目标 1 分钟 1 次"→ 攻击者可用我们的 SMTP
    // **批量轰炸任意邮箱**（发码风暴 + 损害我们发信信誉/额度）。加 IP 维度：每小时 10 次。
    if (!authRateOk(ip, 10, 3600000)) {
      return json(res, 429, { ok: false, error: '发码过于频繁，请稍后再试' });
    }
    const r = await auth.sendCode(target, type, ip);
    return json(res, r.ok ? 200 : (r.retryAfter ? 429 : 400), r);
  }
  // ——【2026-10-21 安全加固】公开的验证码/登录端点必须有 IP 限流 ——
  // 6 位码只有 100 万种，验证码本身有 3 次尝试上限，但**发码/验码/登录**如果不限流，
  // 就能被用来暴力试码或批量枚举"哪些邮箱在我们这儿有账号"。这里做一个进程内 IP 计数。
  const _authHits = new Map();
  function authRateOk(ip, cap, winMs) {
    const key = String(ip || 'anon');
    const now = Date.now();
    // 【2026-10-25 无界防护·修 clear 事故面】原兜底是 _authHits.clear()：
    // 一刀全清恰好发生在洪峰时刻（size>5000 只有洪峰才触发），把**所有正在限流的
    // 计数器一起清零**——攻击者窗口重开、正当 IP 的限流状态丢失。现在改为只清
    // 「窗口已过」的死键（所有调用点 winMs 都是 1h），清完仍超限才退回全清。
    if (_authHits.size > 5000) {
      for (const [k, v] of _authHits) {
        if (!v.length || now - v[v.length - 1] > winMs) _authHits.delete(k);
        if (_authHits.size <= 5000) break;
      }
      if (_authHits.size > 5000) _authHits.clear();
    }
    const arr = (_authHits.get(key) || []).filter((t) => now - t < winMs);
    if (arr.length >= cap) { _authHits.set(key, arr); return false; }
    arr.push(now);
    _authHits.set(key, arr);
    return true;
  }
  if (p === '/v1/auth/verify-code' && req.method === 'POST') {
    const auth = require('./auth');
    const b = await readBody(req);
    const target = String(b.target || '').trim();
    const type = String(b.type || '').toLowerCase();
    const code = String(b.code || '').trim();
    const ip = String(req.socket.remoteAddress || 'anon').replace(/^::ffff:/, '');
    if (!target || !['email', 'phone'].includes(type) || !code) {
      return json(res, 400, { ok: false, error: '缺少 target、type、code' });
    }
    if (!authRateOk(ip, 20, 3600000)) {
      return json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
    }
    const r = auth.verifyCode(target, type, code);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/auth/bind' && req.method === 'POST') {
    const auth = require('./auth');
    const b = await readBody(req);
    const target = String(b.target || '').trim();
    const type = String(b.type || '').toLowerCase();
    const vid = String(b.vid || visitorOf(req, q, res));
    if (!target || !['email', 'phone'].includes(type)) {
      return json(res, 400, { ok: false, error: '缺少 target、type' });
    }
    const code = String(b.code || '').trim();
    if (!code) return json(res, 400, { ok: false, error: '缺少验证码' });
    const vr = auth.verifyCode(target, type, code);
    if (!vr.ok) return json(res, 400, vr);
    const r = auth.bindContact(vid, target, type);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/auth/login' && req.method === 'POST') {
    const auth = require('./auth');
    const b = await readBody(req);
    const target = String(b.target || '').trim();
    const type = String(b.type || '').toLowerCase();
    const code = String(b.code || '').trim();
    const ip = String(req.socket.remoteAddress || 'anon').replace(/^::ffff:/, '');
    if (!target || !['email', 'phone'].includes(type)) {
      return json(res, 400, { ok: false, error: '缺少 target、type' });
    }
    // 【2026-10-21 安全加固·账号接管】验证码原来**是可选的**：
    // 只要知道一个"已绑定且已验证"的邮箱，就能不验证直接换成对方身份（拿到其订阅与沉淀）。
    // 现在**验证码必填** —— 邮箱是找回线索，不是凭证。
    if (!code) {
      return json(res, 400, { ok: false, error: '需要邮箱验证码（请先点「发送验证码」）' });
    }
    if (!authRateOk(ip, 20, 3600000)) {
      return json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
    }
    const vr = auth.verifyCode(target, type, code);
    if (!vr.ok) return json(res, 400, vr);
    // verified=true：验证码刚校验通过 → 允许把邮箱正式绑定为已验证（邮箱是线索，不是凭证）
    const r = auth.loginContact(target, type, { verified: true });
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/auth/unbind' && req.method === 'POST') {
    const auth = require('./auth');
    const b = await readBody(req);
    const type = String(b.type || '').toLowerCase();
    const vid = String(b.vid || visitorOf(req, q, res));
    if (!['email', 'phone'].includes(type)) {
      return json(res, 400, { ok: false, error: '缺少 type' });
    }
    const r = auth.unbindContact(vid, type);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/auth/bindings' && req.method === 'GET') {
    const auth = require('./auth');
    const vid = String(q.get('vid') || visitorOf(req, q, res));
    const r = auth.getBindings(vid);
    return json(res, 200, r);
  }

  // ===== 证据管线：手工采集 / 确认 / 清单 =====
  if (p === '/v1/evidence/capture' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限：证据采集仅限本机/管理令牌' });
    const b = await readBody(req);
    const { sourceType, channel, quote, name, leadId, note } = b || {};
    const r = require('./evidence-pipeline').captureManual({ sourceType, channel, quote, name, leadId, note });
    return json(res, 200, r);
  }
  if (p === '/v1/evidence/confirm' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = require('./evidence-pipeline').confirm(b && b.id);
    return json(res, 200, r);
  }
  if (p === '/v1/evidence/list' && req.method === 'GET') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const r = require('./evidence-pipeline').list();
    return json(res, 200, { ok: true, list: r });
  }

  // ===== 免费额度（订阅墙前置：先免费、后订阅）=====
  if (p === '/v1/free-tier' && req.method === 'GET') {
    try {
      const ft = require('./free-tier');
      const st = ft.status();
      const vid = visitorOf(req, q, res);
      return json(res, 200, Object.assign({ ok: true, grant: ft.grantStatus(vid) }, st));
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/free-tier/discover' && req.method === 'POST') {
    try {
      const ft = require('./free-tier');
      const r = await ft.refreshAll();
      return json(res, 200, { ok: true, results: r, status: ft.status() });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 真实评价（必须显式同意才展示）=====
  if (p === '/v1/reviews' && req.method === 'GET') {
    try {
      const list = (store.read().reviews || []).filter(r => r.approved && r.consent);
      return json(res, 200, {
        ok: true, count: list.length,
        reviews: list.map(r => ({ name: r.name, role: r.role || '', rating: r.rating || 5, text: r.text, at: r.at }))
      });
    } catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/reviews' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      const name = String(b.name || '').trim().slice(0, 40);
      const role = String(b.role || '').trim().slice(0, 40);
      const email = String(b.email || '').trim();
      const rating = Math.min(5, Math.max(1, parseInt(b.rating, 10) || 5));
      const consent = b.consent === true || b.consent === 'true';
      if (text.length < 4) return json(res, 400, { ok: false, error: '评价内容太短' });
      if (!consent) return json(res, 400, { ok: false, error: '需要显式同意才会公开（consent=true）' });
      const db = store.read();
      if (!db.reviews) db.reviews = [];
      db.reviews.push({ id: store.uid(), name: name || '匿名用户', role, email, rating, text: text.slice(0, 600), consent: true, approved: false, at: Date.now(), ip: (req.socket && req.socket.remoteAddress) || '' });
      store.write(db);
      const saved = db.reviews[db.reviews.length - 1];
      return json(res, 200, { ok: true, id: saved.id, message: '已收到，待人工审核后展示' });
    } catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/reviews/approve' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const id = String(b.id || '');
      const db = store.read();
      const r = (db.reviews || []).find(x => x.id === id);
      if (!r) return json(res, 404, { ok: false, error: '评价不存在' });
      r.approved = b.approved !== false;
      store.write(db);
      return json(res, 200, { ok: true, id, approved: r.approved });
    } catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/reviews/pending' && req.method === 'GET') {
    try {
      const list = (store.read().reviews || []).filter(r => !r.approved);
      return json(res, 200, { ok: true, count: list.length, reviews: list });
    } catch (e) { return err(res, 500, e.message); }
  }

  // ===== 候补名单（需显式同意，绝不默认订阅）=====
  if (p === '/v1/waitlist' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const email = String(b.email || '').trim();
      const consent = b.consent === true || b.consent === 'true';
      const source = String(b.source || '').trim().slice(0, 60);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' });
      if (!consent) return json(res, 400, { ok: false, error: '需要显式同意才会记录（consent=true）' });
      const db = store.read();
      if (!db.leads) db.leads = [];
      let lead = db.leads.find(l => l.email && l.email.toLowerCase() === email.toLowerCase());
      const ip = (req.socket && req.socket.remoteAddress) || '';
      if (!lead) {
        lead = { id: store.uid(), name: '', email, source, stage: 'waitlist', consent: true, consentAt: Date.now(), consentIp: ip };
        db.leads.push(lead);
      } else {
        lead.consent = true; lead.stage = 'waitlist'; lead.consentAt = Date.now(); lead.consentIp = ip;
      }
      store.write(db);
      return json(res, 200, { ok: true, message: '已加入候补名单。我们只在你同意的前提下联系你。' });
    } catch (e) { return err(res, 500, e.message); }
  }

  // ===== 触达调度开关 =====
  if (p === '/v1/scheduler/enable' && req.method === 'POST') {
    try { store.setSetting('outreachEnabled', true); return json(res, 200, { ok: true, outreachEnabled: true, hint: '仅对已同意（consent=true）的线索触达' }); }
    catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/scheduler/disable' && req.method === 'POST') {
    try { store.setSetting('outreachEnabled', false); return json(res, 200, { ok: true, outreachEnabled: false }); }
    catch (e) { return err(res, 500, e.message); }
  }

  // ===== 决策转项目（决策中心 → 项目管理）=====
  if (p === '/v1/projects/from-decision' && req.method === 'POST') {
    if (gateSection(req, q, res, 'decision')) return true;
    const DF = require('./decision-focus');
    const focus = DF.current();
    if (!focus || focus.closed) return err(res, 400, '当前没有进行中的决策焦点');
    const AW = require('./assign-work');
    const projName = focus.topic || (focus.domain + '决策落地');
    const projDesc = '来自决策焦点：' + focus.domain + ' — ' + focus.topic + '\n' + (focus.questions || []).map((x, i) => (i + 1) + '. ' + x).join('\n');
    const milestones = (focus.questions || []).map((x, i) => ({ title: x, seq: i + 1 }));
    const proj = AW.createProject({ name: projName, desc: projDesc, milestones });
    if (!proj.ok) return err(res, 400, proj.error);
    const db = store.read();
    const taskIds = focus.taskIds || [];
    if (taskIds.length) {
      taskIds.forEach(tid => {
        const t = (db.tasks || []).find(x => x.id === tid);
        if (t) t.projectId = proj.project.id;
      });
      store.write(db);
    }
    return json(res, 200, { ok: true, project: proj.project, milestones, linkedTasks: taskIds.length });
  }

  // ===== 创业验证所（startup-skill 方法论：8 阶段 + 两道闸 + 诚实协议）=====
  if (p.startsWith('/v1/validator')) {
    const V = require('./validator');
    if (p === '/v1/validator/frameworks' && req.method === 'GET') {
      // 公开元数据：阶段、维度、标签定义（前端渲染用）
      return json(res, 200, { ok: true, phases: V.PHASES, dims: V.SCORECARD_DIMS, labels: V.LABELS, tiers: V.TIERS });
    }
    if (p === '/v1/validator/preflight' && req.method === 'POST') {
      const b = await readBody(req);
      const r = V.preflight(b && b.idea);
      return json(res, 200, { ok: true, preflight: r });
    }
    if (p === '/v1/validator/depth' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { ok: true, depth: V.researchDepth(b && b.intake) });
    }
    // 以下需运营权限
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限：创业验证所仅限本机/管理令牌' });
    if (p === '/v1/validator/start' && req.method === 'POST') {
      const b = await readBody(req);
      const idea = String(b && b.idea || '').trim();
      if (!idea) return json(res, 400, { ok: false, error: '缺少 idea' });
      const proj = V.createProject(idea, { name: b && b.name });
      return json(res, 200, { ok: true, project: proj });
    }
    if (p === '/v1/validator/list' && req.method === 'GET') {
      return json(res, 200, { ok: true, projects: V.listProjects() });
    }
    if (p === '/v1/validator/state' && req.method === 'GET') {
      const proj = V.getProject(String(q.get('id') || ''));
      if (!proj) return json(res, 404, { ok: false, error: '项目不存在' });
      return json(res, 200, { ok: true, project: proj });
    }
    if (p === '/v1/validator/advance' && req.method === 'POST') {
      const b = await readBody(req);
      const r = V.advance(String(b && b.id || ''), b);
      if (!r.ok) return json(res, 400, r);
      return json(res, 200, { ok: true, phase: r.phase, next: r.next, gate: r.gate, verdict: r.verdict });
    }
    if (p === '/v1/validator/interview' && req.method === 'POST') {
      // 仅记录一次访谈，不推进阶段（补足访谈闸门前的样本量）
      const b = await readBody(req);
      const r = V.recordInterview(String(b && b.id || ''), { summary: b && b.summary, confirmed: b && b.confirmed, behaviorSignal: b && b.behaviorSignal });
      if (!r.ok) return json(res, 400, r);
      return json(res, 200, r);
    }
    return json(res, 404, { ok: false, error: '未知的创业验证端点：' + p });
  }

  return false;
};
