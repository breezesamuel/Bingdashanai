// core/anomaly-scan.js — 数据质量评估 + 统计异常检测 + 误报/漏报校准 + 自适应阈值
//
// 现状缺口（本模块纯增量补上）：
//   watchdog.js = 10 条硬编码静态规则；monitor.js = KPI 偏离 + webhook。两者都不做：
//     1) 数据质量评估（条数/新鲜度/ts 乱序/连重/字段缺失）；
//     2) 统计异常检测（滚动日序列）；
//     3) 误报/漏报校准（运营把 finding 判 tp/fp → 自适应收紧/放宽阈值）。
//   本模块读 store 真实集合，校准态落 setSetting('anomalyCalib')，绝不造数据；
//   样本不足诚实 not_enough，不硬判。
//
// 检测方法（对稀疏日计数稳健）：
//   · 每日计数序列 = 真实记录按 UTC 日桶聚合（空日补 0，不脑补）。
//   · 判定核心 = IQR 四分位（Q1/Q3/IQR，对大量 0/1 的稀疏序列比 MAD 稳健——
//     旧 MAD 版在「5 天相同 + 1 个尖峰」会退化 MAD=0 漏报，IQR 无此问题）。
//   · 自适应阈值：校准 k(3..6) 映射 IQR 倍数 iqrMult = 1.5 + (k-3)/3
//     → k=3 时 1.5（基础），k=6 时 2.5（最保守，误报最少）。
//   · 漏报保护：硬尖峰（value 远高于上界）在任何 k 下仍命中。
//   · 误报校准：被运营判 fp 的比例越高 → 自动推高 k → 越保守。
//
// 集合形状：事件型 = 数组（有 ts）；键值型 = 对象（如 settings，无 ts，只报条数）。
//   全部基于 store.read() 原数组，按实际形状分支，绝不对对象调用 Array API。

'use strict';
const store = require('./store');

const DAY = 86400000;
const LIST_ALL = 100000; // 事件型集合线上最大 ~2000，取全量覆盖 30 天窗口

// 被监控的「事件型」集合：按日计数有意义。ts 字段解析顺序 ts → at → createdAt。
const MONITORED = [
  { key: 'orders', label: '新订单' },
  { key: 'llmUsage', label: 'LLM 调用' },
  { key: 'audit', label: '审计事件' },
  { key: 'autopilot', label: '自动轮次' },
  { key: 'marketEvidence', label: '市场证据' },
  { key: 'wallAbuse', label: '风控命中' },
  { key: 'visitors', label: '新访客' },
  { key: 'revenue', label: '营收事件' },
  { key: 'outbound', label: '出站触达' },
  { key: 'mail', label: '邮件发送' },
  { key: 'conductor', label: '指挥台动作' },
  { key: 'promo', label: '返佣事件' },
  { key: 'harnessRuns', label: 'harness 运行' }
];

// 参与「数据质量」评估的集合（含键值型 settings；qualityFor 按形状自动分支）。
const QUALITY_COLLECTIONS = MONITORED.map(m => m.key).concat(['referralCodes', 'sublist', 'trains', 'settings']);

// 取某集合的真实数组（事件型）。对象型/缺失返回 []（不崩）。
function arrOf(key) {
  let raw;
  try { raw = store.read()[key]; } catch (e) { return []; }
  return Array.isArray(raw) ? raw : [];
}
// 取某集合原始形状（用于质量评估区分 数组/对象/缺失）。
function rawShape(key) {
  let raw;
  try { raw = store.read()[key]; } catch (e) { return undefined; }
  return raw;
}
function tsOf(item) {
  const v = item && (item.ts != null ? item.ts : (item.at != null ? item.at : item.createdAt));
  return Number(v) > 0 ? Number(v) : 0;
}
function dayKey(ts) { return Math.floor(ts / DAY); }
function round1(x) { return Math.round(x * 1000) / 1000; }

