// core/studio.js — 写作·音视频制作全流程引擎（自然语言 → 专业稿 → 分镜脚本 → 配音 → 成片）
//
// 设计依据（全网调研 2026-09，本机为 i7-5600U 4核/无 GPU 的选型结论）：
//   ① 脚本层：LLM 直接产出（专业写作语言 + 音视频制作语言），零额外依赖、质量最高
//   ② 配音层：edge-tts（rany2/edge-tts）—— 微软 Edge 朗读接口封装，**纯 CPU、零模型、免费**。
//      调研共识：无 GPU 场景它是唯一"运维地板低"的可用方案（Fish-Speech/CosyVoice 音质更强
//      但都要 GPU：Fish 需 8GB+，CosyVoice 需 8GB+；本机跑不动）。生产环境需配重试+降级。
//   ③ 合成层：ffmpeg（图像序列/音频 → mp4）。系统级工具，无需 GPU。
//   ④ 可选增强：GPT-SoVITS / CosyVoice / Fish-Speech（用户日后有 GPU 时接入，本模块预留接口）
//
// 诚实红线：ffmpeg/edge-tts 若未安装或网络不通，如实报告"未生成"，绝不伪造"已产出成片"。
// 每一步的真实产物落盘 data/studio/，可核验。

const store = require('./store');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

// 【2026-09】asar 内不可写，改走统一可写数据目录
const ROOT = store.dataPath('studio');
const MAX_JOBS = 60;

// ---------- 工具探测（不假装有）----------
// 注意：Windows 上 execFile 对 python 的退出码判定不可靠（stderr 为空却报 failed），
// 因此统一用 spawn + 显式读退出码来探测。
function probeCmd(cmd, args, timeoutMs) {
  return new Promise(res => {
    let done = false;
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => { if (!done) { try { p.kill(); } catch (e) {} done = true; res(false); } }, timeoutMs || 8000);
    p.on('error', () => { if (!done) { done = true; clearTimeout(t); res(false); } });
    p.on('close', code => { if (!done) { done = true; clearTimeout(t); res(code === 0); } });
  });
}
// ffmpeg 常见安装位置（不只是 PATH——Windows 上 winget/官网安装常不加 PATH）
const FFMPEG_CANDIDATES = [
  'ffmpeg',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links\\ffmpeg.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'ffmpeg\\bin\\ffmpeg.exe')
];
let ffmpegBin = null;
function ffmpegPath() { return ffmpegBin; }

// 逐个探测候选路径，找到可用的那个并记住（后续合成复用，避免每次重探）
async function findFfmpeg() {
  if (ffmpegBin) return ffmpegBin;
  for (const c of FFMPEG_CANDIDATES) {
    if (await probeCmd(c, ['-version'], 6000)) { ffmpegBin = c; return c; }
  }
  return null;
}
function hasFfmpeg() { return findFfmpeg().then(Boolean); }
function hasEdgeTTS() { return probeCmd('python', ['-c', 'import edge_tts'], 12000); }

// ---------- ① 选题 → 专业写作稿 → 音视频制作语言（三段式）----------
// 这是"自然语言 → 专业写作语言 → 音视频制作语言"的转换核心。
// 用 LLM 一次产出三段式结构化稿件，比让用户分三次问更贴近真实制作流程。
const SCRIPT_PROMPT = `你是资深内容主笔 + 短视频编导。用户给出一个自然语言选题，你要产出可直接进入制作的三段式稿件：

【第一段·专业写作稿】面向知识型读者的深度文章：观点先行、有论据有结构、300-600字，不要空话套话，不要AI腔，不要"在当今这个时代"这类开头。

【第二段·口播脚本】把上面的文章改写成可直接念出来的口播稿：口语、短句、有停顿标记（用逗号断句）、开头3秒必须抓人。150-300字。

【第三段·制作指令】给出拍摄/剪辑/字幕的具体指令，每条一行：
- 画面：具体拍什么
- 字幕：这一句配什么字
- 音效/配乐：在哪个点加什么

严格用如下分隔符，不要有多余解释：
===SCRIPT===
===VO===
===PROD===`;

async function writeScript(topic, opts) {
  const providers = require('./providers');
  const o = opts || {};
  const brain = require('./brain');
  const mem = brain.recall(topic).slice(0, 2);
  const les = (() => { try { return require('./lessons').find(topic, 2); } catch (e) { return []; } })();
  const lang = o.lang || store.getSetting('lang') || 'zh';
  const providerId = o.provider || brain.recommendedProvider(providers.list());

  const sys = [
    SCRIPT_PROMPT,
    les.length ? '已有实战教训（避免重蹈）：\n' + les.map(l => '- ' + l.action).join('\n') : '',
    mem.length ? '相关背景：\n' + mem.map(m => '- ' + String(m.value).slice(0, 80)).join('\n') : ''
  ].filter(Boolean).join('\n');

  const out = await providers.chat({
    provider: providerId,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: '选题：' + topic }],
    temperature: 0.75
  });
  return parseScript(out.content);
}

