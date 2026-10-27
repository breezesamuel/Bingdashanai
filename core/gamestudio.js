// core/gamestudio.js — 游戏开发全流程（自然语言 → 游戏设计 → 可运行代码 → 自测 → 调优 → 成品）
//
// 网络约束下的选型（实测 2026-09）：
//   本机可读 api.github.com，但 git clone / 整包下载被阻断；CDN 小请求通。
//   因此引擎走 **CDN 运行时加载**（Phaser 3 实测 206 可达），不依赖本地 clone。
//
// 流程（五段，对应用户要的"自然语言→脚本→开发→输出→微调→成品"）：
//   ① 策划：自然语言 → 游戏设计文档（玩法/机制/数值/关卡/美术规格）—— LLM
//   ② 脚本：设计 → 引擎代码（Phaser 3 / 纯 Canvas，产出单文件可运行 HTML）—— LLM
//   ③ 开发：代码自检（语法/结构/关键 API 存在性），发现问题就如实报
//   ④ 输出：落盘可运行 HTML（双击即玩），自动挂 CDN 引擎
//   ⑤ 微调：跑一局真实数据 → 依结果调数值（血量/速度/难度），产出 v2
//
// 红线：
//   · 产出的游戏是**真实可运行**的代码，不伪造成品；自测失败如实报告
//   · LLM 生成后必须过语法检查，不合格不落"成品"目录
//   · 数值微调基于真实自测输出，不凭空改

const store = require('./store');
const fs = require('fs');
const path = require('path');

// 【2026-09】asar 内不可写，改走统一可写数据目录
const OUT = store.dataPath('games');
const MAX_JOBS = 40;

// 引擎走 CDN（实测可达），引擎枚举供 LLM 选型
const ENGINES = {
  phaser: {
    id: 'phaser', name: 'Phaser 3', lang: 'JavaScript',
    cdn: 'https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js',
    best: '2D 动作/平台跳跃/物理碰撞，生态最全',
    verified: true
  },
  canvas: {
    id: 'canvas', name: '原生 Canvas', lang: 'JavaScript',
    cdn: null,
    best: '极简小游戏/贪吃蛇/俄罗斯方块，零依赖零加载',
    verified: true
  },
  love2d: {
    id: 'love2d', name: 'LÖVE 2D', lang: 'Lua',
    cdn: null,
    best: '需本机装 LÖVE，跨平台发布佳（本机未装，故不入默认）',
    verified: false
  }
};

// ---------- ① 策划：自然语言 → 设计文档 ----------
const DESIGN_PROMPT = `你是资深游戏策划。把用户的自然语言点子，转成一份**可直接开发的游戏设计文档**（中文），严格按以下结构，不要多余客套：

【一句话】玩法核心一句话
【类型】如 平台跳跃/贪吃蛇/塔防/消除
【核心机制】2-3 条，每条一行
【操作】键盘/鼠标/触屏，具体按键
【关卡/流程】如何开始、如何结束、难度如何递进
【数值】给出**具体数字**（速度/血量/分数/时间限制等，标单位）
【美术】像素风/矢量/纯色块，具体色值
【引擎】phaser 或 canvas，并说明为什么

不要写"待定"，全部给具体值。`;

async function design(idea, opts) {
  const providers = require('./providers');
  const brain = require('./brain');
  const providerId = (opts && opts.provider) || brain.recommendedProvider(providers.list());
  if (!providerId) return { ok: false, error: '无可用模型通道' };
  const les = (() => { try { return require('./lessons').find(idea, 2); } catch (e) { return []; } })();
  const out = await providers.chat({
    provider: providerId,
    messages: [
      { role: 'system', content: DESIGN_PROMPT + (les.length ? '\n\n历史教训（避免重蹈）：\n' + les.map(l => '- ' + l.action).join('\n') : '') },
      { role: 'user', content: '游戏点子：' + idea }
    ],
    temperature: 0.85
  });
  return { ok: true, design: String(out.content || ''), engine: out.engine };
}

