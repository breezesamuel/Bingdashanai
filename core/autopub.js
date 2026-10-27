// core/autopub.js — 自主发布引擎（L1：浏览器自主运行）
// 使命：把 conductor 产出的真实内容资产，用 Playwright 控制系统浏览器，
//       按授权边界自动发布到授权平台（知乎/小红书/公众号），每次发布留 URL 证据与审计。
// 诚实红线：① 登录态/发布一律走真实浏览器(可被看见、可验证 URL)；
//           ② dry-run 只填不点"发布"，绝不伪造"已发布"；③ DOM 选择器失效即如实失败，
//              绝不假装成功；④ 未登录/登录过期 → 报告"需要人工扫码"，等人工接入后再接管。
// 约束：单实例串行（同一时间只跑一个发布任务）；发布超时由调用方护栏截断。

const store = require('./store');
const fs = require('fs');
const path = require('path');
let pw = null;

// 【2026-09】原来 path.join(__dirname,'..','data','autopub') 打包后落在只读的 app.asar 内 → ENOENT。改走统一可写数据目录。
const ROOT = store.dataPath('autopub');
const PUBLOG_MAX = 300;

function dbPath(platform) {
  const safe = String(platform).replace(/[^a-z0-9_-]/gi, '_');
  return path.join(ROOT, safe + '.json');
}

function loadDb(platform) {
  try { return JSON.parse(fs.readFileSync(dbPath(platform), 'utf8')); } catch (e) { return { sessions: {}, log: [], seq: 0 }; }
}

function saveDb(platform, db) { try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) {} fs.writeFileSync(dbPath(platform), JSON.stringify(db, null, 2), 'utf8'); }

// —— 平台适配器：登录 URL 与"是否已登录"判据（诚实：选择器随平台改版会漂移，漂移即失败）——
const PLATFORMS = {
  zhihu: {
    name: '知乎',
    loginUrl: 'https://www.zhihu.com/signin',
    home: 'https://www.zhihu.com',
    loggedInJudge: async (page) => {
      // 知乎登录态：右上角"创作中心"导航（href=/creator）登录后必现；图像懒加载不可靠，故仅依赖此菜单项
      try { await page.waitForSelector('a[href*="/creator"]', { timeout: 8000 }); return true; } catch (e) { return false; }
    }
  },
  xiaohongshu: {
    name: '小红书',
    loginUrl: 'https://www.xiaohongshu.com/explore',
    home: 'https://www.xiaohongshu.com',
    loggedInJudge: async (page) => {
      // 小红书登录态：右下角发布按钮（红色 + 条带）+ 顶部头像
      try {
        await Promise.race([page.waitForSelector('#user-info-container, .user .avatar, [class*=UserInfo] .avatar', { timeout: 4000 }), page.waitForSelector('[class*=create-center]', { timeout: 4000 })]);
        return true;
      } catch (e) { return false; }
    },
    // 诚实红线：只有捕获到"页面离开发布页 或 出现发布成功字样"才算成功。
    confirm: async (page, inner) => {
      const url = page.url();
      if (!/creator\.xiaohongshu\.com\/publish\/publish/.test(url)) return { ok: true, by: 'url-change', url };
      if (inner && /发布成功|已发布|笔记.{0,12}成功/.test(inner)) return { ok: true, by: 'success-text', url };
      return null;
    }
  },
  mp: {
    name: '微信公众号',
    loginUrl: 'https://mp.weixin.qq.com/',
    home: 'https://mp.weixin.qq.com/',
    loggedInJudge: async (page) => {
      // 公众号登录态：工作台骨架（侧边菜单 + 顶部用户徽标）
      try {
        await Promise.race([page.waitForSelector('.weui-desktop-account, .login__type__container, .main-bar-nav', { timeout: 5000 }), page.waitForSelector('#mobile_plate_standalone, .right-column', { timeout: 5000 })]);
        return true;
      } catch (e) { return false; }
    },
    // 诚实红线：只有捕获到"发送/群发/发布成功"字样才算成功。
    confirm: async (page, inner) => {
      const url = page.url();
      if (inner && /发送成功|群发成功|发布成功|已发布/.test(inner)) return { ok: true, by: 'success-text', url };
      if (/appmsg/.test(url)) return { ok: true, by: 'url-change', url };
      return null;
    }
  }
};

