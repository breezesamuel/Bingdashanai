// core/knowledge.js — 知识库：Q&A 沉淀、自动检索注入
// 对话前召回相关条目注入 system，让回答"用大脑里沉淀过的结论"，形成自管理式学习闭环。

const store = require('./store');
const memoryext = require('./memoryext');

// 全部知识
function list() { return store.list('knowledge'); }

// 沉淀一条 {q, a, tag, source}（知识上限 400 条，防自治采集无限膨胀；同名 Q 自动替换刷新）
const K_MAX = 400;
function add(q, a, tag) {
  const qs = String(q);
  const db = store.read();
  if (!Array.isArray(db.knowledge)) db.knowledge = [];
  const idx = db.knowledge.findIndex(x => String(x.q) === qs);
  if (idx >= 0) db.knowledge[idx] = Object.assign({}, db.knowledge[idx], { a: String(a), tag: tag || db.knowledge[idx].tag, createdAt: Date.now() });
  else {
    db.knowledge.push({ q: qs, a: String(a), tag: tag || 'general', createdAt: Date.now() });
    if (db.knowledge.length > K_MAX) db.knowledge = db.knowledge.slice(-K_MAX);
  }
  store.write(db);
  store.push('audit', { action: '新增知识', detail: qs.slice(0, 80), at: Date.now() });
  // 外部语义层镜像（未配置/连不上时静默跳过，不影响本地写入）
  memoryext.save('Q: ' + qs + '\nA: ' + String(a), { source: 'knowledge', tag: tag || 'general' })
    .catch(() => null);
  return store.list('knowledge').find(x => String(x.q) === qs);
}

// 删除
function remove(id) { return store.remove('knowledge', id, '删除知识'); }

// 检索：关键词命中 q/a/tag，按相关度 + 近因 + 词序加权取前 N 条
function recall(kw, n) {
  const all = store.list('knowledge');
  if (!kw) return all.slice(0, n || 10);
  const k = String(kw).toLowerCase();
  const now = Date.now();
  const DAY = 864e5;
  const scored = all
    .map(x => {
      const q = String(x.q || '').toLowerCase(), a = String(x.a || '').toLowerCase(), tag = String(x.tag || '').toLowerCase();
      const hay = q + ' ' + a + ' ' + tag;
      let s = 0;
      // 位置加权：问题命中权重最高，答案次之，标签最低
      k.split(/\s+/).forEach(w => {
        if (!w) return;
        if (q.includes(w)) s += w.length * 3;
        else if (a.includes(w)) s += w.length * 2;
        else if (tag.includes(w)) s += w.length;
        else if (hay.includes(w)) s += w.length * 0.5;
      });
      // 近因加权（知识随时间略衰减，但保留长期沉淀）
      const age = Math.exp(-(now - (x.createdAt || now)) / (90 * DAY));
      return { x, s: s * (0.6 + 0.4 * age) };
    })
    .filter(p => p.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, n || 10).map(p => p.x);
}

// 统计
function stats() { const all = list(); return { total: all.length }; }

// 语义召回：走外部记忆层；未启用时返回空数组（调用方无需判断）
async function semanticRecall(kw, n) {
  if (!kw) return [];
  return memoryext.search(kw, n).catch(() => []);
}

// 混合检索 = 关键词结果 + 语义结果，按去重合并返回
// 语义部分用 sem 标记，便于前端区分来源
async function hybridRecall(kw, n) {
  const local = recall(kw, n);
  const sem = await semanticRecall(kw, n);
  if (!sem.length) return local;
  const seen = new Set(local.map(x => String(x.q)));
  const extra = sem
    .filter(s => {
      const key = String(s.content).slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(s => ({ q: s.title || s.content.slice(0, 60), a: s.content, tag: (s.tag || 'semantic'), sem: true, createdAt: s.at || Date.now(), score: s.score }));
  return local.concat(extra).slice(0, (n || 10) * 2);
}

// 外部记忆层状态（可观测）
function memoryStatus() { return memoryext.status(); }

module.exports = { list, add, remove, recall, stats, semanticRecall, hybridRecall, memoryStatus };