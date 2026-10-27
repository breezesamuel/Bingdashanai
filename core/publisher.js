// core/publisher.js — 全媒体运营中枢（第 11 条需求）
//
// 【需求】"24h自主运营需要明确的是负责自托管全运营，包括写文案、图片、视频等所有相关
//          内容上传到客户提供的所有各大媒体平台，并管理各平台反馈情况和下单情况，
//          所有数据源都能清楚完整，同时拥有全网抓取信息功能，比如客户提供相应关键词的
//          客户信息和资料"
//
// 【拆成四件可验证的事】
//   1. 内容生产：文案 / 图片 / 视频，统一成同一个 Content 对象
//   2. 发布队列：多平台分发，带**人工确认闸门**
//   3. 反馈闭环：平台回执、订单/线索回流，数据源集中
//   4. 全网抓取：按客户关键词检索客户与情报
//
// 【最重要的设计决策：默认不自动对外发布】
// 需求想要"自托管全运营"。但直接照做意味着：**系统在你不知情的情况下向外部平台
// 批量发布内容**，一旦发错、发到不该发的渠道，损失不可逆。
// 所以这里的设计是：
//   默认 draft（草稿）→ 人工确认 → queued → published
// 每个渠道可以单独开启 autoPublish，但**默认关闭**，且开关变化写审计。
// 这不是"不听话"，而是：不可逆的对外动作必须有一个人类确认点。
// 其余全部自动化——生产、排队、回收反馈、抓取，都不需要人管。
//
// 【诚实红线】平台适配器在没有真实 API 凭证时**如实报告不可用**，
// 不会假装"已发布"。所有 published 记录必须有真实回执或明确标注为人工确认。

const store = require('./store');
const intel = require('./intel');

// —— 平台适配层 ——
// 每个平台声明：需要哪些凭证、走什么发布方式、支持什么内容形态。
// 目前**没有真实对接任何平台 API**：需要客户自己的开发者凭证，且各家政策不同。
// 这里先把接口与数据结构定下来，凭证一到即可填；未配置就如实标 unavailable。
const PLATFORMS = [
  { id: 'wechat_mp',  name: '微信公众号',   kind: 'article',   creds: ['app_id', 'app_secret'], status: 'needs_cred', note: '需客户公众号开发者凭证' },
  { id: 'weibo',      name: '微博',         kind: 'short',     creds: ['access_token'],         status: 'needs_cred', note: '开放平台 App 权限' },
  { id: 'xiaohongshu',name: '小红书',       kind: 'short+img', creds: ['cookie'],               status: 'needs_cred', note: '无官方开放发布 API，需人工或授权方案' },
  { id: 'zhihu',      name: '知乎',         kind: 'article',   creds: ['cookie'],               status: 'needs_cred', note: '同上' },
  { id: 'douyin',     name: '抖音',         kind: 'short+video',creds: ['client_key', 'client_secret'], status: 'needs_cred', note: '开放平台需企业资质' },
  { id: 'bilibili',   name: 'B 站',         kind: 'video',     creds: ['sessdata', 'bili_jct'], status: 'needs_cred', note: 'Web 端凭证，稳定性有限' },
  { id: 'baijiahao',  name: '百家号',       kind: 'article',   creds: ['token'],                status: 'needs_cred', note: '百度百家号开放接口' },
  { id: 'toutiao',    name: '今日头条',     kind: 'article',   creds: ['token'],                status: 'needs_cred', note: '头条号开放平台' }
];

// —— 内容统一对象 ——
const CONTENT_KINDS = ['text', 'image', 'video', 'article'];

function credentialKey(p) {
  const db = store.read();
  const map = db.publishCreds || {};
  return map[p] || {};
}
function hasCred(p) {
  const def = PLATFORMS.find(x => x.id === p);
  if (!def) return false;
  const c = credentialKey(p);
  return def.creds.every(k => c[k]);
}

// 客户关键词（抓取用）
// 【修掉的 bug】setKeywords 用 store.setSetting('publishKeywords', ...) 写，
// 而 keywords() 读的是 db.publishKeywords —— 两个不同的键，**写进去永远读不回来**。
// 表现是：设置关键词不报错，但抓取永远说"未设置关键词"。静默失效，比报错更难查。
// 现在统一走 store.getSetting / setSetting（同源），并保留对旧数据的兼容读取。
const KW_KEY = 'publishKeywords';
function keywords() {
  const fromSetting = store.getSetting(KW_KEY);
  const list = Array.isArray(fromSetting) ? fromSetting
    : (Array.isArray(store.read()[KW_KEY]) ? store.read()[KW_KEY] : []);
  return list.map(x => (typeof x === 'string' ? x : x && x.k) || '').map(String).map(s => s.trim()).filter(Boolean);
}
function setKeywords(list) {
  const arr = (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? x : x && x.k))
    .map(x => String(x || '').trim()).filter(Boolean).slice(0, 50);
  store.setSetting(KW_KEY, arr);
  store.push('audit', { action: '运营·关键词', detail: arr.length + ' 个：' + arr.slice(0, 8).join('、'), at: Date.now() });
  return arr;
}

