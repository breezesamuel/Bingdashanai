// core/crawler.js — 24h 蜘蛛入料：GitHub 周巡寻客 + 网页深爬回填知识库
// 全自主管线的第一段：24h 不停歇轮换主题去 GitHub 探测真实仓库，把候选登记成
// 「探测」线索；对登记成线索的每个仓库再深爬公开页面（README/官网）回填情报，
// 把抓到的公开正文清洗后沉淀进知识库（完善网站内容）。全部真实落库可审计。
// 开关未开启 → 如实 skipped；GitHub/网页不可达 → 如实跳过并计数，绝不编造线索。

const store = require('./store');
const intel = require('./intel');

const DEFAULT_TOPICS = ['claude skills', 'mcp server agent', 'ai agent workflow', 'writing automation', 'workflow automation'];
const MAX_ADD_PER_ROUND = 3;     // 每轮最多登记条数：限流下细水长流，24h 滚动累计
const RE_CRAWL_WINDOW_MS = 86400000; // 同源网页 24h 后才允许重爬刷新

function cfg() {
  const st = (store.read().settings || {});
  let topics = st.crawlerTopics;
  if (typeof topics === 'string') { try { topics = JSON.parse(topics); } catch (e) { topics = null; } }
  if (!Array.isArray(topics) || !topics.length) topics = DEFAULT_TOPICS;
  return { on: !!st.crawlerOn, topics: topics.map(t => String(t).trim()).filter(Boolean).slice(0, 8) };
}

function normUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').replace(/^https?:\/\//i, '').toLowerCase();
}

function stats(patch) {
  const d = store.read();
  d.crawlStats = Object.assign({ rounds: 0, lastAt: 0, lastTopicIndex: 0, lastTopic: '', searched: 0, found: 0, failedReach: 0 }, d.crawlStats || {}, patch || {});
  store.write(d);
  return d.crawlStats;
}

function status() {
  const c = cfg();
  const d = store.read();
  return { ok: true, on: c.on, topics: c.topics, stats: d.crawlStats || {}, tail: (d.crawl || []).slice(-8).reverse() };
}

// 深爬一条仓库公开页面（真实抓取，失败不影响登记）——成功时带回正文，
// 供下一步"复制粘贴数据到网站"入知识库（网页爬虫 → 网站内容完善闭环）。
async function enrich(repoUrl) {
  try {
    const r = await intel.research(repoUrl, { max: 4000 });
    if (r.ok) return { rendered: !!r.rendered, chars: r.chars || 0, pricing: !!r.pricing, desc: (r.description || '').slice(0, 100), mdLen: (r.markdown || '').length, markdown: (r.markdown || '').slice(0, 3500) };
  } catch (e) {}
  return null;
}

// 网页爬虫 → 网站内容完善：把深爬到的公开正文清洗后沉淀进知识库（tag='crawl'）。
// 同源不重复入：knowledge.add 按 q 幂等替换；返回入库文档 id，供审计追溯。
function bank(repoName, url, md) {
  const body = String(md || '').trim();
  if (body.length < 80) return { ok: false, error: '正文过短（' + body.length + ' 字符，需 ≥80）：不把残缺内容当完善入库' };
  const docs = require('./knowledge');
  const q = '蜘蛛采集·' + String(repoName || url || '').slice(0, 60);
  const src = '来源 ' + String(url || '') + '（24h 蜘蛛网页深爬，自动入站）';
  const doc = docs.add(q, src + '\n\n' + body.slice(0, 3000), 'crawl');
  return { ok: !!doc, doc: doc && (doc.id || doc.q) };
}