function parseDesign(text) {
  const t = String(text || '');
  const field = name => {
    const m = t.match(new RegExp('【' + name + '】([^\\n]*)'));
    return m ? m[1].trim() : '';
  };
  return {
    oneLine: field('一句话'), type: field('类型'),
    mechanics: (t.match(/【核心机制】([\s\S]*?)(?=【|$)/) || [, ''])[1].trim(),
    control: field('操作'), level: (t.match(/【关卡\/流程】([\s\S]*?)(?=【|$)/) || [, ''])[1].trim(),
    values: (t.match(/【数值】([\s\S]*?)(?=【|$)/) || [, ''])[1].trim(),
    art: field('美术'), engine: field('引擎'), raw: t
  };
}

// ---------- ② 脚本：设计 → 可运行代码 ----------
const PHASER_CDN = 'https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js';
function codePrompt(engineId) {
  const engineRules = engineId === 'phaser'
    ? [
      '- 用 Phaser 3，head 里加 <script src="' + PHASER_CDN + '"></script>',
      "- 用 new Phaser.Game({...}) 配置，scene 用普通函数写法，逻辑写实（物理/碰撞/计分/失败/胜利）"
    ].join('\n')
    : [
      '- 不用任何外部库，原生 Canvas + requestAnimationFrame',
      '- 完整实现：输入处理、游戏循环、碰撞检测、计分、失败与重开'
    ].join('\n');
  return [
    '你是游戏开发者。根据设计文档写出一个**完整可运行**的单文件 HTML 游戏。',
    '要求（' + engineId + '）：',
    '- 输出一段 HTML（从 <!DOCTYPE html> 到 </html>），不要任何解释文字',
    engineRules,
    '- 设计文档里的**具体数值**必须体现在代码里（不要写 TODO 或占位符）',
    '- 键盘控制写清楚；中文注释',
    '- 结尾提供一个 window.__gameMeta = { score: 分数, state: playing|over|win } 供自动化自测读取'
  ].join('\n');
}

async function code(designDoc, engineId) {
  const providers = require('./providers');
  const brain = require('./brain');
  const providerId = brain.recommendedProvider(providers.list());
  const out = await providers.chat({
    provider: providerId,
    messages: [
      { role: 'system', content: codePrompt(engineId) },
      { role: 'user', content: '设计文档：\n' + designDoc }
    ],
    temperature: 0.3
  });
  return { ok: true, code: String(out.content || ''), engine: out.engine };
}

// ---------- ③ 开发：代码自检（语法/结构/关键 API）----------
// 诚实红线：这里做**静态**自检（能可靠判定的），不假装跑过游戏。
function lint(code, engineId) {
  const issues = [];
  const c = String(code || '');
  if (!/<!DOCTYPE html/i.test(c)) issues.push('缺少 DOCTYPE');
  if (!/<html/i.test(c) || !/<\/html>/i.test(c)) issues.push('html 结构不完整');
  if (!/<script/i.test(c)) issues.push('没有 script 块');
  if (/TODO|FIXME|待实现|占位/.test(c)) issues.push('含 TODO/占位符，未完成');
  if (engineId === 'phaser') {
    if (!/cdn\.jsdelivr\.net\/npm\/phaser/i.test(c)) issues.push('未引入 Phaser CDN');
    if (!/new\s+Phaser\.Game/.test(c)) issues.push('未创建 Phaser.Game');
  } else {
    if (!/getContext\(/.test(c)) issues.push('没有 canvas.getContext');
    if (!/requestAnimationFrame/.test(c)) issues.push('没有游戏循环');
  }
  // 括号平衡（最常见的语法错误）
  const bal = (a, b) => (c.split(a).length - 1) === (c.split(b).length - 1);
  if (!bal('{', '}')) issues.push('花括号不平衡');
  if (!bal('(', ')')) issues.push('圆括号不平衡');
  return { ok: issues.length === 0, issues, bytes: c.length };
}

// ---------- ④ 输出：落盘可运行成品 ----------
function save(gameId, code, meta) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, gameId + '.html');
  fs.writeFileSync(f, code, 'utf8');
  return { file: f, bytes: fs.statSync(f).size, meta };
}

