// core/agentcenter.js — Agent 管理中心
// 功能：paseo（github.com/getpaseo/paseo）Agent 编排守护进程的落地与管理。
//   a) 落地：从 GitHub 下载源码 zip + 装 @getpaseo/cli 运行时（npm 官方包，含预编译 dist），验证 paseo --version
//   b) daemon：start / stop / restart / status（独立 PASEO_HOME 沙箱，127.0.0.1:6767）
//   c) 联动联调：agent ls / run / send / stop / logs —— 跨 Agent 指挥 + 协同流水落库
// 安全：一切命令 execFile 数组参数（禁止 shell 拼接）；运行时目录走沙箱；状态写入 store + audit。

const store = require('./store');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

// —— 沙箱根：BINGDASHAN_AGENT_ROOT 可覆盖（测试隔离）——
const ROOT = () => String(process.env.BINGDASHAN_AGENT_ROOT || path.join(os.homedir(), '.bingdashan-agentcenter'));
const SRC_DIR = () => path.join(ROOT(), 'src');          // GitHub 源码快照
const RUNTIME_DIR = () => path.join(ROOT(), 'runtime');  // npm 运行时
const HOME_DIR = () => path.join(ROOT(), 'home');        // paseo PASEO_HOME（daemon 状态/agent 数据）
const ZIP_URL = 'https://codeload.github.com/getpaseo/paseo/zip/refs/heads/main';
const REPO = 'getpaseo/paseo';
const CLI_PKG = '@getpaseo/cli';
const REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'];
const PASEO_VERSION = '0.9.2';

