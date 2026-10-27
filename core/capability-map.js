// core/capability-map.js — 能力全景：把「有什么、在哪、能不能用」一次说清
//
// 【为什么需要它】系统有 90+ core 模块、350+ HTTP 端点，但前端只有 20 个 tab。
// 剩下 130+ 个能力**存在却不可达**——用户看到的是 20 个入口，
// 背后是一整套已经建好、却没有出口的能力。这类缺口最危险：
// 不是「做不出来」，而是「做出来了没人知道」，且永远不会有人主动提。
//
// 本模块自动盘点三件事，不靠人工维护清单（手工清单必然与代码漂移）：
//   1. 后端有什么（core 模块 + HTTP 端点）
//   2. 前端能点什么（tab + 前端源码里真实调用过的路径）
//   3. 差集：哪些能力存在但**用户够不到**
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
// 【2026-10-25 扫描盲区修复】原来硬编码 7 个根目录 JS（app/biz/convert/capture/zodiac/geo/ui），
// **完全不扫 index.html 和全部子页**（assist/ops/care 三页/download/activate/architecture/landing/
// manual-verify）—— care/center.html 里明明调用的 /v1/care/center 等 37 个端点被算成
// 「用户够不到」，缺口清单虚高到没人再信。现在递归扫 web/ 下所有 .js/.html。
function listFrontFiles() {
  const out = [];
  (function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const f of names) {
      const p = path.join(dir, f);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { if (f !== 'node_modules' && f !== 'icons') walk(p); continue; }
      // 备份/历史文件不是活代码（app.js.orig 曾被当可达性证据 → 死路径撑高覆盖）
      if (/\.(orig|bak|old)$/.test(f)) continue;
      if (/\.(js|html)$/.test(f)) out.push(p);
    }
  })(WEB);
  return out;
}

// 机器/调度/对端端点：设计上就没有人类入口（设备心跳、爬虫任务、物流回调、
// 二维码跳转目标）。它们出现在 unreachable 清单里只会把真缺口淹掉——
// 单独归类为 machineUnreachable，不计入「用户够不到」与覆盖率分母。
const MACHINE_PREFIXES = [
  ['/v1/crawler/', '自主巡游/调度器内部'],
  ['/v1/logistics/', '物流对端回调'],
  ['/v1/care/device/heartbeat', '机器人心跳（设备侧上报）'],
  ['/v1/care/notifies/flush', '定时冲刷（调度器）'],
  ['/v1/pay/go/', '扫码跳转目标（二维码内容，非前端 fetch）'],
  // 网关服务端回调（对端系统 POST 过来，永远不该有前端入口）
  ['/v1/pay/alipay/notify', '支付宝网关回调（服务端对服务端）'],
  ['/v1/pay/wechat/notify', '微信网关回调（服务端对服务端）'],
  ['/v1/pay/moltspay/notify', 'Moltspay 网关回调（服务端对服务端）'],
  ['/v1/pay/paypal/webhook', 'PayPal Webhook（服务端对服务端）'],
  // 支付回站落地页：买家浏览器被网关重定向到这里，是「链接可达」而非前端 fetch
  ['/v1/pay/alipay/return', '支付宝回站落地页（网关跳转目标）'],
  ['/v1/pay/paypal/success', 'PayPal 支付完成回站落地页'],
];
function machineWhy(ep) {
  for (const [pre, why] of MACHINE_PREFIXES) if (ep.startsWith(pre)) return why;
  return '';
}

// 前端 tab → 主题面板（用于把孤儿端点归类到用户看得懂的领域）
const TOPIC_HINTS = [
  [/^\/v1\/(gtm|leads|leadgen|outreach|partners?|partner)/, '获客与成交'],
  [/^\/v1\/(pay|subs|money|payout|settle|checkout|invoice|pricing)/, '收钱与结算'],
  [/^\/v1\/(fulfillment|materials|logistics|ship)/, '履约与交付'],
  [/^\/v1\/(tickets|after|support|refund)/, '售后与工单'],
  [/^\/v1\/(auto|workflow|conductor|goalpilot|organs|harness|orkernel|arch|lessons)/, '自主运行'],
  [/^\/v1\/(agents?|agentcenter|agentmesh|paperclip|mcp|registry|skills|skilllib|skillspace|capability)/, '智能体与技能'],
  [/^\/v1\/(decision|deliberation|report|decision-bridge|decision-focus)/, '决策与复盘'],
  [/^\/v1\/(org|tasks?|team|staff|talents|assign)/, '组织与执行'],
  [/^\/v1\/(intel|crawler|firecrawl|knowledge|webfetch|scout)/, '情报与知识'],
  [/^\/v1\/(watch|guard|self-heal|devcap|health)/, '监控与自愈'],
  [/^\/v1\/(chat|voice|studio|game|music|zodiac|foundry|publisher|autopub)/, '创作与内容'],
  [/^\/v1\/(auth|tenancy|geo|evidence|memory|brain|smart)/, '底座能力'],
  // 复用选型（SOP）本质是「自主决策能力」的组成部分，归入自主运行而非"其他"
  [/^\/v1\/adoption/, '自主运行'],
];

function topicOf(ep) {
  for (const [re, t] of TOPIC_HINTS) if (re.test(ep)) return t;
  return '其他';
}

function listCoreModules() {
  try {
    return fs.readdirSync(path.join(ROOT, 'core'))
      .filter(f => f.endsWith('.js'))
      .map(f => {
        const st = fs.statSync(path.join(ROOT, 'core', f));
        return { name: f.replace(/\.js$/, ''), size: st.size };
      });
  } catch (e) { return []; }
}

