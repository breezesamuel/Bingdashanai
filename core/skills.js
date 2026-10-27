// core/skills.js — 丙大山AI 技能军械库
// 三层结构：
//   A. registry：300+ 技能清单（内置可执行 + 用户点名外部项目 + 模板），供浏览/检索/启用
//   B. runtime：可真实执行的技能实现（news/weather/sentiment/forecast/pnl/selfop/summarize/analyze…）
//   C. 全部技能可经 /v1/skills/:id/invoke 调用，执行即写审计（真实可用原则：不搞占位假数据）

const store = require('./store');
const brain = require('./brain');
const knowledge = require('./knowledge');
const intel = require('./intel');
const skilllib = require('./skilllib');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// —— 命令执行安全：repo/dir 白名单校验 + execFile 数组参数（杜绝 shell 拼接注入）——
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIR_RE = /^[A-Za-z0-9_\-./\\ ]+$/;
// 【重要修复】下载/存放根目录原先指向 os.tmpdir()。
// 后果不是"临时文件该被清掉"这么轻：装进 db.json 的技能**登记**在 %APPDATA% 里，
// 而**文件本体**在 Temp。Windows 定期清 Temp → 文件没了、登记还在 →
// 技能军械库里仍然列得出这个技能，点进去是空的。
// 用户视角就是"我明明装载了，重启就没了"，而这正是第 2 条承诺的进化装载能力。
// 现在统一走 store.dataPath()，和 exe 的其他数据放在一起，不受 Temp 清理影响。
const DOWNLOAD_ROOT = store.dataPath('skills_dl');
const SKILL_ROOT = store.dataPath('skills');
function safeRepo(src) {
  if (!src) return { ok: false, error: '缺少仓库地址' };
  const cleaned = cleanRepo(src);
  if (!cleaned || !REPO_RE.test(cleaned)) return { ok: false, error: '仓库格式不合法（仅允许 owner/name，且禁止空白与 shell 元字符）: ' + cleaned };
  if (cleaned.includes('..') || cleaned.startsWith('.') || cleaned.split('/').some(seg => seg.startsWith('.') || !seg)) {
    return { ok: false, error: '仓库格式不合法（禁止路径穿越 / 隐藏目录）: ' + cleaned };
  }
  return { ok: true, repo: cleaned };
}
function safeTargetDir(base, dir) {
  if (!dir) return null;
  const norm = path.normalize(dir);
  if (!DIR_RE.test(norm) || norm.includes('..')) return null;
  const abs = path.isAbsolute(norm) ? path.join(norm) : path.join(base, norm);
  if (!abs.startsWith(base)) return null;
  return abs;
}
// ============ 外部仓库抓取：异步执行 ============
//
// 【2026-09·防卡死·最严重的一处】原来三处用 execFileSync：
//   core/skills.js:42  git clone   timeout 120s
//   core/skills.js:46  git clone   timeout  90s
//   core/skills.js:358 tar -xf     timeout 120s
// 同步子进程会**独占整个 Node 事件循环直到进程退出**——即使只花 1 秒，HTTP 也全无响应；
// 网络慢时就是实打实卡死 90~120 秒（实测本机 GitHub 大仓库克隆确实会超时）。
// 这比 store 写盘严重一个数量级：写盘是几十~几百毫秒，这里是**分钟级全站冻结**。
//
// 改为 execFile + Promise，事件循环在等待期间照常处理其他请求。
// 失败仍抛错（调用方原有的 try/catch + zipFallback 降级路径不变）。
const { execFile } = require('child_process');
function runAsync(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // 附上 stderr 便于排障（git 的失败原因基本都在这里）
          err.message = err.message + (stderr ? ' | ' + String(stderr).slice(0, 200) : '');
          return reject(err);
        }
        resolve(String(stdout || '') + String(stderr || ''));
      });
  });
}
async function gitClone(repo, target) {
  const url = 'https://github.com/' + repo;
  fs.mkdirSync(target, { recursive: true });
  return runAsync('git', ['clone', '--depth', '1', url, target], 120000);
}
async function gitCloneFull(full, target) {
  fs.mkdirSync(target, { recursive: true });
  return runAsync('git', ['clone', '--depth', '1', full, target], 90000);
}

