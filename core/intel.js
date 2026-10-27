// core/intel.js — 全网情报层（真实抓取，零依赖，失败静默降级）
// 职责：聊天/技能/自主运营/决策 共用的联网能力。
//   A. GitHub 搜索：按关键词全网检索仓库（含 star/语言/简介），驱动"技能自我进化"
//   B. GitHub 仓库详情 / 目录 / README（contents API），支撑技能发现-下载落地
//   C. RSS 头条收集（多源，任一失败不影响其余）
// 约定：所有方法带超时与 try/catch，网络不可用返回空结构并在 out.reach 标记。

const GITHUB_API = 'https://api.github.com';
const webfetch = require('./webfetch');
const firecrawl = require('./firecrawl');

// GitHub 匿名限流较紧（搜索 10/min、核心 60/h）。无 token 时用令牌桶节流，
// 避免 selfop 并发核验瞬间打满导致 403；有 token 则放宽间隔。
const ghQueue = (() => {
  let last = 0;
  return async (fn) => {
    const gap = gitToken() ? 200 : 1100;
    const wait = Math.max(0, gap - (Date.now() - last));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    return fn();
  };
})();

// 可选 GITHUB_TOKEN：读包内/用户级 .env 提升 GitHub API 限流（无则用匿名 60次/时）
let _token = undefined;
function gitToken() {
  if (_token !== undefined) return _token;
  _token = '';
  try {
    const fs = require('fs'), os = require('os'), path = require('path');
    const files = [];
    const rootEnv = path.join(__dirname, '..', '.env');
    try { files.push(fs.readFileSync(rootEnv, 'utf8')); } catch (e) {}
    const userEnv = path.join(process.env.APPDATA || path.join(os.homedir(), '.bingdashan'), 'BingDashanAI', '.env');
    try { files.push(fs.readFileSync(userEnv, 'utf8')); } catch (e) {}
    for (const txt of files) for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('GITHUB_TOKEN=')) _token = t.slice('GITHUB_TOKEN='.length).trim();
    }
  } catch (e) {}
  return _token;
}

function UA() {
  const h = { 'User-Agent': 'BingDashanAI/1.0' };
  const tk = gitToken();
  if (tk) h.Authorization = 'token ' + tk;
  h.Accept = 'application/vnd.github+json';
  return h;
}

async function getJSON(url, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const doFetch = () => fetch(url, { headers: UA(), signal: ctl.signal, redirect: 'follow' });
    const r = url.indexOf('api.github.com') >= 0 ? await ghQueue(doFetch) : await doFetch();
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status);
      e.status = r.status;
      // 403/429 = 限流；把响应体里的消息带上,便于上游分类（如 GitHub 限流提示）
      if (r.status === 403 || r.status === 429) e.body = (await r.text().catch(() => '')).slice(0, 300);
      throw e;
    }
    return await r.json();
  } finally { clearTimeout(t); }
}

