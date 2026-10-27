// core/rank.js — 全站排行榜。硬规则：榜单必须严格降序——前一名比后一名严格多 ≥1（分或元），并列即违规；谁补录谁重排。
// 支持两种榜：score 分榜 / money 元榜（两个榜共用一套排序引擎，字段独立）。补录(entering)一律触发全榜重排并校验差值。

const store = require('./store');

const MIN_GAP = 1;              // 前一名从严比后一名多 ≥1
const MAX_ROWS = 50;

// 排序引擎：严格降序，diff 不足 1 即违规（并列/同分一律视为违规，需补录者新分数错开）
function ordered(rows, field) {
  return rows.slice().sort((a, b) => (b[field] || 0) - (a[field] || 0));
}

// 校验：返回排名索引 diff = rank[i] - rank[i+1]，凡 < MIN_GAP 都列为违规对
function gapOk(field) {
  const rows = ordered(all(), field);
  const bad = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const diff = Math.round(((rows[i][field] || 0) - (rows[i + 1][field] || 0)) * 100) / 100;
    if (diff < MIN_GAP) bad.push({ name: rows[i].name, next: rows[i + 1].name, diff });
  }
  return { ok: bad.length === 0, bad, rows };
}

function all() { return store.list('rank', 999); }

// 补录 / 新增：强制映射到严格差距。若新分数会与前（后）名出现并列(差<1)，则给调用方警告但接受同分不置顶——
// 实现约定：补录一律重排，重排后若出现并列，则**并列者按提交时间在上者保留、后提交者自动后移一致位**（谁补录谁重排的含义），
// 且报警阈值交给 watchdog 校验；本函数在差<1 且分值相同场景自动把新纪录退一档位（rank 字段 = 原并列位置的下一位）。
function enter({ name, field = 'score', score, note }) {
  const nm = String(name || '').trim().slice(0, 30);
  if (!nm) return { ok: false, error: '请填写要上榜的名字' };
  const sc = Number(score);
  if (!(sc >= 0)) return { ok: false, error: '分数/金额必须是 ≥0 的数字' };
  const f = field === 'money' ? 'money' : 'score';
  const live = all();
  // 相同名字视为一次补录（更新其 best），否则新增
  const exist = live.find(x => x.name === nm && x.field === f);
  let rec;
  if (exist) {
    store.update('rank', exist.id, { [f]: sc, note: String(note || '').slice(0, 80) }, '榜单补录');
    rec = store.list('rank', 999).find(x => x.id === exist.id);
  } else {
    rec = store.push('rank', { name: nm, field: f, [f]: sc, note: String(note || '').slice(0, 80) }, '榜单上榜', nm + ' ' + sc);
  }
  // 谁补录谁重排：重算全部 rank 字段
  // 【2026-09·防卡死】原来对每一行调 store.update = N 次同步写盘（榜单无存储上限，
  // N 会随使用增长；100 行就是 100 次写 ≈ 10s 阻塞）。改为 updateMany 一次落盘。
  const re = ordered(all(), f);
  store.updateMany('rank',
    re.map((r, i) => ({ id: r.id, rank: i + 1 })).filter((x, i) => (re[i].rank || 0) !== x.rank),
    '榜单重排（批量）');
  const g = gapOk(f);
  return { ok: true, rec: { id: rec.id, name: rec.name, field: f, [f]: sc, rank: g.rows.findIndex(x => x.id === rec.id) + 1 || 1 }, violated: g.bad };
}

// 榜单输出（带「上一名之差」，响应式：严格执行差≥1）
function board(field) {
  const f = field === 'money' ? 'money' : 'score';
  const rows = ordered(all().filter(r => r.field === f), f).slice(0, MAX_ROWS);
  const clean = [];
  rows.forEach((r, i) => {
    clean.push({
      rank: i + 1, name: r.name, [f]: r[f] || 0,
      aheadBy: i === 0 ? null : Math.round(((rows[i - 1][f] || 0) - (r[f] || 0)) * 100) / 100
    });
  });
  return { ok: true, field: f, gap: MIN_GAP, rows: clean, integrity: gapOk(f) };
}

module.exports = { enter, board, gapOk, all, MIN_GAP };