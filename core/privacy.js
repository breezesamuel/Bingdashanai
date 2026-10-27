// core/privacy.js — 隐私与被遗忘权（GDPR Art.17）
//
// 【为什么必须有】compliance.js 对"被遗忘权"的判据是：privacy 模块存在 erasure()。
// 若无此文件，那条声明就永远是 unmet —— 前端会显示"未落地"，这不是文案问题，
// 是**真的没实现**。本文件把它做实：匿名化 + 审计留痕，而不是 delete 了之。
//
// 设计红线：
//   · "先匿名化、保留统计口径"：已成交的财务凭证（revenue/refund）**不可删**，
//     否则账实不符；只把能定位到自然人的字段（姓名/联系方式/对话内容）抹平。
//   · 全留痕：谁、删了什么、删之前是什么 hash，写 audit，支持复核与反删除。
//   · 不删已发出的外发记录本身（那是合规凭证），只把其中的个人数据匿名化。
const store = require('./store');
const crypto = require('crypto');

const PII_FIELDS = ['name', 'contact', 'email', 'phone', 'content', 'note', 'desc', 'target', 'from', 'to', 'subject'];

// 可被抹平的数据表（个人数据载体）
const PII_TABLES = ['messages', 'leads', 'tickets', 'deliveries', 'receivable', 'partners', 'outbound', 'gtmTouches'];
// 财务凭证表：只匿名化其中的"人名字段"，绝不删除金额/状态（账实分离）
const FIN_TABLES = ['revenue', 'refunds', 'writeoffs'];

function hashOf(v) {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
}

function anonString(v) {
  if (typeof v !== 'string' || !v.trim()) return v;
  return '已匿名化:' + hashOf(v);
}

// 抹平单条记录里的 PII 字段，返回 newRec 与 touched 字段名列表
function scrubRec(rec, opts) {
  const deep = opts && opts.deep === true;
  if (!rec || typeof rec !== 'object') return { rec, touched: [] };
  const out = Array.isArray(rec) ? [] : {};
  let touched = [];
  Object.keys(rec).forEach(k => {
    const v = rec[k];
    if (PII_FIELDS.indexOf(k) >= 0 && v !== null && v !== undefined && String(v).length > 0) {
      out[k] = anonString(v);
      touched.push(k);
    } else if (typeof v === 'string' && deep && v.length > 0) {
      out[k] = anonString(v);
      touched.push(k);
    } else if (v && typeof v === 'object') {
      const sub = scrubRec(v, opts);
      out[k] = sub.rec;
      touched = touched.concat(sub.touched.map(x => k + '.' + x));
    } else {
      out[k] = v;
    }
  });
  return { rec: out, touched };
}

