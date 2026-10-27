// core/paperclip.js — Paperclip（paperclipai/paperclip，MIT）外挂连接器
//
// 【定位】Paperclip 是独立的 Node 服务 + React UI（默认 :3100，自带内置 PostgreSQL，
// 要求 Node >= 24.11），负责「多 AI 角色组织架构 / 派任务 / 审批 / 预算」。
// 它不是库，整仓 330MB，不能也不该并进 BingDashan 的 Electron 包，所以：
//   · 安装在 tools/paperclip（隔离目录，不进 electron-builder 白名单，不注册系统服务）；
//   · 数据固定在 tools/paperclip/data（--data-dir），不碰用户的 ~/.paperclip；
//   · 本模块只做两件事：①如实探测它装没装、跑没跑；②把 BingDashan 的核心目标 +
//     未完成任务翻译成一份「交接单」（可复制的 paperclipai 命令），由人确认后执行。
//
// 【诚实红线】
//   · 不替用户启动服务、不自动创建公司/智能体/任务——那会花模型费用（需 agent 运行时凭证），
//     属于要人确认的动作；这里只给出命令。
//   · 探测不到就报 running:false，绝不假装"已联通"。
//   · 交接单里的 <COMPANY_ID> 必须由人填：我们不猜 Paperclip 里的 ID。

const fs = require('fs');
const path = require('path');
const http = require('http');
const store = require('./store');

const ROOT = path.resolve(__dirname, '..', 'tools', 'paperclip');
const BIN = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'paperclipai.cmd' : 'paperclipai');
const PKG = path.join(ROOT, 'node_modules', 'paperclipai', 'package.json');
const DATA_DIR = path.join(ROOT, 'data');

function apiBase() {
  const raw = String(process.env.PAPERCLIP_API_BASE || store.getSetting('paperclipApiBase') || 'http://127.0.0.1:3100').trim();
  return raw.replace(/\/+$/, '');
}

function installedVersion() {
  try { return JSON.parse(fs.readFileSync(PKG, 'utf8')).version || null; } catch (e) { return null; }
}

// 只判断「有没有服务在应答」：任何 HTTP 状态码都算可达（鉴权模式下根路径可能 401/302），
// 连接被拒/超时才算没跑。
function probe(base, timeoutMs) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(base); } catch (e) { return resolve({ running: false, error: 'bad-url' }); }
    if (u.protocol !== 'http:') return resolve({ running: false, error: 'only-http-supported' });
    const req = http.request({ host: u.hostname, port: u.port || 80, path: '/', method: 'GET', timeout: timeoutMs || 2000 }, res => {
      res.resume();
      resolve({ running: true, httpStatus: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ running: false, error: 'timeout' }); });
    req.on('error', e => resolve({ running: false, error: e.code || e.message }));
    req.end();
  });
}

function nodeOk() {
  const m = /^v(\d+)\.(\d+)/.exec(process.version) || [];
  const major = Number(m[1]) || 0, minor = Number(m[2]) || 0;
  return { version: process.version, ok: major > 24 || (major === 24 && minor >= 11), need: '>=24.11' };
}

function launchCommand() {
  const rel = path.relative(process.cwd(), BIN) || BIN;
  return '"' + rel + '" run --data-dir "' + path.relative(process.cwd(), DATA_DIR) + '"';
}

async function status() {
  const version = installedVersion();
  const installed = !!version && fs.existsSync(BIN);
  const base = apiBase();
  const p = await probe(base);
  const node = nodeOk();
  let hint;
  if (!installed) hint = '未安装：npm install paperclipai --prefix tools/paperclip（发行包不含此目录，属开发机外挂）';
  else if (!node.ok) hint = '本机 Node ' + node.version + ' 低于 Paperclip 要求 ' + node.need;
  else if (!p.running) hint = '已安装但未运行。需要时手动启动：' + launchCommand() + '（首次需按向导配置 agent 运行时凭证，会产生模型费用）';
  else hint = '运行中：' + base + '（可按交接单在其中建立公司/目标/任务）';
  return {
    ok: true, installed, version, binPath: installed ? BIN : null, dataDir: DATA_DIR,
    node, apiBase: base, running: p.running, httpStatus: p.httpStatus || null, probeError: p.error || null,
    license: 'MIT', source: 'https://github.com/paperclipai/paperclip',
    launchCommand: launchCommand(), hint
  };
}

// 命令行参数里的文本：去掉会破坏 PowerShell/cmd 引号的字符，并限长
function q(s, max) {
  const t = String(s == null ? '' : s).replace(/["`$\r\n\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 120);
  return '"' + t + '"';
}

// 交接单：把核心目标 + 未完成任务翻译成 paperclipai 命令。只生成，不执行。
function handoff(opt) {
  const limit = Math.max(1, Math.min(30, Number(opt && opt.limit) || 10));
  let goal = null;
  try {
    const GP = require('./goals');
    const pc = GP.pace();
    if (pc && pc.ok) {
      goal = {
        title: pc.title, target: pc.target, unit: pc.unit, period: pc.period,
        pct: pc.pct, remain: pc.remain, daysLeft: pc.daysLeft, status: pc.status || null,
        dailyNeed: pc.dailyNeed === undefined ? null : pc.dailyNeed
      };
    }
  } catch (e) {}
  const tasks = (store.list('tasks', 999) || [])
    .filter(t => t && !t.done && t.title)
    .slice(0, limit)
    .map(t => ({ id: t.id || null, title: String(t.title), due: t.due || null, owner: t.owner || t.assignee || null, ref: t.ref || null }));

  const cid = '<COMPANY_ID>';
  const commands = [];
  commands.push({ step: 1, why: '创建公司（已有则跳过，改用 `paperclipai company list` 取 ID）', cmd: 'paperclipai company create --name ' + q('BingDashan 运营公司') });
  if (goal) {
    const desc = '目标 ' + goal.target + ' ' + goal.unit + '，周期 ' + goal.period + '，已完成 ' + goal.pct + '%，剩 ' + goal.daysLeft + ' 天'
      + (goal.dailyNeed ? '，每日需新增 ' + Math.round(goal.dailyNeed) + ' ' + goal.unit : '');
    commands.push({ step: 2, why: '把 BingDashan 核心目标建为 Paperclip 目标（拿到 goalId 后填入下方任务）', cmd: 'paperclipai goal create -C ' + cid + ' --title ' + q(goal.title) + ' --description ' + q(desc, 300) });
  }
  tasks.forEach((t, i) => {
    commands.push({
      step: commands.length + 1,
      why: '任务「' + t.title.slice(0, 30) + '」交给 Paperclip 派发/审批（--assignee-agent-id 在智能体建好后补）',
      cmd: 'paperclipai issue create -C ' + cid + ' --title ' + q(t.title) + (t.due ? ' --description ' + q('期限：' + t.due + (t.ref ? '；来源：' + t.ref : '')) : '') + (goal ? ' --goal-id <GOAL_ID>' : '')
    });
  });
  return {
    ok: true, goal, taskCount: tasks.length, commands,
    placeholders: ['<COMPANY_ID>'].concat(goal ? ['<GOAL_ID>'] : []),
    note: '只生成命令，不会自动执行；占位符须由人从 Paperclip 返回值中填写。真正执行智能体需要在 Paperclip 里配置运行时凭证（产生模型费用），不在本系统代办范围。'
  };
}

module.exports = { status, handoff, probe, apiBase, launchCommand, nodeOk, BIN, DATA_DIR };