// —— 集合级数据质量（全真实：条数/新鲜度/ts乱序/连重/ts缺失率；对象型只报条数）——
function qualityFor(key) {
  const raw = rawShape(key);
  if (raw != null && !Array.isArray(raw) && typeof raw === 'object') {
    const n = Object.keys(raw).length;
    return { collection: key, type: 'map', count: n, score: 100, note: n ? '键值集合（非事件序列），只报条数，不做 ts/新鲜度指标' : '空（0 key）' };
  }
  const items = arrOf(key);
  const n = items.length;
  if (!n) return { collection: key, type: 'list', count: 0, fresh: false, score: 0, note: '集合为空（0 条）——不是异常，是尚未有真实数据' };
  const withTs = items.filter(x => tsOf(x) > 0);
  const tsMissingPct = Math.round((n - withTs.length) / n * 1000) / 10;
  const tsVals = withTs.map(x => tsOf(x));
  const lastTs = tsVals.length ? Math.max.apply(null, tsVals) : 0;
  const ageMs = lastTs ? Date.now() - lastTs : 0;
  let tsRegressions = 0;
  for (let i = 1; i < items.length; i++) {
    const a = tsOf(items[i - 1]), b = tsOf(items[i]);
    if (a > 0 && b > 0 && b < a) tsRegressions++;
  }
  let dupAdjacent = 0;
  for (let i = 1; i < items.length; i++) {
    if (items[i].id != null && items[i].id === items[i - 1].id) dupAdjacent++;
  }
  const fresh = lastTs > 0 && ageMs < 24 * DAY;
  const score = Math.max(0, 100 - tsMissingPct * 2 - Math.min(40, tsRegressions * 5) - Math.min(30, dupAdjacent * 3));
  return {
    collection: key, type: 'list', count: n, lastTs, ageDays: lastTs ? Math.round(ageMs / DAY) : null, fresh,
    tsMissingPct, tsRegressions, dupAdjacent, score,
    note: fresh ? '新鲜' : '已 ' + (lastTs ? Math.round(ageMs / DAY) : '∞') + ' 天无新数据'
  };
}

// —— 滚动日序列（基于真实记录按 UTC 日桶；空日补 0，不脑补）——
function dailySeries(key, days) {
  const items = arrOf(key);
  const nowDay = dayKey(Date.now());
  const buckets = {};
  for (let d = nowDay - (days - 1); d <= nowDay; d++) buckets[d] = 0;
  for (const it of items) {
    const t = tsOf(it);
    if (!t) continue;
    const dk = dayKey(t);
    if (buckets[dk] != null) buckets[dk]++;
  }
  const series = [];
  for (let d = nowDay - (days - 1); d <= nowDay; d++) series.push({ day: d, n: buckets[d] });
  return { series, nowDay, total: items.length };
}

// —— 分位 & 稳健统计（纯函数）——
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function median(a) {
  if (!a.length) return 0;
  return quantile(a.slice().sort((x, y) => x - y), 0.5);
}
function madZ(values) {
  const med = median(values);
  const absd = values.map(v => Math.abs(v - med));
  const mad = median(absd);
  const value = values[values.length - 1];
  const z = mad > 0 ? 0.6745 * (value - med) / mad : 0;
  return { value, median: med, mad, z };
}
// IQR 判定：对稀疏/恒定日计数稳健。iqrMult 越大越保守（越难判异常，误报越少）。
// IQR>0 → 经典 Tukey 上/下界（q3+mult*iqr / q1-mult*iqr，下界 clamp 0）。
// IQR=0（恒定基线或全零）→ 上界取 q3*(1+mult/10)：k=3→1.15x，k=6→1.25x。
//   硬尖峰（如 基线2/天 → 30/天，15x）在任何 k 下仍命中（漏报保护）；
//   轻微抬升（2→2.5）只有最保守档才不报（误报保护）。q3=0（全零）→ 上界 0，任何 >0 命中。
function iqrDetect(values, iqrMult) {
  const s = values.slice().sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  const upper = iqr > 0 ? q3 + iqrMult * iqr : q3 * (1 + iqrMult / 10);
  let lower = iqr > 0 ? q1 - iqrMult * iqr : 0;
  if (lower < 0) lower = 0; // 计数非负，下界不低于 0
  const value = values[values.length - 1];
  let hit = false, dir = null;
  if (value > upper) { hit = true; dir = 'spike'; }
  else if (value < lower) { hit = true; dir = 'drop'; }
  const ratio = q3 > 0 ? value / q3 : (value > 0 ? Infinity : 0);
  return { value, q1, q3, iqr, upper: round1(upper), lower: round1(lower), hit, dir, ratio: round1(ratio) };
}
// k(3..6) → IQR 倍数：k=3→1.5（基础），k=6→2.5（最保守）。
function kToIqrMult(k) {
  const kk = Math.max(3, Math.min(6, Number(k) || 3));
  return round1(1.5 + (kk - 3) / 3);
}