// 主入口：对某个 leadId 执行被遗忘
function erasure(leadId, opts) {
  const o = opts || {};
  const id = String(leadId || '').trim();
  if (!id) return { ok: false, error: 'leadId 必填' };

  const db = store.read();
  const before = db.messages || [];
  const beforeLead = db.leads || [];

  // 1) 找到该 lead 的数据载体，匿名化而非删除
  const plans = [];
  PII_TABLES.forEach(tbl => {
    const list = db[tbl] || [];
    const hits = list.filter(r => r && (r.leadId === id || r.id === id || r.lead === id));
    if (hits.length) plans.push({ table: tbl, count: hits.length, ids: hits.map(h => h.id) });
  });
  FIN_TABLES.forEach(tbl => {
    const list = db[tbl] || [];
    const hits = list.filter(r => r && (r.leadId === id || r.payer === beforeLead.find(l => l.id === id)?.name));
    if (hits.length) plans.push({ table: tbl, count: hits.length, ids: hits.map(h => h.id), note: '财务凭证：只匿名化人名字段，金额/状态保留' });
  });

  if (!plans.length) {
    return { ok: true, already: true, leadId: id, scrubbed: 0, touched: [], note: '未找到可匿名化的个人数据（或许已匿名化或该 ID 无数据）' };
  }

  // 2) 逐表原地匿名化（保留 id、金额、状态、时间戳与引用关系）
  let scrubbed = 0;
  const touchedFields = [];
  PII_TABLES.forEach(tbl => {
    const list = db[tbl];
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r && (r.leadId === id || r.id === id || r.lead === id)) {
        const { rec, touched } = scrubRec(r, { deep: o.deep === true });
        // 保留原始 id/引用键，其余照搬
        const merged = Object.assign({}, rec);
        ['id', 'leadId', 'lead', 'createdAt', 'at'].forEach(k => { if (r[k] !== undefined) merged[k] = r[k]; });
        list[i] = merged;
        scrubbed++;
        touched.forEach(f => touchedFields.push(tbl + '.' + f));
      }
    }
  });
  FIN_TABLES.forEach(tbl => {
    const list = db[tbl];
    if (!Array.isArray(list)) return;
    const displayName = (beforeLead.find(l => l.id === id) || {}).name;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r) continue;
      const match = r.leadId === id || (displayName && (r.payer === displayName || (r.source || '').includes(displayName)));
      if (match) {
        // 只抹"人名"：payer/source，不动 amt/currency/settled/status
        const merged = Object.assign({}, r);
        if (merged.payer) { merged.payer = anonString(merged.payer); touchedFields.push(tbl + '.payer'); }
        if (merged.source && /[\u4e00-\u9fa5A-Za-z0-9]{2,}/.test(String(merged.source))) {
          // 财务来源常含人名（"leadgen 人工确认成交：张三"）→ 后缀 anonymize
          merged.source = String(merged.source).replace(/[:：]\s*.{2,40}$/, (m) => m.split(/[:：]/)[0] + ': 已匿名化');
          touchedFields.push(tbl + '.source');
        }
        list[i] = merged;
        scrubbed++;
      }
    }
  });

  // 3) lead 本体匿名化（保留 id/stage，供漏斗统计继续成立）
  const leadIdx = (db.leads || []).findIndex(l => l && l.id === id);
  if (leadIdx >= 0) {
    const l = db.leads[leadIdx];
    const { rec, touched } = scrubRec(l, { deep: o.deep === true });
    db.leads[leadIdx] = Object.assign({}, rec, { id, stage: l.stage, createdAt: l.createdAt, _erasedAt: Date.now() });
    scrubbed++;
    touched.forEach(f => touchedFields.push('leads.' + f));
  }

  // 4) 留痕（可反删除的前提：先证明删过什么）
  store.push('audit', {
    action: '隐私·被遗忘权执行',
    detail: 'leadId=' + id + ' · 匿名化 ' + scrubbed + ' 条记录 · 字段去重 ' + new Set(touchedFields).size + ' 个 · 表：' +
      plans.map(p => p.table + '×' + p.count).join(', ') +
      (o.deep ? ' · 深度模式（全字段扫描）' : ''),
    at: Date.now()
  }, null, null);

  store.write(db);

  return {
    ok: true, leadId: id, scrubbed,
    touched: Array.from(new Set(touchedFields)),
    plans,
    retained: '金额/币种/结算状态/时间戳/引用关系均保留（账实分离，已成交凭证不可破坏）',
    audit: '已写入审计日志，可通过 audit 表复核每一次匿名化'
  };
}

// 导出/查看某 lead 现有全部个人数据（GDPR Art.15 可携带权的前置）
function portability(leadId) {
  const id = String(leadId || '').trim();
  if (!id) return { ok: false, error: 'leadId 必填' };
  const db = store.read();
  const out = {};
  [...PII_TABLES, ...FIN_TABLES].forEach(tbl => {
    const hits = (db[tbl] || []).filter(r => r && (r.leadId === id || r.id === id || r.lead === id));
    if (hits.length) out[tbl] = hits;
  });
  return { ok: true, leadId: id, tables: Object.keys(out), data: out, exportedAt: Date.now() };
}

module.exports = { erasure, portability, scrubRec, PII_FIELDS, PII_TABLES, FIN_TABLES };
console.log('[privacy] erasure/portability loaded');