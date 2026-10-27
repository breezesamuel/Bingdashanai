// core/mcp.js — A13 Agent-ready：把「推演」变成别人 Agent 的工具（FINAL-2.0 §6 落地）
// M10 班车：现有 REST 之上包一层 MCP server（~250 行），端点原样复用。
// 工具面只暴露三个：
//   decision.deliberate（完整推演，计费 ¥0.99/次）——报告带"powered by 我一直在"脚注 + 验证页链接
//   case.search（案例卡检索，免费带水印）
//   manual.get（活下去手册，免费——免费层在 agent 生态里是获客入口）
// 边界（三不接，写进服务条款）：不接医疗/法律/金融投资建议类 prompt 场景（命中即返回"该题需专业人士"+拒扣费）；
//   不接转售型批量调用（速率+用途声明）；不接需要存用户数据的中间平台（数据边界守 v12 §6 同款）。
// 计费：API key + 预付余额；每次 deliberate 扣 ¥0.99；小赌快验，不死磕（M12 撤下仅留免费引流档）。

const store = require('./store');
const decision = require('./decision');
const crypto = require('crypto');
const manuals = require('./manuals');
const peers = require('./peers');

const PRICE = 0.99;                       // ¥0.99/次完整盘
const BANNED_DOMAINS = ['医疗', '诊断', '用药', '手术', '处方', '起诉', '条款解释', '股票', '基金', '投资建议', '期货', '加密货币'];
const EXEMPT_BALANCE = 20;                // 完整盘预充值底限：余额低于则只保留免费引流档
const FREE_RATE = { winSec: 60, max: 20 }; // 免费档：单 key 每 60s 最多 20 次（防转售批量爬取）