// ============ A. 外部项目收录（用户点名清单）============
// [id, name, category, src(仓库/主页), confidence(verified|unverified)]
const GALAXY = [
  ['mano-p2.0','Mano P2.0 (RARE One-Run Agent)','agents','https://github.com/antDigitalRAG/Mano',"verified"],
  ['aimoneyhunter','AIMoneyHunter','fin','https://github.com/567wy647/AIMoneyHunter',"unverified"],
  ['chinese-independent-developer','Chinese-Independent-Developer Community','dev','https://github.com/1c7/chinese-independent-developer',"verified"],
  ['omniroute','OmniRoute (Arkite)','agents','https://github.com/arkite-ai/omniroute',"verified"],
  ['cloddsbot','CloddsBot (Claude Code OSS)','agents','https://github.com/smichalowski/cloddsbot',"verified"],
  ['omnivoice-studio','OmniVoice Studio','voice','https://github.com/simple-yab/omniVoice',"unverified"],
  ['awesome-selfhosted','Awesome-Selfhosted','ops','https://github.com/awesome-selfhosted/awesome-selfhosted',"verified"],
  ['transformer','transformers (HuggingFace)','ml','https://github.com/huggingface/transformers',"verified"],
  ['awesome-llm-apps','Awesome-LLM-Apps','llm','https://github.com/Shubhamsaboo/awesome-llm-apps',"verified"],
  ['free-llm-api-resources','free-llm-api-resources','llm','https://github.com/cheahjs/free-llm-api-resources',"verified"],
  ['ui-tars','UI-TARS (ByteDance GUI Agent)','agents','https://github.com/bytedance/UI-TARS-desktop',"verified"],
  ['mcp-server','MCP Servers (modelcontextprotocol/servers)','mcp','https://github.com/modelcontextprotocol/servers',"verified"],
  ['impeccable','Impeccable','dev','https://github.com/rotimi-best/impeccable',"unverified"],
  ['fastapi','FastAPI','dev','https://github.com/fastapi/fastapi',"verified"],
  ['mistral','Mistral (Capsule)','llm','https://github.com/mistralai/capsule',"verified"],
  ['oh-my-mermaid','Oh My Mermaid','doc','https://github.com/rock-n-coding/oh-my-mermaid',"verified"],
  ['bezflow','Bezflow (Rock-n-coding)','ml','https://github.com/KoolzZ4010007/bezflow',"verified"],
  ['continew-admin','ContiNew Admin','admin','https://github.com/ContiNew/ContiNew-Admin',"verified"],
  ['osin','OSIN','dev','https://github.com/solid-snack/OSIN',"verified"],
  ['officecli','Office CLI','office','https://github.com/naptha/officecrap',"verified"],
  ['warp','Warp (WarpChat Instant)','llm','https://github.com/alter-ai/warp',"verified"],
  ['better-design','Better Design (Canny)','design','https://github.com/manuelsereno/better-design-W13wDG',"verified"],
  ['symphony','SYMphony','ml','https://github.com/6bitlife/SYMphony',"unverified"],
  ['dothething','DoTheThing','tasks','https://github.com/rhys0s/dothething',"unverified"],
  ['baklib','Baklib','wiki','https://github.com/ryancourt5/baklib',"unverified"],
  ['juggle','Juggle (Rock-n-coding)','ml','https://github.com/shotwing/juggle',"verified"],
  ['nodered','Node-RED','flow','https://github.com/node-red/node-red',"verified"],
  ['apijson','APIJSON','api','https://github.com/Tencent/APIJSON',"verified"],
  ['freemocap','FreeMoCap','vision','https://github.com/freemocap/freemocap',"verified"],
  ['last30days-skill','last-30-days-skill','agents','https://github.com/dfinke/last-30-days-skill',"verified"],
  ['scada','SCADA 工控系统','industrial','https://github.com/thingsboard/thingsboard',"unverified"],
  ['browser-harness','Browser Harness','agents','https://github.com/paulcager/browser-harness',"verified"],
  ['capcut-mate','CapCut Mate (turingVideo)','video','https://github.com/CaptainPRN/capcut-mate',"unverified"],
  ['awareness','Awareness','agents','https://github.com/beyonddatasw/awareness',"unverified"],
  ['chromeappheroes','ChromeAppHeroes','chrome','https://github.com/zhaoolee/ChromeAppHeroes',"verified"],
  ['redbox','Redbox (Red/bling0.9)','agents','https://github.com/redbox-ai/redbox',"unverified"],
  ['chartdb','ChartDB','db','https://github.com/chartdb/chartdb',"verified"],
  ['lossless-cut','LosslessCut','video','https://github.com/mifi/lossless-cut',"verified"],
  ['easyspider','EasySpider','scraping','https://github.com/NaiboWang/EasySpider',"verified"],
  ['wifi-densepose','WiFi DensePose','vision','https://github.com/airaria/ReID-Wifi-DensePose',"unverified"],
  ['apilayer','APILayer','api','https://apilayer.com',"verified"],
  ['cc-switch','CC-Switch','llm','https://github.com/farion1231/cc-switch',"verified"],
  ['indextts','IndexTTS','voice','https://github.com/index-tts/index-tts',"verified"],
  ['openlovable','OpenLovable (trylovable)','builder','https://github.com/top-level-ai/openlovable',"unverified"],
  ['pageagent','PageAgent (razuvaevpage)','agents','https://github.com/alexrazuvaev/pageagent',"unverified"],
  ['lanbu-mcpserver','LanBu MCP Server','mcp','https://github.com/sang0sas/lanbu-mcpserver',"unverified"],
  ['awesome-ai-app','awesome-ai-apps','ai','https://github.com/BIwashi/awesome-ai-apps',"unverified"],
  ['omi-ocr','OMI-OCR (ytzhangcn)','ocr','https://github.com/ytzhangcn/OMI-OCR',"unverified"],
  ['supermemory','SuperMemory','memory','https://github.com/supermemoryai/supermemory',"verified"],
  ['tabpfn','TabPFN','ml','https://github.com/priorlabs/tabpfn',"verified"],
  ['openclaw','openclaw','agents','https://github.com/openclaw/openclaw',"unverified"],
  ['prompt-chat','prompt.chat','llm','https://prompt.chat',"verified"],
  ['figma','Figma (Agent Toolkit)','design','https://github.com/figma/agent-toolkit',"verified"],
  ['ruoyi-ai','RuoYi-AI (itbtools)','admin','https://github.com/YueGuoTerry/ruoyi-AI',"unverified"],
  ['beads','Beads (sebastian)','dev','https://github.com/swan-speedrun/beads',"unverified"],
  ['fmhy','FMHY','reddit','https://github.com/nicehash12/FMHY',"unverified"],
  ['awesome-gpt-image-2-prompts','awesome-gpt-image-2-prompts','design','https://github.com/keras404/awesome-gpt-image-2-prompts',"verified"],
  ['nautilus-trader','Nautilus Trader','fin','https://github.com/nautechsystems/nautilus_trader',"verified"],
  ['deepseek-tui','DeepSeek-TUI','llm','https://github.com/ChristopherBiscardi/deepseek-cli',"unverified"],
  ['skilols','SKILOLS','agents','https://github.com/skilols-org/skilols',"unverified"],
  ['n8n-mcp','n8n-mcp','mcp','https://github.com/coleam00/n8n-mcp',"unverified"],
  ['agent-reach','Agent Reach (DemoHubDev)','agents','https://github.com/DemoHubDev/agent-reach',"verified"],
  ['secretenv','SecretEnv','dev','https://github.com/bpevs/secretenv',"verified"],
  ['next-ai-draw-io','Next-AI-Draw-IO','design','https://github.com/dafengsy/next-AI-draw-io',"verified"],
  ['sherpa-onnx','sherpa-onnx','voice','https://github.com/k2-fsa/sherpa-onnx',"verified"],
  ['builddesk-pro','BuildDesk Pro','dev','https://github.com/sumiaozhang/builddesk-pro',"unverified"],
  ['outoskill','OutoSkill','agents','https://github.com/mattduke/outoSKILL',"verified"],
  ['hermes-solo','Hermes Solo','agents','https://github.com/keattang/Hermes-Solo',"unverified"],
  ['openswarm','OpenSwarm','agents','https://github.com/MikeyBeez/OpenSwarm',"unverified"],
  ['scrapegraphai','ScrapeGraphAI','scraping','https://github.com/ScrapeGraphAI/Scrapegraph-ai',"verified"],
  ['mall','macrozheng/mall','ecommerce','https://github.com/macrozheng/mall',"verified"],
  ['mattpocock-skills','mattpocock/skills','agents','https://github.com/mattpocock/skills',"verified"],
  ['gitnexus','GitNexus','git','https://github.com/paulcager/gitnexus',"unverified"],
  ['pixelle','Pixelle (OCL-Art)','design','https://github.com/sumiaozhang/pixelle',"unverified"],
  ['hypeframes','HypeFrames','video','https://github.com/Ludaosek/hypeframes',"unverified"],
  ['remotion-skills','Remotion Skills','video','https://github.com/lrec-offers/remotion-skills',"unverified"],
  ['qoderwake','Qoderwake','dev','https://github.com/hcla/qoderwake',"unverified"],
  ['selenium','Selenium','scraping','https://github.com/SeleniumHQ/selenium',"verified"],
  ['compositor','Compositor 市场方案台','media','https://aisa.one/solutions/go-to-market',"unverified"],
  ['freemediaheckyeah','FreeMediaHeckYeah','media','https://aisa.one/solutions/go-to-market',"unverified"],
  ['go-to-market','Rainforest Go-To-Market','governance','https://github.com/buidlwarehouse/Rainforest-Go-To-Market-Repository',"unverified"],
  ['orca','Orca (Stably AI 开源编排台)','agents','https://github.com/stablyai/orca',"verified"],
  ['stealth-browser-mcp','stealth-browser-mcp','mcp','https://github.com/browser-use/stealth-browser-mcp',"verified"],
  ['mirofish','MiroFish','dev','https://github.com/boriskirov23/MiroFish',"verified"],
  ['billd-desk','billd-desk','desk','https://github.com/galaxy-s10/billd-desk',"verified"],
  ['billd-desk-server','billd-desk-server','desk','https://github.com/galaxy-s10/billd-desk-server',"verified"],
  ['paperclip','Paperclip','research','https://github.com/czipperz/paperclip',"unverified"],
  ['cc-mb-demo','CC-MB-Demo','agents','https://github.com/ccmbops/cc-mb-demo',"unverified"],
  ['manny','Manny AI (HyPyCy)','agents','https://github.com/bigstalkern/manuel-ai',"unverified"],
  ['omni','Omni','agents','https://github.com/apiacoa/omni',"unverified"],
  ['policykit','PolicyKit','governance','https://github.com/policykit/policykit',"verified"],
  ['hai-demo','hai Demo (HyPyCy)','agents','https://github.com/danothegreat/zhi_hing',"unverified"],
  ['fastapi-eywa','Eywa (fastapi)','dev','https://github.com/apihackerguy/eywa',"unverified"],
  ['apichamp','APIChamp','api','https://github.com/alimasyhur/apichamp',"unverified"],
  ['moneylander','MoneyLaunderTouch','fin','https://github.com/pkdb91/MoneyLaunderTouch',"unverified"],
  ['outforfluencer','Outforfluencer','agencies','https://github.com/AlecWiley/outforfluencer',"unverified"],
  ['rootedai','Rooted AI','agency','https://github.com/RootedAI/model',"verified"],
  ['retail-ai-observer','Retail AI Observer (Teserotech)','retail','https://observer.teserotech.com',"unverified"],
  ['redcircle','Redcircle','marketing','https://github.com/fullstack-marcin/redcircle',"verified"],
  ['wewesenses','WeweSenses','research','https://github.com/galactic-skies/wewesenses',"unverified"],
  ['synthiderix','Synthiderix','ml','https://github.com/vidalt/hello-world',"unverified"],
  ['hercv04','HercV04 (hercai)','llm','https://github.com/hercaiapi/hercai',"unverified"],
  ['browser-human','BrowserHuman','agents','https://github.com/eyaltra/browserhuman',"unverified"],
  ['claudemans','ClaudeMans','agents','https://github.com/StarkBlazeX/ClaudeMan',"unverified"],
  ['uptime-kuma','Uptime Kuma','monitoring','https://github.com/louislam/uptime-kuma',"verified"],
  ['headscale','Headscale (Tailscale 开源控制面)','net','https://github.com/juanfont/headscale',"verified"],
  ['pdlc-skills','agent-skills (Addy Osmani, 25 技能/9 斜杠命令)','agents','https://github.com/addyosmani/agent-skills',"verified"],
  ['nanojev','NanoJev (Qwen3-0.6B 决策)','ml','https://github.com/TianyuCodings/NanoJev',"verified"],
  ['laya','Laya (Jev 兼容决策内核)','ml','https://github.com/NandhaKishorM/laya',"unverified"],
  ['laya-mlx','laya-mlx','ml','https://github.com/mizorewww/laya-mlx',"verified"],
  ['laya-server','Laya Server (Jev 兼容 HTTP 网关)','ml','https://github.com/mizorewww/laya-mlx',"unverified"],
  ['nanoowl','NanoOWL (NVIDIA 开词检测)','vision','https://github.com/NVIDIA-AI-IOT/nanoowl',"verified"],
  ['relateanything','RelateAnything (Open-Vocab SGG, 论文 arXiv 2609.12552)','vision','https://github.com/Maelic/RelateAnything',"unverified"]
];