// 从 server.js 里抽出所有被路由的端点
function listEndpoints() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const set = new Set();
    let m;
    const re = /p === '(\/v1\/[^']+)'/g;
    while ((m = re.exec(src))) set.add(m[1]);
    return [...set].sort();
  } catch (e) { return []; }
}

// 前端实际调用过的路径（web/ 全目录递归扫 api('/v1/...') / href="/v1/..." 这类引用）
function listFrontendCalls() {
  const calls = new Set();
  listFrontFiles().forEach(file => {
    try {
      const src = fs.readFileSync(file, 'utf8');
      let m;
      // 【必须匹配到引号/反引号/空白为止，而不是要求下一字符就是引号】
      // 原先用 [A-Za-z0-9_\-/{}$.]* 后紧跟 ['"`]，遇到 `api('/v1/audit?limit=200')`
      // 时路径会在 `?` 处断掉，而下一字符不是引号 → 整条匹配失败。
      // 结果是 `/v1/audit`、`/v1/funnel/snapshots` 这些**前端明明在用**的端点
      // 被算成「用户够不到」，缺口清单虚高、可信度归零。
      const re = /['"`](\/v1\/[^'"`\s)]*)/g;
      while ((m = re.exec(src))) {
        // 去掉可能粘连的模板变量占位（拼接出来的路径无法静态判定）
        let p = m[1].replace(/\$\{[^}]*\}/g, '').replace(/[?&#].*$/, '');
        // 【2026-10-25 尾斜坑】`api('/v1/goalpilot/' + kind)` 捕获到 '/v1/goalpilot/'，
        // 而 isReachable 用 ep.startsWith(c + '/') → '/v1/goalpilot//' 双斜杠永假，
        // 动态拼接的整族端点全部误报够不到。统一剥掉尾斜杠。
        p = p.replace(/\/+$/, '');
        if (p && p.length > 5) calls.add(p);
      }
    } catch (e) { /* 文件不存在跳过 */ }
  });
  return [...calls];
}

function listTabs() {
  try {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    return [...html.matchAll(/data-tab="([^"]+)"/g)].map(x => x[1]);
  } catch (e) { return []; }
}

// 判断端点是否被前端触及：前缀包含匹配（后端 /v1/x/y 与前端 /v1/x/y/z 都算命中）
function isReachable(ep, calls) {
  return calls.some(c => c === ep || ep.startsWith(c + '/') || c.startsWith(ep + '/'));
}

function build() {
  const modules = listCoreModules();
  const endpoints = listEndpoints();
  const calls = listFrontendCalls();
  const tabs = listTabs();

  const reachable = endpoints.filter(e => isReachable(e, calls));
  // 机器端点先剔除（前提：前端没引用它——被引用说明也给了人入口，按可达算）
  const machineUnreachable = endpoints.filter(e => !isReachable(e, calls) && machineWhy(e))
    .map(e => ({ path: e, why: machineWhy(e) }));
  const unreachable = endpoints.filter(e => !isReachable(e, calls) && !machineWhy(e));

  // 按主题聚合不可达能力 —— 这就是「查缺补漏」的缺口清单
  const gaps = {};
  unreachable.forEach(e => {
    const t = topicOf(e);
    (gaps[t] = gaps[t] || []).push(e);
  });

  // 覆盖率只对「本该有前端入口」的端点计算：机器端点没有 UI 不是缺陷，
  // 把它们算进分母会把覆盖率永久压低、把真缺口的信号稀释掉。
  const userFacing = reachable.length + unreachable.length;
  return {
    coreModules: modules.length,
    endpoints: endpoints.length,
    frontendTabs: tabs.length,
    frontendCalls: calls.length,
    reachableEndpoints: reachable.length,
    unreachableEndpoints: unreachable.length,
    machineEndpoints: machineUnreachable.length,
    machineUnreachable,
    // 覆盖率：这是唯一需要盯住的数字（分母=人类入口端点，不含机器端点）
    reachabilityPct: userFacing ? Math.round(reachable.length / userFacing * 1000) / 10 : 0,
    tabs,
    gapsByTopic: Object.keys(gaps).map(t => ({ topic: t, count: gaps[t].length, endpoints: gaps[t] }))
      .sort((a, b) => b.count - a.count),
    unreachable
  };
}

// 空转检测：机制存在但从未运行 —— 与「够不到」并列的第二类缺口
function idleMechanisms() {
  const out = [];
  const probe = (name, mod, keys) => {
    try {
      const m = require(path.join(ROOT, 'core', mod));
      const st = typeof m.status === 'function' ? m.status() : (typeof m.snapshot === 'function' ? m.snapshot() : null);
      if (!st) return;
      keys.forEach(k => {
        const v = st[k];
        if (typeof v === 'number' && v === 0) out.push({ module: name, field: k, value: 0 });
      });
      // harness 特判：有 totalRuns 但全是 skipped 仍算空转；有非 skipped 结果则不算
      if (name.includes('harness')) {
        const runs = (require(path.join(ROOT, 'core', 'store')).read()[require(path.join(ROOT, 'core', 'harness')).RUNS_KEY] || []);
        const nonSkipped = runs.filter(r => r.result && r.result !== 'skipped').length;
        if (st.totalRuns > 0 && nonSkipped === 0) {
          out.push({ module: name, field: 'onlySkipped', value: st.totalRuns, detail: '全部 ' + st.totalRuns + ' 轮均为 skipped，无实质优化尝试' });
        }
      }
    } catch (e) { /* 模块不可用跳过 */ }
  };
  probe('harness(自我进化闭环)', 'harness', ['totalRuns', 'adopted', 'rejectedByCritic']);
  return out;
}

module.exports = { build, idleMechanisms, topicOf };