async function getText(url, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const doFetch = () => fetch(url, { headers: UA(), signal: ctl.signal, redirect: 'follow' });
    const r = url.indexOf('api.github.com') >= 0 ? await ghQueue(doFetch) : await doFetch();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// 仓库全名入 URL：仅转义非法字符，保留 '/'（%2F 在 API 路径里会 404）
function repoPath(full) {
  return String(full || '').replace(/[^A-Za-z0-9_\-.\\/]/g, '');
}

// ============ A. GitHub 搜索（默认按 star 降序，返回真实仓库）============
// q 支持 GitHub 语法，如 'claude skills' / 'mcp server' / language:python agent
async function gitSearch(q, opts) {
  const o = opts || {};
  const per = Math.min(30, Number(o.per || 8));
  const sort = o.sort || 'stars';
  const extra = [];
  if (o.lang) extra.push('language:' + o.lang);
  const qs = encodeURIComponent((q || '').trim() + (o.lang ? ' language:' + o.lang : ''));
  const url = GITHUB_API + '/search/repositories?q=' + qs + '&sort=' + sort + '&order=desc&per_page=' + per;
  try {
    const j = await getJSON(url);
    return {
      ok: true, reach: true, total: j.total_count || 0, query: q,
      items: (j.items || []).map(x => ({
        id: x.full_name, repo: x.full_name, name: x.name,
        desc: x.description || '', lang: x.language || '',
        stars: x.stargazers_count || 0, forks: x.forks_count || 0,
        url: x.html_url, updated: x.updated_at || '',
        topics: x.topics || [],
        archived: !!x.archived,
        license: (x.license && x.license.spdx_id) || ''
      }))
    };
  } catch (e) {
    return { ok: false, reach: false, error: e.message, query: q, items: [], total: 0 };
  }
}

// 用户公开资料（联系人解析用：公开 email / 公司）
async function ghUser(login) {
  try {
    const j = await getJSON(GITHUB_API + '/users/' + encodeURIComponent(String(login || '').replace(/^@/, '')));
    if (!j || !j.id) return { ok: false, reach: true, error: '用户不存在' };
    return {
      ok: true, reach: true, login: j.login, email: j.email || '', name: j.name || '',
      company: j.company || '', blog: j.blog || '', bio: j.bio || ''
    };
  } catch (e) {
    const msg = String(e.message || e);
    const isLimited = e.status === 403 || e.status === 429 || /403|429|rate limit/i.test(msg);
    return { ok: false, reach: !isLimited, error: msg };
  }
}

// 仓库详情（用于注入注册前的核验）——带 TTL 内存缓存，降低重复请求与限流
const repoCache = new Map();
const CACHE_MS = 5 * 60 * 1000;
// 【2026-10-25 无界防护】24h 自主运营每天都会发现新仓库，键只增不删——
// 长驻进程下 repoCache 会随天数字线性膨胀。TTL 只有 5 分钟，过期条目纯垃圾：
// 超 2000 键时把过期条目扫掉（沿用 server.js rateOK 的兜底模式）。
function _repoCacheSweep() {
  if (repoCache.size <= 2000) return;
  const now = Date.now();
  for (const [k, e] of repoCache) {
    if (now - e.t >= CACHE_MS) repoCache.delete(k);
    if (repoCache.size <= 2000) break;
  }
}
async function gitRepo(repoFull) {
  const key = repoPath(repoFull);
  const hit = repoCache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  try {
    const j = await getJSON(GITHUB_API + '/repos/' + key);
    const v = {
      ok: true, reach: true,
      repo: j.full_name, desc: j.description || '', lang: j.language || '',
      stars: j.stargazers_count || 0, url: j.html_url,
      defaultBranch: j.default_branch || 'main', topics: j.topics || [],
      license: (j.license && j.license.spdx_id) || '',
      archived: !!j.archived, pushedAt: j.pushed_at || '',
      // 【复用选型需要】forks 与 createdAt 是 core/adoption 判定「疑似刷量」的两个必需信号：
      // 极新 + 极高 Star + 极低 fork 是典型的刷星特征。此前不返回这两项，
      // 导致投毒检测永远拿不到数据、静默失效。
      forks: j.forks_count || 0, createdAt: j.created_at || ''
    };
    _repoCacheSweep();
    repoCache.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    const msg = String(e.message || e);
    // HTTP 404/403：API 可达但仓库不存在（404）或限流（403/429）
    const is404 = /404|not found|Not Found/i.test(msg);
    const isLimited = e.status === 403 || e.status === 429 || /403|429|rate limit/i.test(msg);
    if (isLimited) return { ok: false, reach: true, limited: true, error: msg, detail: (e.body || '').slice(0, 160) };
    return is404 ? { ok: false, reach: true, exists: false, error: msg } : { ok: false, reach: false, error: msg };
  }
}

// 仓库根目录文件清单（用于发现 skills/README 是否存在）
async function gitTree(repoFull) {
  try {
    const j = await getJSON(GITHUB_API + '/repos/' + repoPath(repoFull) + '/contents/');
    return { ok: true, reach: true, items: (Array.isArray(j) ? j : []).map(x => ({ name: x.name, type: x.type, path: x.path })) };
  } catch (e) {
    return { ok: false, reach: false, error: e.message };
  }
}

// 读取仓库内任意文件文本（README/SKILL.md/package.json 等，用于"下载前预览"）
// 读仓库里的某个文件。路径未命中时按 readme 的常见大小写形态依次重试。
// 【踩坑记录】原先只试 'README.md' 一个名字，而 GitHub 的 contents API **大小写敏感**：
// chalk/chalk 用的是小写 readme.md，于是永远 404。后果不是日志不好看——
// inspectRepo() 返回给用户的 readme 字段一直是空的，用户判断一个技能靠不靠谱时
// 拿到的唯一说明就是空串。第 2 条要"搜索候选技能供用户判断并装载"，
// 判断依据没了，这一环就是残的。
const README_VARIANTS = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README.rst', 'README'];
async function gitFile(repoFull, filePath) {
  const variants = (filePath === 'README.md') ? README_VARIANTS : [filePath];
  let last = null;
  for (const p of variants) {
    if (!p) continue;
    try {
      const j = await getJSON(GITHUB_API + '/repos/' + repoPath(repoFull) + '/contents/' + encodeURIComponent(p));
      if (!j || typeof j.content !== 'string') throw new Error('not a file');
      const txt = Buffer.from(j.content, 'base64').toString('utf8');
      return { ok: true, reach: true, name: j.name || p, path: j.path || p, size: j.size || 0, content: txt.slice(0, 20000) };
    } catch (e) {
      last = e.message;
    }
  }
  return { ok: false, reach: false, error: last || '未找到文件' };
}

// ============ B. 全网热点头条（多源 RSS，任一失败不影响）============
// 解析极简 RSS/Atom：<title> 与 <link> 抽取，去 HTML 标签。
const FEEDS = [
  ['GitHub 趋势', 'https://github.com/trending', 'html'],
  ['Hacker News', 'https://hnrss.org/frontpage', 'rss'],
  ['界面·AI', 'https://www.jiemian.com/rss/2537.xml', 'rss'],
  ['少数派', 'https://sspai.com/feed', 'rss']
];

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

// 解析 RSS/Atom：抽取 title+link 对
function parseFeed(xml) {
  const items = [];
  const itemRe = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/g;
  const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/;
  const linkRe = /<link[^>]*href="([^"]+)"[^>]*>|<link[^>]*>([^<]*)<\/link>/;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < 8) {
    const body = m[1];
    const t = titleRe.exec(body);
    const l = linkRe.exec(body);
    const title = t ? stripTags(t[1]) : '';
    const link = l ? (l[1] || l[2] || '') : '';
    if (title) items.push({ title: title.slice(0, 120), link });
  }
  return items;
}