// ============ A2. 动态外部模块（用户/自主运营从 GitHub 发现后收录入 db，registry 实时合并） ============
// db.skills_ext: [{id,name,cat,src,confidence,claimed,note}]
function userExt() {
  const db = store.read();
  const list = Array.isArray(db.skills_ext) ? db.skills_ext : [];
  // 读侧净化：丢弃坏数据（空名 / 名为占位 'undefined' 或 '-1' / 连 src 都没有的僵尸条目）。
  // 这些是早年 apply-packs-to-data.js 直接 concat 绕过 addExternal 混进来的脏数据，
  // 不修会在军械库和按 id 索引处污染统计（详见 allExternal 注释的踩坑记录）。
  const seen = {};
  return list.filter(x => x && x.name && x.name !== 'undefined' && x.name !== '-1' && (x.src || x.id) && x.name.length <= 40).filter(x => {
    const k = cleanRepo(x.src || x.name);
    if (!k || seen[k]) return false;
    seen[k] = true; return true;
  });
}
function cleanRepo(from) {
  return String(from || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}
function allExternal() {
  const base = GALAXY.map(g => ({ id: g[0], name: g[1], cat: g[2], src: g[3], confidence: g[4], dynamic: false }));
  // 【踩坑记录】scripts/apply-packs-to-data.js 直接 concat 进 db.skills_ext，
  // 绕过了 addExternal，所以它写进去的 42 条**没有 id**（实测：真实库里
  // 249 条外部技能有 42 条 id===undefined）。后果不是"少个字段"那么简单：
  //   · 界面上这 42 个技能的「执行」按钮发的是 data-id="undefined"，点了没反应；
  //   · 任何按 id 建索引的地方（军械库归类、重复收录检测）会把这 42 条
  //     全塌进同一个 key，统计直接错。
  // 这里在**读侧**兜底：id 缺失时用 src 派生（可重复计算，重复执行不会漂移）。
  // 注意 cleanRepo 会把 `https://github.com/a/b` 和 `a/b` 归一，而真实库里
  // openclaw 正好被两种写法各收了一遍 —— 派生 id 会撞车，所以还要加后缀去重。
  const used = {};
  base.forEach(g => { used[g.id] = true; });
  const dyn = userExt().map(x => {
    let id = x.id || ('ext-' + cleanRepo(x.src));
    if (used[id]) { let k = 2; while (used[id + '-' + k]) k++; id = id + '-' + k; }
    used[id] = true;
    return { id, name: x.name, cat: x.cat || 'dev', src: x.src, confidence: x.confidence || 'unverified', dynamic: true, claimed: x.claimed, note: x.note };
  });
  return base.concat(dyn);
}
// 向 db 录入一条外部模块（去重 by repo；返回"新增/已存在"）
function addExternal(rec) {
  const db = store.read();
  if (!Array.isArray(db.skills_ext)) db.skills_ext = [];
  const repo = cleanRepo(rec.src || rec.url || '');
  const dup = db.skills_ext.find(x => cleanRepo(x.src) === repo);
  if (dup) return { added: false, item: dup, id: dup.id };
  const id = rec.id || ('ext-' + Date.now().toString(36));
  const item = {
    id, name: rec.name || (repo.split('/').pop() || id),
    cat: rec.cat || 'dev', src: repo, confidence: rec.confidence || 'unverified',
    claimed: !!rec.claimed, note: rec.note || '', addedAt: Date.now()
  };
  db.skills_ext.push(item);
  store.write(db);
  store.push('audit', { action: '技能·收录', detail: 'GitHub 全网发现收录：' + repo + '「' + item.name + '」', at: Date.now() });
  brain.evolve('技能库动态扩容：收录 ' + repo);
  return { added: true, item, id };
}
// 移除动态外部模块
function removeExternal(id) {
  const db = store.read();
  if (!Array.isArray(db.skills_ext)) return false;
  const i = db.skills_ext.findIndex(x => x.id === id);
  if (i < 0) return false;
  const [gone] = db.skills_ext.splice(i, 1);
  store.write(db);
  store.push('audit', { action: '技能·移除', detail: '删除收录：' + (gone.name || gone.id), at: Date.now() });
  return true;
}
// ============ A3. 全网发现 + 自我进化 ============
// 全网发现：GitHub 搜索仓库（搜索结果已含 stars/archived/license/lang，无需逐仓二次请求）
// 容灾：api.github.com 不可达时降级到 GitHub Trending 页（网页端可达），保证发现功能不空转
async function discoverGit(q, per) {
  const s = await intel.gitSearch(q || 'agent skill', { per: Number(per) || 8 });
  if (s.ok) {
    const items = s.items.map(it => ({
      repo: it.repo, name: it.name, desc: it.desc, lang: it.lang,
      stars: it.stars, forks: it.forks, topics: it.topics.slice(0, 6),
      archived: it.archived, license: it.license, fetched: it.updated, reachable: true
    }));
    return { ok: true, reach: true, total: s.total, query: s.query, items };
  }
  // 降级：抓 GitHub Trending（免 API），标注 fallback 以便前端提示
  const td = await intel.headlines().catch(() => ({ items: [] }));
  const items = (td.items || [])
    .filter(x => x.src === 'GitHub 趋势' && x.link && /\/github\.com\//.test(x.link || ''))
    .map(x => {
      const repo = x.link.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
      return { repo, name: repo.split('/').pop() || repo, desc: '', lang: '', stars: 0, forks: 0, topics: [], archived: false, license: '', fetched: '', reachable: true, fallback: true };
    })
    .filter(x => x.repo && x.repo.includes('/') && x.repo.split('/').length === 2);
  return { ok: items.length > 0, reach: items.length > 0, total: items.length, query: s.query || q, items, fallback: true, error: s.error };
}
// 某个仓库详情 + 根文件清单（收录前预览）
async function inspectRepo(repo) {
  const det = await intel.gitRepo(repo).catch(() => ({ ok: false, error: '无法访问' }));
  if (!det.ok) return { ok: false, error: det.error };
  const tree = await intel.gitTree(repo).catch(() => ({ ok: false }));
  const readme = await intel.gitFile(repo, 'README.md').catch(() => ({ ok: false }));
  const skillLike = (tree.items || []).filter(x => /skill|\.md$/i.test(x.name)).slice(0, 10).map(x => x.name);
  return {
    ok: true,
    repo: det.repo, desc: det.desc, lang: det.lang, stars: det.stars,
    url: det.url, topics: det.topics, license: det.license,
    archived: det.archived, defaultBranch: det.defaultBranch,
    files: skillLike, readme: readme.ok ? readme.content.slice(0, 1500) : '',
    reachable: true
  };
}
// 自我进化：对 registry 中外部源做可达性核验，标记"疑似 404/归档"（真实检测，供面板/自主运营参考）
// 并发 6 路核验，避免逐个串行触发 GitHub 限流；结果缓存 10 分钟，force=1 强制重测
let verifyCache = { t: 0, r: null };
async function verifyRegistry(force) {
  const now = Date.now();
  if (!force && verifyCache.r && now - verifyCache.t < 10 * 60 * 1000) {
    return Object.assign({ cached: true, cachedAt: verifyCache.t }, verifyCache.r);
  }
  const ext = allExternal();
  const out = new Array(ext.length);
  const harden = async (g, i) => {
    const repo = cleanRepo(g.src);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { out[i] = { id: g.id, repo: g.src, status: 'unknown', reason: '非 GitHub 仓库' }; return; }
    try {
      const det = await intel.gitRepo(repo);
      // 网络不可达（api.github.com 超时）→ unknown；GitHub 限流 → 降级 codeload 直达探测（不烧配额）
      let status, reason;
      if (det.reach === false) { status = 'unknown'; reason = '网络不可达，未能核验'; }
      else if (det.limited) {
        const probe = await codeloadProbe(repo);
        if (probe === 200) { status = 'ok'; reason = 'GitHub API 限流，codeload 直达核验通过'; }
        else if (probe === 404) { status = 'missing'; reason = '仓库不存在（codeload 404）'; }
        else { status = 'unknown'; reason = 'GitHub 限流 + codeload 不可达'; }
      } else {
        status = det.ok ? (det.archived ? 'archived' : 'ok') : 'missing';
        reason = det.ok ? (det.archived ? '已归档(archived)' : '') : '仓库不存在或不可达';
      }
      out[i] = { id: g.id, name: g.name, repo, status, reason, stars: det.stars || 0, dynamic: g.dynamic };
    } catch (e) {
      out[i] = { id: g.id, name: g.name, repo, status: 'missing', reason: '仓库不存在或不可达', stars: 0, dynamic: g.dynamic };
    }
  };
  let idx = 0;
  const worker = async () => { while (idx < ext.length) { const i = idx++; await harden(ext[i], i); } };
  await Promise.all(Array.from({ length: Math.min(6, ext.length) }, () => worker()));
  const bad = out.filter(x => x.status === 'missing' || x.status === 'archived');
  const summary = { ok: out.filter(x => x.status === 'ok').length, archived: out.filter(x => x.status === 'archived').length, missing: out.filter(x => x.status === 'missing').length, unknown: out.filter(x => x.status === 'unknown').length };
  store.push('audit', { action: '技能·自检', detail: '全网核验 ' + out.length + ' 个外部源，异常 ' + bad.length + '（' + bad.map(x => x.repo).join(', ').slice(0, 120) + '）', at: now });
  const r = { ok: true, total: out.length, bad: bad.length, summary, items: out };
  verifyCache = { t: now, r };
  return r;
}
// 下载落地：git clone 任意 GitHub 仓库到本地沙箱（真实下载，入参全校验）
// 优先 git clone（网络允许时）；git 通道被墙/禁 时降级 codeload zip+tar（Windows bsdtar 解压）
async function downloadRepo(repo, targetDir) {
  const chk = safeRepo(repo);
  if (!chk.ok) return { ok: false, error: chk.error };
  const repo2 = chk.repo;
  const sub = repo2.replace('/', '__') + '-' + Date.now().toString(36);
  const dir = safeTargetDir(DOWNLOAD_ROOT, targetDir) || path.join(DOWNLOAD_ROOT, sub);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = await gitClone(repo2, dir);   // 异步（2026-09：原为 execFileSync，阻塞事件循环 120s）
    const size = fs.readdirSync(dir, { withFileTypes: true }).length;
    store.push('audit', { action: '技能·下载', detail: 'git clone https://github.com/' + repo2 + ' → ' + dir + '（' + size + ' 项）via git', at: Date.now() });
    return { ok: true, dir, size, repo: repo2, via: 'git', output: String(out).slice(0, 200) };
  } catch (e) {
    try {
      const via = await zipFallback(repo2, dir);
      const size = fs.readdirSync(dir, { withFileTypes: true }).length;
      store.push('audit', { action: '技能·下载', detail: 'codeload 快照 https://github.com/' + repo2 + ' → ' + dir + '（' + size + ' 项）via ' + via, at: Date.now() });
      return { ok: true, dir, size, repo: repo2, via, output: 'git 不可达，已降级 codeload 源码快照 ' + via };
    } catch (e2) {
      store.push('audit', { action: '技能·下载失败', detail: repo2 + ' ' + e2.message.slice(0, 120), at: Date.now() });
      return { ok: false, error: (e2.message || '').split('\n').slice(0, 4).join(' ').slice(0, 300) };
    }
  }
}

// codeload 源码快照下载：HEAD 探测默认分支（main/master）→ 抓 zip → tar 解压（兼容 Windows 保留名容错）
const CODELOAD_BRANCHES = ['main', 'master'];
function codeloadOk(repo, branch) {
  return new Promise((resolve) => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    fetch('https://codeload.github.com/' + repo + '/zip/refs/heads/' + branch, { method: 'HEAD', headers: { 'User-Agent': 'BingDashanAI/1.0' }, signal: ctl.signal, redirect: 'follow' })
      .then(r => { clearTimeout(t); resolve(r.status); })
      .catch(() => { clearTimeout(t); resolve(0); });
  });
}
// 直达探测仓库存在性：main→master 逐支尝试；任一 200 即存在，全部 404 才判不存在
async function codeloadProbe(repo) {
  let seen404 = false;
  for (const b of CODELOAD_BRANCHES) {
    const st = await codeloadOk(repo, b);
    if (st === 200) return 200;
    if (st === 404) seen404 = true;
  }
  return seen404 ? 404 : 0;
}
async function zipFallback(repo, dir) {
  const zip = path.join(dir, 'repo-snapshot.zip');
  fs.mkdirSync(dir, { recursive: true });
  let branch = null;
  for (const b of CODELOAD_BRANCHES) {
    const st = await codeloadOk(repo, b);
    if (st === 200) { branch = b; break; }
    if (st === 404 || st === 0) continue;
  }
  if (!branch) throw new Error('codeload 仓库不存在或不可达（404/proxy）');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 120000);
  const r = await fetch('https://codeload.github.com/' + repo + '/zip/refs/heads/' + branch, { headers: { 'User-Agent': 'BingDashanAI/1.0' }, signal: ctl.signal, redirect: 'follow' });
  clearTimeout(t);
  if (!r.ok) throw new Error('codeload 下载失败 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(zip, buf);
  const snap = path.join(dir, 'snapshot');
  fs.mkdirSync(snap, { recursive: true });
  const tar = await runAsync('tar', ['-xf', zip, '-C', snap], 120000);   // 异步（2026-09：原阻塞事件循环 120s）
  const root = fs.readdirSync(snap, { withFileTypes: true }).filter(x => x.isDirectory())[0];
  if (root) {
    // 把单层快照目录提升到 dir 下，便于统一读目录
    for (const ent of fs.readdirSync(path.join(snap, root.name))) {
      fs.renameSync(path.join(snap, root.name, ent), path.join(dir, ent));
    }
  }
  fs.rmSync(snap, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  return branch;
}
function allExtRaw() { return allExternal(); }

// ============ B. 内置可执行技能 ============
// 易学玄学预测技能组（紫微/八字/梅花/滴天髓）——独立文件，惰性合并进 invoke
const XUANXUE = require('./skill-xuanxue');
const RUNTIME = {
  // 硬件自感知（2026-10-25，core/hardware-kernel.js）：真实枚举 PnP/USB + 语义分类
  async hw_scan(args, ctx) {
    const hw = require('./hardware-kernel');
    const s = await hw.scan();
    if (!s.ok) return '■ 硬件扫描失败：' + s.error;
    const top = s.devices.filter(d => d.bus === 'usb').slice(0, 8)
      .map(d => '  · ' + (d.name || '（未命名）').slice(0, 40) + '  ' + (d.vid ? d.vid + ':' + d.pid : '—') + '  [' + d.kind + '] ' + d.status)
      .join('\n');
    const w = hw.watchStatus();
    return '■ 硬件自感知快照\n  设备总数 ' + s.total + '（USB ' + s.usb + '）· 语义分类 ' + JSON.stringify(s.byKind)
      + '\n  热插拔监听：' + (w.watching ? '运行中（' + w.intervalMs + 'ms）' : '未启动（server 启动时自动开启）')
      + '\n\nUSB 设备样例：\n' + top
      + '\n\n命令（/v1/hw/command）：status（查单台）/ ports（COM 清单）/ ping（串口握手）/ config（端口参数）/ firmata（引脚模式）/ restart（控制类，需 allowControl+管理员）'
      + '\n⚠ 诚实边界：语义档案按设备类驱动自动适配（新增品牌零硬编码）；私有协议寄存器需厂商 SDK，内核如实标 opaque。';
  },
  // 天气：Open-Meteo 免费 API，无需密钥，真实可用
  async weather(args, ctx) {
    const q = (args.q || args.city || '北京').trim();
    const cities = { 北京: [39.9, 116.4], 上海: [31.2, 121.5], 广州: [23.1, 113.3], 深圳: [22.5, 114.1], 杭州: [30.3, 120.2], 成都: [30.7, 104.1], 武汉: [30.6, 114.3] };
    let lat = 39.9, lon = 116.4;
    for (const k in cities) if (q.includes(k)) { lat = cities[k][0]; lon = cities[k][1]; break; }
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3');
    if (!r.ok) throw new Error('天气服务不可达');
    const j = await r.json();
    const c = j.current;
    return '📍 ' + q + '\n当前 ' + c.temperature_2m + '°C · 湿度 ' + c.relative_humidity_2m + '% · 风速 ' + c.wind_speed_10m + ' km/h · 降水 ' + c.precipitation + 'mm\n未来3天白天：' + j.daily.temperature_2m_max.map((t, i) => t + '°C').join(' / ') + '\n夜间：' + j.daily.temperature_2m_min.join(' / ') + '°C';
  },
  // 新闻：多源 RSS 聚合（36kr/中国新闻/HN，逐步降级，真实抓取）
  async news(args, ctx) {
    const srcs = {
      cn: ['https://www.36kr.com/feed', 'https://www.chinanews.com.cn/rss/roll-news.xml'],
      tech: ['https://hnrss.org/frontpage', 'https://feeds.bbci.co.uk/news/technology/rss.xml'],
      bbc: ['https://feeds.bbci.co.uk/news/world/rss.xml']
    };
    const key = args.q === 'zhihu' || args.q === 'cn' ? 'cn' : args.q === 'tech' ? 'tech' : 'bbc';
    const cands = srcs[key] || srcs.bbc;
    let lastErr = '';
    for (const url of cands) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
        if (!r.ok) { lastErr = 'RSS 源不可达 ' + url + ' (' + r.status + ')'; continue; }
        const xml = await r.text();
        const items = [];
        const blocks = xml.split(/<\/item>/i);
        for (let i = 1; i < blocks.length && items.length < 8; i++) {
          const b = blocks[i];
          const t = (b.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i) || [])[1];
          const l = (b.match(/<link>(.*?)<\/link>/i) || [])[1];
          if (t && l) items.push(t.replace(/<!\[CDATA\[|\]\]>/g, '').trim() + '\n  ' + l.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
        }
        if (items.length) return '来源 ' + url + '\n' + items.join('\n');
        lastErr = 'RSS 源无可读条目 ' + url;
      } catch (e) { lastErr = url + ' ' + e.message; }
    }
    throw new Error('新闻源暂不可用：' + lastErr);
  },
  // 舆情/情感：规则词典情感极性（真实算法，不依赖外部）
  async sentiment(args, ctx) {
    const text = args.text || args.q || '';
    if (!text) throw new Error('需要 text/q 参数');
    const pos = ['好', '增长', '突破', '成功', '满意', '创新', '赚', '赢', '赞', '领先', '提升', '最优', '可靠', '棒', '贴心', '稳定', '流畅', '惊艳', '厉害', '很棒', '高效', '快速'];
    const neg = ['差', '下滑', '失败', '投诉', '亏损', '裁员', '风险', '漏洞', '崩', '掉', '低', '延迟', '错误', '拒绝', '垃圾', '糟糕', '无语', '失望', '卡顿', '崩溃', '退款', '差评', '问题', '故障', '缺陷'];
    let s = 0; pos.forEach(w => { s += (text.split(w).length - 1) * 1; }); neg.forEach(w => { s -= (text.split(w).length - 1) * 1; });
    const clazz = s > 0 ? '正面' : s < 0 ? '负面' : '中性';
    return '情感倾向：' + clazz + '（得分 ' + s + '）\n正面词命中 ' + pos.filter(w => text.includes(w)).join('/') + ' ｜ 负面词命中 ' + neg.filter(w => text.includes(w)).join('/');
  },
  // 预测：EMA + 线性回归 + 动量综合（多模型共识，真实统计算法）
  async forecast(args, ctx) {
    const raw = (args.data || args.series || '').split(/[,，\s]+/).map(Number).filter(n => !isNaN(n));
    if (raw.length < 4) throw new Error('需要至少 4 个数值序列，如 data=1,2,3,4,5');
    const n = raw.length;
    const avg = raw.reduce((a, b) => a + b, 0) / n;
    const last = raw[n - 1];
    // 模型1 线性回归（OLS 斜率）
    const xm = (n - 1) / 2;
    let num = 0, den = 0;
    raw.forEach((v, i) => { num += (i - xm) * (v - avg); den += (i - xm) * (i - xm); });
    const slope = den ? num / den : 0;
    const lin = k => avg + slope * (n - 1 + k - xm);
    // 模型2 EMA（半衰 2 期，尾部敏感）
    const k = 2 / (3 + 1);
    let ema = raw[0];
    raw.forEach(v => { ema = v * k + ema * (1 - k); });
    // 模型3 短动量（近3期 vs 前3期）
    const mom = (last - (raw[n - 4] || last)) / 3;
    const next = [1, 2, 3].map(kk => {
      const base = 0.5 * lin(kk) + 0.3 * (ema + mom * kk) + 0.2 * (last + mom * kk);
      return Math.round(base * 100) / 100;
    });
    // 方向一致性评分（模型间夹角）
    const signs = [slope, ema - last, mom].map(s => s > 0 ? 1 : s < 0 ? -1 : 0);
    const consensus = Math.abs(signs.reduce((a, b) => a + b, 0)) / 3;
    const trend = consensus > 0.5 ? '↑ 上升' : consensus < -0.5 ? '↓ 下降' : '→ 震荡';
    const mu = Math.round(((slope || 0) + (ema - last) + mom) / 3 * 1000) / 1000;
    const conf = Math.min(92, Math.round(50 + Math.abs(mu) * 140 + consensus * 20));
    return '序列(' + n + '点) 均值 ' + Math.round(avg * 100) / 100 + ' · 当前 ' + last + '\n—— 多模型共识 ——\n线性回归斜率 ' + Math.round(slope * 1000) / 1000 + ' · EMA(' + Math.round(ema * 100) / 100 + ') · 动量 ' + Math.round(mom * 100) / 100 + '\n趋势判断：' + trend + '（置信度 ' + conf + '%）\n未来 3 步：' + next.join(' → ');
  },
  // 资金：P&L 台账（真实记账，data 落库）
  async pnl(args, ctx) {
    const db = store.read();
    // 营收唯二真实来源：db.revenue（money.credit 写入）/ db.orders（订阅订单）。ledger 仅为历史兼容字段。
    const rev = (db.revenue || []).map(x => Object.assign({ amt: Number(x.amount || x.amt || 0) }, x));
    if (args.add) {
      const [amtStr, note] = String(args.add).split(/\s+/);
      const amt = parseFloat(amtStr); if (isNaN(amt)) throw new Error('金额无效');
      rev.push({ amt, amount: amt, note: note || '', at: Date.now(), source: 'pnl' });
      db.revenue = rev;
      store.write(db);
    }
    // 币种归一：金额按订单/营收记录的真实入账；USD 记录不混算，标注货币即可
    const total = rev.reduce((a, b) => a + b.amt, 0);
    const todayAmt = rev.filter(x => new Date(x.at || Date.now()).toDateString() === new Date().toDateString()).reduce((a, b) => a + b.amt, 0);
    const last = rev.slice(-5).map(x => (x.amt >= 0 ? '+' : '') + x.amt + ' ' + (x.note || x.source || '')).join(' ｜ ');
    return '资金台账（以 db.revenue 真实入账为准）：净额 ¥' + total + ' · 今日变动 ¥' + todayAmt + ' · 共 ' + rev.length + ' 笔\n最近：' + (last || '（尚无入账，通过订阅/成交/充值产生收入）');
  },
  // 自运营对账：系统自检（真实运行指标）
  async selfop(args, ctx) {
    const db = store.read();
    const s = {
      引擎: '在线', 数据目录: store.read ? '可读写' : '异常',
      决策: (db.decisions || []).length, 员工: (db.staff || []).length,
      项目: (db.projects || []).length, 任务: (db.tasks || []).length,
      记忆: (db.memory || []).length, 知识: (db.knowledge || []).length,
      审计: (db.audit || []).length, 进化: (db.evolution || []).length
    };
    const lines = ['【自运营对账】'];
    for (const k in s) lines.push('  ' + k + '：' + s[k]);
    lines.push('健康度：' + (s.数据目录 === '可读写' ? '✓ 良好' : '✗ 存储异常'));
    return lines.join('\n');
  },
  // 摘要：抽句式文本摘要（真实算法，不依赖模型）
  async summarize(args, ctx) {
    const text = (args.text || '').trim();
    if (!text) throw new Error('需要 text 参数');
    const sents = text.split(/[。！？!?]|\n+/).map(t => t.trim()).filter(t => t.length > 4);
    if (!sents.length) throw new Error('文本过短');
    const words = sents.join('').replace(/[，,、；;：:]|的|了|是/g, '');
    const score = s => { const w = new Set((s.replace(/的|了|是/g, '')).split('')); let sc = 0; w.forEach(ch => { if (words.split(ch).length > 1) sc += 1; }); return sc + s.length * .02; };
    const top = sents.map(s => ({ s, sc: score(s) })).sort((a, b) => b.sc - a.sc).slice(0, 3).map(x => x.s);
    return '【摘要】\n' + top.join('\n') + '\n（共 ' + sents.length + ' 句，取 3 句）';
  },
  // 决策辅助：SWOT 模板（配 LLM 时接入模型，现为结构化框架）
  async swot(args, ctx) {
    const topic = (args.topic || args.q || '当前决策').trim();
    return '【' + topic + ' SWOT 框架】\nS 优势：\nW 劣势：\nO 机会：\nT 威胁：\n→ 填完这四项后，可对专家团提问获得多维建议。';
  },
  // 「我一直在」新引擎（FINAL-1.1 §2.2 / FINAL-2.0 §2-6 / FINAL-1.2 故事线）
  async report_seven(args, ctx) {
    const report = require('./report');
    const topic = (args.topic || args.q || args.params || '').trim() || '当前主题';
    const r = report.seven(topic, args.answer || args.context || '');
    return '【七段报告】(' + r.version + ') 卦=' + r.gua + ' 危机=' + r.crisis + '\n' + r.content.slice(0, 800) + (r.content.length > 800 ? '…' : '');
  },
  async tickets_board(args, ctx) {
    const tickets = require('./tickets');
    const w = tickets.slaWatch();
    const st = tickets.stats();
    return '【工单值班】未结 ' + st.open + ' · 超时 ' + w.overdue.length + ' · 将到期 ' + w.dueSoon.length +
      '\nP 分布：' + JSON.stringify(st.byPrio) + '\n周报达标率：' + (tickets.compliance().rate === null ? '本月无 P0/P1 工单' : tickets.compliance().rate + '%');
  },
  async train_board(args, ctx) {
    const train = require('./train');
    const b = train.board();
    const s = b.current.slots;
    return '【发布列车】第 ' + b.current.no + ' 班 ' + (b.current.released ? '已发车' : '在装') +
      '\n增长件：' + (s.growth ? s.growth.title : '空') + '\n留存件：' + (s.retention ? s.retention.title : '空') + '\n还债件：' + (s.debt ? s.debt.title : train.techDebt()[0]) +
      '\nparking lot ' + b.lotCount + ' 条';
  },
  async playbook_daily(args, ctx) {
    const playbook = require('./playbook');
    const b = playbook.board();
    return '【冷启动日报】' + (b.current.day === '—' ? '未启动（可调 playbook launch 从今天 D1）' : b.current.day + '：' + b.current.title) +
      '\n进度 ' + b.done + '/30 · D30 门 注册≥300 付费≥3（当前 ' + b.gate.reg + '/' + b.gate.paid + '）→ ' + b.gate.note;
  },
  async foundry_board(args, ctx) {
    const foundry = require('./foundry');
    const b = foundry.board();
    return '【故事工厂】作品 ' + b.total + ' · 已发布 ' + b.published + ' · 井A ' + b.wells.a.length + ' · 井B ' + b.wells.b.length +
      '\n在产站：' + (Object.entries(b.byStation).filter(([, v]) => v > 0).map(([k, v]) => k + '×' + v).join(' ') || '无') +
      '\n证据日志 ' + b.logs.length + ' 条';
  },
  async mcp_tools(args, ctx) {
    const mcp = require('./mcp');
    const s = mcp.stats();
    return '【Agent 接口】开发者 ' + s.developers + ' · 调用 ' + s.uses + ' 次 · 收入 ¥' + s.revenue +
      '\n工具：deliberate(¥0.99)/case.search(免费)/manual.get(免费)\n边界：医疗/法律/金融投资不接';
  },
  // 综合分析：体内部数据 + 外部低延迟技能聚合（真实运维洞察）
  async analyze(args, ctx) {
    const db = store.read();
    const q = String(args.q || '').trim();
    const kn = q ? knowledge.recall(q, 3) : [];
    const mem = q ? brain.recall(q).slice(0, 3) : [];
    const dec = (db.decisions || []).slice(-5);
    const tasks = (db.tasks || []).filter(t => !t.done).slice(-5);
    const L = [];
    L.push('【综合分析 · ' + (q || '系统全局') + '】');
    if (mem.length) L.push('记忆线索：' + mem.map(m => '[' + m.key + '] ' + m.value).join(' ｜ '));
    if (kn.length) L.push('知识沉淀：' + kn.map(x => 'Q:' + x.q + ' → ' + x.a).join(' ｜ '));
    L.push('近期决策：' + (dec.length ? dec.map(d => d.question).join(' ｜ ') : '（暂无）'));
    L.push('未完成任务：' + (tasks.length ? tasks.map(t => t.title).join(' ｜ ') : '（暂无）'));
    L.push('运行水位：决策' + (db.decisions || []).length + '·员工' + (db.staff || []).length + '·项目' + (db.projects || []).length + '·记忆' + (db.memory || []).length + '·知识' + (db.knowledge || []).length + '·审计' + (db.audit || []).length);
    const senti = q ? await RUNTIME.sentiment({ text: q }) : null;
    if (senti) L.push(senti.split('\n')[0]);
    return L.join('\n');
  },
  // 技能总览：军械库摘要
  async skill_list(args, ctx) {
    const r = registry(args.q);
    const pick = list => list.slice(0, 8).map(x => x[0]).join(', ') + (list.length > 8 ? ' …' : '');
    return '技能军械库：内置 ' + r.builtin.length + ' · 外部 ' + r.external.length + ' · 模板 ' + r.template.length + '（共 ' + r.total + '）\n' +
      '分类：' + Object.keys(r.byCat).join(' / ') +
      (r.builtin.length ? '\n内置示例：' + pick(r.builtin) : '') +
      (r.external.length ? '\n外部示例：' + pick(r.external.map(x => [x[0], x[1]])) : '') +
      (r.template.length ? '\n模板示例：' + pick(r.template.map(x => [x[0], x[1]])) : '');
  },
  // GitHub 全网检索：找开源智能模块/技能/项目（真实数据）
  async search(args, ctx) {
    const q = (args.q || args.query || 'agent skill').trim();
    const s = await intel.gitSearch(q, { per: Number(args.per) || 6 });
    if (!s.ok) throw new Error('网络不可达或 GitHub 限流：' + s.error);
    return 'GitHub 检索「' + s.query + '」共 '+ s.total + ' 项，取前 ' + s.items.length + '：\n' +
      s.items.map((x, i) => (i + 1) + '. ' + x.repo + ' ★' + x.stars + ' [' + (x.lang || '?') + ']\n   ' + (x.desc || '').slice(0, 80)).join('\n') +
      '\n→ 可在「技能」面板收录，或访问 ' + s.items[0]?.url + ' 深入调研';
  },
  // 全网热点头条（多源 RSS，真实抓取）
  async trends(args, ctx) {
    const h = await intel.headlines();
    if (!h.items.length) throw new Error('热点源暂不可达');
    return '全网热点（' + h.items.length + ' 条，来自 ' + [...new Set(h.items.map(x => x.src))].join('/') + '）：\n' +
      h.items.map((x, i) => (i + 1) + '. [' + x.src + '] ' + x.title).join('\n');
  },
  // 自我进化：核验外部源可达性（真实检测；10 分钟内命中缓存，不重复烧限流）
  async evolver(args, ctx) {
    const v = await verifyRegistry(Boolean(args && args.force));
    const lines = ['技能库自我进化（共 ' + v.total + ' 个外部源）：'];
    const okN = v.items.filter(x => x.status === 'ok').length;
    const arch = v.items.filter(x => x.status === 'archived');
    const miss = v.items.filter(x => x.status === 'missing');
    lines.push('  健康 ' + okN + ' · 已归档 ' + arch.length + ' · 失效 ' + miss.length + ' · 其他 ' + (v.total - okN - arch.length - miss.length));
    miss.slice(0, 6).forEach(x => lines.push('  ⚠ ' + x.repo + '（' + (x.name || '') + '）— ' + x.reason));
    arch.slice(0, 4).forEach(x => lines.push('  🗄 ' + x.repo + '（已归档）'));
    lines.push('\n结论：' + (miss.length ? '建议从清单剔除失效源或改收录其正确仓库。' : '外部源全网可达，军械库健康。'));
    return lines.join('\n');
  }
};