// GitHub 周巡：轮换 topic 持续探测新仓库，去重后真实登记为「探测」线索。
async function harvestOnce() {
  const c = cfg();
  if (!c.on) return { ok: true, skipped: 'disabled' };
  const prev = (store.read().crawlStats) || {};
  const topic = c.topics[(Number(prev.lastTopicIndex) || 0) % c.topics.length] || c.topics[0];
  const r = await intel.gitSearch(topic, { per: 8, sort: 'updated' });
  if (!r.ok) {
    stats({ rounds: Number(prev.rounds || 0) + 1, lastAt: Date.now(), lastTopic: topic, failedReach: Number(prev.failedReach || 0) + 1, searched: Number(prev.searched || 0), found: Number(prev.found || 0) });
    return { ok: true, reach: false, error: r.error, line: '蜘蛛入料：GitHub 暂不可达（' + String(r.error || '').slice(0, 60) + '），本轮不登记线索', lines: [] };
  }
  const now = Date.now();
  const db = store.read();
  const exist = new Set((db.leads || []).map(l => l.name));
  const urls = new Set((db.leads || []).map(l => normUrl(l.url)).filter(Boolean));
  let added = 0, skippedDup = 0;
  const lines = [];
  for (const it of (r.items || [])) {
    if (added >= MAX_ADD_PER_ROUND) break;
    if (it.archived) { skippedDup++; continue; }
    if (exist.has(it.name)) { skippedDup++; continue; }
    const nu = normUrl(it.url);
    if (!nu || urls.has(nu)) { skippedDup++; continue; }
    urls.add(nu); exist.add(it.name);
    const ix = await enrich(it.url);
    store.push('leads', {
      name: it.repo, company: it.repo, repo: it.repo, url: it.url,
      industry: it.lang || '未知', lang: it.lang || '',
      signal: Math.min(95, 48 + Math.min(12, Math.floor(Number(it.stars) / 20))),
      source: 'GitHub 周巡·' + topic, stage: '探测', status: 'new', path: 'crawler',
      topics: it.topics || [],
      desc: (ix && ix.desc) || it.desc || '',
      crawl: { at: now, topic, stars: it.stars || 0, lang: it.lang || '', enriched: !!(ix && ix.rendered), mdLen: (ix && ix.mdLen) || 0, priceSignals: !!(ix && ix.pricing) }
    }, '爬虫·发现线索', it.repo + ((ix && ix.rendered) ? '·已深爬' : ''));
    store.push('crawl', { at: now, kind: 'found', repo: it.repo, url: it.url, topic, stars: it.stars || 0, enriched: !!(ix && ix.rendered) }, '蜘蛛·登记线索', it.repo);
    // 网页爬虫 → 网站内容完善：深爬到的公开正文入库（同源幂等；无正文/抓取失败如实跳过不伪造）
    let banked = null;
    if (ix && ix.markdown && ix.markdown.trim().length >= 80) {
      banked = bank(it.repo, it.url, ix.markdown);
    } else {
      store.push('crawl', { at: Date.now(), kind: 'bank-skip', repo: it.repo, reason: !ix ? '深爬失败' : (String(ix.markdown || '').trim().length < 80 ? '正文过短' : '无正文') }, '蜘蛛·内容入库跳过', it.repo);
    }
    added++;
    lines.push('蜘蛛入料：环绕 GitHub 登记『' + it.repo + '』(' + (it.lang || '未知') + '·stars ' + (it.stars || 0) + ')' + ((ix && ix.rendered) ? '·网页深爬已回填' : '') + (banked ? '·内容已入网站知识库' : ''));
  }
  stats({ rounds: Number(prev.rounds || 0) + 1, lastAt: now, lastTopicIndex: (Number(prev.lastTopicIndex) || 0) + 1, lastTopic: topic, searched: Number(prev.searched || 0) + (r.items || []).length, found: Number(prev.found || 0) + added });
  if (!added) lines.push('蜘蛛入料：本轮无新线索（' + (r.items || []).length + ' 条均已登记/归档，topic=' + topic + '）');
  return { ok: true, reach: true, topic, searched: (r.items || []).length, added, skippedDup, lines };
}

// 显式网页深爬 → 知识库回填（完善网站内容）。同源 24h 窗口内去重；窗口外重爬刷新。
async function ingest(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '仅接受 http(s) 地址' };
  const db0 = store.read();
  const dup = (db0.knowledge || []).filter(k => k.tag === 'crawl' && String(k.source || '') === u).sort((a, b) => (b.crawledAt || 0) - (a.crawledAt || 0))[0];
  if (dup && Date.now() - (dup.crawledAt || 0) < RE_CRAWL_WINDOW_MS) {
    store.push('crawl', { at: Date.now(), kind: 'ingest-skip', url: u.slice(0, 160), reason: 'same-source-24h' }, '蜘蛛·跳过重爬', u.slice(0, 60));
    return { ok: true, already: true, doc: dup.id };
  }
  const r = await intel.research(u, { max: 6000 });
  if (!r.ok) {
    store.push('crawl', { at: Date.now(), kind: 'ingest-fail', url: u.slice(0, 160), error: String(r.note || '').slice(0, 120) }, '蜘蛛·深爬失败', u.slice(0, 60));
    return { ok: false, reach: !!r.fellBack, error: r.note || '抓取失败' };
  }
  const d = store.read();
  d.crawlStats = Object.assign({ rounds: 0, lastTopicIndex: 0, searched: 0, found: 0, failedReach: 0 }, d.crawlStats || {}, { latestIngestAt: Date.now() });
  store.write(d);
  const knowledge = require('./knowledge');
  const doc = knowledge.add((r.title || u).slice(0, 120), '来源 ' + u + '\n\n' + (r.markdown || '').slice(0, 4000), 'crawl');
  store.push('crawl', { at: Date.now(), kind: 'ingest', url: u.slice(0, 160), chars: r.chars || 0, title: (r.title || '').slice(0, 80) }, '蜘蛛·知识入库', '字符 ' + (r.chars || 0));
  const docId = doc && (doc.id || doc.q);
  return { ok: true, title: r.title || '', chars: r.chars || 0, pricing: !!r.pricing, doc: docId };
}

module.exports = { harvestOnce, ingest, bank, status, cfg, stats };