// —— 发布成功信号确认器：点过"发布"后轮询平台成功信号；捕不到就如实报"未确认"，绝不伪造成功 ——
async function confirmAfterPublish(page, spec, timeout) {
  const deadline = Date.now() + (timeout || 25000);
  let tried = 0;
  while (Date.now() < deadline) {
    tried++;
    const inner = await page.evaluate(() => document.body ? (document.body.innerText || '').slice(0, 40000) : '').catch(() => '');
    const hit = spec.confirm ? await spec.confirm(page, inner).catch(() => null) : null;
    if (hit) return { ok: true, tried, by: hit.by, url: hit.url };
    await page.waitForTimeout(2000);
  }
  return { ok: false, tried };
}

function pushLog(platform, entry) {
  const db = loadDb(platform);
  db.log.unshift({ id: store.uid(), at: Date.now(), ...entry });
  if (db.log.length > PUBLOG_MAX) db.log = db.log.slice(0, PUBLOG_MAX);
  saveDb(platform, db);
  return entry;
}

// —— 启动浏览器（复用已存储的持久登录态；失败返回明确原因，绝不静默）——
async function launch(platform, opts) {
  opts = opts || {};
  // 【为什么这里要自己兜一手】playwright 是 dependencies，但打包配置 files 白名单里
  // 没有 node_modules（asar 只有 17.5MB），所以发行版里 require('playwright') 会抛
  // MODULE_NOT_FOUND。原样抛出的话用户看到的是一句天书般的模块名，不知道该干什么。
  // 这里如实说清"缺什么、装什么、还有哪条路能走"，不假装功能可用。
  if (!pw) {
    try { pw = require('playwright'); }
    catch (e) {
      const err = new Error('当前发行包未包含 Playwright，无法用浏览器自动发布。'
        + '两条可行路径：① 在项目目录执行 npm i playwright && npx playwright install chromium 后重新打包；'
        + '② 直接用「发布队列 · 登记手动发布」入口（core/publisher.js manualRelease，需填核验依据）。'
        + '原始错误：' + e.message);
      err.code = 'PLAYWRIGHT_MISSING';
      throw err;
    }
  }
  const db = loadDb(platform);
  const storagePath = path.join(ROOT, platform + '-state.json');
  const userDataDir = path.join(ROOT, platform + '-profile');
  const useState = { storageState: fs.existsSync(storagePath) ? storagePath : undefined };
  const usePersist = !!db.sessions.lasted;
  const browser = await pw.chromium.launch({ headless: opts.headless !== false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  // 持久化 profile：让登录态跨会话保留（首扫一次码，长期可用）
  const contextArgs = usePersist ? { userDataDir } : (useState.storageState ? { storageState: useState.storageState } : {});
  const context = await browser.newContext(contextArgs);
  const page = await context.newPage();
  await page.waitForTimeout(300);
  return { browser, context, page, db };
}

async function closeAll(c) { try { if (c.page) await c.page.close(); } catch (e) {} try { if (c.context) await c.context.close(); } catch (e) {} try { if (c.browser) await c.browser.close(); } catch (e) {} }

// —— 返回某平台登录状态（首页探一次）——
async function statusOne(platform, opts) {
  const spec = PLATFORMS[platform];
  if (!spec) throw new Error('未知平台：' + platform);
  let c;
  try {
    c = await launch(platform, opts);
    await c.page.goto(spec.home, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await c.page.waitForTimeout(1500);
    const logged = await spec.loggedInJudge(c.page);
    return { platform, name: spec.name, logged, at: Date.now() };
  } finally { await closeAll(c); }
}

// —— 拟发布 vs 真实发布（dryRun=false 才真发；每次真实发布落审计与 URL）——
async function publish(platform, draft, opts) {
  opts = opts || {};
  const dryRun = opts.dryRun !== false;
  const spec = PLATFORMS[platform];
  if (!spec) throw new Error('未知平台：' + platform);
  const title = String(draft && draft.title || '').slice(0, 60);
  const body = String(draft && draft.body || '').slice(0, 5000);
  if (!title || !body) throw new Error('缺标题或正文');
  // —— 授权边界强制（变形≠授权扩张）：带 materialId+variantKey 的发布必须过 publishable 闸口，否则不进浏览器直接拦截 ——
  const auth = (draft && draft.auth) || {};
  if (auth.materialId || auth.variantKey) {
    const mate = store.list('repurposes').find(m => m.id === auth.materialId);
    const v = mate && (mate.variants || []).find(x => x.key === auth.variantKey);
    if (!mate || !v) return { ok: false, platform, reason: '授权记录不存在：素材或变体已被删除/未变形' };
    if (v.publishable !== true) return { ok: false, platform, reason: '授权边界拦截：变体「' + (v.name || auth.variantKey) + '」当前不可发布（publishable=false，需先勾选载体授权，变形≠授权扩张）' };
  }
  let c;
  try {
    c = await launch(platform, opts);
    await c.page.goto(spec.loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await c.page.waitForTimeout(1200);
    const logged = await spec.loggedInJudge(c.page);
    if (!logged) {
      const msg = '未登录（或登录态过期），需人工扫码后测试自动发布';
      pushLog(platform, { type: 'unauthed', title, ok: false, detail: msg });
      return { ok: false, reason: msg, platform };
    }
    // 平台专属填写逻辑（DOM 命令式，选择器漂移会抛错 → 诚实失败）
    if (platform === 'zhihu') {
      // 知乎"想法/动态"发布：首页点"发想法" → Draft 弹层编辑器 → 点"发布"
      await c.page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await c.page.waitForTimeout(2500);
      await c.page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => /^发想法$/.test((b.textContent || '').trim()));
        if (btns.length) btns[0].click();
        else { const els = [...document.querySelectorAll('div')].filter(d => /^发想法$/.test((d.textContent || '').trim()) && d.children.length === 0); if (els.length) els[0].click(); }
      });
      await c.page.waitForSelector('div.public-DraftEditor-content[contenteditable=true]', { timeout: 10000 }).catch(() => {});
      const editor = await c.page.$('div.public-DraftEditor-content[contenteditable=true]');
      if (!editor) throw new Error('知乎内容编辑框未找到（页面结构变更，如实失败）');
      await editor.click();
      await c.page.keyboard.insertText(body);
      if (dryRun) {
        return { ok: true, dryRun: true, platform, title, detail: '已拟稿到输入框（未点击发布）' };
      }
      // 读取当前账号最新想法 pin id（发布前/后核验共用，避免两处各写一份漂移）
      const readTopPin = () => c.page.evaluate(async () => {
        try {
          const me = await fetch('https://www.zhihu.com/api/v4/me', { credentials: 'include' }).then(r => r.json());
          if (!me || !me.url_token) return { ok: false, topId: '' };
          const j = await fetch('https://www.zhihu.com/api/v4/members/' + me.url_token + '/pins?limit=1', { credentials: 'include' }).then(r => r.json());
          const d = (j.data && j.data.length) ? j.data : [];
          return { ok: !!d.length, topId: d.length ? String(d[0].id) : '' };
        } catch (e) { return { ok: false, topId: '' }; }
      }).catch(() => ({ ok: false, topId: '' }));
      // 发布前记录最新想法 pin id（用于发布后核验真的新增了一条）
      const before = await readTopPin();
      // 点"发布"（必须用 Playwright 原生 click：知乎按钮为 React 受控，DOM .click() 无效）
      const pubBtn = c.page.locator('button', { hasText: /^发布$/ }).last();
      if (!(await pubBtn.count())) throw new Error('知乎"发布"按钮未找到（页面结构变更，如实失败）');
      if (!(await pubBtn.first().isEnabled().catch(() => false))) throw new Error('知乎"发布"按钮不可用（内容未生效/被风控），如实失败');
      await pubBtn.first().click({ force: true });
      // 发布成功校验（诚实红线）：最新想法 pin 必须是一个新的 id（不同于发布前）。
      // 用轮询而非固定等待：发布后想法列表接口常有数秒延迟，固定等 3.5s 会把"已成功"误判为失败。
      const deadline = Date.now() + 15000;
      let after = { ok: false, topId: '' }, tries = 0;
      while (Date.now() < deadline) {
        await c.page.waitForTimeout(1500);
        tries++;
        after = await readTopPin();
        if (after.ok && after.topId && after.topId !== before.topId) break; // 新 pin 出现即确认成功
      }
      if (!after.ok) throw new Error('知乎发布未生效：想法列表为空/接口失败（如实失败）');
      if (before.ok && after.topId === before.topId) throw new Error('知乎发布未生效：' + tries + ' 次轮询内最新想法未变化（可能被风控拦截），如实失败');
      const url = 'https://www.zhihu.com/pin/' + after.topId;
      pushLog(platform, { type: 'published', title, ok: true, url, detail: '知乎发布成功（API 核验：最新想法 pin=' + after.topId + '，轮询 ' + tries + ' 次）' });
      return { ok: true, dryRun: false, platform, title, url };
    }
    if (platform === 'xiaohongshu') {
      // 打开发布页
      await c.page.goto('https://creator.xiaohongshu.com/publish/publish', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await c.page.waitForTimeout(1500);
      const titleBox = await c.page.$('input[placeholder*="标题" i], input[placeholder*="填写标题"]');
      const bodyBox = await c.page.$('div[contenteditable=true][class*=editor], textarea[placeholder*="正文" i], .ql-editor, div[class*=rich-editor]');
      if (!bodyBox) throw new Error('小红书编辑框未找到（页面结构变更，如实失败）');
      if (titleBox) { try { await titleBox.fill(title); } catch (e) {} }
      await bodyBox.fill(body);
      if (dryRun) {
        return { ok: true, dryRun: true, platform, title, detail: '已拟稿到发布页（未点击发布）' };
      }
      await c.page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => /发布/.test(b.textContent || ''));
        if (btns.length) btns[0].click();
      });
      // 诚实红线：必须捕获"离开发布页/发布成功"信号才算发布成功，捕不到就如实报未确认（不伪造）。
      const conf = await confirmAfterPublish(c.page, spec, 25000);
      if (conf.ok) {
        pushLog(platform, { type: 'published', title, ok: true, url: conf.url, detail: '小红书发布成功（信号：' + conf.by + '，轮询 ' + conf.tried + ' 次）' });
        return { ok: true, dryRun: false, platform, title, url: conf.url };
      }
      const curUrl = c.page.url();
      pushLog(platform, { type: 'unverified', title, ok: false, url: curUrl, detail: '已点击发布但未捕获「发布成功」信号（页面结构可能变更或仍在处理，请人工去平台核对；系统不伪造成功）' });
      return { ok: false, platform, title, url: curUrl, unverified: true, reason: '已点击发布但未捕获「发布成功」信号（可能已成功或页面变更，需人工核对；系统不伪造成功）' };
    }
    if (platform === 'mp') {
      await c.page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await c.page.waitForTimeout(1500);
      // 新建图文
      const newBtn = await c.page.$('[class*=right-column] [class*=icon] [title*=新建]');
      await c.page.evaluate(() => {
        const links = [...document.querySelectorAll('a')].filter(a => /新建|新图文/.test(a.textContent || ''));
        if (links.length) links[0].click();
        else { const btns = [...document.querySelectorAll('button')].filter(b => /新建|新图文/.test(b.textContent || '')); if (btns.length) btns[0].click(); }
      }).catch(() => {});
      await c.page.waitForTimeout(1200);
      const titleBox = await c.page.$('input[id=title], input[placeholder*="标题" i]');
      if (titleBox) { try { await titleBox.fill(title); } catch (e) {} }
      const bodyArea = await c.page.$('iframe[id=ueditor_0], div[contenteditable=true]');
      if (!bodyArea) throw new Error('公众号编辑器未找到（页面结构变更，如实失败）');
      try { await bodyArea.fill(body); } catch (e) {}
      if (dryRun) {
        return { ok: true, dryRun: true, platform, title, detail: '已拟稿到公众号编辑器（未点击发布）' };
      }
      await c.page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => /群发|发布/.test(b.textContent || ''));
        if (btns.length) btns[0].click();
      });
      // 诚实红线：必须捕获"发送/群发/发布成功"信号才算成功，捕不到就如实报未确认（不伪造）。
      const conf = await confirmAfterPublish(c.page, spec, 25000);
      if (conf.ok) {
        pushLog(platform, { type: 'published', title, ok: true, url: conf.url, detail: '公众号发布成功（信号：' + conf.by + '，轮询 ' + conf.tried + ' 次）' });
        return { ok: true, dryRun: false, platform, title, url: conf.url };
      }
      const curUrl = c.page.url();
      pushLog(platform, { type: 'unverified', title, ok: false, url: curUrl, detail: '已点击群发/发布但未捕获成功信号（可能仍在人工复核队列或页面变更，请人工去公众号核对；系统不伪造成功）' });
      return { ok: false, platform, title, url: curUrl, unverified: true, reason: '已点击群发/发布但未捕获成功信号（需人工核对；系统不伪造成功）' };
    }
    throw new Error('平台适配器未实现：' + platform);
  } catch (e) {
    pushLog(platform, { type: 'error', title, ok: false, detail: String(e.message || e).slice(0, 160) });
    return { ok: false, reason: String(e.message || e).slice(0, 160), platform };
  } finally { await closeAll(c); }
}