function parseScript(text) {
  const t = String(text || '');
  const seg = (a, b) => {
    const i = t.indexOf(a);
    if (i < 0) return '';
    const rest = t.slice(i + a.length);
    const j = b ? rest.indexOf(b) : -1;
    return (j >= 0 ? rest.slice(0, j) : rest).trim();
  };
  return {
    article: seg('===SCRIPT===', '===VO==='),
    voice: seg('===VO===', '===PROD==='),
    prod: seg('===PROD===', null) || seg('===PROD==='),
    raw: t
  };
}

// ---------- ② 口播稿 → 配音（edge-tts，零 GPU）----------
// 诚实：未装 edge-tts 或无网络 → 如实返回 unavailable，不伪造音频文件。
async function synthesize(voiceText, opts) {
  const o = opts || {};
  fs.mkdirSync(ROOT, { recursive: true });
  const jobId = o.jobId || ('job-' + Date.now().toString(36));
  const outFile = path.join(ROOT, jobId + '.mp3');
  const voice = o.voice || 'zh-CN-YunxiNeural';   // 男声·清朗
  const rate = o.rate || '+0%';
  const pitch = o.pitch || '+0Hz';

  if (!voiceText) return { ok: false, error: '口播稿为空，无可合成内容' };
  if (!(await hasEdgeTTS())) {
    return {
      ok: false, error: '未检测到 edge-tts（pip install edge-tts）。未生成音频——不伪造产物。',
      installHint: 'pip install edge-tts',
      alternative: '无 GPU 环境下 edge-tts 是零成本可用途径；有 GPU 可换 CosyVoice/Fish-Speech 提升音质'
    };
  }  const py = `import asyncio,edge_tts
async def m():
    c=edge_tts.Communicate(${JSON.stringify(voiceText)}, ${JSON.stringify(voice)}, rate=${JSON.stringify(rate)}, pitch=${JSON.stringify(pitch)})
    await c.save(${JSON.stringify(outFile)})
asyncio.run(m())`;
  return new Promise(res => {
    // 限流是真实存在的：Microsoft 端按 IP 限速，连打只会让每一次都被拒。
    // 【踩坑记录】原本无脑重试 3 次（间隔 2s/4s）。实测表现为：
    //   直连单次调用成功，但经服务器连续 3 次必失败，报 NoAudioReceived；
    //   等 45 秒后单发仍失败——因为这一"单发"内部又是 3 次连打。
    // 也就是说**重试本身在制造限流**。现在改成：长退避 + 冷却窗口 + 冷却期内直接快速失败，
    // 让边缘服务有机会恢复，而不是把它打死。
    const BACKOFF = [3000, 9000, 20000];
    const COOLDOWN_MS = 60000;
    // 最近一次因限流失败的时刻（模块级记忆，跨请求生效）
    if (_ttsBlockedUntil > Date.now()) {
      return res({
        ok: false,
        error: '语音合成正在冷却中（' + Math.ceil((_ttsBlockedUntil - Date.now()) / 1000) + 's 后可重试）。'
          + '原因是上游限流（NoAudioReceived），不是能力缺失。',
        retryAfterSec: Math.ceil((_ttsBlockedUntil - Date.now()) / 1000)
      });
    }
    let tries = 0;
    const attempt = () => {
      execFile('python', ['-c', py], { timeout: 120000, windowsHide: true }, (e, so, se) => {
        if (fs.existsSync(outFile) && fs.statSync(outFile).size > 512) {
          _ttsBlockedUntil = 0;   // 成功即解除冷却
          return res({ ok: true, file: outFile, bytes: fs.statSync(outFile).size, voice, tries: tries + 1 });
        }
        if (tries < BACKOFF.length) return setTimeout(attempt, BACKOFF[tries++]);
        const reason = lastMeaningfulLine(se);
        // NoAudioReceived = 上游限流，值得进冷却；其他错误（如参数错）退避即可
        if (/NoAudioReceived/i.test(reason)) _ttsBlockedUntil = Date.now() + COOLDOWN_MS;
        res({ ok: false, error: 'edge-tts 合成失败：' + reason, retryable: /NoAudioReceived/i.test(reason) });
      });
    };
    attempt();
  });
}

// 语音合成冷却截止时刻（模块级）。见 synthesize() 内注释。
let _ttsBlockedUntil = 0;