// ---------- ⑤ 微调：基于自测结果改数值 ----------
// 诚实：需要真实跑一局才有数据。提供"按实测分数调难度"的重生成入口。
async function tune(gameId, feedback) {
  const rec = job(gameId);
  if (!rec) return { ok: false, error: '没有这个游戏：' + gameId };
  const c = codeOf(gameId);
  if (!c) return { ok: false, error: '源码不存在，无法微调' };
  const providers = require('./providers');
  const providerId = require('./brain').recommendedProvider(providers.list());
  if (!providerId) return { ok: false, error: '无可用模型通道' };
  const out = await providers.chat({
    provider: providerId,
    messages: [
      { role: 'system', content: '你是游戏调优师。基于实测反馈修改游戏代码：**只调整数值与难度曲线**（速度/血量/时间/分数阈值），不要改玩法结构与渲染。输出完整 HTML，不要解释。' },
      { role: 'user', content: '实测反馈：' + feedback + '\n\n原代码：\n' + c }
    ],
    temperature: 0.2
  });
  const nc = String(out.content || '');
  const lint2 = lint(nc, rec.engine);
  if (!lint2.ok) return { ok: false, error: '微调后自检未通过：' + lint2.issues.join('; '), issues: lint2.issues };
  const v2 = rec.version + 1;
  const saved = save(gameId + '-v' + v2, nc, Object.assign({}, rec, { version: v2, tunedFrom: gameId, feedback }));
  bumpJob(gameId, { version: v2, tuned: saved.file, feedback });
  return { ok: true, version: v2, file: saved.file, bytes: saved.bytes };
}

function codeOf(gameId) {
  const f = path.join(OUT, gameId + '.html');
  try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
}

// ---------- 台账 ----------
function saveJob(rec) {
  const db = store.read();
  if (!Array.isArray(db.gameJobs)) db.gameJobs = [];
  db.gameJobs.unshift(rec);
  if (db.gameJobs.length > MAX_JOBS) db.gameJobs = db.gameJobs.slice(0, MAX_JOBS);
  store.write(db);
}
function bumpJob(id, patch) {
  const db = store.read();
  const rec = (db.gameJobs || []).find(x => x.id === id);
  if (rec) { Object.assign(rec, patch); store.write(db); }
}
function job(id) { return (store.read().gameJobs || []).find(x => x.id === id); }
function jobs(limit) { return (store.read().gameJobs || []).slice(0, limit || 20); }

// ---------- 主流程 ----------
async function build(idea, opts) {
  const o = opts || {};
  const steps = [];
  // ① 策划
  const d = await design(idea, o);
  if (!d.ok) return { ok: false, error: d.error };
  const parsed = parseDesign(d.design);
  steps.push({ step: 'design', ok: true, engine: parsed.engine, bytes: d.design.length });

  // ② 引擎选择（LLM 说的引擎若不可用，回退 canvas）
  let engineId = /phaser/i.test(parsed.engine) ? 'phaser' : (/canvas/i.test(parsed.engine) ? 'canvas' : 'canvas');
  const eng = ENGINES[engineId];

  // ③ 脚本
  const c = await code(d.design, engineId);
  const src = c.code;
  // ④ 自检
  const lt = lint(src, engineId);
  steps.push({ step: 'code', ok: true, bytes: src.length, engine: engineId });
  steps.push({ step: 'lint', ok: lt.ok, issues: lt.issues });

  const gameId = 'g' + Date.now().toString(36);
  if (!lt.ok) {
    // 不合格就不进"成品"，如实返回问题清单让用户/下一轮修
    const f = path.join(OUT, gameId + '.draft.html');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(f, src, 'utf8');
    saveJob({ id: gameId, idea, at: Date.now(), engine: engineId, version: 0, draft: f, issues: lt.issues, design: parsed });
    return { ok: false, gameId, error: '自检未通过（已存草稿，未进成品）', issues: lt.issues, draft: f, steps };
  }
  const saved = save(gameId, src, { idea, engine: engineId, version: 1 });
  saveJob({ id: gameId, idea, at: Date.now(), engine: engineId, version: 1, file: saved.file, design: parsed });
  steps.push({ step: 'ship', ok: true, file: saved.file, bytes: saved.bytes });

  return {
    ok: true, gameId, engine: engineId, engineName: eng.name,
    file: saved.file, bytes: saved.bytes,
    design: parsed,
    status: '成品已产出（双击 HTML 即玩；已做静态自检）',
    nextStep: '玩一局后把体感/分数告诉我，我用 /v1/game/tune 做数值微调',
    steps
  };
}

module.exports = { ENGINES, design, parseDesign, code, lint, build, tune, jobs, job, codeOf, OUT };
