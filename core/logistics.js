// core/logistics.js — 物流/快递跟踪（自动化入料，绝不造假）
// 采用快递100（kuaidi100）官方「即时查询」pol API 的对接方式（零依赖自实现）：
//   endpoint: https://poll.kuaidi100.com/poll/query.do
//   参数:  customer(授权码) + sign(md5(param+customer+key)) + param(JSON: comp+num+phone尾4)
// 来源：kuaidi100-api/kuaidi100-MCP-Nodejs（已在技能军械库登记，官方仓库）
// 诚实原则（与 pay.js 同款）：
//   · 未配 KUAIDI100_KEY / KUAIDI100_CUSTOMER → 返回 needKey:true，绝不假装已查到；
//   · 网络失败/单号不存在 → 如实返回 error；
//   · 只有真实 HTTP 200 + result 非空才判定为"跟踪成功"。
// 备注：快递100 免费即时查询需企业认证 key；未认证时接口返回 400（认证失败），
//   同样如实透传，不降级为伪造数据。

const crypto = require('crypto');
const store = require('./store');
const path = require('path');
const fs = require('fs');

function envGet(name) {
  try {
    if (process.env[name] && String(process.env[name]).trim()) return String(process.env[name]).trim();
    const ef = {};
    const envPath = path.resolve(__dirname, '..', '.env');
    try {
      fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return;
        const i = t.indexOf('=');
        if (i < 0) return;
        ef[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      });
    } catch (e) {}
    return (ef[name] || '').trim();
  } catch (e) { return ''; }
}

function creds() {
  const k = String(store.getSetting('kuaidi100Key') || envGet('KUAIDI100_KEY') || '').trim();
  const c = String(store.getSetting('kuaidi100Customer') || envGet('KUAIDI100_CUSTOMER') || '').trim();
  return { key: k, customer: c, configured: !!(k && c) };
}

// comp（快递公司编码）兜底：已知主流编码，未知时置空让它自动识别
function compFor(carrier) {
  const m = {
    '顺丰': 'shunfeng', 'SF': 'shunfeng',
    '中通': 'zhongtong', '圆通': 'yuantong', '申通': 'shentong',
    '韵达': 'yunda', '百世': 'baishiwuliu',
    '京东': 'jd', 'EMS': 'ems', '邮政': 'youzhengguonei', '极兔': 'jtexpress'
  };
  const key = String(carrier || '').trim();
  return m[key] || '';
}

// 即时查询一条物流：真实 HTTP 调用，失败/未配置如实返回
async function query(no, carrier) {
  const number = String(no || '').trim();
  if (!number) return { ok: false, code: 'no-number', error: '缺少快递单号' };
  const c = creds();
  if (!c.configured) {
    return {
      ok: false, code: 'need-key', error: '未配置快递100 key（KUAIDI100_KEY + KUAIDI100_CUSTOMER）',
      hint: '注册快递100 开放平台企业认证后可调用；未配置绝不伪造物流状态'
    };
  }
  const param = JSON.stringify({ comp: compFor(carrier), num: number, resultv2: '4' });
  const sign = crypto.createHash('md5').update(param + c.customer + c.key).digest('hex').toUpperCase();
  const body = new URLSearchParams({ customer: c.customer, sign, param });
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const resp = await fetch('https://poll.kuaidi100.com/poll/query.do', {
      method: 'POST', body, signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      redirect: 'follow'
    });
    clearTimeout(timer);
    const status = resp.status;
    const txt = await resp.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) { j = { raw: txt.slice(0, 200) }; }
    if (Number(j.status) === 200 && j.data && Array.isArray(j.data) && j.data.length) {
      const last = j.data[0];
      const isDelivered = /签收|已交付|妥投|已代收|已收件提交/.test(String(last.context || '')) ||
        /SIGN/.test(String(last.ischeck === '1' ? '' : ''));
      return {
        ok: true,
        provider: 'kuaidi100', no: number, comp: j.com || compFor(carrier),
        state: last.ischeck === '1' ? '已签收' : '在途',
        delivered: isDelivered,
        checkpoint: String(last.context || '').slice(0, 120),
        time: last.time || '',
        fmTime: last.fmTime || '',
        raw: { status: '200' }
      };
    }
    let error = j.message || '查询失败';
    if (String(status) === '400') {
      error = '快递100 返回 400（未认证/无权限或单号异常）：' + (j.message || '') + ' —— 企业认证后才可免费即时查询';
    }
    return { ok: false, code: 'remote-error', error: String(error).slice(0, 200), raw: { status: String(status) } };
  } catch (e) {
    return { ok: false, code: 'network', error: '物流查询网络失败：' + String(e && (e.message || e)).slice(0, 160) };
  }
}

// 自动盯盘：对「物流在途」订单逐条真实查询，签收则回写 fulfilled 推进
// 冷却：同一单号 query 后 DUAL 冷却期内不再重复打快递100（付费 API，省着点）
//   配置项 logisticsQueryCooldownMin（分钟），默认 30。force=true 忽略冷却。
async function sweep(opts) {
  const o = opts || {};
  const st = store.read();
  const rows = (st.fulfillment || []).filter(x => x.status === 'shipped' && x.logistics && x.logistics.no);
  if (!rows.length) return { ok: true, checked: 0, delivered: [], errors: [] };
  const c = creds();
  if (!c.configured) return { ok: false, needKey: true, checked: 0, error: '未配置快递100 key，跳过自动物流查询（不伪造）' };
  const fm = require('./fulfillment');
  const cooldownMin = Number(o.cooldownMin !== undefined ? o.cooldownMin : (store.getSetting('logisticsQueryCooldownMin') || 30));
  const cooldownMs = Math.max(0, Number(cooldownMin) || 0) * 60000;
  const now = Date.now();
  const delivered = [], errors = [], skipped = [];
  for (const ord of rows) {
    const last = Number(ord.logistics.lastQueriedAt) || 0;
    if (!o.force && cooldownMs > 0 && now - last < cooldownMs) {
      skipped.push({ orderNo: ord.orderNo, no: ord.logistics.no, waitMin: Math.ceil((cooldownMs - (now - last)) / 60000) });
      continue;
    }
    const r = await query(ord.logistics.no, ord.logistics.carrier).catch(() => ({ ok: false, code: 'network', error: '查询异常' }));
    store.update('fulfillment', ord.id, { logistics: Object.assign({}, ord.logistics, { lastQueriedAt: Date.now(), lastStatus: r.ok ? r.state : 'error', lastError: r.ok ? '' : String(r.error || '').slice(0, 60) }) }, '物流·自动查询');
    if (r.ok && r.delivered && !ord.deliveredAt) {
      try {
        fm.advance(ord.id, { delivered: true, stageNote: '物流自动签收：' + String(r.checkpoint).slice(0, 40) });
        delivered.push({ orderNo: ord.orderNo, no: ord.logistics.no });
      } catch (e) { errors.push({ orderNo: ord.orderNo, error: '回写失败 ' + String(e.message || e).slice(0, 80) }); }
    } else if (!r.ok) {
      errors.push({ orderNo: ord.orderNo, error: String(r.error || '').slice(0, 120) });
    }
  }
  return { ok: true, checked: rows.length - skipped.length, skipped, delivered, errors, needKey: false };
}

function status() {
  const c = creds();
  return { configured: c.configured, provider: '快递100(kuaidi100)', hint: !c.configured ? '需 KUAIDI100_KEY + KUAIDI100_CUSTOMER（企业认证）才可真实查询' : '已配置，可真实查询' };
}

module.exports = { query, sweep, status, creds, compFor };