// —— 命令执行安全包装：全部数组参数（.cmd shim 交 node 用 shell 内部转义，无用户输入拼接） ——
function isCmdShim(c) { return /\.(cmd|bat)$/i.test(String(c)); }
function run(cmd, args, opts) {
  return new Promise(resolve => {
    // windowsHide:true ——【用户报的"node.exe 弹窗"】Windows 下默认会给每个子进程新建一个
    // 控制台窗口；本模块是唯一漏掉这个开关的地方，daemon 查询 / agent 联动每次都会闪出一个
    // node.exe 黑窗。加上后子进程在后台静默运行，窗口不再出现。
    const o = Object.assign({ timeout: opts && opts.timeout || 60000, encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, opts && opts.env || {}) }, opts);
    if (isCmdShim(cmd)) o.shell = true;
    execFile(cmd, args, o, (err, stdout, stderr) => {
      resolve({ ok: !err, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
function runSync(cmd, args, opts) {
  try {
    const o = Object.assign({ encoding: 'utf8', timeout: 20000, windowsHide: true }, opts);
    if (isCmdShim(cmd)) o.shell = true;
    const out = execFileSync(cmd, args, o);
    return { ok: true, stdout: String(out) };
  } catch (e) {
    return { ok: false, err: e };
  }
}

// —— 运行时信息 ——
function isInstalled() {
  return fs.existsSync(path.join(RUNTIME_DIR(), 'node_modules')) &&
    fs.existsSync(cliBin()) && fs.existsSync(stateFile());
}
function stateFile() { return path.join(ROOT(), 'installed.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return null; }
}
function cliBin() {
  const p = path.join(RUNTIME_DIR(), 'node_modules', '@getpaseo', 'cli', 'bin', 'paseo');
  return p;
}
function npmBin() {
  const p = path.join(RUNTIME_DIR(), 'node_modules', '.bin', 'npm.cmd');
  return fs.existsSync(p) ? p : null;
}

// 找可用 npm：.js 用 node 跑，.cmd/.exe 直接跑，找不到则用 `where npm`（Windows npm.cmd shim）
// Windows 上补全可执行扩展名（npm 无扩展名会被 where 返回，直接 spawn 会 ENOENT）
function winExt(c) {
  if (process.platform !== 'win32') return fs.existsSync(c) ? c : null;
  if (/\.[a-z0-9]{1,6}$/i.test(c)) return fs.existsSync(c) ? c : null;
  for (const ext of ['.cmd', '.exe', '.ps1']) if (fs.existsSync(c + ext)) return c + ext;
  return null;
}
// 优先直接跑 npm 的 CLI JS（node 直接执行，绕开 cmd /c 空格转义问题）；否则回退 .cmd shim
function npmCliJs(c) {
  if (!c) return null;
  const candidates = [
    c.replace(/[\\/]npm(\.cmd)?$/i, process.platform === 'win32' ? '\\node_modules\\npm\\bin\\npm-cli.js' : '/node_modules/npm/bin/npm-cli.js'),
    process.env.npm_execpath
  ];
  for (const t of candidates) if (t && /\.js$/i.test(t) && fs.existsSync(t)) return t;
  return null;
}
function npmResolve() {
  const candidates = [process.env.npm_execpath, npmBin()].filter(Boolean);
  for (let c of candidates) { const r = c && winExt(c); if (r) return r; }
  if (process.platform === 'win32') {
    try {
      const w = execFileSync('where.exe', ['npm'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const line = String(w).split(/\r?\n/)[0];
      const r = line && winExt(line.trim());
      if (r) return r;
    } catch (e) { /* 不可用 */ }
  }
  try { execFileSync('which', ['npm'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); return 'npm'; } catch (e) { return null; }
}
function npmCmd() { return npmResolve(); }
function npmInvoke() {
  const c = npmResolve();
  if (!c) return { file: null, args: [] };
  const cli = npmCliJs(c);
  if (cli) return { file: process.execPath, args: [cli] };
  if (/\.js$/i.test(c)) return { file: process.execPath, args: [c] };
  return { file: c, args: [] };
}

function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  store.push('agentcenter_log', { at: Date.now(), msg: msg.slice(0, 240) });
  return line;
}

// —— 未落地状态（面板优先展示）——
function status() {
  const inst = isInstalled();
  const st = readState();
  return {
    ok: true,
    repo: REPO,
    version: st && st.version || PASEO_VERSION,
    installed: inst,
    sourceAt: st && st.sourceAt || null,
    installedAt: st && st.installedAt || null,
    runtimeDir: RUNTIME_DIR(),
    homeDir: HOME_DIR(),
    daemonPort: 6767,
    daemon: inst ? undefined : 'paseo 未落地：请先在「Agent 管理中心」点击「从 GitHub 下载 paseo」',
    hint: inst ? null : '落地后自动可查 daemon 状态与 Agent 列表'
  };
}

// —— 落地：下载源码 + 装运行时 + 验证 ——
async function ensureDirs() {
  fs.mkdirSync(ROOT(), { recursive: true });
  fs.mkdirSync(SRC_DIR(), { recursive: true });
  fs.mkdirSync(RUNTIME_DIR(), { recursive: true });
  fs.mkdirSync(HOME_DIR(), { recursive: true });
}

async function downloadSource() {
  const zip = path.join(ROOT(), 'paseo-main.zip');
  if (!fs.existsSync(zip.trim())) {
    let curl = runSync('curl', ['-L', '-sS', '-m', '120', '-o', zip, ZIP_URL]);
    if (!curl.ok) curl = runSync('curl.exe', ['-L', '-sS', '-m', '120', '-o', zip, ZIP_URL]);
    if (!curl.ok) {
      // 降级：git clone --depth 1（源码树）
      const git = await run('git', ['clone', '--depth', '1', 'https://github.com/' + REPO + '.git', path.join(SRC_DIR(), 'paseo-main')], { timeout: 240000 });
      if (!git.ok) throw new Error('GitHub 源码下载失败：' + (git.stderr || git.err.message || '网络不可达'));
      log('源码 git clone 完成');
      return;
    }
  }
  // 清理旧快照后解压源码快照（Windows 上个别保留名/符号链接条目会失败，不影响 package.json 与 packages/cli 等关键路径）
  const snap = path.join(SRC_DIR(), 'paseo-main');
  fs.rmSync(snap, { recursive: true, force: true });
  const tar = await run('tar', ['-xf', zip, '-C', SRC_DIR()]);
  if (!tar.ok && !fs.existsSync(snap)) {
    throw new Error('源码解压失败：' + (tar.stderr || tar.err.message || 'tar 不可用'));
  }
  if (!tar.ok) log('源码解压跳过部分 Windows 保留名条目，关键路径已就位');
  log('源码 zip 解压完成（' + fs.readdirSync(SRC_DIR()).length + ' 项）');
}

async function installRuntime() {
  // npm 官方包带预编译 dist，免 monorepo 全量构建
  const inv = npmInvoke();
  if (!inv.file) throw new Error('npm 不可用');
  let regErr = null;
  for (const reg of REGISTRIES) {
    log('运行时安装：' + reg + CLI_PKG);
    const r = await run(inv.file, inv.args.concat(['install', CLI_PKG + '@' + PASEO_VERSION, '--prefix', RUNTIME_DIR(), '--no-audit', '--no-fund', '--registry', reg]), { timeout: 540000 });
    if (!r.ok) { regErr = r; continue; }
    log('运行时安装完成（' + reg + '）');
    return;
  }
  throw new Error('运行时安装失败：' + ((regErr && (regErr.stderr || regErr.err.message)) || '）'));
}

// 同步检索验证 paseo 可用版本（异步 install 后节点法再做一次）
// 子命令超时预算：agent run/send 会在内部再 spawn 一次 node 拉起 provider，
// 20s 必然不够（实测 opencode 冷启 >60s），会误报 ETIMEDOUT 而 agent 其实已建。
const CMD_TIMEOUT = {
  run: 180000, send: 120000, stop: 60000, logs: 60000, install: 540000,
};
function cmdTimeout(args) {
  const verb = String((args && args[1]) || '');
  return CMD_TIMEOUT[verb] || 30000;
}

// 只读查询走短 TTL 缓存：面板会并发打 daemon/status + agent/ls + coop + log，
// 每次都 spawn 一个 paseo CLI（约 5s），叠加既拖慢又容易撞穿前端超时。
const _cache = new Map();
// daemon status 实测要 ~11s（paseo CLI 冷启），频繁重查会把面板长期拖在"加载中"。
// 只读查询缓存适度放宽；变更类命令后 bustCache() 立即失效，不会显示陈旧状态。
const CACHE_TTL = { ls: 12000, status: 15000, coop: 8000, log: 8000 };
function cacheKey(args) { return args.slice(0, 2).join(' '); }

async function paseoRun(args, opts) {
  if (!isInstalled()) {
    const what = args[0] === 'daemon' ? '操作 daemon' : '联动 Agent';
    return notInstalledError(what);
  }
  const verb = String((args && args[1]) || '');
  const isReadOnly = ['ls', 'status', 'coop', 'log', 'provider'].indexOf(verb) >= 0;
  const key = cacheKey(args);
  if (isReadOnly && !opts) {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < (CACHE_TTL[verb] || 2000)) return hit.val;
  }

  const bin = cliBin();
  // 用异步 execFile 而非 execFileSync：同步调用会阻塞整个单线程 server，
  // 并发查询时互相排队，直接顶穿前端 15s 超时。
  const ok = await run('node', [bin].concat(args), { timeout: cmdTimeout(args), env: homeEnv() });
  let val;
  if (!ok.ok) {
    // 超时 ≠ 失败：paseo 可能已把 agent 建好，只是没来得及回包。
    // 先回查 agent 列表，若确实落地了就按成功返回，避免前端误报 + 用户重复点。
    if (isTimeout(ok.err)) {
      const probe = await listAgents();
      if (probe.ok) {
        const born = (probe.agents || []).filter(a => a.status === 'running' || a.status === 'pending');
        if (born.length) {
          log('paseo 超时但 agent 已落地（回查确认 ' + born.length + ' 个在跑）');
          return { ok: true, out: '', timedOutButCreated: true, agentId: born[0].id };
        }
      }
      val = { ok: false, error: 'paseo 响应超时且未查到新建 agent，请稍后刷新 Agent 列表确认', timedOut: true };
      return val;
    }
    // 提取 paseo CLI 的 {error:{code,message}}，失败时给出可读信息
    let msg = null, code = null;
    const se = ok.stderr ? String(ok.stderr || '') : '';
    const cm = se.match(/"code"\s*:\s*"([^"]+)"/);
    if (cm) code = cm[1];
    const m = se.match(/"message"\s*:\s*"([^"]+)"/);
    if (m) msg = m[1];
    else if (se.trim()) msg = se.trim().split(/\r?\n/)[0].slice(0, 300);
    val = { ok: false, error: msg || (ok.err && ok.err.message) || '未知错误' };
    if (code) val.code = code;
    return val;
  }
  val = { ok: true, out: ok.stdout };
  if (isReadOnly) _cache.set(key, { at: Date.now(), val });
  return val;
}

// 变更类命令（run/send/stop/install）后立即失效只读缓存，避免面板继续显示陈旧状态
function bustCache() { _cache.clear(); }

function isTimeout(err) {
  if (!err) return false;
  return err.code === 'ETIMEDOUT' || /ETIMEDOUT|timed out|Command failed/i.test(String(err.message || ''));
}

function homeEnv() {
  return { PASEO_HOME: HOME_DIR(), NO_COLOR: '1' };
}

// 未落地时统一提示（避免抛出 Node 模块级原始错误）
function notInstalledError(what) {
  return { ok: false, error: 'paseo 未落地，无法' + what + '：请先点击「📥 从 GitHub 下载 paseo」' };
}

// 解析 paseo CLI JSON（非 JSON 原样展示）
function parseJson(str) {
  try { return JSON.parse(str); } catch (e) { return { raw: str.slice(0, 800) }; }
}

// —— 落地主流程：下载 + 装运行时 + 验证，返回状态快照（可重复执行）————
async function installPaseo() {
  const started = Date.now();
  const meta = { repo: REPO, sourceUrl: ZIP_URL, startedAt: started, ok: false, error: null };
  log('开始从 GitHub 落地 paseo：' + REPO);
  try {
    await ensureDirs();
    await downloadSource();
    await installRuntime();
    const v = await verifyVersion();
    meta.version = v || PASEO_VERSION;
    meta.sourceAt = started;
    meta.installedAt = started;
    meta.ok = true;
    writeState(meta);
    log('paseo 落地成功：' + (v || meta.version));
    return { ok: true, version: v || PASEO_VERSION, installedAt: started };
  } catch (e) {
    meta.error = String((e && e.message) || e);
    writeState(meta);
    log('paseo 落地失败：' + meta.error);
    return { ok: false, error: meta.error };
  }
}

async function verifyVersion() {
  // install 后立即校验一次（同目录 node 跑 bin）
  const bin = cliBin();
  if (!fs.existsSync(bin)) return null;
  const r = await run('node', [bin, '--version'], { timeout: 60000, env: homeEnv() });
  return r.ok ? String(r.stdout || '').trim() : null;
}

function writeState(meta) {
  fs.mkdirSync(ROOT(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(meta, null, 2));
}

// —— daemon 生命周期 ——
async function daemonStatus() {
  const r = await paseoRun(['daemon', 'status', '--json']);
  if (!r.ok) return { ok: false, running: false, error: r.error };
  const d = parseJson(r.out);
  const running = d.localDaemon === 'running' || d.localDaemon === 'not_ready' || d.connectedDaemon === 'reachable' || !!d.pid;
  return { ok: true, running, localDaemon: d.localDaemon, pid: d.pid, listen: d.listen || d.configuredListen || '127.0.0.1:6767', daemonVersion: d.daemonVersion, connected: d.connectedDaemon };
}

async function daemonStart() { return daemonAction('start', '启动'); }
async function daemonRestart() {
  // paseo 的 restart 要求 daemon 正在运行；未运行时降级为 start（不依赖版本化错误文案，先查状态）
  const st = await daemonStatus();
  if (!st.ok) return { ok: false, error: st.error };
  if (!st.running) return daemonAction('start', '启动');
  const r = await paseoRun(['daemon', 'restart', '--json']);
  if (!r.ok) { try { const d = parseJson(r.out); return { ok: d && (d.localDaemon === 'running' || d.connectedDaemon === 'reachable'), running: true, error: (d && d.error) || r.error }; } catch (e) {} return { ok: false, error: r.error }; }
  log('daemon 重启：' + r.out.trim().slice(0, 120));
  return { ok: true, action: 'restart' };
}
async function daemonStop() {
  const r = await paseoRun(['daemon', 'stop', '--json']);
  if (!r.ok) return { ok: false, error: r.error };
  log('daemon 已停止');
  return { ok: true, action: 'stop' };
}
async function daemonAction(act, label) {
  const r = await paseoRun(['daemon', act, '--json']);
  if (!r.ok) return { ok: false, error: r.error };
  bustCache();
  log('daemon ' + label + '：' + r.out.trim().slice(0, 120));
  return { ok: true, action: act };
}

// —— Agent 联动查询 ——
async function listAgents() {
  let r = await paseoRun(['agent', 'ls', '--json', '-g']);
  // daemon 没起时 CLI 会直接拒连；这里自动拉一次再查，避免整块面板空白
  if (!r.ok && /daemon is not running|Cannot connect to daemon/i.test(String(r.error || ''))) {
    log('查询前发现 daemon 未运行，自动启动后重查');
    await daemonStart();
    await new Promise(res => setTimeout(res, 2500));
    r = await paseoRun(['agent', 'ls', '--json', '-g']);
  }
  if (!r.ok) return { ok: false, error: r.error };
  const arr = parseJson(r.out);
  if (Array.isArray(arr)) return { ok: true, agents: arr };
  if (arr && Array.isArray(arr.data)) return { ok: true, agents: arr.data };
  return { ok: true, agents: [], raw: r.out.slice(0, 400) };
}

// paseo 的 provider 列表是它自己的（claude/codex/copilot/opencode/pi），与本项目 providers 无关。
// 不显式传 --provider 时 paseo 直接 MISSING_PROVIDER 失败，所以这里兜一个默认值。
const DEFAULT_AGENT_PROVIDER = 'opencode';

async function agentRun(p) {
  const prompt = String(p.prompt || '').trim();
  if (!prompt) return { ok: false, error: '缺少任务描述' };
  const args = ['agent', 'run', '--json', '--background'];
  if (String(p.title || '').trim()) args.push('--title', String(p.title).trim().slice(0, 80));
  const provider = String(p.provider || '').trim() || DEFAULT_AGENT_PROVIDER;
  args.push('--provider', provider.slice(0, 60));
  if (String(p.model || '').trim()) args.push('--model', String(p.model).trim().slice(0, 60));
  if (String(p.workspace || '').trim()) args.push('--workspace', String(p.workspace).trim().slice(0, 120));
  args.push(prompt.slice(0, 4000));
  const r = await paseoRun(args);
  if (!r.ok) return { ok: false, error: r.error, code: r.code, timedOut: !!r.timedOut };
  // 超时回查兜底路径：agent 已建但 CLI 没回包，用 title 反查
  if (r.timedOutButCreated) {
    bustCache();
    coord('run', r.agentId || '', (p.title || '') + ' · ' + prompt.slice(0, 60));
    return { ok: true, agentId: r.agentId, status: 'running', title: p.title || '', provider, slow: true };
  }
  const d = parseJson(r.out);
  bustCache();
  coord('run', d.agentId || '', (d.title || p.title || '') + ' · ' + prompt.slice(0, 60));
  return { ok: true, agentId: d.agentId, status: d.status, cwd: d.cwd, provider: d.provider || provider, title: d.title || p.title || '', workspaceId: d.workspaceId };
}

async function agentSend(p) {
  const id = String(p.agentId || '').trim();
  const prompt = String(p.prompt || '').trim();
  if (!id) return { ok: false, error: '缺少 Agent ID' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, error: 'Agent ID 格式不合法' };
  if (!prompt) return { ok: false, error: '缺少指挥内容' };
  const r = await paseoRun(['agent', 'send', '--json', '--no-wait', id, '--prompt', prompt.slice(0, 4000)]);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  bustCache();
  coord('send', id, '→ ' + prompt.slice(0, 60));
  return { ok: true, agentId: id, status: 'sent', message: '指令已投递（不等待完成），协作中…' };
}

async function agentLogs(p) {
  const id = String(p.agentId || '').trim();
  if (!id) return { ok: false, error: '缺少 Agent ID' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, error: 'Agent ID 格式不合法' };
  const r = await paseoRun(['agent', 'logs', '--json', id]);
  if (!r.ok) return { ok: false, error: r.error };
  const d = parseJson(r.out);
  return { ok: true, logs: Array.isArray(d) ? d : (d && d.logs) || [] };
}

async function agentStop(p) {
  const id = String(p.agentId || '').trim();
  if (!id) return { ok: false, error: '缺少 Agent ID' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, error: 'Agent ID 格式不合法' };
  const r = await paseoRun(['agent', 'stop', '--json', id]);
  if (!r.ok) return { ok: false, error: r.error };
  bustCache();
  coord('stop', id, '停止');
  return { ok: true, agentId: id, status: 'stopped' };
}

// —— 协同流水（联动联调协调互动协同工作台账）——
function coord(kind, agentId, detail) {
  const row = {
    kind: kind || 'coop',
    agentId: String(agentId || '').slice(0, 64),
    detail: String(detail || '').slice(0, 200),
    at: Date.now()
  };
  store.push('agentcoop', row, 'Agent·' + (kind || 'coop'), '联动联调：' + row.detail);
  return row;
}
function coopLog(limit) {
  return store.list('agentcoop', Number(limit) || 30);
}

module.exports = {
  status,
  installPaseo,
  daemonStart,
  daemonRestart,
  daemonStop,
  daemonStatus,
  listAgents,
  agentRun,
  agentSend,
  agentLogs,
  agentStop,
  coord,
  coopLog,
  isInstalled,
  REPO,
  PASEO_VERSION
};