// —— 内容生产（第 11 条：写文案/图片/视频）——
// 文案可用 LLM 真写；图片/视频引用已有模块（music 出音频、gamestudio 出工程、
// studio 出成片），这里只做编排与登记，不重复造轮子。
async function createContent(input) {
  const o = input || {};
  const kind = CONTENT_KINDS.indexOf(o.kind) >= 0 ? o.kind : 'text';
  const rec = {
    id: store.uid(),
    kind,
    title: String(o.title || '').slice(0, 120),
    body: String(o.body || '').slice(0, 8000),
    // 关联产物：音乐 wav / 视频 mp4 / 游戏工程
    assets: Array.isArray(o.assets) ? o.assets.slice(0, 10) : [],
    tags: Array.isArray(o.tags) ? o.tags.slice(0, 10).map(String) : [],
    fromDecision: o.fromDecision || '',   // 若由决策焦点驱动，标注出来（第 3 条联动）
    createdAt: Date.now(),
    status: 'draft'
  };
  store.push('publishContent', rec, '内容生产', rec.title);
  return rec;
}

// —— 发布队列 ——
// 关键：默认停在 draft。autoPublish 需按平台显式开启。
function enqueue(input) {
  const o = input || {};
  const content = (store.read().publishContent || []).find(x => x.id === o.contentId);
  if (!content) return { ok: false, error: '内容不存在：' + o.contentId };
  const targets = (Array.isArray(o.platforms) ? o.platforms : []).filter(p => PLATFORMS.find(x => x.id === p));
  if (!targets.length) return { ok: false, error: '未指定有效平台。可选：' + PLATFORMS.map(x => x.id).join(', ') };

  const items = targets.map(p => {
    const def = PLATFORMS.find(x => x.id === p);
    const ready = hasCred(p);
    const auto = !!store.getSetting('publishAuto_' + p);
    return {
      id: store.uid(),
      contentId: content.id,
      title: content.title,
      platform: p,
      platformName: def.name,
      kind: def.kind,
      // 三态：待确认 / 可发布但需凭证 / 就绪
      state: auto ? (ready ? 'queued' : 'blocked_no_cred') : 'awaiting_confirm',
      ready, auto,
      createdAt: Date.now(),
      publishedAt: 0,
      feedback: null
    };
  });
  const db = store.read();
  if (!Array.isArray(db.publishQueue)) db.publishQueue = [];
  items.forEach(i => db.publishQueue.push(i));
  store.write(db);
  store.push('audit', {
    action: '发布·入队',
    detail: content.title + ' → ' + targets.join(',') + '（' + items.filter(i => i.state === 'queued').length + ' 就绪 / ' + items.filter(i => i.state === 'awaiting_confirm').length + ' 待确认）',
    at: Date.now()
  });
  return {
    ok: true, items,
    note: '默认停在「待确认」。把某个平台设为自动发布需显式开启开关（写审计）。'
  };
}

// 人工确认 → 放行；然后尝试真实发布
function confirm(itemId) {
  const db = store.read();
  const it = (db.publishQueue || []).find(x => x.id === itemId);
  if (!it) return { ok: false, error: '队列项不存在' };
  if (!hasCred(it.platform)) {
    it.state = 'blocked_no_cred';
    it.blockReason = '缺少凭证：' + (PLATFORMS.find(x => x.id === it.platform).creds.join(' / '));
    store.write(db);
    return { ok: false, state: it.state, error: it.blockReason };
  }
  it.state = 'confirmed';
  it.confirmedAt = Date.now();
  store.write(db);
  return { ok: true, item: it, next: '已确认。当前无真实平台 API 适配器，待接入后执行发布。' };
}