async function headline(source, url, kind) {
  try {
    if (kind === 'html') {
      // GitHub trending：抓 HTML 标题文本里仓库名（真实、免令牌）
      const html = await getText(url);
      const re = /<h2[^>]*>\s*<a[^>]*href="\/([^"]+)"/g;
      const out = []; let m;
      while ((m = re.exec(html)) && out.length < 8) {
        const seg = m[1].replace(/^\/+|\/+$/g, '');
        if (seg.includes('/') && !seg.includes(' ')) out.push({ title: seg, link: 'https://github.com/' + seg });
      }
      return out;
    }
    const xml = await getText(url);
    return parseFeed(xml);
  } catch (e) { return []; }
}

async function headlines() {
  const out = [];
  for (const [src, url, kind] of FEEDS) {
    const items = await headline(src, url, kind);
    items.slice(0, 5).forEach(it => out.push({ src, title: it.title, link: it.link || '' }));
  }
  return { ok: true, reach: out.length > 0, items: out.slice(0, 16) };
}

// ============ C. 全网速查：训练/学习/工具等资料站（真实可抓取）============
// 免费开放的科技新闻/日报 RSS，作为自主运营的外部知识来源
const DOC_FEEDS = [
  ['GitHub 每日热门', 'https://mshibanami.github.io/GitHubTrendingRSS/daily/', 'rss'],
  ['AI 新奇玩意儿', 'https://github.com/missuo/AI-News/raw/main/news.xml', 'rss']
];
async function docHeadlines() {
  const out = [];
  for (const [src, url, kind] of DOC_FEEDS) {
    const x = parseFeed(await getText(url).catch(() => ''));
    x.slice(0, 6).forEach(it => out.push({ src, title: it.title, link: it.link }));
  }
  return out;
}