// —— 校准态（持久化 settings.anomalyCalib）——
function calib() { return store.getSetting('anomalyCalib') || { k: 3, reviews: [], history: [] }; }
function calibSave(c) { store.setSetting('anomalyCalib', c); }
function deriveK(reviews) {
  const decided = reviews.filter(r => r.verdict === 'tp' || r.verdict === 'fp');
  if (!decided.length) return 3;
  const fp = decided.filter(r => r.verdict === 'fp').length;
  const fpRate = fp / decided.length;
  return Math.max(3, Math.min(6, 3 + Math.round(fpRate * 3)));
}

// —— 主扫描 ——
function scan(opt) {
  const o = opt || {};
  const days = Math.max(7, Math.min(Number(o.days) || 14, 30));
  const minSamples = Math.max(3, Number(o.minSamples) || 7);
  const c = calib();
  const k = c.k || 3;
  const iqrMult = kToIqrMult(k);

  const quality = QUALITY_COLLECTIONS.map(qualityFor);

  const findings = [];
  const scanned = [];
  for (const m of MONITORED) {
    const { series, nowDay } = dailySeries(m.key, days);
    const vals = series.map(s => s.n);
    const nonZeroDays = vals.filter(v => v > 0).length;
    const res = { collection: m.key, label: m.label, days, k, iqrMult };
    if (nonZeroDays < minSamples) {
      res.status = 'not_enough';
      res.reason = '近 ' + days + ' 天仅 ' + nonZeroDays + ' 天有数据（需 ≥' + minSamples + '），样本不足不硬判';
      res.recent = series.slice(-7).map(s => s.n);
      scanned.push(res);
      continue;
    }
    const iq = iqrDetect(vals, iqrMult);
    const mzs = madZ(vals);
    res.status = iq.hit ? iq.dir : 'normal';
    res.last = iq.value;
    res.recent = series.slice(-7).map(s => s.n);
    res.iqr = { q1: iq.q1, q3: iq.q3, iqr: iq.iqr, upper: iq.upper, lower: iq.lower, iqrMult };
    res.madz = { median: mzs.median, mad: mzs.mad, z: round1(mzs.z) };
    if (iq.hit) {
      const fkey = m.key + ':' + nowDay + ':' + iq.dir;
      res.finding = {
        fkey, collection: m.key, label: m.label,
        day: new Date(nowDay * DAY).toISOString().slice(0, 10),
        dir: iq.dir, value: iq.value,
        bound: round1(iq.dir === 'spike' ? iq.upper : iq.lower),
        iqrMult, ratio: iq.ratio,
        severity: iq.dir === 'spike' ? (iq.ratio >= 3 ? 'high' : 'medium') : (iq.iqr === 0 ? 'high' : 'medium')
      };
      findings.push(res.finding);
    }
    scanned.push(res);
  }

  const fp = c.reviews.filter(r => r.verdict === 'fp').length;
  const tp = c.reviews.filter(r => r.verdict === 'tp').length;
  const fpRate = (fp + tp) ? Math.round(fp / (fp + tp) * 1000) / 10 : 0;
  return {
    ok: true, at: Date.now(), days, minSamples, k, iqrMult,
    quality, scanned, findings,
    calibration: { k, iqrMult, fp, tp, fpRate, note: 'k 越高越保守（IQR 倍数越大，误报越少）；被标误报越多自动收紧' },
    honesty: '全部来自 store 真实集合；样本不足 = not_enough（不硬判）；判定用 IQR 四分位（对稀疏日计数稳健），MAD-z 仅供展示；计数 0 = 尚未有真实数据'
  };
}

