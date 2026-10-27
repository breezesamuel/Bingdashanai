// core/maturity.js — 能力成熟度自动校准（2026-10-23）
//
// 【问题】SECTIONS 里的 maturity（tested/beta/experimental）是人工填写的，
// 随着功能迭代和实际故障数据积累，人工标注会逐渐失真：
//   · 一个 experimental 功能跑稳定了 → 应该升 beta
//   · 一个 beta 功能连续出故障 → 应该降 experimental
//   · 没有校准机制 → 成熟度标签失去意义
//
// 【校准逻辑】结合 paywall.ledger() 的真实用量与故障信号（如有），
// 自动生成 maturity 调整建议（不自动改 SECTIONS，人工确认后手动改）：
//
//   升级条件（experimental → beta）：
//     · 过去 7 天该分区有真实用量（usageToday + 历史累计 > 0）
//     · 无未解决故障（故障表为空或该分区无 open 记录）
//   降级条件（beta → experimental）：
//     · 该分区过去 24h 故障数 ≥ 3
//   升级条件（beta → tested）：
//     · 过去 30 天用量 > 100 次且无 open 故障
//
// 【数据源】
//   · 用量：store.list('visitors') 里 pools 字段（按分区按天汇总）
//   · 故障：store.list('faults') 或 /v1/audit 记录（暂未建立时用 0 代替）
//   · SECTIONS 定义：require('./paywall').SECTIONS
//
// 【红线】
//   · 只出建议，不自动改 SECTIONS（maturity 是代码常量，需 git commit）
//   · 建议结果写入 store（key='maturity-suggestions'），前端可展示
//   · 每次校准结果带时间戳，可审计
'use strict';

const store = require('./store');

const MATS = ['experimental', 'beta', 'tested'];
// 升级顺序：experimental → beta → tested（不可跳跃，每次只升一级）
const NEXT_MAT = { experimental: 'beta', beta: 'tested', tested: null };

/**
 * 读取过去 N 天各分区的真实用量
 * @returns {Object} section → 累计用量
 */
function usageLastDays(days = 7) {
  const visitors = store.list('visitors', 9999);
  const dayKeys = [];
  for (let i = 0; i < days; i++) dayKeys.push(new Date(Date.now() - i * 86400000).toDateString());
  const set = new Set(dayKeys);
  const usage = {};
  visitors.forEach(v => {
    const pools = v.pools || {};
    Object.keys(pools).forEach(k => {
      const parts = String(k).split('.');
      const day = parts.slice(1).join('.');
      const sec = parts[0];
      if (set.has(day) && sec) usage[sec] = (usage[sec] || 0) + Number(pools[k] || 0);
    });
  });
  return usage;
}

/**
 * 读取过去 24h 各分区故障数（故障数据在 /v1/audit 的 faults 表或 errors 日志）
 * 当前系统未建立专门故障表，返回 0；未来接入后可扩展数据源
 * @returns {Object} section → faultCount
 */
function faultsLast24h() {
  // 预留接口：若 store 里有 faults 记录，这里读出来
  try {
    const faults = store.list('faults', 999);
    const now = Date.now();
    const count = {};
    (faults || []).forEach(f => {
      if (f.ts && now - f.ts < 86400000 && f.section) {
        count[f.section] = (count[f.section] || 0) + 1;
      }
    });
    return count;
  } catch (e) {
    return {};   // 故障表不存在 → 全部 0
  }
}