// ============ D. 网页抓取（可插拔后端：fetch / lightpanda）============
// 对 JS 渲染页，裸 fetch 拿不到内容。默认仍走 fetch；设 BROWSE_BACKEND=lightpanda 启用渲染。
// 返回值必带 backend / rendered / fellBack，便于发现「以为在渲染、其实在裸取」。
async function page(url, opts) {
  const o = opts || {};
  const r = await webfetch.fetchPage(url, { backend: o.backend });
  const text = r.ok ? webfetch.toText(r.body) : '';
  return {
    ok: r.ok,
    url,
    status: r.status,
    backend: r.backend,
    rendered: r.rendered,
    fellBack: r.fellBack,
    ms: r.ms,
    note: r.note,
    title: (r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '',
    text: text.slice(0, Number(o.max) || 8000),
    chars: text.length
  };
}

// 抓取后端状态（确认当前用哪个引擎、lightpanda 是否可达）
async function browseStatus() {
  return Object.assign({ ok: true }, webfetch.status(), { lightpanda: await webfetch.probe() });
}

// 竞品/定价情报：优先 Firecrawl（干净 Markdown），无 key 自动降级本地抓取
async function research(url, opts) {
  const o = opts || {};
  const r = await firecrawl.scrape(url, o);
  return {
    ok: r.ok,
    url,
    title: r.title,
    description: r.description || '',
    markdown: r.markdown,
    links: r.links || [],
    chars: r.chars || 0,
    rendered: !!r.rendered,
    fellBack: !!r.fellBack,
    ms: r.ms,
    note: r.note,
    pricing: r.ok ? firecrawl.pricingSignals(r.markdown) : null
  };
}

function researchStatus() { return Object.assign({ ok: true }, firecrawl.status()); }

// ============ E. GitHub Issue 触达（真正自主：搜仓库 → 创建 Issue → 跟回复）============
// 这是唯一不需要任何人铺路的触达通道。只需要 GitHub token（API 凭证，不是基础设施）。
// 诚实契约：只对有明确需求的仓库发 Issue，不发垃圾；所有触达记录留痕。

// 在仓库下创建 Issue（真实触达）
async function createIssue(repoFull, title, body) {
  const key = repoPath(repoFull);
  const url = GITHUB_API + '/repos/' + key + '/issues';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const doFetch = () => fetch(url, {
      method: 'POST',
      headers: Object.assign(UA(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: String(title || '').slice(0, 200), body: String(body || '').slice(0, 60000) }),
      signal: ctl.signal
    });
    const r = await ghQueue(doFetch);
    const txt = await r.text().catch(() => '');
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status + ' ' + txt.slice(0, 200));
      e.status = r.status; e.body = txt.slice(0, 300);
      throw e;
    }
    const j = JSON.parse(txt);
    return {
      ok: true, reach: true, issue: j.number, url: j.html_url,
      repo: key, title: j.title || title, state: j.state || 'open'
    };
  } catch (e) {
    return { ok: false, reach: false, error: e.message, body: (e.body || '').slice(0, 200), repo: key };
  } finally { clearTimeout(t); }
}

// 读取仓库 Issue 列表（跟回复用）
async function listIssues(repoFull, opts) {
  const o = opts || {};
  const key = repoPath(repoFull);
  const state = o.state || 'all';
  const per = Math.min(100, Number(o.per || 30));
  const url = GITHUB_API + '/repos/' + key + '/issues?state=' + state + '&per_page=' + per;
  try {
    const j = await getJSON(url);
    return {
      ok: true, reach: true,
      items: (Array.isArray(j) ? j : []).map(x => ({
        number: x.number, title: x.title || '', state: x.state || '',
        url: x.html_url, user: (x.user && x.user.login) || '',
        body: (x.body || '').slice(0, 500), comments: x.comments || 0,
        created: x.created_at || '', updated: x.updated_at || ''
      }))
    };
  } catch (e) {
    return { ok: false, reach: false, error: e.message, items: [] };
  }
}

// 读取单个 Issue 的评论（客户回复）
async function getIssueComments(repoFull, issueNumber) {
  const key = repoPath(repoFull);
  const url = GITHUB_API + '/repos/' + key + '/issues/' + issueNumber + '/comments?per_page=100';
  try {
    const j = await getJSON(url);
    return {
      ok: true, reach: true,
      items: (Array.isArray(j) ? j : []).map(x => ({
        id: x.id, user: (x.user && x.user.login) || '',
        body: (x.body || '').slice(0, 1000), created: x.created_at || ''
      }))
    };
  } catch (e) {
    return { ok: false, reach: false, error: e.message, items: [] };
  }
}

// 验证 token 是否有效（调 /user）
async function verifyToken() {
  try {
    const j = await getJSON(GITHUB_API + '/user');
    return { ok: !!j.login, reach: true, login: j.login || '', name: j.name || '' };
  } catch (e) {
    return { ok: false, reach: false, error: e.message };
  }
}

module.exports = { gitSearch, gitRepo, gitTree, gitFile, ghUser, headlines, docHeadlines, page, browseStatus, research, researchStatus, createIssue, listIssues, getIssueComments, verifyToken, gitToken };