// 从 Python 的 stderr 里取出真正有信息量的那一行。
// Python traceback 的形态是：若干行代码回显 + 若干行 ^^^^^^ 指示 + 最后一行 "异常类型: 消息"。
// 前面的行都是噪声，只有最后一行说明"到底为什么失败"。
// 找不到异常行时回退到原始文本（宁可长一点，也不要丢掉唯一线索）。
function lastMeaningfulLine(se) {
  const raw = String(se || '').trim();
  if (!raw) return '(无 stderr 输出)';
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return raw.slice(0, 200);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    // 跳过 traceback 头部与指针行
    if (/^Traceback \(/.test(s)) continue;
    if (/^[~^ ]+$/.test(s)) continue;
    if (/^File "/.test(s)) continue;
    return s.slice(0, 200);
  }
  return lines[lines.length - 1].slice(0, 200);
}

// ---------- ③ 成片合成（ffmpeg，可选）----------
// 把音频 + 画面（可纯色/文字卡片）合成为 mp4。无 GPU，纯 CPU。
// ffmpeg 不是必需依赖：没有它时仍会产出【音频 + SRT 字幕 + 分镜清单】，
// 导入剪映/PR 即可成片——这是剪辑师真实工作流，不是"半成品"。
async function compose(audioFile, opts) {
  const o = opts || {};
  fs.mkdirSync(ROOT, { recursive: true });
  const jobId = o.jobId || 'job';
  const outFile = path.join(ROOT, jobId + '.mp4');
  const title = String(o.title || '').slice(0, 40);
  const bin = await findFfmpeg();
  if (!bin) {
    return { ok: false, error: '未检测到 ffmpeg，无法直接合成 mp4。', installHint: 'https://ffmpeg.org/download.html 下载后把 bin 加入 PATH，或放到 C:\\ffmpeg\\bin' };
  }
  if (!fs.existsSync(audioFile)) return { ok: false, error: '音频不存在，无法合成' };

  // 竖屏 1080x1920 纯色底 + 音频：无 GPU、零字体依赖，任何机器都能出片
  const args = [
    '-f', 'lavfi', '-i', 'color=c=0x1a1a2e:s=1080x1920:r=30',
    '-i', audioFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-pix_fmt', 'yuv420p', outFile
  ];
  return new Promise(res => {
    execFile(bin, args, { timeout: 300000, windowsHide: true }, (e, so, se) => {
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024) {
        return res({ ok: true, file: outFile, bytes: fs.statSync(outFile).size, title });
      }
      res({ ok: false, error: 'ffmpeg 合成失败：' + String(se || (e && e.message) || '').slice(0, 160) });
    });
  });
}

// ---------- ②' SRT 字幕生成（零依赖，剪辑师直接导入）----------
// 按中文朗读速度约 4.5 字/秒切分口播稿，生成标准 SRT。
function makeSRT(voiceText, opts) {
  const o = opts || {};
  const cps = Number(o.cps) || 4.5;          // chars per second
  // 先按句号类强断句，再把过短的碎句合并（字幕不宜过碎，也不宜一条太长）
  const raw = String(voiceText || '').split(/(?<=[。！？!?])/).map(x => x.trim()).filter(Boolean);
  const MIN_CHARS = 6;
  const parts = [];
  raw.forEach(seg => {
    // 一句内再按逗号细分，但保证每条至少 MIN_CHARS 字
    const subs = seg.split(/(?<=[，,；;、])/).map(x => x.trim()).filter(Boolean);
    let buf = '';
    subs.forEach(s => {
      if ((buf + s).length <= MIN_CHARS && buf) buf += s;
      else { if (buf) parts.push(buf); buf = s; }
    });
    if (buf) parts.push(buf);
  });
  if (!parts.length) return null;
  const pad = n => String(n).padStart(2, '0');
  const tc = ms => pad(Math.floor(ms / 3600000)) + ':' + pad(Math.floor(ms / 60000) % 60) + ':' + pad(Math.floor(ms / 1000) % 60) + ',' + pad(ms % 1000);
  const cues = [];
  let t = 0;
  parts.forEach((seg, i) => {
    const dur = Math.max(1200, (seg.trim().length / cps) * 1000);   // 最短 1.2s
    cues.push((i + 1) + '\n' + tc(t) + ' --> ' + tc(t + dur) + '\n' + seg.trim());
    t += dur;
  });
  return cues.join('\n\n') + '\n';
}

