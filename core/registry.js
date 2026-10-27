// core/registry.js — 自适应端点解析 · 自动建点 · 自动验证（第 2 条需求）
//
// 【需求】"自适应自动解析自动建点自动验证"
//
// 【现状：这四个字对应三个真实缺口】
//   1. **自动解析**：server.js 里 250+ 个端点是手写 if 链。新增端点要手写两遍
//      （路由 + paywall 登记），漏一处就静默免费——这正是我上一轮花大力气补的地方。
//   2. **自动建点**：能力表（capability.js 的 18 项）、编排器（7 种）都是硬编码常量。
//      新增一个模块不会自动出现在对话里，必须记得改 CAPS。
//   3. **自动验证**：新增端点/能力后，没有机制证明它真的能用。
//      之前的做法是我手动写脚本测——不可持续。
//
// 【解法】让"注册"变成一个动作的三段：
//   discover()  扫描 core/*.js，自动发现所有导出函数 → 推断它属于哪层、能回答什么
//   register()  自动建点：把发现的模块写入能力候选（含触发词推断），供人工确认
//   verify()    自动验证：对每个已注册端点/能力发真实探测，产出可读报告
//
// 【红线】
// 自动发现 ≠ 自动信任。新发现的能力一律标 confidence:'discovered'，
// 不会因为"扫到了"就进对话路由——否则模型会开始调用没验证过的东西。
// 要生效必须经过 verify() 或人工确认。这是"自动化"和"失控"的分界。

const fs = require('fs');
const path = require('path');
const store = require('./store');
const capability = require('./capability');
const layers = require('./layers');

// —— 能力域推断：把函数名映射到触发词 ——
const DOMAIN_HINTS = [
  { domain: '营收', kw: ['revenue', 'kpi', 'budget', 'settle', 'credit', 'spend', 'money', 'payout', 'profit', 'roi'], cn: ['营收', '收款', '到账', '收入', '利润', '成本'] },
  { domain: '获客', kw: ['lead', 'funnel', 'touch', 'convert', 'prospect', 'gtm', 'campaign'], cn: ['线索', '获客', '漏斗', '触达', '转化'] },
  { domain: '组织', kw: ['staff', 'org', 'team', 'assign', 'talent', 'hire', 'evolve'], cn: ['员工', '组队', '派工', '招人', '人才'] },
  { domain: '决策', kw: ['decision', 'suggest', 'apply', 'framework', 'deliber', 'focus'], cn: ['决策', '判断', '框架', '建议'] },
  { domain: '任务', kw: ['task', 'assign', 'plan', 'schedule', 'due'], cn: ['任务', '计划', '排期', '进度'] },
  { domain: '学习', kw: ['learn', 'memory', 'lesson', 'knowledge', 'train', 'evolve', 'recall'], cn: ['学习', '记忆', '经验', '知识', '训练'] },
  { domain: '内容', kw: ['produce', 'script', 'compose', 'music', 'studio', 'publish', 'draft', 'game'], cn: ['写稿', '音乐', '制作', '发布', '游戏', '文案'] },
  { domain: '监控', kw: ['watch', 'health', 'diag', 'scan', 'patrol', 'status', 'perf', 'loop'], cn: ['监控', '告警', '健康', '诊断', '性能'] },
  { domain: '技能', kw: ['skill', 'invoke', 'discover', 'repo', 'pack'], cn: ['技能', '调用', '装载', '技能包'] },
  { domain: 'Agent', kw: ['agent', 'consult', 'team', 'debate', 'backend', 'mesh'], cn: ['agent', '会诊', '协作', '后端'] }
];

function inferDomain(fnName) {
  const s = String(fnName || '').toLowerCase();
  for (const d of DOMAIN_HINTS) {
    if (d.kw.some(k => s.indexOf(k) >= 0)) return d.domain;
  }
  return null;
}

// —— 1. 自动解析：扫 core 目录 ——
function discover(opt) {
  const o = opt || {};
  const dir = path.join(__dirname);
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch (e) {}
  for (const f of files) {
    const id = f.replace(/\.js$/, '');
    // 基础设施类不进能力候选：它们是其他模块的依赖，不是用户会问的"能力"
    if (['store', 'tasktime', 'registry', 'trash', 'util'].indexOf(id) >= 0) continue;
    let mod = null;
    try { mod = require('./' + id); } catch (e) { out.push({ id, file: f, ok: false, error: '加载失败: ' + String(e.message).slice(0, 50) }); continue; }
    const fns = Object.keys(mod).filter(k => typeof mod[k] === 'function');
    if (!fns.length) { out.push({ id, file: f, ok: true, fns: 0, note: '无导出函数' }); continue; }
    // 每个函数 → 一条候选能力
    fns.forEach(fn => {
      const dom = inferDomain(fn) || inferDomain(id);
      out.push({
        id, file: f, fn, ok: true,
        domain: dom || '未分类',
        // 触发词初稿：中文用函数名的分词近似不可靠，所以给"领域词 + 函数名"作为候选
        suggestedKw: (DOMAIN_HINTS.find(d => d.domain === dom) || { cn: [] }).cn.concat([fn.replace(/_/g, '')]).slice(0, 5),
        registered: isRegistered(id + '.' + fn)
      });
    });
  }
  return {
    modules: files.length,
    candidates: out,
    okCount: out.filter(x => x.ok).length,
    failCount: out.filter(x => !x.ok).length,
    unregistered: out.filter(x => x.ok && !x.registered).length
  };
}

function registry() {
  return store.read().autoCaps || [];
}
function isRegistered(key) {
  return registry().some(x => x.key === key);
}

