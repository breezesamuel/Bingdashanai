// goal-e2e-runner.js — 回归跑在隔离实例上，绝不碰生产 db
// 用法: node goal-e2e-runner.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = 'C:/Users/Think/project/BingDashan';
// 【端口必须动态取】原来硬编码 3729。端口被占时子进程 spawn 不报错，
// 整套 E2E 会打到一个残留的旧实例上（或整轮卡死），而且症状是"跑到一半
// 静默消失、stderr 全空"，极难定位。改成优先 3729，被占就另取。
// 安全性不受影响：_guard.js 只拒绝生产端口 3721/3722，动态端口天然安全。
const DEFAULT_PORT = 3729;
let TEST_PORT = DEFAULT_PORT;
let BASE = '';
const E2E = path.join(os.tmpdir(), 'opencode', 'e2e-sandbox-' + Date.now());
fs.mkdirSync(E2E, { recursive: true });

function waitUp(port, path, ms) {
  const t0 = Date.now();
  return new Promise(res => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path }, r => { r.resume(); res(true); })
        .on('error', () => { if (Date.now() - t0 > ms) res(false); else setTimeout(tick, 400); });
    };
    tick();
  });
}

function setupFixture(dataDir) {
  process.env.BINGDASHAN_DATA_DIR = dataDir;
  const s = require(ROOT + '/core/store');
  const old = s.read();
  // 前置素材：1 条已批准 T1 灯角（foundry 井A）+ 1 条公版手册授权（井B）
  if (!(old.parkinglot || []).some(x => x.title === '沙箱测试素材')) {
    const peer = s.push('peers', {
      kind: 'T1', gua: 'S01', approved: true, hidden: false, grantTier: 'G3',
      text: '沙箱测试经历：被裁后重新起步，走过一年回到轨道，现在更好。',
      fear: '怕重蹈覆辙', step: '先稳住现金流再图发展', say: '别急着下结论',
      authorHash: 'u_fixture', viewCount: 0, helpedCount: 0,
      optin: { publish: true, share: true }
    }, '沙箱夹具·T1灯角', 'foundry 井A 前置');
    const gr = s.push('peers', {
      kind: 'T1', gua: 'S12', text: '沙箱测试素材：从零起步做小生意，先跑通再放大。',
      fear: '怕失败', step: '小步试错', say: '先做再说', approved: true, hidden: false
    }, '沙箱夹具·T1灯角2', 'foundry 井A 备用');
    s.push('foundryGrant', { manualNo: '1', tier: 'G3', at: Date.now() }, '沙箱夹具·公版素材授权', 'foundry 井B');
    // 1 条报告（verify 页面断言用）
    s.push('reports', { kind: 'seven', topic: '沙箱夹具报告-被裁后重新起步', answer: '稳定现金流', lights: 0, crisis: false }, '沙箱夹具·报告', 'verify 页面');
  }
  delete process.env.BINGDASHAN_DATA_DIR;
  console.log('[runner] 沙箱前置素材已注入 (peer=' + (s.list('peers') || []).length + ' grant=' + (s.read().foundryGrant || []).length + ')');
}

// 沙箱管理令牌：资金类接口（/v1/subs/confirm、/v1/pay/query、/v1/pay/alipay/check、
// /v1/subs/rotate-admin-token）走 adminAuthedStrict，**回环也强制**带令牌。
// 这不是 bug，是"本机≠可信"的安全设计（浏览器里一个恶意网页就能打这些接口）。
// 所以套件必须拿到沙箱令牌才能跑通——此前 runner 根本没注入 BINGDASHAN_ADMIN_TOKEN，
// 导致 sec-e2e 在 confirm 处抛错、pay-e2e 6 条红。
// 【为什么要每个套件重读】sec-e2e part5 会轮换令牌；用启动时那份旧值，
// 后面 12 个套件全会莫名 403。core/store.getSetting 每次 readFileSync 磁盘，读的是最新值。
function sandboxAdminToken() {
  process.env.BINGDASHAN_DATA_DIR = E2E;   // 必须在首次 require store 之前设好（DB_PATH 在模块加载时绑定）
  const st = require(ROOT + '/core/store');
  delete process.env.BINGDASHAN_DATA_DIR;
  let t = st.getSetting('adminToken');
  if (!t) {
    // 预置：让第一个套件就有令牌可用，不必等某次 strict 调用惰性生成
    t = require('crypto').randomBytes(18).toString('base64url');
    st.setSetting('adminToken', t);
  }
  return t;
}