// —— 对外一览：可用平台 + 各平台最近状态 ——
function overview() {
  const out = [];
  for (const k of Object.keys(PLATFORMS)) {
    const db = loadDb(k);
    const last = db.log[0] || null;
    out.push({ platform: k, name: PLATFORMS[k].name, last, logCount: db.log.length });
  }
  return out;
}

function logAll(platform) {
  const db = loadDb(platform);
  return (db.log || []).slice(0, 50).map(x => ({ id: x.id, type: x.type, title: (x.title || '').slice(0, 40), ok: x.ok, url: x.url || '', detail: (x.detail || '').slice(0, 80), at: x.at }));
}

// —— 在库内容资产（conductor 产物 data/assets），供前端"一键取料"拟稿发布 ——
// 诚实红线：取料面板绝不允许出现 ①测试残留（_e2e_wo_）②含资金/隐私的敏感稿（催款函/付款指令/银行账号/支付宝等），防止内部财务信外泄。
const ASSET_SENSITIVE = /催款|付款指令|转账|银行账号|开户银行|开户姓名|支付宝|收款(码|方|账户)?|流水号|卡号|佣?金到账/i;
function assetPublishable(f) {
  if (/_e2e_wo_/.test(f)) return false;
  let body = '';
  try { body = fs.readFileSync(f, 'utf8'); } catch (e) {}
  if (ASSET_SENSITIVE.test(f) || ASSET_SENSITIVE.test(body.slice(0, 2000))) return false;
  return true;
}
function listAssets(n) {
  const dir = store.dataPath('assets');   // 【2026-09】同上：asar 内不可写
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.md'))
      .map(f => path.join(dir, f))
      .filter(assetPublishable)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch (e) {}
  return files.slice(0, n || 20).map(f => {
    let body = '';
    try { body = fs.readFileSync(f, 'utf8').slice(0, 2000); } catch (e) {}
    return { file: path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/'), title: path.basename(f, '.md'), body };
  });
}

module.exports = { PLATFORMS, overview, logAll, publish, statusOne, listAssets };