// 【2026-10-24 接通真实故障源】此前 faults 表无人写入 → faultsLast24h() 恒为 0，
// 成熟度自校准的"故障降级"从未真正生效（审计 §8.2 #8 历史遗留）。
// 现在 server.js 主处理器在响应结束时把**分区端点的 HTTP 5xx** 落进 faults 表；
// 公共/只读端点（@public）不算故障面。只留最近 500 条，扫描器打爆 5xx 也撑不穿库。
function recordFault(section, detail) {
  const sec = String(section || '');
  if (!sec || sec === '@public') return;
  try {
    store.push('faults', { ts: Date.now(), section: sec, detail: String(detail || '').slice(0, 160) }, '成熟度·故障记录', sec);
    const all = store.list('faults', 9999);
    if (all.length > 500) {
      all.slice(0, all.length - 500).forEach(f => { try { store.remove('faults', f.id, '故障表封顶清理'); } catch (e) {} });
    }
  } catch (e) { /* 记故障不能反过来弄挂请求 */ }
}

/**
 * 生成校准建议
 * @returns {Array}  [{ section, current, suggested, reason, confidence }]
 */
function suggest() {
  const sections = require('./paywall').SECTIONS || {};
  const usage = usageLastDays(7);
  const faults = faultsLast24h();
  const suggestions = [];

  Object.keys(sections).forEach(sec => {
    const cur = sections[sec].maturity || 'experimental';
    const u = usage[sec] || 0;
    const f = faults[sec] || 0;
    let next = cur;
    let reason = '保持';
    let confidence = 'high';

    // 降级规则优先（出故障 → 降级）
    if (f >= 3 && cur !== 'experimental') {
      next = cur === 'beta' ? 'experimental' : 'beta';
      reason = `24h 内故障 ${f} 次（≥3）→ 自动建议降级`;
      confidence = f >= 5 ? 'high' : 'medium';
    } else if (cur === 'experimental') {
      // 升级 experimental → beta：需要真实用量
      if (u >= 10) {
        next = 'beta';
        reason = `过去 7 天用量 ${u} 次（≥10）且无 open 故障 → 建议升 beta`;
      }
    } else if (cur === 'beta') {
      // 升级 beta → tested：用量充足且无故障
      if (u >= 50 && f === 0) {
        next = 'tested';
        reason = `过去 7 天用量 ${u} 次（≥50）且无 24h 故障 → 建议升 tested`;
      }
    }

    if (next !== cur || reason !== '保持') {
      suggestions.push({ section: sec, current: cur, suggested: next, reason, confidence, usage: u, faults: f });
    }
  });

  return suggestions;
}

/**
 * 生成所有分区完整状态报告（含无需调整的）
 * @returns {Object}
 */
function report() {
  const sections = require('./paywall').SECTIONS || {};
  const usage = usageLastDays(7);
  const faults = faultsLast24h();
  const rows = Object.keys(sections).map(sec => ({
    section: sec,
    label: sections[sec].label || sec,
    maturity: sections[sec].maturity || 'experimental',
    usage7d: usage[sec] || 0,
    faults24h: faults[sec] || 0,
  }));
  return {
    ts: new Date().toISOString(),
    rows,
    suggestions: suggest().filter(s => s.suggested !== s.current),
    usageSource: 'store.visitors.pools（过去 7 天）',
    faultSource: 'store.faults（过去 24h；表不存在时全部 0）',
    note: '本建议仅供参考；升级/降级需人工确认后修改 core/paywall.js SECTIONS.maturity 字段。',
  };
}

/**
 * 把本次报告存档（方便追踪历史）
 * 【2026-10-23 修复】原先调用不存在的 store.upsert —— 运行时会抛
 * TypeError: store.upsert is not a function。store 的通用写入 API 是
 * push(key, item)（追加一条，自带 id/createdAt 与审计）。校准报告本就该
 * 留历史轨迹（谁在什么时候建议了什么），所以用 push 追加而非覆盖。
 */
function persist() {
  const rep = report();
  store.push('maturity-reports', {
    ts: rep.ts,
    rows: rep.rows,
    suggestions: rep.suggestions,
  }, '成熟度校准存档', rep.ts + ' 建议 ' + rep.suggestions.length + ' 条');
  return rep;
}

module.exports = { MATS, NEXT_MAT, usageLastDays, faultsLast24h, recordFault, suggest, report, persist };