// 状态（轻量）
function status() {
  const c = calib();
  const k = c.k || 3;
  const fp = c.reviews.filter(r => r.verdict === 'fp').length;
  const tp = c.reviews.filter(r => r.verdict === 'tp').length;
  const fpRate = (fp + tp) ? Math.round(fp / (fp + tp) * 1000) / 10 : 0;
  const lastScan = store.getSetting('anomalyLastScan') || null;
  return {
    ok: true, at: Date.now(), k, iqrMult: kToIqrMult(k), fp, tp, fpRate,
    reviews: c.reviews.slice(-20), history: (c.history || []).slice(-10),
    lastScan: lastScan ? lastScan : '（尚未运行过扫描，先调 GET /v1/anomaly/scan）',
    note: 'GET /v1/anomaly/scan 触发一次；POST /v1/anomaly/review 校准 k'
  };
}

// 运营把某条 finding 判 tp(真异常)/fp(误报) → 重算 k 并落库。
function review(fkey, verdict) {
  verdict = String(verdict || '').toLowerCase();
  if (verdict !== 'tp' && verdict !== 'fp') return { ok: false, error: "verdict 必须是 'tp'(真异常) 或 'fp'(误报)" };
  if (!fkey) return { ok: false, error: 'fkey 必填（形如 collection:dayKey:dir）' };
  const c = calib();
  const reviews = c.reviews || [];
  const clean = reviews.filter(r => r.fkey !== fkey);
  clean.push({ fkey, verdict, at: Date.now() });
  const newK = deriveK(clean);
  c.reviews = clean;
  c.k = newK;
  c.history = (c.history || []);
  c.history.push({ at: Date.now(), fkey, verdict, k: newK });
  if (c.history.length > 60) c.history = c.history.slice(-60);
  calibSave(c);
  const decided = clean.filter(r => r.verdict === 'tp' || r.verdict === 'fp');
  const fpN = decided.filter(r => r.verdict === 'fp').length;
  return { ok: true, fkey, verdict, k: newK, iqrMult: kToIqrMult(newK), decidedCount: decided.length, fpRate: decided.length ? Math.round(fpN / decided.length * 1000) / 10 : 0, note: '校准已保存；下次 scan 用新 k' };
}

// 校准曲线
function calibration() {
  const c = calib();
  const k = c.k || 3;
  const fp = c.reviews.filter(r => r.verdict === 'fp').length;
  const tp = c.reviews.filter(r => r.verdict === 'tp').length;
  return {
    ok: true, at: Date.now(), k, iqrMult: kToIqrMult(k), fp, tp,
    fpRate: (fp + tp) ? Math.round(fp / (fp + tp) * 1000) / 10 : 0,
    curve: (c.history || []).map(h => ({ at: h.at, k: h.k, fkey: h.fkey, verdict: h.verdict })),
    kRange: [3, 6], iqrMultRange: [1.5, 2.5],
    honesty: 'k 由已判 review 的误报率推导（无 review→3，≥0.5→6）；k→IQR倍数 1.5..2.5（越保守越难命中）'
  };
}

// 运行一次并缓存摘要（供 status 轻量读取；可被定时器调用）
function runOnce() {
  const r = scan();
  store.setSetting('anomalyLastScan', {
    at: r.at, k: r.k, iqrMult: r.iqrMult,
    findings: r.findings.length,
    notEnough: r.scanned.filter(s => s.status === 'not_enough').length,
    normal: r.scanned.filter(s => s.status === 'normal').length,
    spikes: r.scanned.filter(s => s.status === 'spike').length,
    drops: r.scanned.filter(s => s.status === 'drop').length
  });
  return r;
}

module.exports = {
  MONITORED, QUALITY_COLLECTIONS,
  scan, status, review, calibration, runOnce,
  _internal: { tsOf, dayKey, median, madZ, iqrDetect, kToIqrMult, deriveK, dailySeries, calib, quantile, round1, arrOf, rawShape }
};