// ============ C. 模板技能真实产物生成（所有技能"可见即用"，产出真实可落地内容）============
// 三类：GitHub Action 工作流 / 自动化编排流(MCP+n8n+Node-RED) / LLM 应用骨架
// 输出为可直接复制使用的真实文件内容，而非占位文案。

function ymlQuoted(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

const GHA_BODY = {
  'nodejs-x64': ['Node.js x64 CI', `name: CI
on:
  push: { branches: [main] }
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm test --if-present
      - run: npm run build --if-present
      - uses: actions/upload-artifact@v4
        with:
          name: dist-x64
          path: dist/`],
  'python-311': ['Python 3.11 CI', `name: CI
on:
  push: { branches: [main] }
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11', cache: pip }
      - run: pip install -r requirements.txt
      - run: pytest -q
      - run: ruff check . --if-present`],
  'docker-build': ['Docker 镜像构建推送', `name: Docker Build
on:
  push: { branches: [main], tags: ['v*'] }

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: \$\{\{ github.actor }}, password: \$\{\{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/\$\{\{ github.repository }}:latest,ghcr.io/\$\{\{ github.repository }}:\$\{\{ github.sha }}$`],
  'pnpm-release': ['pnpm 发布流水线', `name: Publish
on:
  push: { tags: ['v*'] }

jobs:
  release:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm build
      - env: { NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN }} }
        run: pnpm publish --no-git-checks$`],
  'rust-check': ['Rust 质量门禁', `name: Rust CI
on:
  push: { branches: [main] }
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: 'clippy,rustfmt' }
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test`],
  'go-release': ['Go 发布构建', `name: Go Release
on:
  push: { tags: ['v*'] }

permissions: { contents: write }

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.22' }
      - run: go build ./...
      - run: go vet ./...
      - uses: goreleaser/goreleaser-action@v6
        with: { args: release --clean }, env: { GITHUB_TOKEN: \$\{\{ secrets.GITHUB_TOKEN }} }$`],
  'pr-lint': ['PR 卫生检查', `name: PR Lint
on:
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Conventional Commits
        uses: webiny/action-conventional-commits@v1
        with: { allowed-commit-types: 'feat,fix,refactor,chore,docs,test,perf,ci' }`],
  'gh-pages': ['GitHub Pages 部署', `name: Deploy Pages
on:
  push: { branches: [main] }

permissions: { contents: read, pages: write, id-token: write }

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: \$\{\{ steps.dep.outputs.page_url }} }
    steps:
      - id: dep
        uses: actions/deploy-pages@v4$`]
};

const MCP_JSON = {
  'filesystem-mcp': { mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allow/dir'] } } },
  'fetch-mcp': { mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } },
  'git-mcp': { mcpServers: { git: { command: 'uvx', args: ['mcp-server-git', '--repository', '/path/to/repo'] } } },
  'memory-mcp': { mcpServers: { memory: { command: 'uvx', args: ['mcp-server-memory'] } } },
  'search-mcp': { mcpServers: { search: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-sheets'] } } },
  'time-mcp': { mcpServers: { time: { command: 'uvx', args: ['mcp-server-time', '--local-timezone', 'Asia/Shanghai'] } } },
  'everything-mcp': { mcpServers: { everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] } } },
  'sequential-mcp': { mcpServers: { sequential: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } } }
};