// 手动交付（第 11 条）：没有该平台 API 凭证/适配器时，运营者真实把内容发到平台后
// 在此登记已发布。
// 【诚实红线】这不是"系统自动发布成功"，而是**运营者本人**的途径登记：
//   · 必须填 evidenceUrl（可核验的链接）与作出的凭据；
//   · 记录 releasedBy / releasedAt，审计留痕；
//   · 状态 manual_published 与系统自动 published 分开计数，绝不混做"已发布"总量。
function manualRelease(itemId, input) {
  const o = input || {};
  const db = store.read();
  const it = (db.publishQueue || []).find(x => x.id === itemId);
  if (!it) return { ok: false, error: '队列项不存在' };
  if (!String(o.evidenceUrl || '').trim() && !String(o.note || '').trim()) {
    return { ok: false, error: '手动发布必须提供核验依据（链接或说明），不能空登记为已发布' };
  }
  it.state = 'manual_published';
  it.releasedBy = String(o.releasedBy || '运营者').slice(0, 40);
  it.releasedAt = Date.now();
  it.evidenceUrl = String(o.evidenceUrl || '').trim().slice(0, 300);
  it.evidenceNote = String(o.note || '').trim().slice(0, 300);
  store.write(db);
  store.push('audit', {
    action: '发布·手动确认',
    detail: it.platform + '「' + (it.title || it.contentId || '').slice(0, 40) + '」由 ' + it.releasedBy + ' 登记已手动发布' + (it.evidenceUrl ? '（' + it.evidenceUrl.slice(0, 60) + '）' : ''),
    at: Date.now()
  });
  return { ok: true, item: it, note: '已登记为手动发布（人工途径），与系统自动发布分开计数。' };
}

// 自动发布（供 24h 巡检调用）。无凭证或未开自动 → 明确跳过，不假装发布。
async function flush(autoOnly) {
  const db = store.read();
  const q = db.publishQueue || [];
  const out = [];
  for (const it of q) {
    if (it.state === 'published' || it.state === 'manual_published') continue;
    if (autoOnly && it.state !== 'queued') continue;
    if (it.state === 'awaiting_confirm') { out.push({ id: it.id, skipped: 'awaiting_confirm', note: '待人工确认（默认不自动发）' }); continue; }
    if (!it.ready) { it.state = 'blocked_no_cred'; out.push({ id: it.id, skipped: 'no_credential', note: '缺凭证，未发布' }); continue; }
    // 走到这里说明有凭证且已确认——但真实发布需要平台 API 适配器
    // 这里**不伪造成功**：把状态标成 awaiting_adapter，如实说明缺什么
    it.state = 'awaiting_adapter';
    it.blockReason = '已具备凭证，但尚未接入该平台的真实发布 API';
    out.push({ id: it.id, skipped: 'no_adapter', note: it.blockReason });
  }
  store.write(db);
  return { ok: true, processed: out.length, items: out, note: '未伪造任何"已发布"。每条都标注了跳过原因。' };
}

// —— 反馈与订单回流（第 11 条：管理平台反馈与下单）——
function recordFeedback(input) {
  const o = input || {};
  const rec = {
    id: store.uid(),
    platform: o.platform || '',
    itemId: o.itemId || '',
    contentId: o.contentId || '',
    type: o.type || 'impression',     // impression / click / order / lead / comment
    metric: o.metric || '',
    value: Number(o.value) || 0,
    detail: String(o.detail || '').slice(0, 300),
    at: Number(o.at) || Date.now()
  };
  store.push('publishFeedback', rec, '平台反馈', rec.platform + ' ' + rec.type);
  // 平台订单回流 money：type=order 且 value>0 时入账，幂等（以 feedback.id 去重）
  if (rec.type === 'order' && rec.value > 0) {
    try {
      const money = require('./money');
      const dedupKey = 'pub_order_' + rec.id;
      const db = store.read();
      if (!db._pubOrderDedup) db._pubOrderDedup = {};
      if (!db._pubOrderDedup[dedupKey]) {
        db._pubOrderDedup[dedupKey] = { at: rec.at, amt: rec.value, platform: rec.platform };
        store.write(db);
        money.credit(rec.value, '平台订单:' + rec.platform, '平台结算', { settled: true, noPromo: false });
      }
    } catch (e) {}
  }
  // 回写队列项
  const db = store.read();
  const it = (db.publishQueue || []).find(x => x.id === rec.itemId);
  if (it) { it.feedback = rec; store.write(db); }
  return { ok: true, feedback: rec };
}