// —— 免费档速率闸（内存滑动窗口，进程级即可；计费盘本身按余额天然限速）——
const freeHits = new Map(); // key -> number[]
function ratelimit(key, nowMs) {
  const now = nowMs || Date.now();
  const win = FREE_RATE.winSec * 1000;
  const arr = (freeHits.get(key) || []).filter(t => now - t < win);
  if (arr.length >= FREE_RATE.max) {
    freeHits.set(key, arr);
    return { hit: true, retryInSec: Math.ceil((win - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  freeHits.set(key, arr);
  return { hit: false };
}

// —— 密钥台账：developer key + 余额（预付）——
function issueKey(body) {
  const dev = String(body.dev || '').trim().slice(0, 40);
  if (!dev) throw new Error('开发者署名必填');
  const total = Math.max(0, Number(body.recharge || 0));
  if (String(body.purpose || '').includes('完整盘') && total < EXEMPT_BALANCE) {
    throw new Error('完整盘（计费 ¥0.99/次）需预充值 ≥ ¥' + EXEMPT_BALANCE + '；免费引流档可签 ¥0 专用 key');
  }
  const key = 'bds_' + crypto.randomBytes(9).toString('base64url');
  store.push('mcpKeys', {
    key, dev, balance: total, uses: 0, createdAt: Date.now(),
    purpose: String(body.purpose || '').slice(0, 120),
    status: 'active'
  }, 'MCP 密钥签发', dev + ' 充 ¥' + total);
  return { key, dev, balance: total };
}

function findKey(key) {
  const k = store.list('mcpKeys').find(x => x.key === key && x.status === 'active');
  if (!k) throw new Error('无效或已停用的 API key');
  return k;
}

// 充值：只在**人工确认到账凭证**后才加余额。
// 红线：绝不接受"自报金额即入账"——那等于任何人都能给自己加无限余额（历史漏洞）。
function recharge(key, amt, evidence) {
  const ev = String(evidence || '').trim();
  if (!ev) return { error: '必须提供到账凭证（evidence），否则不予记账' };
  const v = Math.max(0, Number(amt || 0));
  if (!(v > 0)) return { error: '充值金额必须 > 0' };
  const k = findKey(key);
  store.update('mcpKeys', k.id, {
    balance: k.balance + v,
    lastRecharge: { amt: v, evidence: ev.slice(0, 120), at: Date.now() },
    updatedAt: Date.now()
  }, 'MCP 充值（人工确认到账）');
  store.push('audit', {
    action: 'MCP 余额充值',
    detail: k.dev + ' +¥' + v + '（余额 ¥' + Math.round((k.balance + v) * 100) / 100 + '）· 凭证：' + ev.slice(0, 60),
    at: Date.now()
  }, null, null);
  return { dev: k.dev, balance: Math.round((k.balance + v) * 100) / 100 };
}

// 三不接判定：命中即拒扣费
function blocked(input) {
  const t = String(input || '');
  const hit = BANNED_DOMAINS.find(w => t.includes(w));
  return hit ? { blocked: true, reason: '该题需专业人士（命中禁区：' + hit + '）——已拒绝且不扣费。' } : { blocked: false };
}

// —— tools 目录（供外部 Agent 发现）——
function tools() {
  return {
    server: 'myongyi-mcp',
    version: 'v1',
    tools: [
{
        id: 'decision.deliberate',
        name: '完整推演（计费 ¥0.99/次）',
        params: ['topic（必填，≤200 字）', 'framework（可选，framework id）'],
        note: '输出七段报告；脚注 powered by 我一直在 + 验证页链接。完整盘预充值底限 ¥' + EXEMPT_BALANCE + '，余额低于则保留免费引流档。'
      },
      { id: 'case.search', name: '案例卡检索（免费，带水印）', params: ['gua（可选，处境卦 S01–S16）', 'kw（可选）'], note: '仅返回出处+摘要，不含完整正文' },
      { id: 'manual.get', name: '活下去手册（免费）', params: ['slug 或 no（1–12）'], note: '全文可读，免登录，危机版含 12356' }
    ],
    pricing: { deliberate: PRICE, case_search: 0, manual_get: 0 },
    boundary: '不接医疗/法律/金融投资建议；不接转售型批量调用；不接需存用户数据的中间平台'
  };
}

// —— MCP call 统一入口（HTTP 版：POST /v1/mcp/call {tools, params, key}）——
function call(body) {
  const tool = String(body.tools || body.tool || '').trim();
  if (!tool) throw new Error('缺 tools 参数');
  if (tool === 'decision.deliberate') return deliberate(body);
  if (tool === 'case.search' || tool === 'manual.get') {
    // 免费档限速：单 key 60s 最多 20 次（无 key 的匿名调用共用 anon 桶，仍有闸）
    const bucket = String(body.key || 'anon').slice(0, 40);
    const rl = ratelimit(bucket);
    if (rl.hit) return { ok: false, error: '免费档请求过频，请 ' + rl.retryInSec + 's 后再试（或充值完整盘）', fees: 0, limited: true };
    return tool === 'case.search' ? caseSearch(body) : manualGet(body);
  }
  throw new Error('未知工具：' + tool);
}

// deliberate：完整推演（计费）。调七段报告引擎，输出带脚注。
function deliberate(body) {
  const key = String(body.key || '').trim();
  const k = findKey(key);
  const topic = String(body.topic || body.params || '').trim();
  if (!topic) return { ok: false, error: 'topic 必填' };
  // 三不接：命中禁区 → 拒扣费
  const bl = blocked(topic);
  if (bl.blocked) return { ok: false, error: bl.reason, fees: 0 };
  // 计费：余额不足拒接
  if (k.balance < PRICE) return { ok: false, error: '余额不足（¥' + k.balance + '），请充值（单次 ¥' + PRICE + '）', fees: 0 };
  // 跑真实推演（七段报告引擎，与站内同源）
  const report = require('./report').seven(topic, body.context || '');
  store.update('mcpKeys', k.id, { balance: +(k.balance - PRICE).toFixed(2), uses: k.uses + 1, lastUse: Date.now() }, 'MCP deliberate 计费');
  store.push('mcpUsage', {
    dev: k.dev, tool: 'decision.deliberate', topic: topic.slice(0, 100), fee: PRICE, gua: report.gua, at: Date.now()
  }, 'MCP 调用 deliberate', (k.dev + ' ' + topic.slice(0, 40)));
  const rawV = report.verifyUrl ? String(report.verifyUrl) : '';
  const vurl = /^https?:/i.test(rawV) ? rawV : 'http://127.0.0.1:3721' + rawV;
  return {
    ok: true, fee: PRICE, balance: +(k.balance - PRICE).toFixed(2),
    result: {
      version: report.version, gua: report.gua, crisis: report.crisis,
      content: report.content + '\n\n—— powered by 我一直在 · 验证页 ' + vurl,
      verify: vurl
    }
  };
}

// case.search：案例卡检索（免费，带水印——只在正文处带标识，不含完整内容）
function caseSearch(body) {
  const gua = String(body.gua || '').trim().toUpperCase();
  const kw = String(body.kw || '').trim();
  const m = manuals.MANUALS.find(x => {
    try { return gua === '' || peers.guaOf(gua).name === peers.guaName(String(x.title)); } catch (e) { return false; }
  });
  const items = (m && m.cases ? m.cases : []).map(c => ({
    person: c.person, how: c.how.slice(0, 80), src: c.src
  }));
  // kw 过滤
  const out = kw ? items.filter(i => i.person.includes(kw) || i.how.includes(kw) || i.src.includes(kw)) : items;
  return {
    ok: true, fees: 0,
    watermark: '案例卡由「我一直在」提供（水印：myongyi）。',
    gua: gua || '未指定', count: out.length,
    cases: out.slice(0, 5).map(c => ({ text: c.person + '：' + c.how + '（' + c.src + '）' }))
  };
}

// manual.get：活下去手册（免费，全文）
function manualGet(body) {
  const ref = String(body.params || body.slug || body.no || '').trim();
  const m = manuals.get(ref);
  if (!m) return { ok: false, error: '手册不存在（no 1–12 或 slug）' };
  return {
    ok: true, fees: 0,
    manual: { no: m.no, title: m.title, crisis: !!m.crisis, steps: m.steps, dont: m.dont, policy: m.policy, exit: m.exit },
    note: m.crisis ? '本册为危机版：12356 置顶，零商业（' + manuals.HOTLINE.main + '）' : '全文开放'
  };
}

// —— 使用统计（战情室面板）——
function stats() {
  const keys = store.list('mcpKeys');
  const usage = store.list('mcpUsage');
  const rev = usage.reduce((a, u) => a + (u.fee || 0), 0);
  return {
    developers: keys.length,
    keysActive: keys.filter(k => k.status !== 'revoked').length,
    uses: usage.length,
    revenue: Math.round(rev * 100) / 100,
    balancePool: keys.reduce((a, k) => a + (k.balance || 0), 0),
    last: usage.slice(0, 5).map(u => ({ dev: u.dev, tool: u.tool, topic: u.topic }))
  };
}

module.exports = { PRICE, BANNED_DOMAINS, tools, issueKey, recharge, call, deliberate, caseSearch, manualGet, stats, blocked, findKey };