// core/wled.js — WLED 物理通知桥
//
// WLED 是真实存在的开源固件（github.com/wled/WLED，EUPL-1.2，ESP32/ESP8266 驱动 WS2812B 等
// 数字 RGB 灯带）。它**不是本项目的依赖**，也无法被"装载"进 Node——我们能做的是通过它
// **已实测核对过的本地 JSON API** 把经营事件变成一下看得见的物理反馈：
//     GET  /json/info    → { ver, name, leds:{ count }, ... }
//   （依据 https://kno.wled.ge/interfaces/json-api/ ，2026-10 实际抓取核对）
//   POST /json/state     body: {"on":true,"bri":255,"transition":4,"seg":[{"col":[[0,255,80]]}]}
//        成功返回 {"success":true}（加 "v":true 才回全量 state）
//
// 设计原则（与 lightning 旁观者一致）：
//   · 设备不可达/未配置 → 静默失败，返回 {ok:false,error}，**绝不抛异常、绝不阻断结算**。
//   · 只用于「真实」事件：真实成交、真实到账。自测单、模拟数据一律不触发。
//
// 诚实边界：灯亮不是收入，不是证据，只是给自己/团队的一个物理反馈信号。
// 绝不允许用它冒充"成交通知"或制造"业务很火"的假象。

const DEFAULT_PORT = 80;
const TIMEOUT_MS = 2500;

const PRESETS = {
  deal: { color: [0, 255, 80], bri: 255, transition: 4, note: '真实成交' },
  payment: { color: [255, 180, 0], bri: 255, transition: 4, note: '真实到账' },
  alert: { color: [255, 0, 0], bri: 255, transition: 2, note: '告警' },
  info: { color: [0, 140, 255], bri: 150, transition: 4, note: '信息' }
};

function storeMod() { return require('./store'); }

function cfg() {
  const g = k => { try { return storeMod().getSetting(k); } catch (e) { return undefined; } };
  return {
    enabled: g('wledEnabled') === true,
    host: String(g('wledHost') || ''),
    port: Number(g('wledPort')) || DEFAULT_PORT,
    brightness: Number(g('wledBrightness')) || 200
  };
}

function saveConfig(patch) {
  const p = patch || {};
  const s = storeMod();
  if (p.enabled !== undefined) s.setSetting('wledEnabled', p.enabled === true);
  if (p.host !== undefined) s.setSetting('wledHost', String(p.host || '').trim().slice(0, 120));
  if (p.port !== undefined) s.setSetting('wledPort', Number(p.port) || DEFAULT_PORT);
  if (p.brightness !== undefined) s.setSetting('wledBrightness', Math.max(1, Math.min(255, Number(p.brightness) || 200)));
  return cfg();
}

function baseUrl(c) {
  const conf = c || cfg();
  if (!conf.host) return '';
  const host = conf.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const withPort = /:\d+$/.test(host) ? host : host + ':' + conf.port;
  return 'http://' + withPort;
}

// Node fetch 对 ECONNREFUSED 只给一句 'fetch failed'，运维看了等于没看。
// 这里把底层 cause（ECONNREFUSED/EHOSTUNREACH/…）带出来，让"灯不亮"变成可归因的。
function errMsg(e) {
  if (!e) return String(e);
  const base = String(e.message || e);
  if (e.name === 'TimeoutError') return '设备无响应（超时）';
  const cause = e.cause && (e.cause.message || e.cause.code) ? String(e.cause.message || e.cause.code) : '';
  return cause ? base + '（' + cause + '）' : base;
}

// 读设备信息：用于「连接测试」——能拿到 ver/name 才算真的通了
async function info() {
  const c = cfg();
  const base = baseUrl(c);
  if (!base) return { ok: false, error: '未配置 WLED 地址（wledHost）' };
  try {
    const r = await fetch(base + '/json/info', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const j = await r.json();
    return {
      ok: true, url: base,
      version: j && j.ver, name: j && j.name,
      leds: j && j.leds && j.leds.count, arch: j && j.arch, mac: j && j.mac
    };
  } catch (e) {
    return { ok: false, error: errMsg(e), url: base };
  }
}

// 下发状态（严格按 WLED JSON API 的 state 对象）
async function apply(state) {
  const c = cfg();
  const base = baseUrl(c);
  if (!base) return { ok: false, error: '未配置 WLED 地址（wledHost）' };
  const body = Object.assign({ transition: 4 }, state || {});
  try {
    const r = await fetch(base + '/json/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: true, url: base, sent: body, ack: j && j.success ? true : (j ? j : null) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

function presetState(p) {
  return { on: true, bri: p.bri, transition: p.transition, seg: [{ col: [p.color] }] };
}

// 手动触发某个预设（运营/测试用）
async function notify(kind) {
  const c = cfg();
  if (!c.enabled) return { ok: false, error: 'WLED 未启用（wledEnabled=false）' };
  const p = PRESETS[kind] || PRESETS.info;
  const r = await apply(presetState(p));
  return Object.assign({ kind, note: p.note }, r);
}

// 真实成交/真实到账才调用：自测、金额<=0 一律不触发（绝不放大假象）
async function celebrateRealDeal(opts) {
  const o = opts || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, skipped: 'disabled' };
  const amt = Number(o.amount) || 0;
  if (!(amt > 0)) return { ok: false, skipped: 'amount<=0' };
  if (o.selfTest === true) return { ok: false, skipped: 'self-test' };
  const kind = o.kind === 'payment' ? 'payment' : 'deal';
  const p = PRESETS[kind];
  const r = await apply(Object.assign(presetState(p), { bri: Math.max(c.brightness, p.bri) }));
  return Object.assign({ kind, amount: amt, currency: o.currency || 'CNY' }, r);
}

// 给配置面板看的说明
function describe() {
  const c = cfg();
  return {
    ok: true, config: c, baseUrl: baseUrl(c), presets: Object.keys(PRESETS),
    api: { info: 'GET /json/info', state: 'POST /json/state' },
    doc: 'https://kno.wled.ge/interfaces/json-api/',
    note: 'WLED 是独立开源固件(wled/WLED, EUPL-1.2)，非本项目依赖；这里只通过其本地 JSON API 做物理通知'
  };
}

module.exports = { cfg, saveConfig, baseUrl, info, apply, notify, celebrateRealDeal, describe, PRESETS, DEFAULT_PORT };