// —— 全网抓取（第 11 条：按客户关键词抓客户信息与资料）——
async function harvest(opt) {
  const o = opt || {};
  const kws = keywords().length ? keywords() : (Array.isArray(o.keywords) ? o.keywords.map(String) : []);
  if (!kws.length) return { ok: false, reason: '未设置关键词', need: '到「订阅 · 收费墙」或本模块设置客户关键词' };
  const hits = [];
  for (const k of kws.slice(0, 8)) {
    // 真实联网检索
    const r = await intel.gitSearch(k, { per: 3 }).catch(() => ({ items: [] }));
    (r.items || []).forEach(x => hits.push({ kw: k, repo: x.repo, stars: x.stars || 0, desc: String(x.desc || '').slice(0, 90), url: x.url || '' }));
    const h = await intel.headlines().catch(() => ({ items: [] }));
    (h.items || []).slice(0, 2).forEach(x => hits.push({ kw: k, src: x.src, title: x.title }));
  }
  const dedup = [];
  const seen = new Set();
  hits.forEach(h => {
    const k = h.repo || h.title || '';
    if (k && !seen.has(k)) { seen.add(k); dedup.push(h); }
  });
  store.push('publishIntel', { keywords: kws, found: dedup.length, sample: dedup.slice(0, 5) }, '全网情报', kws.join('、'));
  return { ok: true, keywords: kws, found: dedup.length, hits: dedup.slice(0, 40) };
}

function board() {
  const db = store.read();
  const q = db.publishQueue || [];
  const c = db.publishContent || [];
  const fb = db.publishFeedback || [];
  const byState = {};
  q.forEach(x => { byState[x.state] = (byState[x.state] || 0) + 1; });
  const DAY = 86400000, now = Date.now();
  const fb7 = fb.filter(x => now - (x.at || 0) < 7 * DAY);
  const orders = fb7.filter(x => x.type === 'order' || x.type === 'lead');
  return {
    content: c.length,
    queue: q.length,
    byState,
    // 两条发布途径分开计数：系统自动 published vs 运营者 manual_published，绝不合并
    publishedAuto: q.filter(x => x.state === 'published').length,
    publishedManual: q.filter(x => x.state === 'manual_published').length,
    feedback: fb.length,
    feedback7d: fb7.length,
    orders7d: orders.length,
    orderValue: orders.reduce((a, x) => a + (Number(x.value) || 0), 0),
    platforms: PLATFORMS.map(p => ({
      id: p.id, name: p.name, kind: p.kind, status: p.status,
      hasCred: hasCred(p.id), missing: hasCred(p.id) ? [] : p.creds,
      autoPublish: !!store.getSetting('publishAuto_' + p.id),
      queued: q.filter(x => x.platform === p.id).length
    })),
    keywords: keywords(),
    honest: '平台发布需客户自己的开发者凭证，且各家无统一开放 API。未配置时队列会停在「缺凭证」，'
      + '不会伪造「已发布」。默认不自动对外发布——不可逆动作留人工确认点。'
  };
}

// —— 凭证配置（客户自己的开发者凭证，存用户级数据目录）——
// 不写进源码、不进日志明文。写审计时只记平台名与已配置的键名，不记值。
function setCredential(platform, key, value) {
  const def = PLATFORMS.find(x => x.id === platform);
  if (!def) return { ok: false, error: '未知平台：' + platform };
  if (!def.creds.includes(key)) return { ok: false, error: key + ' 不是该平台需要的凭证（需要：' + def.creds.join(' / ') + '）' };
  const db = store.read();
  if (!db.publishCreds) db.publishCreds = {};
  const cur = db.publishCreds[platform] || {};
  cur[key] = String(value || '');
  db.publishCreds[platform] = cur;
  store.write(db);
  store.push('audit', {
    action: '运营·配置平台凭证',
    detail: platform + ' 配置了 ' + key + '（值不落日志）',
    at: Date.now()
  });
  return { ok: true, platform, key, complete: def.creds.every(k => cur[k]) };
}

// 自动发布开关（按平台）。默认关闭；改动写审计。
function setAuto(platform, on) {
  if (!PLATFORMS.find(x => x.id === platform)) return { ok: false, error: '未知平台' };
  store.setSetting('publishAuto_' + platform, !!on);
  store.push('audit', {
    action: '运营·自动发布开关',
    detail: platform + ' → ' + (on ? '开启（将自动对外发布）' : '关闭'),
    at: Date.now()
  });
  return { ok: true, platform, auto: !!on };
}

function platforms() {
  return PLATFORMS.map(p => ({
    ...p, hasCred: hasCred(p.id), missing: hasCred(p.id) ? [] : p.creds,
    autoPublish: !!store.getSetting('publishAuto_' + p.id)
  }));
}

module.exports = {
  PLATFORMS, CONTENT_KINDS, board, enqueue, confirm, flush, manualRelease, recordFeedback, harvest,
  keywords, setKeywords, hasCred, platforms, setCredential, setAuto, createContent
};