// —— 2. 自动建点 ——
// 把发现结果写入注册表。**不会自动进对话路由**——需要 confidence >= 'verified'
// 才被 capability 采纳。
function register(list) {
  const db = store.read();
  if (!Array.isArray(db.autoCaps)) db.autoCaps = [];
  const have = {};
  db.autoCaps.forEach(x => { have[x.key] = x; });
  let added = 0;
  (list || []).forEach(item => {
    const key = item.id + '.' + item.fn;
    if (have[key]) return;
    db.autoCaps.push({
      key, mod: item.id, fn: item.fn, domain: item.domain || '未分类',
      kw: (item.suggestedKw || []).slice(0, 6),
      confidence: 'discovered',      // 扫到的，未验证
      registeredAt: Date.now()
    });
    have[key] = true;
    added++;
  });
  store.write(db);
  store.push('audit', { action: '自动建点', detail: '新增 ' + added + ' 条候选能力（confidence=discovered，未验证不自动生效）', at: Date.now() });
  return { added, total: db.autoCaps.length };
}

// 人工/自动验证通过后升级 confidence → 才会被采纳
function confirm(key, ok, note) {
  const db = store.read();
  const c = (db.autoCaps || []).find(x => x.key === key);
  if (!c) return { ok: false, error: '未注册：' + key };
  c.confidence = ok ? 'verified' : 'rejected';
  c.note = String(note || '').slice(0, 160);
  c.checkedAt = Date.now();
  store.write(db);
  return { ok: true, key, confidence: c.confidence };
}

// —— 3. 自动验证 ——
// 依次尝试调用新函数的**无参调用**，能返回即视为"至少不崩"。
// 刻意不传参：传了可能触发真实副作用（发邮件/发钱），不该在验证阶段做。
function verify(opt) {
  const o = opt || {};
  const limit = Math.min(60, Number(o.limit) || 40);
  const regs = registry().filter(x => x.confidence === 'discovered').slice(0, limit);
  const results = [];
  for (const c of regs) {
    let state = 'ok', note = '';
    try {
      const mod = require('./' + c.mod);
      const fn = mod[c.fn];
      if (typeof fn !== 'function') { state = 'missing'; note = '导出里没有该函数'; }
      else {
        // 危险函数跳过自动调用——它们可能有副作用
        const DANGEROUS = /send|pay|credit|spend|settle|purchase|order|publish|delete|remove|reset|clear|run|execute|flush|kill|stop/i;
        if (DANGEROUS.test(c.fn)) { state = 'skipped'; note = '可能有副作用，跳过自动调用（需人工验证）'; }
        else {
          // 检查函数是否需要必填参数（length > 0 且第一个参数不是可选）
          const paramCount = fn.length;
          if (paramCount > 0) {
            state = 'skipped';
            note = '函数需要参数，跳过自动验证（需人工提供参数）';
          } else {
            const r = fn();
            note = r && typeof r.then === 'function' ? '返回 Promise（未 await）' : ('返回 ' + JSON.stringify(r === undefined ? 'undefined' : r).slice(0, 60));
          }
        }
      }
    } catch (e) {
      state = 'error'; note = String(e.message || e).slice(0, 80);
    }
    results.push({ key: c.key, mod: c.mod, fn: c.fn, domain: c.domain, state, note });
    // 验证通过的自动升级（skipped/error 不升级）
    if (state === 'ok') confirm(c.key, true, note);
    else if (state === 'error') confirm(c.key, false, note);
  }
  const by = {};
  results.forEach(r => { by[r.state] = (by[r.state] || 0) + 1; });
  return {
    checked: results.length, byState: by,
    results,
    summary: '检查 ' + results.length + ' 条：正常 ' + (by.ok || 0) + ' / 跳过 ' + (by.skipped || 0) + ' / 报错 ' + (by.error || 0) + ' / 缺失 ' + (by.missing || 0)
  };
}

// —— 端点自动登记（第 15 条收费墙的手工部分补齐）——
// 自动从 server.js 解析路由 → 与 paywall 登记表对账 → 列出**未登记**的端点。
// 这样新增端点漏登记会被立即暴露，而不是等到覆盖率掉下来才发现。
function auditEndpoints() {
  const pw = require('./paywall');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const set = new Set();
  let m;
  const re1 = /p\s*===\s*'([^']+)'\s*&&\s*req\.method\s*===\s*'(GET|POST|PATCH|DELETE|PUT)'/g;
  const re2 = /p\s*===\s*'([^']+)'\s*(?:\/\/[^\n]*)?\n\s*(?:if\s*\()?\s*req\.method\s*===\s*'(GET|POST|PATCH|DELETE|PUT)'/g;
  while ((m = re1.exec(src))) set.add(m[2] + ' ' + m[1]);
  while ((m = re2.exec(src))) set.add(m[2] + ' ' + m[1]);
  const list = [...set];
  const cov = pw.coverage(list);
  return {
    total: list.length, covered: cov.covered, rate: cov.rate,
    uncovered: cov.uncovered,
    sections: cov.sections.map(s => ({ key: s.key, quota: s.quota, endpoints: s.endpoints }))
  };
}

// 采纳：把已验证的 autoCaps 注入能力路由
function adopt() {
  const regs = registry().filter(x => x.confidence === 'verified');
  if (!regs.length) return { adopted: 0, note: '无已验证能力' };
  const db = store.read();
  const existing = (db.adoptedCaps || []).filter(k => regs.some(r => r.key === k));
  regs.forEach(r => { if (existing.indexOf(r.key) < 0) existing.push(r.key); });
  db.adoptedCaps = existing;
  store.write(db);
  return { adopted: existing.length, keys: existing.slice(0, 20) };
}

module.exports = { discover, register, confirm, verify, auditEndpoints, adopt, registry, isRegistered, inferDomain, DOMAIN_HINTS };