// 逐套件超时上限（毫秒）。
// 【为什么不能再全局一刀切 180s】core/autopilot.js 的单轮 ROUND_TIMEOUT = MAX_TICK(6)
// × STEP_TIMEOUT(45s) + 30s = 300s，autopilot-e2e 自己也把兜底设成 900s。
// runner 原来的 180s 反而比「产品单轮预算」和「套件自述预算」都短，
// 于是 autopilot 必然被杀——它不是坏了，是 runner 提前砍断了它。
// 只给真正慢的套件放宽上限，其余仍用 180s 快速失败（套件挂了要立刻看到，而不是干等 10 分钟）。
const SUITE_TIMEOUTS = { autopilot: 600000, autoloop: 600000 };
const DEFAULT_SUITE_TIMEOUT = 180000;

function runScript(file, env, timeoutMs) {
  return new Promise(res => {
    const p = spawn(process.execPath, [file], { cwd: ROOT, env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    // 单套件超时：以前一个套件挂死就整轮无限等，外部一掐断就是
    // "日志停在第 4 个、stderr 全空"，完全看不出是超时还是被中断。
    // 超时后明确杀掉并回报，让它变成一条可诊断的 FAIL 而不是沉默。
    // 上限由调用方按套件给定（慢套件放宽），这里只负责把上限说清楚。
    const cap = timeoutMs || DEFAULT_SUITE_TIMEOUT;
    const timer = setTimeout(() => {
      if (done) return;
      try { p.kill(); } catch (e) {}
      res({ code: 'TIMEOUT', out, err: err + '\n[runner] 单套件超时（>' + Math.round(cap / 1000) + 's），已终止 ' + file });
    }, cap);
    p.on('close', code => { done = true; clearTimeout(timer); res({ code, out, err }); });
  });
}

(async () => {
  TEST_PORT = await require('../../../scripts/_port').freePort(DEFAULT_PORT);
  BASE = 'http://127.0.0.1:' + TEST_PORT;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { BINGDASHAN_PORT: String(TEST_PORT), BINGDASHAN_HOST: '127.0.0.1', BINGDASHAN_DATA_DIR: E2E }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvErr = '';
  child.stderr.on('data', d => srvErr += d);
  const up = await waitUp(TEST_PORT, '/v1/status', 30000);
  if (!up) { console.error('测试实例未就绪'); child.kill(); process.exit(1); }
  console.log('[runner] 隔离实例就绪 ' + BASE + ' (data=' + E2E + ')');

  const baseEnv = { BINGDASHAN_E2E_BASE: BASE, BINGDASHAN_E2E_DATA_DIR: E2E, BINGDASHAN_DATA_DIR: E2E };

  const HERE = __dirname;
const suites = [
  ['war', path.join(HERE, 'war-e2e.js')],
  ['new', path.join(HERE, 'new-e2e.js')],
  ['biz', path.join(HERE, 'biz-e2e.js')],
  ['sec', path.join(HERE, 'sec-e2e.js')],
  ['autopilot', path.join(HERE, 'autopilot-e2e.js')],
  ['autoloop', path.join(HERE, 'autoloop-e2e.js')],
  ['leadfunnel', path.join(HERE, 'leadfunnel-e2e.js')],
  ['money', path.join(HERE, 'money-e2e.js')],
  ['fee', path.join(HERE, 'fee-e2e.js')],
  ['outreach', path.join(HERE, 'outreach-e2e.js')],
  ['fulfillment', path.join(HERE, 'fulfillment-e2e.js')],
  ['materials', path.join(HERE, 'materials-e2e.js')],
  ['crawler', path.join(HERE, 'crawler-e2e.js')],
  ['deepen', path.join(HERE, 'deepen-e2e.js')],
  ['notifyverify', path.join(HERE, 'notify-verify-test.js')],
  ['pay', path.join(HERE, 'pay-e2e.js')],
  ['pay-fund-safety', path.join(HERE, 'pay-fund-safety-e2e.js')],
  ['refund', path.join(HERE, 'refund-e2e.js')],
  ['adoption', path.join(HERE, 'adoption-e2e.js')],
  ['harness', path.join(HERE, 'harness-e2e.js')],
  ['ssrf', path.join(HERE, 'ssrf-e2e.js')],
  ['honesty', path.join(HERE, 'honesty-e2e.js')],
  ['deliberation', path.join(HERE, 'deliberation-e2e.js')],
  ['settle', path.join(HERE, 'settle-e2e.js')],
  ['checkout', path.join(HERE, 'checkout-e2e.js')],
  ['mcp-protocol', path.join(HERE, 'mcp-protocol-e2e.js')],
  ['mcp-client', path.join(HERE, 'mcp-client-e2e.js')],
  ['crm', path.join(HERE, 'crm-e2e.js')],
  ['delivery-spec', path.join(HERE, 'delivery-spec-e2e.js')],
  ['tenancy', path.join(HERE, 'tenancy-e2e.js')],
  ['license', path.join(HERE, 'license-e2e.js')],
  ['download', path.join(HERE, 'download-e2e.js')],
  ['lightning', path.join(HERE, 'lightning-e2e.js')],
  ['wled', path.join(HERE, 'wled-e2e.js')],
  ['orca-ws', path.join(HERE, 'orca-ws-e2e.js')]
];
  // 只跑指定套件：BINGDASHAN_E2E_ONLY=license,biz
  // 【为什么留着】全轮 ~4 分钟（autopilot/autoloop 各 10 分钟上限），
  // 只改了一个新套件却要等整轮，排查时根本没法快速迭代。沙箱与令牌逻辑完全复用，
  // 过滤只影响"跑哪些"，不影响"怎么跑"——生产安全闸门（_guard）依旧生效。
  const only = (process.env.BINGDASHAN_E2E_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
  const runList = only.length ? suites.filter(([n]) => only.includes(n)) : suites;
  if (only.length && !runList.length) { console.error('[runner] BINGDASHAN_E2E_ONLY 未匹配任何套件: ' + only.join(',')); child.kill(); process.exit(1); }
  if (only.length) console.log('[runner] 只跑: ' + runList.map(s => s[0]).join(', '));

  let failed = [];
  for (const [name, file] of runList) {
    if (name === 'new') setupFixture(E2E);
    const t0 = Date.now();
    // 每个套件重读令牌（sec-e2e 会轮换）
    const env = Object.assign({}, baseEnv, { BINGDASHAN_ADMIN_TOKEN: sandboxAdminToken() });
    const { code, out, err } = await runScript(file, env, SUITE_TIMEOUTS[name]);
    // 诊断留档：设 BINGDASHAN_E2E_DUMP=<目录> 时，把每套件的完整 stdout/stderr 落盘。
    // 以前红套件只能看到尾部 600 字，翻转顺序的前置断言根本看不见，排查全靠猜。
    if (process.env.BINGDASHAN_E2E_DUMP) {
      try {
        fs.mkdirSync(process.env.BINGDASHAN_E2E_DUMP, { recursive: true });
        fs.writeFileSync(path.join(process.env.BINGDASHAN_E2E_DUMP, name + '.txt'),
          'exit=' + code + '\n' + out + '\n--- STDERR ---\n' + err, 'utf8');
      } catch (e) {}
    }
    // 断言裁定优先于退出码：Windows libuv 关停伪崩(0xC0000409)发生在所有断言通过之后，
    // stdout 的「===== N PASS / 0 FAIL =====」才是断言真值。仅断言有 FAIL 或进程未出该行才算失败。
    // 超时（code==='TIMEOUT'）是另一回事，必须真判失败，不能享受"退出码非 0 也不判死"的宽松。
    const sum = (out + err).match(/=====\s*(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL\s*=====/);
    const failN = sum ? Number(sum[2]) : null;
    const crashArtifact = (code === 0 || code === null || code === 'TIMEOUT') ? 0 : (code & 0xffffffff) >>> 0;
    const benignTeardown = Number(crashArtifact) === 0xc0000405 || Number(crashArtifact) === 0xc0000409;
    const suiteOk = code !== 'TIMEOUT' && (sum ? failN === 0 : code === 0);
    if (!suiteOk || (failN === null && !benignTeardown)) failed.push(name + ' :: ' + (out + err).slice(-600));
    console.log('[runner] ' + name + ' exit=' + code + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
      + (sum ? ' (' + sum[1] + '/' + sum[2] + ')' : ''));
    // 断言全过但退出码非 0：多半是断言跑完之后冒泡的未捕获异步错误。
    // 以前这段 stderr 被静默丢弃，只能看到「exit=1」却查不出原因（ssrf-e2e 实测踩过）。
    // 不改判失败（Windows 伪崩仍按断言裁定），但必须把 stderr 打出来，否则等于看不见 bug。
    if (suiteOk && code !== 0 && code !== null && !benignTeardown && err.trim()) {
      console.error('[runner] 警告：' + name + ' 断言全过但 exit=' + code + '，stderr 末尾：\n'
        + err.trim().slice(-800));
    }
  }
  child.kill();
  // 服务端 stderr 一直是被丢弃的盲区：unhandledRejection/uncaughtException 都记在这。
  // 全绿也值得扫一遍有没有「已兜住」但未见的异常（状态不一致的隐患）。
  const bgHits = (srvErr.match(/未处理的 Promise 拒绝|未捕获异常/g) || []).length;
  if (bgHits) console.error('[runner] 服务端背景异常记录 ' + bgHits + ' 次（进程仍在运行，但状态可能不一致）：\n'
    + srvErr.trim().split('\n').filter(l => /未处理的 Promise 拒绝|未捕获异常|at /.test(l)).slice(0, 25).join('\n'));
  setTimeout(() => { try { fs.rmSync(E2E, { recursive: true, force: true }); } catch (e) {} console.log('[runner] 沙箱已清理'); }, 1500);
  if (failed.length) { console.error('FAILED:', failed.join(',')); process.exit(1); }
  console.log('[runner] ALL SUITES GREEN');
})().catch(e => { console.error('runner err', e.message); process.exit(1); });