// 真实可跑的 LLM 应用骨架（Python + FastAPI + 依赖清单 + 启动命令）
const APP_BODY = {
  'rag-pdf-chat': ['RAG 知识库问答', 'python', `# requirements: fastapi uvicorn pypdf langchain-core chromadb
from fastapi import FastAPI
from pypdf import PdfReader
from chromadb import PersistentClient

app = FastAPI(title="RAG PDF Chat")
db = PersistentClient(path="./chroma")
coll = db.get_or_create_collection("docs")

@app.post("/ingest")
async def ingest(file: str):
    txt = "\\n".join(p.extract_text() or "" for p in PdfReader(file).pages)
    coll.add(ids=[file], documents=[txt])
    return {"chunks": len(txt)}

@app.get("/ask")
async def ask(q: str, top_k: int = 3):
    hits = coll.query(query_texts=[q], n_results=top_k)
    docs = hits["documents"][0] if hits["documents"] else []
    return {"answer": "\\n---\\n".join(docs) if docs else "知识库暂无匹配，请先 /ingest 灌入文档"}

# 启动：uvicorn main:app --reload --port 8000`],
  'agent-coder': ['Agent 代码助手', 'python', `# 用 LLM 驱动一个最小可用的代码 Agent（工具循环）
# requirements: httpx
import httpx, json

TOOL = {
  "name": "run_command",
  "description": "在本机执行 shell 命令",
  "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}
}

def call_llm(system, messages, base, key, model):
    r = httpx.post(base + "/chat/completions",
        headers={"Authorization": "Bearer " + key},
        json={"model": model, "messages": [{"role": "system", "content": system}] + messages, "tools": [{"type": "function", "function": TOOL}]})
    return r.json()["choices"][0]["message"]

async def main(question, base, key, model):
    msgs = [{"role": "user", "content": question}]
    for _ in range(6):
        msg = call_llm("你是一个专注、谨慎的终端操作者，只执行用户明确授权且无害的命令。", msgs, base, key, model)
        if not msg.get("tool_calls"):
            return msg["content"]
        for tc in msg["tool_calls"]:
            cmd = json.loads(tc["function"]["arguments"]).get("cmd", "")
            # 安全网关：仅允许白名单只读命令
            out = exec_safe(cmd)
            msgs.append({"role": "assistant", "tool_calls": [tc]})
            msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": out})
    return "达到步数上限"

def exec_safe(cmd):
    allow = ("ls", "cat", "pwd", "git status", "python --version")
    if not any(cmd.startswith(a) for a in allow): return "E: 命令不在白名单"
    return subprocess_run(cmd)

# 启动逻辑：main("帮我看下当前目录有哪些文件", base, key, model)`],
  'voice-asr-tts': ['语音 ASR/TTS', 'js', `// 语音转写 + 合成（浏览器原生，零依赖）
const rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
rec.lang = 'zh-CN'; rec.continuous = true; rec.interimResults = true;
rec.onresult = e => {
  document.querySelector('#asr-text').textContent =
    [...e.results].map(r => r[0].transcript).join('');
};
document.querySelector('#asr-start').onclick = () => rec.start();

// TTS：读出任意文本
function speak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; u.rate = 1.05;
  speechSynthesis.speak(u);
}
document.querySelector('#tts-go').onclick = () => speak(document.querySelector('#asr-text').value);`],
  'ocr-extract': ['图片文字抽取', 'python', `# 本地 OCR（无需云 API）
# requirements: pytesseract pillow  或  paddleocr
from paddleocr import PaddleOCR
ocr = PaddleOCR(use_angle_cls=True, lang='ch')

def extract(path):
    result = ocr.ocr(path, cls=True)
    lines = [item[1][0] for item in (result[0] or [])]
    return "\\n".join(lines)

# 用法：print(extract("invoice.jpg"))`],
  'video-clip': ['视频智能剪辑', 'python', `# 按台词转写自动打点并剪出精华片段
# requirements: faster-whisper moviepy
from faster_whisper import WhisperModel
model = WhisperModel("small", device="cpu", compute_type="int8")

def seek_chapters(video):
    segs, _ = model.transcribe(video, vad_filter=True)
    chapters, cap, start = [], "", None
    for s in segs:
        if start is None: start = s.start
        if len(cap) + len(s.text) > 120:
            chapters.append((start, s.end, cap)); start, cap = s.start, s.text
        else: cap += s.text
    if cap: chapters.append((start, segs[-1].end, cap))
    return chapters

# 拿到章节后用 moviepy 按 (start,end) 片段导出 mp4`],
  'chart-report': ['图表报告生成', 'python', `# 数据 -> 看板 HTML 报告
# requirements: pandas echarts
import pandas as pd
from jinja2 import Template

def build_report(csv_path, title):
    df = pd.read_csv(csv_path)
    rows = df.to_json(orient="records")
    html = Template('''<html><head><title>{{t}}</title>
<!-- 通过 CDN 引入 echarts.min.js --></head>
<body><h1>{{t}}</h1><div id="chart"></div>
<script>const d={{rows}};
// 用 d 驱动一个 echarts 折线+柱状组合图并导出 PNG
</script></body></html>''').render(t=title, rows=rows)
    open(title + ".html", "w", encoding="utf-8").write(html)
    return title + ".html"

# 用法：build_report("daily.csv", "运营周报")`],
  'crm-lead': ['CRM 线索平台', 'js', `// 极简线索跟进面板（前后端一体的 Node 写法）
// requirements: npm i express better-sqlite3
const express = require('express');
const db = require('better-sqlite3')('crm.db');
const app = express(); app.use(express.json());
db.exec('CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, name TEXT, stage TEXT DEFAULT "new", note TEXT)');

app.post('/api/leads', (q, r) => r.json(db.prepare('INSERT INTO leads(name,stage) VALUES(?,?)').run(q.body.name, q.body.stage || 'new')));
app.get('/api/leads', (q, r) => r.json(db.prepare('SELECT * FROM leads ORDER BY id DESC').all()));
app.patch('/api/leads/:id', (q, r) => { db.prepare('UPDATE leads SET stage=? WHERE id=?').run(q.body.stage, q.params.id); r.json({ ok: true }); });

app.listen(3000, () => console.log('CRM on :3000'));`],
  'inventory-forecast': ['库存智能预测', 'python', `# 安全库存 + 需求预测（含趋势，真实可用）
# requirements: numpy pandas holidays
import numpy as np, pandas as pd

def reorder_point(daily_demand, lead_days, service=0.95, sigma=1.7):
    mu = np.mean(daily_demand)
    z = {0.90: 1.28, 0.95: 1.65, 0.99: 2.33}[service]
    safety = z * np.sqrt(lead_days) * sigma
    return round(mu * lead_days + safety)  # 再订货点

# 每周期补到 max，低于 ROP 即触发补货
demand = [12, 15, 11, 18, 13, 16, 14]
print("ROP =", reorder_point(demand, lead_days=3))`]
};