// ---------- 主流程：自然语言 → 成片 ----------
async function produce(topic, opts) {
  const o = opts || {};
  const jobId = 'job-' + Date.now().toString(36);
  const steps = [];

  // 1) 写稿
  let sc;
  try { sc = await writeScript(topic, o); }
  catch (e) { return { ok: false, jobId, error: '写稿失败：' + String(e.message || e).slice(0, 160) } };
  steps.push({ step: 'script', ok: true, articleLen: sc.article.length, voiceLen: sc.voice.length, prodLen: sc.prod.length });

  // 稿子先落盘（即使后续音频失败，稿子本身是有价值的产物）
  fs.mkdirSync(ROOT, { recursive: true });
  const scriptFile = path.join(ROOT, jobId + '.script.txt');
  fs.writeFileSync(scriptFile,
    '【选题】' + topic + '\n\n【专业写作稿】\n' + sc.article +
    '\n\n【口播脚本】\n' + sc.voice + '\n\n【制作指令】\n' + sc.prod, 'utf8');

  // 2) 配音
  const voiceText = o.voiceText || sc.voice || sc.article;
  const tts = await synthesize(voiceText, { ...o, jobId });
  steps.push({ step: 'tts', ok: tts.ok, detail: tts.ok ? tts.bytes + ' bytes' : tts.error });

  // 2.5) SRT 字幕（零依赖，剪辑师直接导入剪映/PR）——不依赖 ffmpeg
  let srtFile = null;
  try {
    const srt = makeSRT(voiceText, o);
    if (srt) {
      srtFile = path.join(ROOT, jobId + '.srt');
      fs.writeFileSync(srtFile, srt, 'utf8');
      steps.push({ step: 'srt', ok: true, detail: '字幕已生成（导入剪映即用）' });
    }
  } catch (e) { steps.push({ step: 'srt', ok: false, error: String(e.message || e).slice(0, 80) }); }

  // 3) 成片（可选：没 ffmpeg 也能靠 稿+音频+字幕 在剪辑软件里出片）
  let mp4 = null;
  if (tts.ok) {
    mp4 = await compose(tts.file, { ...o, jobId, title: topic });
    steps.push({ step: 'compose', ok: mp4.ok, detail: mp4.ok ? mp4.bytes + ' bytes' : mp4.error });
  } else {
    steps.push({ step: 'compose', ok: false, skipped: '配音未成功，不合成' });
  }

  // 交付物判定：成片 OR（音频 + 字幕）都算可用交付
  const deliverable = !!(mp4 && mp4.ok) || !!(tts.ok && srtFile);
  const rec = {
    id: jobId, topic, at: Date.now(),
    scriptFile, audioFile: tts.ok ? tts.file : null,
    srtFile, videoFile: mp4 && mp4.ok ? mp4.file : null,
    ok: deliverable,
    script: sc,
    steps
  };
  pushJob(rec);
  return {
    ok: deliverable, jobId,
    scriptFile, audioFile: rec.audioFile, srtFile, videoFile: rec.videoFile,
    status: (mp4 && mp4.ok) ? '成片完成'
      : (deliverable ? '稿+配音+字幕完成（无 ffmpeg，导入剪辑软件即成片）'
      : (tts.ok ? '稿+音频完成，字幕/成片未出' : '仅稿子完成，配音未出')),
    steps
  };
}

function pushJob(rec) {
  const db = store.read();
  if (!Array.isArray(db.studioJobs)) db.studioJobs = [];
  db.studioJobs.unshift({ id: rec.id, topic: rec.topic, at: rec.at, ok: rec.ok, scriptFile: rec.scriptFile, audioFile: rec.audioFile, srtFile: rec.srtFile, videoFile: rec.videoFile });
  if (db.studioJobs.length > MAX_JOBS) db.studioJobs = db.studioJobs.slice(0, MAX_JOBS);
  store.write(db);
}

function jobs(limit) {
  return (store.read().studioJobs || []).slice(0, limit || 20);
}

// 环境自检：如实报告哪些能做、哪些缺
async function capability() {
  const [ff, et] = await Promise.all([hasFfmpeg(), hasEdgeTTS()]);
  return {
    ok: true,
    // 写稿永远可用（只依赖 LLM 通道）
    script: { ok: true, note: '只需模型通道，随时可用' },
    tts: { ok: et, engine: 'edge-tts', note: et ? '已就绪' : '未安装：pip install edge-tts（零 GPU、免费）' },
    srt: { ok: true, note: '零依赖，字幕恒可用（导入剪映/PR 即成片）' },
    compose: { ok: ff, engine: 'ffmpeg', note: ff ? '已就绪，可直接出 mp4' : '未安装（可选）：缺它仍出「稿+配音+字幕」，导入剪辑软件同样成片' },
    upgradePath: {
      有GPU后: 'CosyVoice2（阿里，中文最好，8GB+）/ Fish-Speech S2（情感最强，8GB+）/ GPT-SoVITS（少样本克隆，6GB+）',
      选型依据: 'Fish/CosyVoice 音质显著优于 edge-tts 但需 GPU；edge-tts 是无 GPU 场景唯一低运维成本的可用解'
    }
  };
}

module.exports = { produce, writeScript, synthesize, compose, makeSRT, capability, jobs, hasFfmpeg, hasEdgeTTS };