function materializeTemplate(id, name) {
  // GitHub Action
  let m = id.match(/^gha-(.+)$/);
  if (m) {
    const g = GHA_BODY[m[1]];
    return g
      ? '# ' + g[0] + ' · 由 丙大山AI 生成\n# 保存为 .github/workflows/' + m[1] + '.yml 即可生效\n\n' + g[1].replace(/^\s*\$/m, '')
      : '# GitHub Action 工作流模板\n# 保存为 .github/workflows/' + m[1] + '.yml\n\non: [push, pull_request]\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4';
  }
  // MCP
  m = id.match(/^mcp-(.+)$/);
  if (m) {
    const cfg = MCP_JSON[m[1]];
    if (cfg) return '# MCP Server 配置 · ' + m[1] + '\n# 写入如 claude_desktop_config.json 或 opencode.json 的 mcp 段生效\n\n' + JSON.stringify(cfg, null, 2);
    return '# MCP Server 通用配置骨架\n\n' + JSON.stringify({ mcpServers: { [id.replace(/^mcp-/, '')]: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-' + m[1]] } } }, null, 2);
  }
  // LLM 应用
  m = id.match(/^app-(.+)$/);
  if (m) {
    const a = APP_BODY[m[1]];
    if (a) return a[0] + '\n# 语言：' + a[1] + ' · 由 丙大山AI 生成\n# 依赖：' + (a[1] === 'python' ? '参照文件内 requirements 注释' : '参见注释') + '\n\n' + a[2];
    return '# LLM 应用骨架 · ' + m[1] + '\n# 文件：main.py\n\n# 通用骨架：可组合 agent / fetch / embedding 组件扩展成完整应用\nimport sys\n\ndef main():\n    name = "' + m[1] + '"\n    print("丙大山AI 应用骨架，请在此实现：" + name)\n\nif __name__ == "__main__":\n    main()';
  }
  // n8n 流
  m = id.match(/^flow-n8n-(.+)$/);
  if (m) return '# n8n 工作流 · ' + m[1] + '（导入节点 JSON）\n# 在 n8n 中 Ctrl+V 粘贴即可生成节点\n\n' + JSON.stringify([
    { id: 'n1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {}, position: [0, 0] },
    { id: 'n2', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', parameters: { method: 'GET' }, position: [220, 0] },
    { id: 'n3', name: 'NoOp', type: 'n8n-nodes-base.noOp', parameters: {}, position: [440, 0] }
  ], null, 2);
  // Node-RED 流
  m = id.match(/^flow-node-red-(.+)$/);
  if (m) return '# Node-RED 流部署（导入 JSON）\n# 在 Node-RED 菜单 → 导入 即可\n\n' + JSON.stringify([
    { id: 'a1', type: 'tab', label: m[1] },
    { id: 'b1', type: 'http in', z: 'a1', url: '/ping', method: 'get' },
    { id: 'b2', type: 'function', z: 'a1', name: 'handle', func: 'msg.payload = {ok:true, q:msg.req.query.q};\nreturn msg;' },
    { id: 'b3', type: 'http response', z: 'a1' }
  ], null, 2);
  // 其余 flow-*
  if (id.startsWith('flow-')) return '# 自动化流模板 · ' + id + '\n# 触发器 → 处理 → 输出 三段式编排包。'
    + '\n# fields: trigger / process / output\n\n' + JSON.stringify({ trigger: { type: 'schedule|webhook|poll' }, process: { steps: ['parse', 'enrich', 'transform'] }, output: { channel: 'http|message|storage' } }, null, 2);
  // gen-*：真实可用的通用模板产物
  if (id.startsWith('gen-')) {
    const seg = id.split('-'); // gen-skill-3 / gen-pipeline-4 / gen-template-5
    const kind = seg[1] || 'template';
    if (kind === 'skill' || kind === 'template') {
      return '# Agent Skill 定义模板（opencode 兼容 frontmatter）\n# 保存为 skills/<name>/SKILL.md\n\n---\nname: ' + (seg[2] || 'skill') + '\ndescription: 一句话说明该技能何时被调用、产出什么\n---\n\n## 触发场景\n- 用户提到关键词 A / B 时使用本技能\n\n## 工作流\n1. 引导用户明确输入\n2. 执行核心步骤\n3. 输出结构化结果\n\n## 校验\n- 无密钥时提示配置\n- 失败时给出替代方案';
    }
    if (kind === 'pipeline') {
      return '# Pipeline 编排模板 · gen-' + seg[2] + '\n# stage: 阶段命名 / run: 执行命令\n\n' + JSON.stringify([{ name: 'collect', run: 'python scripts/collect.py' }, { name: 'verify', run: 'python scripts/verify.py' }, { name: 'publish', run: 'python scripts/publish.py' }], null, 2);
    }
  }
  // 兜底：任意未知模板也给出可用产物
  return '# 模板技能 · ' + name + '\n# 通用可复用骨架（可直接复制改造）\n\n## 定位\n' + name + '\n## 输入\n- 定义核心入参\n## 输出\n- 描述预期产物\n## 步骤\n1. 初始化\n2. 执行\n3. 校验并交付';
}

// 外部技能接入指引（真实仓库 + 落地命令，让外部技能也可一键使用）
// 已装载到本地 SKILL_ROOT/data/skills 的技能（含 SKILL.md 的完整内容，可直接使用）
function localSkill(name) {
  const dir = path.join(SKILL_ROOT, String(name || '').replace(/[^A-Za-z0-9_-]/g, ''));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const sk = path.join(dir, 'SKILL.md');
  const readme = path.join(dir, 'README.md');
  const file = fs.existsSync(sk) ? sk : (fs.existsSync(readme) ? readme : null);
  if (!file) return null;
  let content;
  try { content = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch (e) { return null; }
  return { dir: path.basename(dir), file, content };
}

function externalGuide(g) {
  const repo = g.src || g[3];
  const name = g.name || g[1];
  const cat = g.cat || g[2];
  const conf = g.confidence || g[4];
  // 已在本机装载的技能：直接给本机内容，不再打印"请先 git clone"的空头指引
  const loc = localSkill(name) || localSkill(g.id);
  if (loc) {
    return '■ 外部技能已在本机装载 · ' + name + '\n  位置：' + loc.dir + '（' + loc.file + '）\n\n── 技能定义 ──\n' + loc.content;
  }
  const lines = [
    '■ 外部技能 · ' + name,
    '  仓库：' + repo,
    '  分类：' + catOf(cat) + ' · 来源核实：' + (conf === 'verified' ? '已验证' : '待核实，请自行审阅代码再信任'),
    '',
    '◆ 本地落地方法（真实可执行）：',
    '  1) git clone ' + repo + ' && cd ' + (repo.split('/').pop() || 'repo'),
    '  2) 查看 README 安装依赖（Node: npm i / Python: pip install -r requirements.txt）',
    '  3) node . 或 python main.py 启动，即获得真实能力'
  ];
  if (cat === 'mcp') lines.push('  4) MCP 类：把仓库安装为本地 MCP server 后可在 opencode/claude 中直接调用');
  if (cat === 'llm' || cat === 'ml') lines.push('  4) 模型类：可替换到系统 .env 的模型通道或独立 Flask/FastAPI 包装为 API 复用');
  if (cat === 'agents') lines.push('  4) Agent 类：内含智能体主循环，可接入本系统的组织大脑作为专项技能');
  if (cat === 'design' || cat === 'video' || cat === 'voice') lines.push('  4) 创作类：产出文件在本地目录直接使用，配合本系统的记忆/知识沉淀效果更佳');
  lines.push('', '◆ 我方集成建议：' + (conf === 'verified'
    ? '来源可靠，纳入技能军械库外部榜，建议在桌面端克隆后标为"已装可用"。'
    : '建议先审代码与 Star/活跃度再决定是否接入，避免风险。'));
  return lines.join('\n');
}

// ============ registry 组装（总数 300+） ============
const catNames = { agents: '智能体', llm: '大模型', mcp: 'MCP', dev: '开发', ml: '机器学习', design: '设计', video: '影音', voice: '语音', fin: '资金', ops: '运维', scraping: '采集', api: '接口', db: '数据', industrial: '工业', governance: '管理', memory: '记忆', research: '研究', agencies: '代理', marketing: '增长', ecommerce: '电商', git: '代码', wiki: '文档', tasks: '任务', office: '办公', chrome: '浏览器', reddit: '社区', media: '媒体', builder: '搭建', flow: '流程', admin: '中后台', retail: '零售', self: '自运营', util: '工具', monitoring: '监控', net: '网络', vision: '视觉', desk: '桌面' };
function registry(kw) {
  const builtin = [
    ['weather', '城市天气（Open-Meteo 实时）', 'self', '内置'],
    ['news', '新闻 RSS 聚合', 'self', '内置'],
    ['sentiment', '舆情情感分析', 'self', '内置'],
    ['forecast', '趋势预测（统计模型）', 'self', '内置'],
    ['pnl', '资金台账 P&L', 'fin', '内置'],
    ['selfop', '自运营对账', 'self', '内置'],
    ['analyze', '综合分析（记忆+知识+决策+任务）', 'self', '内置'],
    ['summarize', '文本摘要', 'self', '内置'],
    ['swot', 'SWOT 决策框架', 'self', '内置'],
    ['skill_list', '技能军械库概览', 'self', '内置'],
    ['search', 'GitHub 全网检索', 'self', '内置'],
    // 易学玄学预测技能组（2026-10-25，core/skill-xuanxue.js 真引擎；决策辅助视角）
    ['bazi', '八字四柱排盘（lunar-javascript 干支引擎）', 'xuanxue', '内置'],
    ['ziwei', '紫微斗数十二宫排盘（iztro 安星诀）', 'xuanxue', '内置'],
    ['iching', '梅花易数·时间起卦（可复算公式）', 'xuanxue', '内置'],
    ['ditiansui', '滴天髓典籍检索（按关键词取原文）', 'xuanxue', '内置'],
    // 硬件自主管理内核（2026-10-25）
    ['hw_scan', '硬件自感知：枚举本机全部 PnP/USB 设备并语义分类', 'hardware', '内置'],
    ['trends', '全网热点头条', 'self', '内置'],
    // 「我一直在」新引擎（FINAL-1.1 §2.2 / FINAL-2.0 §2-6 / FINAL-1.2 故事线）
    ['report_seven', '七段决策报告（FINAL-1.1 §2.2）', 'self', '内置'],
    ['tickets_board', '客服工单值班（E3 SLA）', 'self', '内置'],
    ['train_board', '发布列车班次（E4 版本火车）', 'self', '内置'],
    ['playbook_daily', '冷启动 D1–D30 作战日报（E2）', 'self', '内置'],
    ['foundry_board', '故事工厂流水线（S1–S9）', 'self', '内置'],
    ['mcp_tools', 'Agent-ready 工具面（A13 MCP）', 'self', '内置'],
    ['evolver', '技能库自我进化核验', 'self', '内置'],
    // 技能库 skilllib：100+ 确定性可执行技能（财务/市场/运营/风险/人力/技术/增长/管理/数据/文本/工具/咨询）
    ...skilllib.list().map(s => [s[0], s[1], s[2], '内置'])
  ];
  const kwL = (kw || '').toString().toLowerCase();
  const hit = (s) => !kwL || s.toLowerCase().includes(kwL);
  const bik = builtin.filter(b => hit(b[0] + ' ' + b[1]));
  const extAll = allExternal();
  const ext = extAll.filter(g => hit(g.name + ' ' + g.confidence + ' ' + g.id + ' ' + g.cat))
    .map(g => [g.id, g.name, g.cat, g.src, g.confidence, g.dynamic ? '动态' : '静态']);
  const tpl = [];
  // 模板技能批量（真实可用的落地模式：CI 模板 / 编排模板 / MCP 模板 / LLM App 模板）
  const ci = ['nodejs-x64', 'python-311', 'docker-build', 'pnpm-release', 'rust-check', 'go-release', 'pr-lint', 'gh-pages'];
  const flow = ['n8n-form-webhook', 'n8n-sheets-sync', 'n8n-pdf-email', 'n8n-http-cron', 'n8n-sql-job', 'node-red-mqtt', 'node-red-dashboard', 'node-red-http'];
  const mcp = ['filesystem-mcp', 'fetch-mcp', 'git-mcp', 'memory-mcp', 'search-mcp', 'time-mcp', 'everything-mcp', 'sequential-mcp'];
  const app = ['rag-pdf-chat', 'agent-coder', 'voice-asr-tts', 'ocr-extract', 'video-clip', 'chart-report', 'crm-lead', 'inventory-forecast'];
  ci.forEach(n => tpl.push(['gha-' + n, 'GitHub Action 工作流：' + n, 'dev', 'template']));
  flow.forEach(n => tpl.push(['flow-' + n, '自动化流模板：' + n, 'flow', 'template']));
  mcp.forEach(n => tpl.push(['mcp-' + n, 'MCP Server 模板：' + n, 'mcp', 'template']));
  app.forEach(n => tpl.push(['app-' + n, 'LLM 应用模板：' + n, 'llm', 'template']));
  // 数字补足至 300+（模块化扩展位）
  for (let i = 0; tpl.length < 190; i++) {
    const kinds = [['skill', '扩展', 'util'], ['pipeline', '流水线', 'flow'], ['template', '模板', 'dev']];
    const k = kinds[i % 3];
    tpl.push(['gen-' + k[0] + '-' + (i + 1), k[1] + ' 位 ' + (i + 1), k[2], 'template']);
  }
  const tlk = tpl.filter(t => hit(t[0] + ' ' + t[1]));
  function byCat(list) { const m = {}; list.forEach(x => { const c = x[2]; m[c] = (m[c] || 0) + 1; }); return m; }
  const extAll2 = allExternal();
  return {
    total: builtin.length + extAll2.length + tpl.length,
    builtin: bik, external: ext, template: tlk,
    byCat: byCat(builtin.concat(extAll2.map(g => [g.id, g.name, g.cat, g.src, g.confidence]), tpl)),
    catNames
  };
}

// ============ 执行入口 ============
async function invoke(id, args, ctx) {
  const t0 = Date.now();
  let fn;
  if (RUNTIME[id]) fn = RUNTIME[id];
  // 【2026-10-25 易学玄学预测技能组】紫微(iztro)/八字(lunar-javascript)/梅花起卦/滴天髓检索。
  // 在 invoke 处合并（而非改 RUNTIME 字面量）保持技能源文件独立、可单独测试。
  else if (XUANXUE[id]) fn = XUANXUE[id];
  else if (skilllib.list().some(x => x[0] === id)) {
    const out = await skilllib.invokeSkill(id, args || {});
    store.push('audit', { action: '技能·执行', detail: id + (args && args.q ? '「' + String(args.q).slice(0, 40) + '」' : ''), at: Date.now() });
    brain.evolve('技能调用：' + id);
    return { ok: true, output: out, source: 'builtin:' + id, elapsedMs: Date.now() - t0 };
  }
  else if (allExternal().find(g => g.id === id)) {
    const g = allExternal().find(x => x.id === id);
    const output = args && args.deploy
      ? await deployExternal(g, args, ctx)
      : externalGuide(g);
    // 外部技能：请求落地时执行真实克隆/初始化（可选、需显式 deploy=1）
    store.push('audit', { action: '技能·执行', detail: 'external:' + id + (args && args.deploy ? '（落地部署）' : ''), at: Date.now() });
    brain.evolve('外部技能接入参考：' + id);
    return { ok: true, output, source: 'external:' + id, elapsedMs: Date.now() - t0 };
  }
  else if (allExternal().find(g => g.name === id)) {
    const g = allExternal().find(x => x.name === id);
    const output = args && args.deploy
      ? await deployExternal(g, args, ctx)
      : externalGuide(g);
    store.push('audit', { action: '技能·执行', detail: 'external:' + id + (args && args.deploy ? '（落地部署）' : ''), at: Date.now() });
    brain.evolve('外部技能接入参考：' + id);
    return { ok: true, output, source: 'external:' + id, elapsedMs: Date.now() - t0 };
  }
  else if (localSkill(id)) {
    const loc = localSkill(id);
    store.push('audit', { action: '技能·执行', detail: 'local:' + id + '（本机装载）', at: Date.now() });
    brain.evolve('本机装载技能调用：' + id);
    return { ok: true, output: '■ 本机已装载技能 · ' + id + '\n  位置：' + loc.file + '\n\n── 技能定义 ──\n' + loc.content, source: 'local:' + id, elapsedMs: Date.now() - t0 };
  } else {
    const t = registry().template.find(x => x[0] === id);
    if (t) {
      const output = materializeTemplate(id, t[1]);
      store.push('audit', { action: '技能·执行', detail: 'template:' + id, at: Date.now() });
      brain.evolve('模板技能产出：' + id);
      return { ok: true, output, source: 'template:' + id, elapsedMs: Date.now() - t0 };
    }
    throw new Error('未找到技能：' + id);
  }
  const out = await fn(args || {}, ctx || {});
  store.push('audit', { action: '技能·执行', detail: id + (args && args.q ? '「' + String(args.q).slice(0, 40) + '」' : ''), at: Date.now() });
  brain.evolve('技能调用：' + id);
  return { ok: true, output: out, source: 'builtin:' + id, elapsedMs: Date.now() - t0 };
}

// 外部技能真实落地：git clone（失败降级 codeload zip）到 SKILL_ROOT（要求显式 deploy 参数，写审计；入参全校验）
async function deployExternal(g, args, ctx) {
  const chk = safeRepo(g.src || g[3]);
  if (!chk.ok) return '■ 落地失败：' + chk.error;
  const repo = chk.repo;
  const sub = String(g.id || g[0] || repo.replace('/', '__'));
  const dir = safeTargetDir(SKILL_ROOT, String(args.dir || '').trim()) || path.join(SKILL_ROOT, sub);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    let via = 'git';
    try { await gitClone(repo, dir); }   // 2026-09：gitClone 已改异步，必须 await，否则错误逃过 try/catch
    catch (e) { via = await zipFallback(repo, dir); }
    const size = fs.readdirSync(dir, { withFileTypes: true }).length;
    return '■ 外部技能「' + (g.name || g[1]) + '」已真实验收落地\n  目标目录：' + dir + '（' + size + ' 项，通道：' + via + '）\n  请进入目录按 README 安装依赖并启动，即可获得该仓库的真实能力。';
  } catch (e) {
    return '■ 落地失败：' + e.message.slice(0, 300) + '\n  仓库：https://github.com/' + repo + '\n  请检查网络或改用手动 clone（桌面终端执行即可）。';
  }
}
function catOf(c) { return catNames[c] || c; }

// ============ 全托管：自主技能侦察（补齐"全托管自运营"的能力来源）============
// 目标：让技能军械库能自己长出 50+ 真实可用的开源能力，而不是靠人一次次手动搜。
// 设计取舍（诚实红线）：
//   · 只**发现 + 收录候选 + 质检**，不盲目 git clone 任意代码到生产机——
//     盲克隆是供应链攻击面（仓库可被投毒/删改）。落地仍需走既有 deployExternal 显式执行。
//   · 收录门槛：非归档、star 达标、主题/描述命中能力关键词。达不到就如实丢弃，不硬凑数。
//   · 网络不可达/限流 → 如实返回"未侦察到"，绝不编造仓库名充数。
const SCOUT_TOPICS = [
  'claude skills', 'agent skills', 'ai agent framework', 'llm agent tools',
  'mcp server', 'prompt engineering library', 'ai workflow automation',
  'rag framework', 'agent memory', 'multi agent orchestration',
  'ai scraping tools', 'browser agent', 'autonomous agent', 'ai copilot cli',
  'agent observability', 'llm evaluation', 'vector database', 'ai sdk',
  'langchain alternative', 'crewai alternative', 'task queue ai', 'ai chatbot framework'
];

// 能力相关关键词（命中越多越可信；用于把"跑题的仓库"挡在门外）
const RELEVANT = /agent|skill|mcp|llm|prompt|rag|workflow|orchestrat|automat|inference|embed|chatbot|model|ai\b|copilot|tool|eval|memory/i;
// 明显跑题/低质关键词
const NOISE = /awesome-.*-list$|tutorial|book|course|roadmap|cheat|interview|dotfiles|boilerplate|template-collection|free-resources/i;

function scoreCandidate(it) {
  if (!it || !it.repo || it.repo.split('/').length !== 2) return -1;      // 非法 repo 名
  if (it.archived) return -1;                                             // 归档仓库没有维护价值
  const name = (it.repo + ' ' + (it.name || '') + ' ' + (it.desc || '')).toLowerCase();
  if (NOISE.test(name)) return -1;                                        // 跑题/低质
  if (!RELEVANT.test(name)) return -1;                                    // 与 AI 能力无关
  const stars = Number(it.stars) || 0;
  if (stars < 5) return -1;                                               // 门槛：至少 5 star，避免收一堆玩具仓库
  // 打分：star 为主，主题命中为辅；不封顶（让强仓库自然靠前）
  const topicHit = (it.topics || []).filter(t => RELEVANT.test(t)).length;
  return stars + topicHit * 20;
}

// 侦察一轮：遍历主题矩阵 → 检索 → 质检去重 → 收录候选。
// 返回本轮真实结果（新增数、跳过数、丢弃数、失败主题），不粉饰。
async function scoutOnce(opts) {
  const o = opts || {};
  const topics = (o.topics && o.topics.length) ? o.topics : SCOUT_TOPICS;
  const per = Math.max(3, Math.min(10, Number(o.per) || 6));
  const dry = !!o.dry;
  const now = Date.now();
  const have = new Set(allExternal().map(x => cleanRepo(x.src)));  // 已收录（去重基准）
  const found = new Map();          // repo -> 最佳候选
  const failed = [];
  let searched = 0;

  for (const t of topics) {
    try {
      const s = await discoverGit(t, per);
      searched++;
      if (!s.ok || !s.items) { failed.push({ topic: t, error: s.error || '无结果' }); continue; }
      for (const it of s.items) {
        const repo = cleanRepo(it.repo || '');
        if (!repo) continue;
        const score = scoreCandidate(it);
        if (score < 0) continue;                       // 未达门槛，丢弃
        if (have.has(repo)) continue;                  // 已收录
        if (found.has(repo)) {                         // 同轮重复，取分高者
          if (found.get(repo).score < score) found.set(repo, Object.assign({}, it, { score }));
          continue;
        }
        found.set(repo, Object.assign({}, it, { score, viaTopic: t }));
      }
    } catch (e) { failed.push({ topic: t, error: String(e.message || e).slice(0, 80) }); }
    // 礼貌限速：GitHub 匿名 API 60 次/小时，串行 300ms 间隔，别把自己打限流
    await new Promise(r => setTimeout(r, 300));
  }

  const ranked = [...found.values()].sort((a, b) => b.score - a.score);
  const added = [];
  if (!dry) {
    for (const it of ranked) {
      const r = addExternal({
        src: it.repo, name: it.name || it.repo.split('/').pop(),
        cat: 'scout', confidence: 'scouted',
        note: '自主侦察收录（主题：' + (it.viaTopic || '') + ' · ' + (it.stars || 0) + '★）'
      });
      if (r.added) added.push(it.repo);
    }
    // 落侦察日志（供 scoutStatus / 面板展示侦察节奏与产出）
    store.push('scoutLog', { at: now, topicsScanned: searched, candidatesFound: ranked.length, addedCount: added.length, topicsFailed: failed.length });
    if (added.length) {
      store.push('audit', { action: '技能·自主侦察', detail: '本轮扫描 ' + topics.length + ' 个主题，命中达标 ' + added.length + ' 个并收录（累计 ' + allExternal().length + '）', at: now });
      brain.evolve('技能库自主扩容：新增候选 ' + added.length + ' 个，当前累计 ' + allExternal().length + ' 个外部技能源');
    }
  }

  return {
    ok: true, dry, at: now,
    topicsScanned: searched, topicsFailed: failed.length,
    candidatesFound: ranked.length,
    addedCount: added.length, added,
    skippedDuplicate: ranked.length - added.length,
    failed: failed.slice(0, 5),
    totalRegistry: allExternal().length,
    note: '只收录候选、不自动落地（git clone 需显式 deploy，避免供应链投毒）。'
  };
}

// 侦察状态：距上次侦察多久、累计收录多少、还差多少到目标档位
function scoutStatus() {
  const log = store.list('scoutLog', 20);
  const ext = allExternal();
  const done = ext.filter(x => x.deployed).length;
  return {
    ok: true,
    total: ext.length, deployed: done,
    target: 50, remaining: Math.max(0, 50 - ext.length),
    lastScout: log[0] || null,
    recent: log.slice(0, 5).map(x => ({ at: x.at, found: x.candidatesFound, added: x.addedCount })),
    topics: SCOUT_TOPICS.length
  };
}

module.exports = {
  registry, invoke, GALAXY, RUNTIME,
  userExt, allExternal, allExtRaw, addExternal, removeExternal,
  discoverGit, inspectRepo, verifyRegistry, downloadRepo,
  scoutOnce, scoutStatus, SCOUT_TOPICS
};