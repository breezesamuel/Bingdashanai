// server.js — 丙大山AI API 服务层
// 职责：v1 HTTP 接口 + web 静态服务。零框架依赖（原生 http）。
// 覆盖：智能对话 / 决策中心 / 组织大脑 / 项目管理 / 审计日志 / 系统设置 / 8家模型状态

// ===== 启动耗时埋点（进程内测量，唯一可信的口径）=====
//
// 【2026-09】之前用 PowerShell 反复拉进程 + Invoke-WebRequest 轮询来测启动耗时，
// 结果 2111ms。但空跑一个 `node -e "setTimeout(...)"` 经同样的 Start-Process 就要 1236ms
// —— **测量方法本身的开销比被测对象还大**，据此优化会完全找错方向。
// 进程内用 performance.now() 量才准。t0 必须放在**所有 require 之前**，
// 否则量到的只是 require 之后的残余（曾因此得到误导性的 modulesLoaded=0）。
const BOOT = { t0: performance.now(), marks: {} };

const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const qs = require('querystring');

const providers = require('./core/providers');
const store = require('./core/store');
const brain = require('./core/brain');
const agents = require('./core/agents');
const knowledge = require('./core/knowledge');
const intel = require('./core/intel');
const webfetch = require('./core/webfetch');
const skills = require('./core/skills');
const talents = require('./core/talents');
const decision = require('./core/decision');
const autopilot = require('./core/autopilot');
const smart = require('./core/smart');
const persona = require('./core/persona');
const manuals = require('./core/manuals');
const peers = require('./core/peers');
const annual = require('./core/annual');
const goals = require('./core/goals');   // 第 16 条：目标任务（多目标 + 唯一核心）
const repurpose = require('./core/repurpose');
const autopub = require('./core/autopub');
const report = require('./core/report');
const tickets = require('./core/tickets');
const train = require('./core/train');
const playbook = require('./core/playbook');
const foundry = require('./core/foundry');
const mcp = require('./core/mcp');
const mailer = require('./core/mailer');
const handleExtRoutes = require('./core/server-ext-routes');
const watchdog = require('./core/watchdog');
const conductor = require('./core/conductor');
const goalpilot = require('./core/goalpilot');
const subs = require('./core/subs');
require('./core/commerce-skus').register(subs); // 新增变现 SKU（增量·幂等·不改 live 金额）
const pay = require('./core/pay');
const payNotify = require('./core/pay-notify');
const refund = require('./core/refund');
const rank = require('./core/rank');
const money = require('./core/money');
const payout = require('./core/payout');
const deliberation = require('./core/deliberation');
const leadgen = require('./core/leadgen');
require('./core/leadgen-icp-extra').register(leadgen); // 新增 ICP 细分（增量·幂等·不改 live 路由已有 4 类）
const agentcenter = require('./core/agentcenter');
const geo = require('./core/geo');

const PORT = Number(process.env.BINGDASHAN_PORT || 3721);
const HOST = process.env.BINGDASHAN_HOST || '127.0.0.1';
const WEB_ROOT = path.join(__dirname, 'web');
const STARTED = Date.now();
const VERSION = require('./package.json').version || '1.0.0';
BOOT.marks.modulesLoaded = performance.now() - BOOT.t0;   // 全部 require 完毕

// ---- 内存状态（组织循环每 5s 刷新，供 status 推给前端自动下滑）----
// 注意：此处不要在启动阶段同步读 db（1.4MB 解析会阻塞事件循环，实测拖出秒级卡顿）。
// 先置空，首个 5s 周期再填充。
const state = { orgStats: null, lastTurn: null };

// 进程级启动锁与定时器台账（跨 require 缓存删除存活，见 core/bootlock.js）。
// 本文件顶层所有长驻 setInterval 一律走 bootlock.interval：Electron 暴力重载前
// 调 bootlock.resetAll() 才能连旧实例的定时器一起清掉，否则新旧两套并行 → 双重扣费/双重开通。
const bootlock = require('./core/bootlock');

// 组织心跳：定时刷新统计（前端"组织大脑/项目"块据此自动下滑刷新）
bootlock.interval(() => {
  try { state.orgStats = store.orgStats(); } catch (e) { }
}, 5000);

// 到账守望：每 60s 对「自动通道」的 pending 单做一次网关查单，网关确认真到账才开通。
// 与买家页面的 5s 轮询互补——买家关掉收银台后（轮询停止），这条服务端兜底继续盯着。
// fail-closed：查不到 / 通道不可用一律不动。启动后 20s 先跑一次，把重启前漏掉的补上。
bootlock.track(setTimeout(() => { try { pay.watchPending(); } catch (e) { } }, 20000));
// 微信通道实测：只在启动后跑一次（真实 native 下单），失败则隐藏微信，避免展示死通道。
bootlock.track(setTimeout(() => { try { pay.wechatProbe(true).catch(() => { }); } catch (e) { } }, 25000));
// 支付宝探针：真下 0.01 元单。ACCESS_FORBIDDEN（个人账户无交易权限）如实反映到通道状态；
// 账户升级+签约生效后下一次探针通过，支付宝通道自动上架，无需改代码。
bootlock.track(setTimeout(() => { try { pay.alipayProbe(true).catch(() => { }); } catch (e) { } }, 35000));
// PayPal 探针：真建 0.01 USD 单（不 capture）。凭据齐备不等于有收款权限。
bootlock.track(setTimeout(() => { try { pay.paypalProbe(true).catch(() => { }); } catch (e) { } }, 45000));
// 每 30 分钟复测：资质修好自动恢复，坏掉自动下线（fail-closed）
// 【2026-10-21】自动探针频率 30min → 6h：探针是**真实单据**（0.01 元），30 分钟一轮 = 每天 48 笔不可删除的商户后台垃圾单
// （另加每日探针预算，core/pay.js probeBudgetState）。人工触发的通道诊断不受限。
bootlock.interval(() => { try { pay.alipayProbe(true).catch(() => { }); } catch (e) { } }, 6 * 3600 * 1000);
bootlock.interval(() => { try { pay.paypalProbe(true).catch(() => { }); } catch (e) { } }, 6 * 3600 * 1000);
bootlock.interval(() => { try { pay.wechatProbe(true).catch(() => { }); } catch (e) { } }, 6 * 3600 * 1000);
bootlock.interval(() => { try { pay.watchPending(); } catch (e) { } }, 60000);
// 人工通道核账守望：24h 内无内部确认 → 自动回收临时权益 + 订单转 needProof（要求客户补交截图）
bootlock.track(setTimeout(() => { try { pay.sweepManual(); } catch (e) { } }, 15000));
bootlock.interval(() => { try { pay.sweepManual(); } catch (e) { } }, 300000);
// 匿名访客清理（2026-10-21）：探针/爬虫/内部调用留下的匿名记录只保留 48h，
// 避免访客表被噪声淹没（生产实测 2805 条里绝大多数是这类）→ 身份统计与 db 体积都恢复真实。
bootlock.interval(() => { try { require('./core/subs').sweepAnonVisitors(); } catch (e) { } }, 300000);
// 陪护巡检：设备掉线 / 告警升级 / 任务漏做（60s 一次；模块内部另有 20s 节流）
bootlock.interval(() => { try { require('./core/care').sweep(); } catch (e) { } }, 60000);
// 到期前续费提醒（每 6 小时扫一次）：订阅到期会**静默回墙**，不提醒 = 白丢复购。
// 每 20 天最多提醒一次（remindedAt 去重），发不出就如实记 failed，不假装发过。
// 同一轮里还补发**失败过的收据**（收据是客户唯一凭证，丢一次就没有了）。
bootlock.track(setTimeout(() => {
  try { require('./core/receipt').sweepRenewalReminders().catch(() => { }); } catch (e) { }
  try { require('./core/receipt').retryFailedReceipts().catch(() => { }); } catch (e) { }
}, 20000));
bootlock.interval(() => {
  try { require('./core/receipt').sweepRenewalReminders().catch(() => { }); } catch (e) { }
  try { require('./core/receipt').retryFailedReceipts().catch(() => { }); } catch (e) { }
}, 6 * 3600 * 1000);

// 24h 后台引擎：错峰启动，避免四个模块在同一 tick 并发跑重量级任务。
// 原实现在此处连续同步调用 autopilot/goalpilot/watchdog/conductor 的 boot()，
// 它们各自立即读 db.json + 发起外部请求，实测事件循环出现 5.6s 阻塞，
// 表现为「打开 exe 电脑卡死、窗口无响应」。
// 改为：先让 HTTP 服务与首屏立即可用，再用 setTimeout 逐个错峰拉起。
//
// 【2026-09 实测】错峰只解决了"几个模块挤在同一 tick"，但单次 boot 内部仍可能长时间
// 同步阻塞：实测启动后 p95 响应 1457ms、**最差一次 9459ms**（9.4 秒窗口完全无响应）。
// 错峰只是把几把刀错开，没有让刀变钝。所以下面加了 loopWatch 事件循环阻塞监测，
// 先把"谁在阻塞"量出来，再对症下刀——不靠猜。
const stagger = (fn, ms, label) => {
  const t = setTimeout(() => {
    const t0 = performance.now();
    try { fn(); } catch (e) { console.log('[' + label + '] boot fail:', e && e.message); }
    const d = performance.now() - t0;
    BOOT.marks[label + 'Boot'] = Math.round(d * 10) / 10;
    // 后台任务也应尽量不阻塞事件循环：同步超过 500ms 就要记一笔，
    // 否则表现为"启动后某个瞬间整站卡住"。
    if (d > 500) {
      loopWatch.note(label + '.boot() 同步阻塞 ' + Math.round(d) + 'ms', d);
      console.log('[BingDashanAI] ⚠ ' + label + '.boot() 同步耗时 ' + Math.round(d) + 'ms（会阻塞事件循环）');
    }
  }, ms);
  if (t.unref) t.unref();
  // 入台账：重载前 resetAll 能把这些错峰启动的 boot 定时器一起清掉，避免旧实例稍后再拉起一套模块。
  bootlock.track(t);
};

// ===== 事件循环阻塞监测 =====
//
// 原理：定时器本该按 INTERVAL 准时触发。若上一次触发到这一次之间本该 setImmediate
// 却迟迟没执行，说明事件循环被同步代码占住了，差值就是阻塞时长。
// 用它把"用户说卡"变成可归因的数字：谁阻塞、堵多久、累计多少次。
const loopWatch = (() => {
  const INTERVAL = 300;
  const THRESHOLD = 400;           // 超过 400ms 才算"可感知卡顿"
  const MAX_KEEP = 40;             // 环形保留最近 N 条最严重记录
  const AUDIT_MAX = 3;             // 审计只写前 3 次（见下方说明）
  let auditWritten = 0;
  let expected = Date.now() + INTERVAL;
  const worst = [];
  let lastAt = Date.now();
  const tick = () => {
    const now = Date.now();
    const lag = now - expected;
    if (lag > THRESHOLD) {
      const sinceLast = now - lastAt;
      worst.push({ at: now, lag, gap: sinceLast });
      if (worst.length > MAX_KEEP) worst.shift();
      // 【不要让诊断加重它测量的东西】原来每检测到一次阻塞就 store.push('audit')，
      // 而 store.push 是**同步写盘**——恰好发生在事件循环已经紧张的时刻，
      // 形成"阻塞 → 写审计 → 更阻塞"的正反馈。实测这条审计自身耗时 176ms，
      // 反而成了慢写盘榜首（诊断器变成了它要诊断的问题本身）。
      // 现在：内存环形保留完整记录（/v1/diag/loop 可读全部），审计只写前 3 次留证。
      if (auditWritten < AUDIT_MAX) {
        auditWritten++;
        try { store.push('audit', { action: '事件循环阻塞', detail: '阻塞 ' + lag + 'ms（距上次 ' + sinceLast + 'ms）', at: now }, null, null); } catch (e) { }
      }
    }
    lastAt = now;
    expected = now + INTERVAL;
    const t = setTimeout(tick, INTERVAL);
    if (t.unref) t.unref();
  };
  const t0 = setTimeout(tick, INTERVAL);
  if (t0.unref) t0.unref();
  return {
    note(label, ms) {   // 供 stagger / 显式埋点使用
      try { worst.push({ at: Date.now(), lag: ms, gap: ms, label }); } catch (e) { }
      if (worst.length > MAX_KEEP) worst.shift();
    },
    report() {
      return {
        threshold: THRESHOLD, interval: INTERVAL,
        count: worst.length,
        worst: worst.slice().sort((a, b) => b.lag - a.lag).slice(0, 10)
      };
    }
  };
})();

// 自主运营引擎：启动即跑一轮 + 后台定时循环（24h 全托管）
stagger(() => autopilot.boot(), 1500, 'autopilot');
// 赚钱目标无人驾驶：启动即跑当天闭环 + 每 15 分钟自查补跑（24h 暗线逼近目标）
stagger(() => goalpilot.boot(), 2500, 'goalpilot');
// 24h 监控哨兵：启动即巡检 + 后台 60s 周期，异常邮件报警
stagger(() => { try { watchdog.boot(); } catch (e) { console.log('[watchdog] boot fail', e.message); } }, 3500, 'watchdog');
// 硬件热插拔感知（2026-10-25）：启动即建基线，此后 10s 轮询 diff → hwEvents 台账 + 学习信号
stagger(() => { try { const w = require('./core/hardware-kernel').watch(10000); console.log('[hw-kernel] hot-plug watch', w.intervalMs + 'ms'); } catch (e) { console.log('[hw-kernel] watch fail', e.message); } }, 5200, 'hwwatch');
// 24h 作战指挥塔：联调联动主循环，目标缺口驱动真实动作（15min 一轮）
stagger(() => { try { conductor.boot(); } catch (e) { console.log('[conductor] boot fail', e.message); } }, 4500, 'conductor');

// ---- 静态文件 ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  // PWA：manifest 必须是 application/manifest+json 才会被浏览器当作可安装应用；
  // Service Worker 必须是 text/javascript 且从根作用域提供（web/sw.js → /sw.js）。
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  // 自助下载（web/downloads/*）。浏览器对未知类型会当文本内联显示，
  // 所以这里显式给出二进制类型 + Content-Disposition: attachment（见 DOWNLOAD_EXT）。
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dmg': 'application/x-apple-diskimage',
  '.appimage': 'application/vnd.appimage',
  '.deb': 'application/vnd.debian.binary-package',
  '.apk': 'application/vnd.android.package-archive',
  '.zip': 'application/zip',
  '.gz': 'application/gzip'
};

// 这些扩展名一律强制下载（不内联打开），并带上原始文件名。
// 【为什么单独一份】MIME 只决定"怎么解析"，attachment 才决定"下载还是打开"；
// 少了它，用户点 .exe 可能被当文本打开，页面看起来像坏了。
const DOWNLOAD_EXT = new Set(['.exe', '.dmg', '.apk', '.deb', '.appimage', '.zip', '.pkg', '.msi']);
// 【2026-10-25 gzip】可压缩文本类型（安装包/字体/图片已压缩过，再压只费 CPU 不减体积）
const GZIP_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);
const GZIP_MIN = 1024;   // 1KB 以下压不掉几个字节，不值当多一路流

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const fp = path.normalize(path.join(WEB_ROOT, rel));
  if (!fp.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  let st = null;
  try { st = fs.statSync(fp); } catch (e) { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(fp).toLowerCase();
  const base = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  // Content-Length：缺了它浏览器看不到下载进度条，83MB 的安装包会像"卡住"。
  if (DOWNLOAD_EXT.has(ext)) {
    // 文件名只允许安全的 ASCII 片段，避免响应头注入（CRLF）。
    const safe = path.basename(fp).replace(/[^A-Za-z0-9._-]/g, '_');
    base['Content-Disposition'] = 'attachment; filename="' + safe + '"';
  }
  base['Accept-Ranges'] = 'bytes';
  const size = st.size;

  // 断点续传：安装包 80MB+，网络一断从头再来一次很难受。
  // 只有单个 bytes=a-b 区间（下载管理器/浏览器的常规用法）；多段 range 直接给全量。
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, Object.assign({}, base, { 'Content-Range': 'bytes */' + size }));
    return res.end();
  }
  const isHead = req.method === 'HEAD';
  // 【2026-10-25 gzip 弱网提速】app.js/i18n-console.js 都是数百 KB 级文本，裸传在弱网/高延迟
  // 下拖慢首屏与面板刷新。满足以下全部条件才压缩：全量响应（Range/断点续传语义优先）、
  // 非 HEAD、非下载件（Content-Length 进度条依赖原长）、可压类型、≥1KB、客户端声明支持。
  const gzOk = !range && !isHead && !DOWNLOAD_EXT.has(ext)
    && GZIP_EXT.has(ext) && size >= GZIP_MIN
    && /gzip/i.test(String(req.headers['accept-encoding'] || ''));
  if (gzOk) {
    const zlib = require('zlib');
    res.writeHead(200, Object.assign({}, base, {
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding'
    }));
    const zs = fs.createReadStream(fp).pipe(zlib.createGzip({ level: 6 }));
    zs.on('error', () => { try { res.destroy(); } catch (e) { } });
    return zs.pipe(res);
  }
  const opts = range ? { start: range.start, end: range.end } : {};
  const len = range ? (range.end - range.start + 1) : size;
  const head = Object.assign({}, base, { 'Content-Length': len });
  if (range) {
    head['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + size;
    res.writeHead(206, head);
  } else {
    res.writeHead(200, head);
  }
  if (isHead) return res.end();
  const stream = fs.createReadStream(fp, opts);
  stream.on('error', () => { try { res.destroy(); } catch (e) { } });
  stream.pipe(res);
}

// 把 Range 头解析成 {start,end}。返回 null=没有 Range 或整段；'invalid'=越界/无法识别。
function parseRange(h, size) {
  if (!h || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
  if (!m) return 'invalid';
  if (m[1] === '' && m[2] === '') return 'invalid';
  let start, end;
  if (m[1] === '') { // 后缀形式 bytes=-500（最后 500 字节）
    const n = parseInt(m[2], 10);
    if (!n) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
  }
  if (start >= size) return 'invalid';
  if (end >= size) end = size - 1;
  if (end < start) return 'invalid';
  return { start, end };
}

// ---- JSON 响应 ----
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function err(res, code, msg) { json(res, code, { ok: false, error: String(msg) }); }
// ===== WebSocket 处理：Orca 实时推送 =====
const orcaWSClients = new Set();
function broadcastOrca(data) {
  const msg = JSON.stringify({ type: 'orca', data, ts: Date.now() });
  orcaWSClients.forEach(ws => {
    try { if (!ws.destroyed) ws.write(wsFrame(msg)); } catch (e) { }
  });
}

// 定时推送：每 5 秒推送一次 board/pulse 变化
setInterval(() => {
  try {
    const Orca = require('./core/orca');
    const board = Orca.board();
    const pulse = Orca.pulseMap();
    broadcastOrca({ board, pulse });
  } catch (e) { }
}, 5000);

// 服务端→客户端文本帧编码。升级后对端发来的帧只需消费不必解析（仅心跳/关断）。
// 服务端发出的帧按 RFC 6455 无需掩码。
function wsFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = buf.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, buf]);
}
// 必须走 server.on('upgrade') 路径；若经 handle() 的 GET 路由，socket 受 http 响应语义
// 管理，res.writeHead(101)+手写 raw 101 双重写头、且 net.Socket 上 ws.send/ws.readyState
// 不存在（readyState 永为 undefined→广播被静默丢弃，send 也不会编码帧），导致 Orca WS
// 从未真正工作过。
function handleOrcaWS(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  const accept = require('crypto').createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.on('data', () => { /* 消费客户端帧（ping/close/续订），无需解析 */ });
  socket.on('close', () => orcaWSClients.delete(socket));
  socket.on('error', () => orcaWSClients.delete(socket));
  orcaWSClients.add(socket);
  console.log('[orca] WS connected, clients:', orcaWSClients.size);
}


// ---- HTML escape for verify page ----
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- 原始 form 读 body（支付回调 form-urlencoded 用）----
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '', size = 0, oversized = false;
    req.on('data', c => {
      size += c.length;
      if (oversized) return;
      if (size > MAX_BODY) { oversized = true; buf = ''; reject(Object.assign(new Error('body too large'), { status: 413 })); return; }
      buf += c;
    });
    req.on('end', () => { if (!oversized) resolve(buf); });
    req.on('error', reject);
  });
}

// ---- 读 body（带体积上限，防内存型 DoS；超出即 413，不再 destroy 连接）----
const MAX_BODY = 2e6;
// 读取 body 并同时保留原始字符串：验签必须用**原始字节**，
// 重新序列化过的 JSON 会让 PayPal 的签名对不上。
function readBodyRaw(req, maxSize) {
  const limit = maxSize || MAX_BODY;
  return new Promise((resolve, reject) => {
    let buf = '', size = 0, oversized = false;
    req.on('data', c => {
      size += c.length;
      if (oversized) return;
      if (size > limit) { oversized = true; buf = ''; reject(Object.assign(new Error('body too large'), { status: 413 })); return; }
      buf += c;
    });
    req.on('end', () => {
      if (oversized) return;
      let json = null;
      try { json = buf ? JSON.parse(buf) : null; } catch (e) { json = null; }
      resolve({ raw: buf, json: json });
    });
    req.on('error', reject);
  });
}

function readBody(req, maxSize, parseForm) {
  const limit = maxSize || MAX_BODY;
  return new Promise((resolve, reject) => {
    let buf = '', size = 0, oversized = false;
    req.on('data', c => {
      size += c.length;
      if (oversized) return;
      if (size > limit) { oversized = true; buf = ''; reject(Object.assign(new Error('body too large'), { status: 413 })); return; }
      buf += c;
    });
    req.on('end', () => {
      if (oversized) return;
      if (!buf) return resolve({});
      if (parseForm) {
        // Parse application/x-www-form-urlencoded
        try { resolve(qs.parse(buf)); } catch (e) { reject(Object.assign(new Error('invalid form'), { status: 400 })); }
      } else {
        // Parse JSON
        try { resolve(JSON.parse(buf)); } catch (e) { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
      }
    });
    req.on('error', reject);
  });
}

function isLoopback(req) {
  // 【部署安全·关键】反向代理（nginx/caddy）会把**所有**请求的 remoteAddress
  // 变成代理本机 127.0.0.1。若把"代理本机"当成"运营本机"，公网任意访客都会被
  // 判为运营身份：全部运营接口 + 免费墙对全世界敞开（白嫖、确认到账）。
  // 凡是带代理头（X-Forwarded-For / X-Real-IP / X-Forwarded-Host）的请求，一律
  // 不认回环，必须走管理令牌；本机直连调试（无代理头）不受影响。
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-host']) return false;
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1';
}

// 限流 / 记录用的「真实客户端 IP」。宝塔 nginx 会覆盖式写入 X-Real-IP=$remote_addr
// （客户端自带的值会被替换，可信）；X-Forwarded-For 用 $proxy_add_x_forwarded_for 是
// **追加**式的，最后一跳才是真实来源。
// 为什么必须取代理头：不取时 req.socket.remoteAddress 永远是 127.0.0.1（代理本机），
// 所有限流键退化成同一个 → 限流变成**全局限流**：单个攻击者刷满 checkout 配额（30/分）
// 就能把真实买家的下单请求一起 429 掉——对支付漏斗的拒绝服务。
function clientIp(req) {
  const clean = s => String(s || '').trim().replace(/^::ffff:/, '').replace(/[^\w.:\-]/g, '').slice(0, 45);
  const xri = clean(req.headers['x-real-ip']);
  if (xri) return xri;
  const xff = String(req.headers['x-forwarded-for'] || '').trim();
  if (xff) {
    const parts = xff.split(',');
    const last = clean(parts[parts.length - 1]);
    if (last) return last;
  }
  return clean(req.socket.remoteAddress) || 'anon';
}

// 运营鉴权：模块级声明（不能放在 handle() 里——多处路由在其之前就要调用，会踩 TDZ）。
// 本机回环视为已授权（单机部署）；非回环必须带 X-Admin-Token。
const adminTokenOf = () => store.getSetting('adminToken') || null;
const adminAuthed = req => {
  if (isLoopback(req)) return true;
  const tok = adminTokenOf();
  return !!tok && String(req.headers['x-admin-token'] || '') === tok;
};
// 管理令牌惰性生成：集中一处。原来有 3 个接口各自复制了一遍
// "读设置→没有就 randomBytes(18) 写回"，将来只改一处就会漏改另外两处，
// 出现"某个接口用旧令牌、某个用新令牌"的极难排查现象。
const ensureAdminToken = () => {
  let tok = store.getSetting('adminToken');
  if (!tok) {
    tok = require('crypto').randomBytes(18).toString('base64url');
    store.setSetting('adminToken', tok);
  }
  return tok;
};

// —— 资金/凭据类接口：回环免令牌不够，必须带管理令牌——
// 【真问题】adminAuthed 里 isLoopback 直接放行，这对"本机桌面应用调试"是对的。
// 但把同一套判断套到**真实资金操作**上就是漏洞：任何本机进程/网页脚本
// 都能查单、触发支付宝通道诊断、确认到账激活订阅。实测：
//   POST /v1/subs/confirm  错误令牌也返回 ok（订单直接变 paid）
//   GET  /v1/pay/query     错误令牌也返回 200
//   GET  /v1/pay/alipay/check 错误令牌也返回 200
// 【为什么回环不能免】浏览器里一个恶意网页在同机跑，就能打这些接口（CORS 不拦
// 简单请求的**读取**），"本机"不等于"可信"。
// 【口径】只收紧这三类，其余一律不动——避免把本机调试也堵死。
const STRICT_ADMIN_PATHS = [
  '/v1/subs/confirm',      // 确认到账 → 直接开通订阅（最严重：可白嫖）
  '/v1/pay/query',         // 主动查单：触碰真实支付通道
  '/v1/pay/alipay/check',  // 通道诊断：触发支付宝远程调用
  '/v1/pay/wechat/check',  // 微信通道诊断：触发微信远程调用
  '/v1/pay/wechat/query',  // 微信主动查单：触碰真实支付通道
  '/v1/subs/rotate-admin-token', // 轮换令牌本身
  '/v1/pay/manual-verify',       // 人工通道内部确认到账 → 直接开通订阅（可白嫖，最严重）
  '/v1/pay/manual-queue',        // 人工核账台：列出全部人工订单（金额/访客/备注）
  '/v1/pay/manual-sweep',        // 人工核账超时回收：批量作废权益
  '/v1/pay/manual-guard',        // 人工通道滥用防护参数
  '/v1/pay/auto-settle',          // 收款监听自动开通（到账信号 → 直接开通订阅）
  '/v1/pay/auto-settle/status',   // 收款监听通道就绪视图
];
const isStrictAdminPath = p => STRICT_ADMIN_PATHS.indexOf(p) >= 0;
// 资金/凭据类：回环也必须带正确令牌
const adminAuthedStrict = req => {
  const tok = ensureAdminToken();
  return String(req.headers['x-admin-token'] || '') === tok;
};
// 收款监听通道鉴权：本机回环 **且**（通知密钥 或 管理令牌），二者缺一不可。
// 【为什么必须回环】通知密钥只在本机监听器与本机运维之间流动；
//   若只靠密钥，公网拿到密钥即可任意「宣布到账」→ 无限白嫖。
// 【为什么还留管理令牌】运维/自检用管理令牌即可，不必分发第二把钥匙。
const notifyAuthed = req => {
  if (!isLoopback(req)) return false;
  // 【为什么用 pay.envGet 而不是 process.env】站点 service 没有 EnvironmentFile，
  //   进程环境里没有 .env 的变量；站点读密钥的惯用法是 core/pay.js 的 envGet()
  //   （自己解析 .env，还处理引号/转义）。这里必须用同一口径，否则密钥永远读不到。
  const nk = String(pay.envGet('BD_NOTIFY_KEY') || '').trim();
  if (nk && String(req.headers['x-bd-notify-key'] || '') === nk) return true;
  return adminAuthedStrict(req);
};

// ---- 轻量固定窗限流（用于会外呼/改状态的敏感接口）----
// 返回 true=放行并计数；false=已超限。窗口内计数，窗口过期重置；定期清理避免 key 无界增长。
const _rate = new Map();
// 付款即开通兜底：记录每个订单最近一次「主动查单」时间，避免前端轮询打爆网关
const _paySyncAt = Object.create(null);
function rateOK(key, cap, win) {
  const now = Date.now();
  if (_rate.size > 4000) {           // 兜底清理：只保留最近有活动的窗口
    for (const [k, v] of _rate) if (now - v.at > win) _rate.delete(k);
  }
  const cur = _rate.get(key);
  if (!cur || now - cur.at > win) { _rate.set(key, { n: 1, at: now }); return true; }
  if (cur.n >= cap) return false;
  cur.n++;
  return true;
}

function parseCookie(header) {
  const out = {};
  String(header || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); });
  return out;
}

// 访客标识：只认服务端签发的 vid（subs.issue/verify，HMAC 防伪造）。
// 优先 X-Visitor/?visitor=（已签名才可信），其次 HttpOnly cookie（bd_vid，同源持久、JS 不可伪造），
// 都没有时 → 签发一个并种 Cookie，首访即开始消耗免费额度。
// 注意：始终返回「裸 key」（内部身份），vid 仅是传输凭证；签发时签给裸 key 可重复往返。
function visitorOf(req, q, res) {
  const direct = (q && q.get('visitor')) || req.headers['x-visitor'] || '';
  const verified = subs.verify(String(direct));
  if (verified) return verified;
  const ck = parseCookie(req.headers.cookie)['bd_vid'];
  if (ck) { const k = subs.verify(ck); if (k) return k; }
  // 【2026-10-21 匿名身份收敛】原来匿名键带**请求时刻**（'ip:<ip>:<ts>'），
  // 于是**每一次不带 Cookie 的请求都会新建一条访客记录**（探针、爬虫、站点自己的
  // 内部调用全算）→ 访客表被噪声淹没（生产实测 2805 条里绝大多数是这类），
  // db.json 无界增长、身份统计失真。
  // 现在匿名身份**按 IP × 小时桶**稳定：同一 IP 小时内共用一条记录（额度也随之按 IP 计，
  // 与既有的 ¥1 试用 IP 闸门口径一致），小时切换才换新身份。
  const anon = 'ip:' + clientIp(req).replace(/[.:\s]/g, '_').slice(0, 40) + ':' + Math.floor(Date.now() / 3600000).toString(36);
  const issued = subs.issue(anon);
  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Set-Cookie', 'bd_vid=' + issued.vid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000');
  }
  return anon;
}

// 陪护专用身份：**按浏览器**签发，不用 IP×小时 的匿名桶。
// 【为什么必须分开】匿名桶让同一 WiFi / 同一平板上的老人和子女变成同一个访客：
//   子女点邀请码加入时会被当成“已建档的老人本人”，直接 already=true，永远绑不上 →
//   告警没人收。陪护的责任链要求“谁就是谁”，所以这里用独立 Cookie（bd_care）+ 随机 key。
// 不影响主站额度口径：额度仍走 bd_vid / visitorOf。
function careVisitorOf(req, q, res) {
  const direct = req.headers['x-care-visitor'] || (q && q.get('careVisitor')) || '';
  const verified = subs.verify(String(direct));
  if (verified && verified.indexOf('care:') === 0) return verified;
  const ck = parseCookie(req.headers.cookie)['bd_care'];
  if (ck) {
    const k = subs.verify(ck);
    if (k && k.indexOf('care:') === 0) return k;
  }
  const k = 'care:' + require('crypto').randomBytes(12).toString('hex');
  const issued = subs.issue(k);
  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Set-Cookie', 'bd_care=' + issued.vid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000');
  }
  return k;
}

// 收费墙：高价值内容端点统一过一次闸。访客前 10 次免费，之后必须订阅（弹窗引导 /v1/subs/status）。
// 无人头可伪造：仅接受服务端签名身份；X-Internal/internal 前缀/白名单 head 一律不再放行。
function gateContent(req, q, res) {
  const v = visitorOf(req, q, res);
  const g = subs.gate(v);
  // 观测（只记不判）：撞墙 / 新访客身份落台账，供运营看"谁在刷免费额度"。
  // 惰性 require + 吞异常：观测代码出任何问题都不能影响收费墙判定本身。
  try { require('./core/wallguard').observe({ ip: clientIp(req), visitor: v, section: 'content', allowed: g.allowed }); } catch (e) { }
  if (!g.allowed) {
    const st = subs.status(v);
    g.wall = true;
    g.msg = g.msg || '免费次数已用完，请订阅后继续使用';
    g.plans = st.plans;
    g.trialUsed = st.trialUsed;
  }
  return g;
}

// 全站收费墙 · 分节闸：高价值功能区独立每日常量，订阅后不限。
// 返回 { allowed } ；不通过时直接写出 402 wall 响应并返回 true（表示已拦截）。
function gateSection(req, q, res, section) {
  // 【2026-10-24 口径对齐】运营关墙（paywallOn=false）时不得拦截、也不得扣量。
  // 此前只有 autoGate 检查开关，直调 gateSection 的 14 处端点（chatdeep/decision/
  // agent/skill/leadgen…）无视开关照常扣额度并 402 —— 墙"暂停"时这些功能仍在被拦，
  // 与 /v1/report/seven 修复时确立的「paywallOn=false ⇒ 免费」口径相悖。
  // CLIENT_MODE（桌面/原生交付）下墙强制开启，不受影响。
  if (!PAYWALL_ENABLED()) return false;
  const v = visitorOf(req, q, res);
  const g = subs.gatePool(v, section);
  // 观测（只记不判）：分节闸的撞墙 / 新访客身份落台账。放在 402 写出之前，
  // 这样 allowed 与 denied 两条路径都会被观测到（否则只看得到撞墙、看不到放行）。
  // 同上：惰性 require + 吞异常，观测绝不影响判定。
  try { require('./core/wallguard').observe({ ip: clientIp(req), visitor: v, section, allowed: g.allowed }); } catch (e) { }
  if (!g.allowed) {
    g.wall = true;
    // 【2026-10-21 收口】subs.status(v) 只调一次（原来调用两次，重复读库）；
    // 并把「是否已是订阅者」带进 402 —— 前端据此区分两种完全不同的文案：
    //   未订阅撞墙 → 引导订阅；已订阅撞重值日限 → 明日恢复/升级套餐，绝不能再弹订阅墙（防重复付费）。
    const st = subs.status(v);
    g.trialUsed = st.trialUsed;
    g.plans = st.plans;
    // 必须是 HTTP 402，不是 200：前端 paywall 钩子只拦 resp.status===402（web/biz.js）。
    // 原来这里写 200+body.code，导致 5/6 高价值功能撞墙时用户看到「会诊失败：undefined」，
    // 订阅墙根本不弹 —— 付费转化链路在这些功能上 100% 断裂。纯 bug，已修。
    // body 同时保留 code/msg/error 多种字段名，兼容旧前端与各调用点。
    json(res, 402, {
      ok: false, code: 402, wall: true, section,
      msg: g.msg, error: g.msg,
      plans: g.plans, trialUsed: g.trialUsed, freeLeft: g.used,
      // 【获客件】未用过免费试用的人，402 里直接带上资格位（前端据此亮「免费试 2 天」按钮，
      // 免去墙弹出时再发一次 /v1/subs/status 的往返）。用 status 口径（已订阅者=不可领）。
      trialAvail: !!st.freeTrialAvailable,
      // 【诚实 402】订阅者上下文：前端 hookWall 依据它决定不弹订阅墙（防重复付费误导）
      unlimited: !!st.unlimited, sub: st.sub || null,
      used: g.used, quota: g.quota, tier: g.tier || null
    });
    return true;
  }
  return false;
}

// ===== 统一收费闸门（第 15 条：收费墙针对的是所有项目）=====
// 现状问题：收费墙靠散落各处的 gateSection(...) 调用挂载，实测全文件仅 13 处。
// 于是"所有项目都收费"这句话无法验证——没人说得清哪些漏了。
// 这里改成**声明式**：
//   paywall.js 里登记「端点 → 分区」，本函数按请求自动匹配；
//   同时把真实端点集合收集起来，供 /v1/paywall/coverage 做反查。
//
// 为什么不能简单地"全部端点都收费"：
// /v1/status 必须免费，否则用户无法确认自己是否已订阅；定价页也必须免费。
// 所以 PUBLIC 列表显式列出免费端点并给出理由——覆盖率报告里能区分
// 「已收费」/「明确免费」/「未登记（漏网）」，第三类才是真正的问题。
const _ENDPOINT_REGISTRY = new Set();

// —— 收费墙开关（按用户要求：先剪除，等功能修好再开）——
// 默认**暂停**。理由不是"功能不该收费"，而是当前阶段：
//   1. 可用模型通道只剩一条，收费墙会把本就稀缺的能力挡在墙外，
//      用户看到的是"功能坏了"，而不是"需要订阅"；
//   2. 大量被拦入口是只读展示（战情室/指挥塔/记忆中枢），
//      收费后界面直接空白，比不收费更让人以为软件有问题。
// 但**分区定义与端点登记全部保留**（core/paywall.js 未动），
// 开关只是把闸门旁路；恢复时 POST /v1/paywall/toggle 即可，无需改代码。
// 每次开关都写审计——不会出现"不知道什么时候被关掉的"。
// 【客户端版本】打包成桌面/原生 App 交付到客户机器后，收费墙**强制开启且不可关闭**：
// 那时"本机"就是用户自己，若还允许关墙，下载版等于没有收费能力。
// 判定见 core/license.js（桌面壳注入 BINGDASHAN_CLIENT=1）。
const CLIENT_MODE = () => { try { return require('./core/license').isClientMode(); } catch (e) { return false; } };
const PAYWALL_ENABLED = () => CLIENT_MODE() || store.getSetting('paywallOn') === true;

// 静态解析 server.js，取出全部 `p === '/v1/xxx' && req.method === 'METHOD'` 形式的端点。
// 用途：收费墙覆盖率需要一个**稳定的全量分母**。运行时收集的集合随调用而变，
// 不能用来证明"所有端点都已定策"。
// 缓存 60 秒：解析 2500 行文件不是免费的，但也没必要每次请求都做。
let _declaredCache = { t: 0, list: [] };
// 运行时端点集合只在「真实应用命名空间」内才并入覆盖率分母。
// 【已修】原来 _ENDPOINT_REGISTRY 无条件并入，而 autoGate 会把**每个**请求过路的
// pathname 都记进去——于是公网扫描器的 404 探测（/.git/config、/fun.php、
// /geoserver/web/、/portal/redlion、/undefined …）也被当成"端点"计入。实测线上
// 分母被顶到 435、28 个"未定策"里约 20 个是这种噪音，真正的漏网端点被埋掉，
// 覆盖率无法再证明"所有端点都已定策"。这些探测不是应用端点，一律不并入。
// 只保留确实由本服务分发的命名空间：/v1/*（业务端点）、/mcp（协议短路）、
// /api/*、/healthz、/metrics。用 /web\/ 而非 /web 前缀，避免把 /webui/ 这类探测放进来。
const _APP_NS_RE = /^(\/v1\/|\/mcp$|\/api\/|\/healthz$|\/metrics$)/;
function allDeclaredEndpoints() {
  if (Date.now() - _declaredCache.t < 60000) return _declaredCache.list;
  const out = new Set();
  try {
    const src = fs.readFileSync(__filename, 'utf8');
    // 匹配两种写法：单行 p==='...'&&req.method==='...' 与多行 p === '...'\n ... req.method === '...'
    const re1 = /p\s*===\s*'([^']+)'\s*&&\s*req\.method\s*===\s*'(GET|POST|PATCH|DELETE|PUT)'/g;
    const re2 = /p\s*===\s*'([^']+)'\s*(?:\/\/[^\n]*)?\n\s*(?:if\s*\()?\s*req\.method\s*===\s*'(GET|POST|PATCH|DELETE|PUT)'/g;
    let m;
    while ((m = re1.exec(src))) out.add(m[2] + ' ' + m[1]);
    while ((m = re2.exec(src))) out.add(m[2] + ' ' + m[1]);
  } catch (e) {
    // 解析失败不能让覆盖率接口整个挂掉，退回运行时集合（同样只取应用命名空间）
    return [..._ENDPOINT_REGISTRY].filter(k => _APP_NS_RE.test(String(k).split(' ')[1] || ''));
  }
  _ENDPOINT_REGISTRY.forEach(k => {
    if (_APP_NS_RE.test(String(k).split(' ')[1] || '')) out.add(k);
  });
  _declaredCache = { t: Date.now(), list: [...out] };
  return _declaredCache.list;
}

// 收费墙当前状态说明（前端展示用，避免"开关关了但用户以为还在收"）
function paywallState() {
  const on = PAYWALL_ENABLED();
  return {
    on,
    label: on ? '已开启' : '已暂停',
    reason: on ? '' : '按当前阶段要求暂停：功能尚未全部修好，收费墙会把仅剩的可用通道挡在墙外，且只读展示类入口会直接空白。分区与端点登记均保留，恢复只需开关，无需改代码。',
    resumeVia: 'POST /v1/paywall/toggle {"on":true}'
  };
}

function registerEndpoint(method, p) {
  _ENDPOINT_REGISTRY.add(method + ' ' + p);
}
// 自动闸门：在路由分发之前调用一次即可，无需逐个端点改代码
function autoGate(req, q, res, pathname) {
  const key = req.method + ' ' + pathname;
  _ENDPOINT_REGISTRY.add(key);
  if (!PAYWALL_ENABLED()) return false;
  const pw = require('./core/paywall');
  const sec = pw.sectionOf(req.method, pathname);
  // '@public' = 显式登记为免费（支付链路、自身数据、基础体验）。绝不能当成收费分区。
  if (!sec || sec === '@public') return false;
  return gateSection(req, q, res, sec);
}

// ══════════ 变更操作统一限权：「读状态公开；变更限本机或 X-Admin-Token」 ══════════
// 原则见 server.js 运营管理区原注释。此前只有资金类端点逐点补齐了 adminAuthed，
// 但 160+ 个运营杠杆端点（退款/审批/发布/发件/技能注入/启停引擎…）对云端/LAN 上的
// 匿名来源完全敞开，任何拿到域名的人都能退款/放开收费墙/发件/注入技能/停掉自主引擎。
// 此处把该原则全局收口：非回环 + 无令牌 的 POST/PUT/PATCH/DELETE 一律 403；
// 回环（Electron 桌面、同机调试浏览器）不受影响；携带正确 X-Admin-Token 的远端
// 运营端自动放行（web/biz.js 已自动透传本地存入的 bd_adminToken）。
// PUBLIC_MUTATE 是故意公开的集合：访客付费漏斗、付费区里的访客功能、合伙人自助登记。
// 自动探针节流：冷却时间戳 + in-flight 锁（见 /v1/pay/channels 路由说明）
let _probeKickAt = 0;
let _probeInFlight = false;

const PUBLIC_MUTATE = new Set([
  // —— 访客付费漏斗（运营鉴权不能打断付费链路）——
  '/v1/subs/identity', '/v1/subs/gate', '/v1/subs/order',
  // 买家给**自己的**订单补邮箱（用于收付款凭证/续费提醒）。
  // 【必须公开】这是付费漏斗的一环；安全性由 subs.attachEmail 的「只能改自己的订单」保证。
  '/v1/subs/order/email',
  '/v1/subs/bind', '/v1/subs/redeem',
  '/v1/pay/checkout', '/v1/pay/alipay/notify', '/v1/pay/wechat/notify',
  // 网关异步回调：必须公开（网关不携带我们的管理令牌），靠签名校验保护
  '/v1/pay/paypal/webhook', '/v1/pay/moltspay/notify',
  // 买家回传"我已转账"：立即开通（24h 内系统内部核账，超时自动回收）
  '/v1/pay/manual-confirm',
  // 客户申请退款（自己的订单）：只受理申请，**绝不在此处退款** —— 实际出款由运营转账后确认
  '/v1/pay/refund',
  // 24h 未核账后客户补交支付截图：重新开启 24h 核账窗口。
  // 【必须公开】这是付费漏斗的一环，漏掉会导致公网访客 403，补交流程直接断掉。
  '/v1/pay/manual-resubmit',
  // 通道就绪状况（买家端据此选支付方式，只读）
  '/v1/pay/channels',
  // —— 设置中心（POST 写入路径里受 PROTECTED_SETTINGS 封禁，写 secrets 必被拒）——
  '/v1/settings',
  // —— 合伙人自助（enroll/deliver/accept 原为公开；pay/paid 仍需令牌）——
  '/v1/partner/enroll', '/v1/partner/deliver', '/v1/partner/accept',
  // —— paywall 付费分区里的访客功能（收费墙兜底，不能再 403 掉）——
  // /v1/report/seven（七日报）登记在 paywall(evolve) 下，web/biz.js 还专门挂 402 收费墙。
  // 若不放这里：公网访客的 POST 会先被"变更限权"挡住 → 403，收费墙的 402 根本轮不到，
  // 收费墙形同虚设、这条付费转化链在公网是断的。放进白名单后，非回环访客能走到端点内部的
  // 收费墙，由免费额度/订阅状态决定，而不是被权限 403 一刀切。
  '/v1/report/seven',
  '/v1/chat', '/v1/voice', '/v1/game/build', '/v1/game/tune', '/v1/studio/produce',
  // —— 授权码激活（下载版的付费漏斗入口）——
  // 与 /v1/subs/order 同理：这是访客"付钱换权益"的入口，不能被运营鉴权 403 打断。
  // 只放开 activate/inspect；config/issue 仍是运营端接口（STRICT 令牌）。
  '/v1/license/activate', '/v1/license/inspect',
  '/v1/decisions/suggest', '/v1/decisions/accuracy', '/v1/decisions/apply',
  '/v1/decisions/infer', '/v1/decisions/brio', '/v1/decision-bridge/sync',
  '/v1/leadgen/advance', '/v1/agents/consult', '/v1/agents/team', '/v1/skills/download',
  // —— 技能执行（2026-10-21 补齐；路径形状 '/v1/skills/<name>/invoke' 已在 handle() 里归一）——
  // 这是访客在技能面板点「执行」的入口：必须能走到端点内部的收费墙（skill 分区），
  // 否则会被变更限权 403 挡在墙之前 —— 付费转化链在公网是断的。
  '/v1/skills/invoke',
  // —— 访客互动轻量入口（玩具/线索追踪）——
  '/v1/zodiac/tick', '/v1/zodiac/interact', '/v1/zodiac/select', '/v1/organs/beat',
  '/v1/geo/report', '/v1/rank/enter', '/v1/gtm/touch',
  // —— 真实触达·外部机器人的入站回复回调（必须免管理令牌，但被 outreachReplyToken 强校验）——
  '/v1/outreach/reply'
]);

// 访客可匿名写入的设置键白名单（**仅**界面偏好类）。
// 【严重漏洞·已修】此前 /v1/settings 在 PUBLIC_MUTATE 里且不区分来源权限，于是：
//   POST /v1/settings {"paywallOn":false}            → 任何人可关掉收费墙（全站免费）
//   POST /v1/settings {"receiveQrAlipay":"<攻击者码>"} → 买家扫到攻击者的收款码（资金被劫）
//   POST /v1/settings {"receiveAccount":"..."}        → 误导买家转账到攻击者账号
// 实测：匿名 POST receiveAccount 确实写入了（已修复）。现在非回环且无管理令牌的写入
// 只放行下面这些偏好键，其余一律拒绝 + 记审计。运营改设置带 X-Admin-Token 或本机回环即可。
const PUBLIC_SETTING_KEYS = new Set(['theme', 'lang', 'provider', 'mode', 'sound', 'soundKind', 'goals', 'myZodiac']);

// 扩展端点（core/server-ext-routes.js）的路径形状，用于在 handle() 里做同步短路。
// 只有在命中时才进入异步扩展处理器；普通请求不经过 await，避免破坏响应时序（见 handle 内注释）。
const EXT_ROUTE_RE = /^(\/mcp$|\/v1\/(mcp\/rpc$|mcp-client\/|lightning\/|license\/|wled\/|crm\/|auth\/|evidence\/|free-tier(\/|$)|reviews(\/|$)|waitlist$|scheduler\/(enable|disable)$|projects\/from-decision$|validator\/))/;

// ---- 路由 ----
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  const q = u.searchParams;

  // 【2026-10-24 真实故障源】响应结束时把**分区端点的 5xx** 落进 faults 表：
  // 成熟度自校准（core/maturity.js suggest）的"故障降级"从此有真数据，
  // 不再恒为 0。公共端点（@public）与 4xx 不算故障面；记故障抛错也绝不影响响应。
  res.on('finish', () => {
    try {
      if (res.statusCode >= 500) {
        const sec = require('./core/paywall').sectionOf(req.method, p);
        if (sec && sec !== '@public') require('./core/maturity').recordFault(sec, req.method + ' ' + p + ' → ' + res.statusCode);
      }
    } catch (e) { }
  });

  // —— 路径规范化（2026-10-21）——
  // 前端历史上调的是 '/v1/skills/<name>/invoke'（技能名在路径），而收费墙登记表与
  // 运营权限白名单用的是 '/v1/skills/invoke'（技能名在 body）—— 两种形状对不齐时，
  // 表现为：点「执行」404，或被变更限权 403 挡在收费墙之前。
  // 这里在**进路由之前**把路径形状归一成规范形状（技能名单独取出），
  // 于是墙登记、白名单、路由三者只有一条口径，前端不用改。
  let pathSkillName = '';
  {
    const m = /^\/v1\/skills\/([^/]+)\/invoke$/.exec(p);
    if (m) {
      try { pathSkillName = decodeURIComponent(m[1]); } catch (e) { pathSkillName = m[1]; }
      p = '/v1/skills/invoke';
    }
  }

  // 扩展路由（HEAD 干净版缺失的约 50 个端点）：
  // MCP 协议 / MCP 客户端 / Agent Lightning / WLED / CRM / auth / 证据 / 免费额度 / 评价 / 候补 / 调度 / 决策转项目。
  // 必须放在收费闸门与「非回环变更 403」之前：/v1/auth/*、/v1/reviews、/v1/waitlist 等公共端点
  // 不能被变更限权拦掉（它们是面向公网访客的入口）。
  //
  // 【为什么先做同步短路、而不是无条件 await】
  // Node 的 http 服务器在"请求带 body、处理函数却先 await 让出事件循环再响应"时，会以
  // 400 + 空 body 直接关闭连接（Node v25 实测；sec-e2e 用 `GET /v1/subs/pay-config` 带 {} body
  // 命中过这个坑）。只用正则同步判断"这个路径是不是扩展端点"，普通请求就完全不会被 await
  // 打断，响应时序与改动前逐字节一致。
  if (EXT_ROUTE_RE.test(p)) {
    try {
      if (await handleExtRoutes({ p, q, req, res, json, err, readBody, adminAuthed, adminAuthedStrict, visitorOf, gateSection, store })) return;
    } catch (e) {
      return err(res, 500, String((e && e.message) || e));
    }
  }

  // ══════════ 客户端版本（桌面/原生 App 交付给客户）的收费墙收口 ══════════
  // 下载到客户机器上运行时，"本机"= 用户本人：管理员令牌就存在他自己的 db.json 里，
  // preload 还会把它交给渲染层。若这些"给自己开通权益"的能力照旧可用，
  // 用户 POST /v1/subs/confirm 造一单、或 POST /v1/paywall/toggle 关墙，收费墙等于不存在。
  // 客户端唯一合法的权益来源 = 运营方私钥签发的授权码（POST /v1/license/activate）。
  // 诚实边界：仍可改 asar/内存绕过；纯离线 DRM 无 100% 方案，不可绕过的版本是 Hosted 模式。
  if (CLIENT_MODE() && (p === '/v1/paywall/toggle' || p === '/v1/subs/confirm' ||
    p === '/v1/subs/rotate-admin-token' || p === '/v1/subs/reset-visitors')) {
    return json(res, 403, {
      ok: false, clientMode: true,
      error: '客户端版本不提供本机开通/改墙能力：请在「激活」页使用授权码（POST /v1/license/activate）',
      activateVia: 'POST /v1/license/activate {"key":"BDS1-..."}'
    });
  }

  // 统一收费闸门：所有已登记为"应收"的端点在此自动拦截（第 15 条）
  try {
    if (autoGate(req, q, res, p)) return;
  } catch (e) {
    // 闸门自身异常绝不能变成 500 把功能打挂——放行并记审计
    store.push('audit', { action: '收费闸门异常', detail: req.method + ' ' + p + ' → ' + String(e.message || e).slice(0, 80), at: Date.now() });
  }

  // —— 变更操作统一限权：白名单外的非 GET 在非回环+无令牌时一律 403 ——
  {
    const m = req.method;
    if ((m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') && !PUBLIC_MUTATE.has(p) && !adminAuthed(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：变更操作需要管理令牌（非回环来源）' });
    }
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token' });
    return res.end();
  }

  // ===== 设备能力扫描 / 自适应速率（第 7 项）=====
  if (p === '/v1/devcap' && req.method === 'GET') {
    try {
      const dc = require('./core/devcap');
      const s = dc.scan();
      return json(res, 200, { ok: true, scan: s, tier: dc.tier(s), plan: dc.plan(s) });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/devcap/plan' && req.method === 'POST') {
    try {
      const dc = require('./core/devcap');
      const b = await readBody(req);
      // 保存人工覆盖：用户显式设定的节奏优先于自动推导
      if (b.overrides && typeof b.overrides === 'object') store.setSetting('devcapOverrides', b.overrides);
      const ov = store.getSetting('devcapOverrides') || {};
      return json(res, 200, { ok: true, plan: dc.effective(ov), source: dc.effective(ov).source });
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 合伙人分润台账（合规单层结构，见 docs/分成与分润设计决策.md）=====
  if (p === '/v1/partner' && req.method === 'GET') {
    try { return json(res, 200, require('./core/partner').board()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/partner/enroll' && req.method === 'POST') {
    try { const b = await readBody(req); const pt = require('./core/partner'); const g = pt.rejectMultilevel(b); if (!g.ok) return json(res, 200, g); return json(res, 200, pt.enroll(b)); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/partner/deliver' && req.method === 'POST') {
    try { const b = await readBody(req); const pt = require('./core/partner'); const g = pt.rejectMultilevel(b); if (!g.ok) return json(res, 200, g); return json(res, 200, pt.deliver(b)); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/partner/deliveries' && req.method === 'GET') {
    // 交付明细查询：支持按 partnerId 筛选
    try {
      const partnerId = q.get('partnerId');
      const db = require('./core/store').read();
      let list = db.deliveries || [];
      if (partnerId) list = list.filter(d => d.partnerId === partnerId);
      list = list.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 200);
      return json(res, 200, { ok: true, list });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/partner/accept' && req.method === 'POST') {
    try { const b = await readBody(req); return json(res, 200, require('./core/partner').accept(b.deliveryId)); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/partner/pay' && req.method === 'POST') {
    try { if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' }); const b = await readBody(req); return json(res, 200, require('./core/partner').pay(b.partnerId)); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/partner/paid' && req.method === 'POST') {
    try { if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' }); const b = await readBody(req); return json(res, 200, require('./core/partner').markPaid(b.partnerId, b.evidence)); }
    catch (e) { return err(res, 200, e.message); }
  }
  // ===== RRSI harness 自优化（用真实业务数据评测，自动改进提示词/工具策略）=====
  if (p === '/v1/harness' && req.method === 'GET') {
    try { return json(res, 200, require('./core/harness').status()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/harness/current' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, harness: require('./core/harness').current() }); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/harness/optimize' && req.method === 'POST') {
    // 真实 LLM 提案 + 真实历史数据评测，耗时可达数十秒
    const b = await readBody(req);
    try { return json(res, 200, await require('./core/harness').runOnce({ t: Number(b.t) || 0, T: Number(b.T) || 6 })); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/harness/rollback' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/harness').rollback(b.version)); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/harness/trajectory' && req.method === 'GET') {
    // 轨迹可读化：返回完整运行历史（含 diff、critic 详情、采纳判定、降级来源）
    // 【Reflection loop 第 4 项硬要求】暴露"改了什么、为什么"，供审计与复盘
    try {
      const limit = Math.min(50, Number(q.get('limit')) || 20);
      const H = require('./core/harness');
      const runs = (require('./core/store').read()[H.RUNS_KEY] || []).slice(0, limit);
      return json(res, 200, { ok: true, runs, count: runs.length });
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 获客引擎（窄定位 + 触达序列 + 转化追踪 + 漏斗诊断）=====
  if (p === '/v1/gtm/icps' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, icps: require('./core/gtm').ICPS, sequences: require('./core/gtm').SEQUENCES }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/gtm/landing' && req.method === 'GET') {
    try { return json(res, 200, require('./core/gtm').landingCopy(String(q.get('icp') || ''))); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/gtm/touch' && req.method === 'POST') {
    // 记录一次触达准备（status=draft）——系统只准备，不群发；需人工确认后 markSent
    const b = await readBody(req);
    try { return json(res, 200, require('./core/gtm').touch(b.key || ('t' + Date.now()), b)); }
    catch (e) { return err(res, 200, e.message); }
  }
  {
    const sentM = p.match(/^\/v1\/gtm\/touch\/([\w-]+)\/sent$/);
    if (sentM && req.method === 'POST') { try { return json(res, 200, require('./core/gtm').markSent(sentM[1])); } catch (e) { return err(res, 200, e.message); } }
    const replyM = p.match(/^\/v1\/gtm\/touch\/([\w-]+)\/reply$/);
    if (replyM && req.method === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, require('./core/gtm').markReply(replyM[1], String(b.outcome || 'no_reply'))); } catch (e) { return err(res, 200, e.message); }
    }
  }
  if (p === '/v1/gtm/funnel' && req.method === 'GET') {
    try { return json(res, 200, require('./core/gtm').funnel()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/gtm/funnel/drill' && req.method === 'GET') {
    // 漏斗下钻：返回指定阶段的线索明细
    try {
      const stage = q.get('stage');
      const db = store.read();
      const leads = db.leads || [];
      const gtmTouches = db.gtmTouches || [];
      let list = leads;
      if (stage) list = leads.filter(l => l.stage === stage);
      // 关联最后触达时间
      list = list.map(l => {
        const touch = gtmTouches.filter(t => t.target === l.name || t.target === l.id).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
        return { ...l, lastTouchAt: touch?.at, lastTouchChannel: touch?.channel, lastTouchOutcome: touch?.outcome };
      });
      return json(res, 200, { ok: true, stage, leads: list.slice(0, 200), at: Date.now() });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/gtm/diagnose' && req.method === 'GET') {
    // 诚实体检：漏斗哪一环断了（用真实数据说话，不自我安慰）
    try { return json(res, 200, require('./core/gtm').diagnose()); } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 游戏开发全流程（自然语言 → 策划 → 代码 → 自检 → 成品 → 微调）=====
  if (p === '/v1/game/engines' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, engines: require('./core/gamestudio').ENGINES }); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/game/build' && req.method === 'POST') {
    // 真实 LLM 生成设计+代码，耗时可达数十秒；自检不过则只存草稿不进成品
    const b = await readBody(req);
    const idea = String(b.idea || '').trim();
    if (!idea) return err(res, 200, '游戏点子必填');
    if (gateSection(req, q, res, 'chatdeep')) return;
    try { return json(res, 200, await require('./core/gamestudio').build(idea, b)); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/game/jobs' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, jobs: require('./core/gamestudio').jobs(Number(q.get('limit') || 20)) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/game/tune' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await require('./core/gamestudio').tune(b.id, b.feedback || '')); } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 器官协作总线（人体式一体：各器官发信号/收信号/反射弧/健康体检）=====
  if (p === '/v1/organs/health' && req.method === 'GET') {
    try { return json(res, 200, require('./core/organs').health()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/organs/beat' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/organs').beat(String(b.id || ''))); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/organs/signal' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, signals: require('./core/organs').signals(Number(q.get('limit') || 30)) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  // ===== 十二生肖养成系统（12 只同屏 · 自主行为 · 互动成长）=====
  if (p === '/v1/zodiac' && req.method === 'GET') {
    try { return json(res, 200, require('./core/zodiac').board()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/zodiac/tick' && req.method === 'POST') {
    // 自主行为调度：按个性/精力/心情/时长推进，前端据此播放动画
    try { const b = await readBody(req); return json(res, 200, require('./core/zodiac').tick({ minGap: Number(b && b.minGap) })); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/zodiac/interact' && req.method === 'POST') {
    // 互动：喂食/玩耍/抚摸/睡觉 → 累积经验、升级、解锁下一只（真实累积，非随机）
    const b = await readBody(req);
    try { return json(res, 200, require('./core/zodiac').interact(b.id, b.kind)); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/zodiac/select' && req.method === 'POST') {
    // 【2026-09】客户选择自己的生肖伙伴：悬浮层只显示这一只，可随时切换。
    // 锁定的不给选（那 9 只属于成长进阶，绕过去等于白送）。
    const b = await readBody(req);
    try { return json(res, 200, require('./core/zodiac').select(b.id)); } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 对话语音播报（第 2 条需求：智能对话要支持语音播报）=====
  // 为什么不用浏览器的 speechSynthesis 当主路径：Electron 里经常一个语音包都没装，
  // 调用不报错但**完全不出声**，用户只会觉得"这个功能坏了"。
  // 主路径改成服务端 edge-tts 生成真实 mp3 再回给前端播放，失败时如实报告缺什么并给安装命令。
  if (p === '/v1/voice' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!text) return err(res, 400, '没有可朗读的内容');
    const lang = b.lang || store.getSetting('lang') || 'zh';
    // 每种语言给一个稳定音色，避免"中文界面读英文"这种错配
    // 【踩过的坑】原来只有 zh/en 两项，末尾 `|| 'zh-CN-YunxiNeural'` 兜底。
    // 于是选阿拉伯语时会**用中文音色去念阿拉伯语** —— 界面已是阿语，声音还是中式发音，
    // 这种"语言混杂"用户不会投诉，只会觉得这软件没做完。
    // 现在 ar 有自己的音色；真不支持时如实报告，而不是默默念错。
    const VOICE_MAP = {
      zh: 'zh-CN-YunxiNeural',
      en: 'en-US-GuyNeural',
      ar: 'ar-EG-ShakirNeural'
    };
    const VOICE = VOICE_MAP[lang];
    if (!VOICE) {
      return json(res, 400, { ok: false, reason: '不支持的朗读语言：' + lang, supported: Object.keys(VOICE_MAP) });
    }
    try {
      const r = await require('./core/studio').synthesize(text, { voice: VOICE, jobId: 'chat-' + Date.now().toString(36) });
      if (r && r.ok && r.file) {
        return json(res, 200, { ok: true, audio: 'data:audio/mpeg;base64,' + fs.readFileSync(r.file).toString('base64'), voice: VOICE, lang });
      }
      // 诚实：不伪造"已生成"。返回明确原因 + 补齐方式。
      return json(res, 200, { ok: false, reason: (r && r.error) || '未知原因', installHint: (r && r.installHint) || 'pip install edge-tts', lang, voice: VOICE });
    } catch (e) {
      return json(res, 200, { ok: false, reason: String(e.message || e).slice(0, 120), installHint: 'pip install edge-tts', lang, voice: VOICE });
    }
  }

  // ===== 写作·音视频制作全流程（自然语言 → 专业稿 → 口播 → 配音 → 成片）=====
  if (p === '/v1/studio/capability' && req.method === 'GET') {
    try { return json(res, 200, await require('./core/studio').capability()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/studio/produce' && req.method === 'POST') {
    // 真实 LLM 写稿 + 真实 TTS + 真实 ffmpeg，耗时可达数十秒；失败环节如实报告
    const b = await readBody(req);
    const topic = String(b.topic || '').trim();
    if (!topic) return err(res, 200, '选题必填');
    if (gateSection(req, q, res, 'chatdeep')) return;
    try { return json(res, 200, await require('./core/studio').produce(topic, b)); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/studio/jobs' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, jobs: require('./core/studio').jobs(Number(q.get('limit') || 20)) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  // ===== 系统状态（前端启动即拉，8家模型状态也在这）=====
  if (p === '/v1/status' && req.method === 'GET') {
    const pl = providers.list();
    return json(res, 200, {
      ok: true, version: VERSION, uptimeMs: Date.now() - STARTED,
      devcap: (function () { try { return require('./core/devcap').plan(); } catch (e) { return null; } })(),
      providers: pl,
      settings: (function () { const o = {}; const s = store.read().settings || {}; Object.keys(s).forEach(k => { if (['visitorSecret', 'adminToken', 'mailAuth', 'smtpAuth', 'smtpPass', 'outreachReplyToken', 'crawlerOn', 'crawlerTopics'].indexOf(k) < 0) o[k] = s[k]; }); return o; })(),
      stats: { decisions: store.decisionStats(), org: store.orgStats() },
      brain: {
        recommended: brain.recommendedProvider(pl),
        learn: brain.learnStats(),
        // 【2026-09】只要条数就别复制数组：evolution()/memories() 每次都会
        // slice().reverse() 全量复制，而这里只需要 .length。
        evolutionTotal: brain.countEvolution(),
        memoryCount: brain.countMemories()
      },
      skillsTotal: skills.registry().total,
      talentsCount: talents.count(),
      decisionFrameworks: decision.stats().total,
      autopilot: autopilot.status(),
      money: (function () { try { return money.kpi(); } catch (e) { return null; } })(),
      watch: (function () { try { return watchdog.status(); } catch (e) { return null; } })(),
      lastTurn: state.lastTurn
    });
  }

  // ===== 8 家模型状态 =====
  if (p === '/v1/providers' && req.method === 'GET') {
    const pl = providers.list();
    const gh = providers.envFiles ? providers.envFiles() : {};
    const ghKey = gh['GITHUB_TOKEN'] || '';
    pl.push({ id: 'github', name: 'GitHub 检索', env: 'GITHUB_TOKEN', hasKey: !!ghKey, keyMask: ghKey ? ghKey.slice(0, 4) + '…' : '', model: 'API 限流提升（可选，不填用匿名）', color: '#24292f' });
    return json(res, 200, { ok: true, providers: pl });
  }

  // ===== 智能对话：历史 =====
  if (p === '/v1/messages' && req.method === 'GET') {
    const limit = Number(q.get('limit') || 50);
    return json(res, 200, { ok: true, messages: store.list('messages', limit) });
  }

  // ===== 智能对话：发送（命令路由 + 记忆召回 + 智能降级 + 学习进化）=====
  if (p === '/v1/chat' && req.method === 'POST') {
    const b = await readBody(req);
    const text = (b.text || '').trim();
    if (!text) return err(res, 400, '内容不能为空');

    const lang = b.lang || store.getSetting('lang') || 'zh';
    const files = Array.isArray(b.files) ? b.files : [];
    const thread = String(b.thread || '').slice(0, 40) || null;
    // 深度思考是高价值能力：非订阅按 chatdeep 节配额计费；订阅不限。
    const depth = !!b.depth;
    if (depth) {
      if (gateSection(req, q, res, 'chatdeep')) return;
    }

    // 1) 命令路由：以 / 开头先进 brain，命中即直接应答并回包
    const cmd = brain.routeCommand(text, { lang });
    if (cmd) {
      store.push('messages', { role: 'user', content: text }, '命令·执行');
      if (cmd.kind === 'setting') {
        try {
          store.setSetting(cmd.key, cmd.value);
          cmd.text = '系统设置已更新：' + cmd.key + ' = ' + cmd.value;
        } catch (e) { }
      }
      store.push('messages', { role: 'assistant', content: cmd.text, engine: 'brain-command' }, '命令·应答');
      store.push('audit', { action: '命令', detail: text.slice(0, 80), at: Date.now() });
      store.push('decisions', { question: text, answer: cmd.text.slice(0, 300), engine: 'brain-command', source: 'command' }, '命令决策', text.slice(0, 60));
      return json(res, 200, { ok: true, reply: cmd.text, engine: 'brain-command', provider: 'command', lang });
    }

    // 1.5) 服务器级命令：/summary /knowledge /task /agents
    const rep = async reply => {
      store.push('messages', { role: 'assistant', content: reply, engine: 'brain-action' }, '命令·应答');
      store.push('audit', { action: '命令', detail: text.slice(0, 80), at: Date.now() });
      return json(res, 200, { ok: true, reply, engine: 'brain-action', provider: 'command', lang });
    };
    const scmd = text.match(/^\/(summary|knowledge|task|project|agents|find)\b/i);
    if (scmd) {
      const act = '/' + scmd[1].toLowerCase();
      const rest = text.slice(scmd[0].length).trim();
      store.push('messages', { role: 'user', content: text }, '命令·执行');

      if (act === '/find') {
        const kw = rest.toLowerCase();
        if (!kw) return rep('用法：/find <关键词> —— 全局检索记忆/知识/任务/项目/审计，一处查询处处联动。');
        const db = store.read();
        const hit = s => String(s || '').toLowerCase().includes(kw);
        const out = [];
        const mem = (db.memory || []).filter(m => hit(m.key) || hit(m.value)).slice(-5);
        if (mem.length) out.push('【记忆】' + mem.map(m => m.value).join(' | '));
        const kn = (db.knowledge || []).filter(x => hit(x.q) || hit(x.a)).slice(-5);
        if (kn.length) out.push('【知识】' + kn.map(x => x.q).join(' | '));
        const tasks = (db.tasks || []).filter(t => hit(t.title)).slice(-5);
        if (tasks.length) out.push('【任务】' + tasks.map(t => t.title + (t.done ? '✓' : '')).join(' | '));
        const proj = (db.projects || []).filter(p => hit(p.name) || hit(p.desc)).slice(-5);
        if (proj.length) out.push('【项目】' + proj.map(p => p.name).join(' | '));
        const aud = (db.audit || []).filter(a => hit(a.action) || hit(a.detail)).slice(-5);
        if (aud.length) out.push('【审计】' + aud.map(a => a.action + ':' + a.detail).join(' | '));
        brain.evolve('全局检索：' + rest.slice(0, 40));
        return rep(out.length ? '全局检索「' + rest + '」命中 ' + (mem.length + kn.length + tasks.length + proj.length + aud.length) + ' 处：\n' + out.join('\n') : '全局检索「' + rest + '」无命中。');
      }
      if (act === '/summary') {
        const db = store.read();
        const os_ = state.orgStats || store.orgStats();
        const t = [
          '【系统摘要】', '引擎 v' + VERSION + ' · 在线 ' + Math.floor((Date.now() - STARTED) / 60000) + ' 分钟',
          '决策 ' + store.decisionStats().total + ' 条 · 今日 ' + store.decisionStats().today,
          '员工 ' + os_.headcount + ' 人(在岗 ' + os_.active + ') · 项目 ' + os_.projects + ' 个',
          '任务 ' + (db.tasks || []).length + ' 项 · 记忆 ' + (db.memory || []).length + ' 条 · 知识 ' + (db.knowledge || []).length + ' 条',
          '进化节点 ' + (db.evolution || []).length + ' 个 · 自适应通道 ' + (brain.recommendedProvider(providers.list()) || '未配置')
        ].join('\n');
        return rep(t);
      }
      if (act === '/knowledge') {
        const idx = rest.search(/[|｜]/);
        if (idx <= 0) return rep('用法：/knowledge 问题 | 答案 —— 沉淀一条知识，之后提问会自动命中。');
        const q = rest.slice(0, idx).trim(), a = rest.slice(idx + 1).trim();
        knowledge.add(q, a, 'chat');
        brain.evolve('知识库新增：' + q.slice(0, 40));
        return rep('知识已沉淀（共 ' + knowledge.stats().total + ' 条）：\nQ:' + q + '\nA:' + a);
      }
      if (act === '/task') {
        if (!rest) return rep('用法：/task 要做的事 [| 截止]，例如 /task 周四前完成上线检查 | 周四 18:00');
        const [title, due] = rest.split(/[|｜]/);
        // 第 5 条：聊天下达任务走统一链路 → 建完立刻派工，回复里告诉用户派给了谁
        const r = require('./core/assign-work').createTask({
          title: title.trim(), due: (due || '').trim(), ref: 'chat'
        });
        if (!r.ok) return rep('任务未创建：' + r.error);
        brain.evolve('任务创建：' + title.trim().slice(0, 40));
        const t = r.task;
        let msg = '任务已创建 [' + t.id + ']：' + t.title
          + (t.due ? '（截止 ' + t.due + '）' : '') + ' —— 可在"任务台"跟踪。';
        // 第 4 条：把派工结果讲清楚，否则用户不知道活归谁
        if (t.ownerName) {
          msg += '\n已认领：' + t.ownerName + '（' + t.role + '）· 状态' + (t.status === 'running' ? '在跑' : '待认领');
          if (t.need && t.need.length) msg += '\n所需能力：' + t.need.join('、');
        } else if (r.team && r.team.hired && r.team.hired.length) {
          msg += '\n（该技能无人具备，系统已自动增员：' + r.team.hired.map(h => h.role + '·' + h.name).join('、') + '）';
        } else {
          msg += '\n暂无合适人选认领（能力缺口已记录，可在组织大脑补人）。';
        }
        return rep(msg);
      }
      // 第 5 条：/project 建项目，可连带下达第一个任务
      if (act === '/project') {
        const [name, first] = rest.split(/[|｜]/);
        if (!name) return rep('用法：/project 项目名 [| 第一个要做的任务]');
        const r = require('./core/assign-work').createProject({ name: name.trim(), createdBy: 'chat', firstTask: (first || '').trim() || undefined });
        if (!r.ok) return rep('项目未创建：' + r.error);
        let msg = '项目已创建 [' + r.project.id + ']：' + r.project.name + ' —— 可在"项目管理"跟踪。';
        if (r.task) msg += '\n首个任务：' + r.task.title + (r.task.ownerName ? '\n已派给：' + r.task.ownerName + '（' + r.task.role + '）' : '\n待认领（能力缺口已记录）');
        return rep(msg);
      }
      if (act === '/agents') {
        const sp = rest.split(/\s+/);
        let agId = sp.shift() || '';
        const question = sp.join(' ').trim();
        if (agId === 'team') {
          if (!question) return rep('用法：/agents team <问题> —— 全员并行会诊，输出分工/共识/分歧/行动。');
          try {
            const out = await agents.team(question, { lang, depth: !!b.depth });
            return rep(out.content);
          } catch (e) { return rep('团队会诊失败：' + e.message); }
        }
        if (!question) return rep('用法：/agents <专家> <问题>。专家：analyst 分析专家 · strategist 战略顾问 · planner 项目策划 · critic 风控审计 · grower 增长专家 · builder 落地工程师 ；或 /agents team <问题> 全员会诊。');
        const ag = agents.AGENTS.find(a => a.id === agId || a.name === agId) || agents.AGENTS.find(a => a.name.startsWith(agId));
        if (!ag) return rep('未知专家 ' + agId + '。可选：analyst / strategist / planner / critic / grower / builder / team');
        try {
          const out = await agents.consult(ag.id, question, { lang, depth: !!b.depth });
          return rep('【' + ag.name + ' · ' + out.engine + '】\n' + out.content);
        } catch (e) { return rep('专家会诊失败：' + e.message); }
      }
    }

    // 2) 记忆召回 + 知识召回：相关记忆与沉淀知识注入上下文
    const mem = brain.recall(text).slice(0, 3);
    const kn = knowledge.recall(text, 3);

    // 2.5) 智能增强：能力路由 + 技能调用 + 缺口装载 + 反推脱契约（第 2 条需求）
    // 关键改动：不再只做 smart.enrich()，而是走 orchestrator.prepare()。
    // 差别在于 prepare() 会：
    //   a) 先调本软件 17 项能力模块，把**真实业务数据**递进上下文（原来只有 3 项硬编码）
    //   b) 判定能力缺口 → 自动检索可装载技能
    //   c) 注入反推脱契约，并记录契约文本供输出后校验
    const ORCH = require('./core/orchestrator');
    const prep = await ORCH.prepare(text, { max: 3 }).catch(e => ({
      context: [], tools: [], intent: 'chat', gap: null, discovery: null,
      error: String(e.message || e)
    }));
    const enh = { intent: prep.intent, tools: prep.tools, context: prep.context };
    const usedTools = prep.tools || [];

    // 3) provider 选择：指定优先；无密钥/已劣化则走自适应推荐；随后串行降级尝试直到成功
    let providerId = b.provider || store.getSetting('provider') || null;
    const pl = providers.list();
    // 候选顺序：用户/设置指定的（若可用）→ 排行榜
    const order = [];
    const ranked = brain.recommendedProviders(pl);
    if (providerId && brain.providerUsable(providerId, pl)) order.push(providerId);
    ranked.forEach(id => { if (!order.includes(id)) order.push(id); });
    if (!order.length) {
      return err(res, 200, '所有模型通道均不可用（无密钥或近期调用失败率过高）。请在 .env 填入密钥，或检查通道余额：' + pl.map(x => x.id + (x.hasKey ? '✓' : '✗')).join(' / '));
    }

    // 4) 组上下文：长会话用 thread（note 摘要 + 近期回合），未命名则退化为全局最近 10 条
    let hist = [];
    let notePrefix = '';
    if (thread) {
      const tc = brain.threadContext(thread, 8);
      notePrefix = tc.note;
      hist = tc.hist;
    } else {
      hist = store.list('messages', 10).reverse().map(m => ({ role: m.role, content: m.content }));
    }
    let userMsg = text;
    if (files.length) userMsg += '\n\n[附件 ' + files.map(f => f.name + '(' + (f.type || '?') + ')').join(', ') + ']';
    hist.push({ role: 'user', content: userMsg });

    const langName = { zh: '中文', en: 'English', fr: 'Francais', ar: 'العربية' }[lang] || '中文';
    // RRSI harness 接入：系统提示词与上下文装配策略来自 core/harness.js（可被 RRSI 优化器自动改进）。
    // 「用某语言回答」是每次请求的动态参数，不属于可优化配置，故单独保留。
    let HARNESS = null;
    try { HARNESS = require('./core/harness').current(); } catch (e) { }
    const sysParts = [(HARNESS && HARNESS.systemPrompt) || '你是丙大山AI智能助理，具备记忆、知识、学习与进化能力。'];
    sysParts.push('请用 ' + langName + ' 回答，简洁、专业、可执行。');
    if (notePrefix) sysParts.push('这是本线程的长期记忆（之前聊过的重点，务必延续认可，不要说忘了）：\n' + notePrefix);
    if (usedTools.length) sysParts.push('本回合已自动调取真实工具/联网情报（结果在下方【工具上下文】，务必引用其数据回答，不要凭空编造）：');
    if (mem.length) sysParts.push('相关历史记忆：\n' + mem.map(m => '- [' + m.key + '] ' + m.value).join('\n'));
    if (kn.length) sysParts.push('团队已沉淀知识（优先据此回答）：\n' + kn.map(x => '- Q:' + x.q + ' | A:' + x.a).join('\n'));
    // 上下文预算（成本闸的实际执行点）：超预算按优先级截断，控制单轮 token 开销
    const ctxBudget = (HARNESS && HARNESS.contextPolicy && HARNESS.contextPolicy.maxContextChars) || 6000;
    let ctxJoined = (enh.context || []).join('\n');
    if (ctxJoined.length > ctxBudget) ctxJoined = ctxJoined.slice(0, ctxBudget) + '\n[上下文超预算已截断]';
    if (ctxJoined) sysParts.push(ctxJoined);
    if (depth) sysParts.push('这是深度思考请求：请把推理过程结构化呈现（假设→依据→结论），给出可执行建议与风险提示。');
    const sys = { role: 'system', content: sysParts.join('\n') };

    const t0 = Date.now();
    let lastErr = '';
    try {
      // 串行降级：按候选顺序尝试，成功即返回；全部失败抛最后错误
      for (const cand of order) {
        try {
          let out = await providers.chat({ provider: cand, model: b.model, messages: [sys].concat(hist), temperature: depth ? 0.3 : 0.7 });

          // —— 反推脱强制（第 2 条需求）——
          // 只在系统提示里写"不要拒绝"是不够的：模型训练时就倾向在不确定时谦逊回避。
          // 所以这里做**输出后校验**：命中推脱话术就作废这一版，用强制契约重问一次。
          // 只重问一次，避免遇到"坚持己见"的模型时死循环（外层 provider 降级链会兜底）。
          const chk = ORCH.verify(out.content);
          let refused = null;
          if (!chk.ok) {
            try {
              const out2 = await providers.chat({
                provider: cand, model: b.model,
                messages: [sys, { role: 'system', content: ORCH.strictContract() }].concat(hist)
                  .concat([{ role: 'assistant', content: out.content }, { role: 'user', content: '请按硬性要求重新作答。' }]),
                temperature: 0.3
              });
              const chk2 = ORCH.verify(out2.content);
              // 重答合格、或明显比原答案更充实，才采纳；否则保留原答案（总比空手好）
              if (out2 && out2.content && (chk2.ok || out2.content.length > out.content.length)) {
                refused = chk.hits;
                out = out2;
              }
            } catch (e3) { /* 重问失败就沿用原答案，不影响主流程 */ }
          }

          // 【2026-09·防卡死】以下 611–629 行原本是 11–12 次同步写盘
          // （learnResult 2 + evolve 2 + push messages 2 + push audit 1 + push decisions 1
          //   + threadPush 1 + rememberAuto 1 + tenancy 2），
          // 也就是**每一次对话都要把近 1MB 的库重新序列化 11 遍**，全程堵死事件循环。
          // 这一段在 await providers.chat 之后全是同步代码，符合 store.batch() 的
          // "同一调用栈"前提，N 次写压成 1 次。
          let mrec, drec, memd, ask;
          store.batch(() => {
            brain.learnResult(cand, true, Date.now() - t0);
            if (cand !== order[0]) brain.evolve('对话自动降级：' + order[0] + ' → ' + cand + '（' + lastErr.slice(0, 40) + '）');
            else brain.evolve('对话引擎 ' + out.engine + ' 正常响应 (' + (Date.now() - t0) + 'ms)');

            mrec = store.push('messages', { role: 'user', content: text, files: files.map(f => f.name) }, '对话·用户');
            try { require('./core/tenancy').markOwned('messages', mrec, visitorOf(req, q, res)); } catch (e) { }
            if (usedTools.length) {
              brain.evolve('对话智能调用工具：' + usedTools.map(t => t.id).join(', '));
              store.push('audit', { action: '对话·自动调工具', detail: text.slice(0, 60) + ' → ' + usedTools.map(t => t.id + (t.elapsedMs ? '(' + t.elapsedMs + 'ms)' : '')).join(', '), at: Date.now() });
            }
            store.push('messages', { role: 'assistant', content: out.content, provider: out.provider, engine: out.engine, tools: usedTools.map(t => t.id) }, '对话·AI');
            drec = store.push('decisions', { question: text, answer: out.content.slice(0, 400), engine: out.engine, source: out.provider }, '新增决策', text.slice(0, 80));
            // 数据归属：对话产生的决策属于提问者本人
            try { require('./core/tenancy').markOwned('decisions', drec, visitorOf(req, q, res)); } catch (e) { }
            state.lastTurn = { at: Date.now(), engine: out.engine, provider: out.provider };
            // 记忆进化：线程推送（长会话压缩记忆） + 主题结论沉淀（7 天去重） + 人性化追问
            if (thread) brain.threadPush(thread, 'user', text);
            memd = brain.rememberAuto(thread ? ('线程' + thread) : text, (enh.intent === 'decision' ? '决策咨询：' : '对话主题：') + text.slice(0, 40) + '｜结论：' + out.content.replace(/\s+/g, ' ').slice(0, 120));
            ask = brain.followUp(enh.intent, text);
          });

          return json(res, 200, { ok: true, reply: out.content + (ask ? '\n\n↳ ' + ask : ''), engine: out.engine, provider: out.provider, lang, degraded: out.provider !== order[0], tools: usedTools.map(t => t.id), intent: enh.intent, memory: memd, thread, gap: prep.gap || null, discovery: prep.discovery || null, refused: refused || null });
        } catch (e2) {
          lastErr = String(e2.message || e2);
          brain.learnResult(cand, false, Date.now() - t0);
        }
      }
      throw new Error(lastErr || '所有通道调用失败');
    } catch (e) {
      brain.evolve('对话引擎失败：' + lastErr.slice(0, 60));
      store.push('audit', { action: '对话失败', detail: lastErr.slice(0, 200) }, '对话失败', lastErr.slice(0, 120));
      return err(res, 200, lastErr || '所有模型通道均失败');
    }
  }

  // ===== 大脑：记忆 =====
  if (p === '/v1/brain/memory') {
    if (req.method === 'GET') return json(res, 200, { ok: true, memories: brain.memories(Number(q.get('limit') || 50)) });
    if (req.method === 'POST') { const b = await readBody(req); return json(res, 200, brain.remember(b.key, b.value)); }
  }
  if (p === '/v1/brain/recall' && req.method === 'GET') {
    return json(res, 200, { ok: true, memories: brain.recall(q.get('q') || '') });
  }

  // ===== 大脑：学习统计 + 进化日志 + 自适应推荐 =====
  if (p === '/v1/brain/learn' && req.method === 'GET') {
    return json(res, 200, { ok: true, learn: brain.learnStats() });
  }
  if (p === '/v1/brain/evolution' && req.method === 'GET') {
    return json(res, 200, { ok: true, evolution: brain.evolution() });
  }

  // ===== 决策中心 =====
  if (p === '/v1/decisions') {
    if (req.method === 'GET') {
      if (q.get('format') === 'csv') {
        const rows = store.list('decisions');
        const csv = store.toCsv(rows, ['id', 'question', 'answer', 'engine', 'source', 'createdAt']);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="decisions.csv"' });
        return res.end('﻿' + csv);
      }
      return json(res, 200, { ok: true, decisions: store.list('decisions', Number(q.get('limit') || 50)), stats: store.decisionStats() });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b.question) return err(res, 400, 'question 必填');
      const rec = store.push('decisions', { question: b.question, answer: b.answer || '', engine: b.engine || 'manual', source: 'manual' }, '新增决策', b.question.slice(0, 80));
      // 数据归属（留存根因）：给用户主动产生的决策打上 visitor，"我的决策"才有东西可失去
      try { require('./core/tenancy').markOwned('decisions', rec, visitorOf(req, q, res)); } catch (e) { }
      return json(res, 200, { ok: true, decision: rec });
    }
  }
  // 我的沉淀（数据归属 + 复购价值锚点）
  if (p === '/v1/my/assets' && req.method === 'GET') {
    try {
      const vid = visitorOf(req, q, res);
      const t = require('./core/tenancy');
      const details = {};
      t.OWNABLE.forEach(c => { details[c] = t.ownedBy(c, vid, 50); });
      return json(res, 200, Object.assign({ ok: true, summary: t.myDataSummary(vid) }, details));
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 组织大脑：员工（自建/点选/状态）=====
  if (p === '/v1/org/staff') {
    if (req.method === 'GET') return json(res, 200, { ok: true, staff: store.list('staff'), stats: store.orgStats() });
    if (req.method === 'POST') {
      const b = await readBody(req);
      // 一人公司：一键生成全角色矩阵（12 角色，真实数据落库）
      if (b.one && b.one === true) {
        const MATRIX = [
          ['艾睿', 'CEO/战略', ['战略', '增长']], ['南犹', '产品经理', ['需求', 'Roadmap']],
          ['小满', '架构师', ['系统设计', '技术选型']], ['阿澄', '前端工程师', ['React', 'CSS']],
          ['晓禾', '后端工程师', ['Node', 'API']], ['拾光', '数据工程师', ['SQL', 'ETL']],
          ['一宁', '算法工程师', ['ML', '预测']], ['宇安', '测试工程师', ['自动化', 'QA']],
          ['青梧', 'UI/UX 设计师', ['Figma', '动效']], ['牧原', '运营增长', ['投放', 'SEO']],
          ['玄镜', '财务与风控', ['预算', '合规']], ['渡川', '客户成功', ['支持', 'CS']]
        ];
        // 【2026-09·防卡死】原为 MATRIX.forEach(store.push) = 12 次同步写盘（≈1.2s 阻塞）。
        // 改 pushMany 一次落盘。
        store.pushMany('staff', MATRIX.map(([name, role, skills]) => ({ name, role, skills, status: 'on' })),
          '矩阵·一人公司（批量）', MATRIX.length + ' 角色');
        brain.evolve('一人公司矩阵启动：12 角色全部就位');
        return json(res, 200, { ok: true, matrix: MATRIX.length, staff: store.list('staff') });
      }
      if (!b.name) return err(res, 400, 'name 必填');
      const rec = store.push('staff', {
        name: b.name, role: b.role || '成员',
        skills: Array.isArray(b.skills) ? b.skills : [],
        status: b.status || 'on'
      }, '新增员工', b.name + ' · ' + (b.role || '成员'));
      return json(res, 200, { ok: true, staff: rec });
    }
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      const rec = store.update('staff', b.id, b.patch || {}, '更新员工 ' + b.id);
      if (!rec) return err(res, 404, 'staff not found');
      return json(res, 200, { ok: true, staff: rec });
    }
    if (req.method === 'DELETE') {
      const b = await readBody(req);
      const ok = store.remove('staff', b.id, '删除员工 ' + b.id);
      return json(res, 200, { ok });
    }
  }
  if (p === '/v1/org/stats' && req.method === 'GET') {
    return json(res, 200, { ok: true, stats: store.orgStats() });
  }

  // ===== 项目管理（多项目并行）=====
  if (p === '/v1/projects') {
    if (req.method === 'GET') {
      // 第 5 条收尾：项目不能只给裸记录。带上的统计全部由 core/assign-work.projectBoard()
      // 从真实任务表派生：taskTotal/taskDone/taskPct/taskOverdue/taskUnclaimed/noTasks/
      // lastActivityDays。一个项目 0 任务就是事实——noTasks:true，界面显示"未拆解"，
      // 而不是假装完成 0% 或把整行隐藏。progress（人工口径）与 task*（子任务口径）并存。
      return json(res, 200, require('./core/assign-work').projectBoard());
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b.name) return err(res, 400, 'name 必填');
      // 第 5 条：项目创建与首个任务下达走同一条链路（原来只有建项目，不派工）
      const r = require('./core/assign-work').createProject(b);
      if (!r.ok) return err(res, 400, r.error);
      return json(res, 200, r);
    }
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      const rec = store.update('projects', b.id, b.patch || {}, '更新项目 ' + b.id);
      if (!rec) return err(res, 404, 'project not found');
      return json(res, 200, { ok: true, project: rec });
    }
    if (req.method === 'DELETE') {
      const b = await readBody(req);
      return json(res, 200, { ok: store.remove('projects', b.id, '删除项目 ' + b.id) });
    }
  }

  // ===== 任务台（待办闭环，自动下滑）=====
  if (p === '/v1/tasks') {
    if (req.method === 'GET') {
      const AW = require('./core/assign-work');
      const db = store.read();
      const all = (db.tasks || []).map(t => {
        const staff = db.staff || [];
        // 展开负责人：owner 存的是 id，但 goalpilot/老数据可能没有 ownerName，补上
        let ownerName = t.ownerName || '';
        let role = t.role || '';
        if (!ownerName && t.owner) {
          const s = staff.find(x => x.id === t.owner);
          if (s) { ownerName = s.name; role = s.role; }
        }
        let projectName = '', projectStatus = '', projectId = t.projectId || '';
        if (projectId) {
          const pr = (db.projects || []).find(x => x.id === projectId);
          if (pr) { projectName = pr.name; projectStatus = pr.status; }
        }
        return Object.assign({}, t, {
          ownerName, role,
          projectId, projectName, projectStatus,
          overdue: AW.isOverdue(t),                 // 未完成且 due 已过
          claimedBy: t.owner ? (ownerName || t.owner) : ''
        });
      });
      const open = all.filter(t => !t.done);
      // 第 6 条："任务台是明确任务数量和进展的，确认有多少任务在跑"
      // 判定口径（只说有依据的，不凭空猜）：
      //   running = 未完成 且 已认领（有 owner —— team.assign 派出去时一定写
      //             status:'running'，goalpilot 等老数据可能缺这字段，认领即算在跑）
      //             或 显式 running 状态
      //   blocked = 显式标记阻塞
      //   overdue = AW.isOverdue（due 已过且未完成；解析不出的 due 按未逾期对待）
      //   unclaimed = 未完成且无 owner（没人认领——如实单列，不硬塞错配的人）
      const isRunningTask = t => !t.done && (t.running === true || t.status === 'running' || !!t.owner);
      const running = open.filter(isRunningTask);
      const blocked = open.filter(t => t.blocked === true || t.status === 'blocked');
      const overdue = open.filter(t => t.overdue);
      const unclaimed = open.filter(t => !t.owner);
      const withDue = open.filter(t => t.due);

      // 按来源分组计数（ref 前缀是可靠的来源标记）
      // 【口径必须和 runningCount 一致】初版用 `!t.done` 统计"(在跑)"，
      // 冒烟测抓出矛盾：goalpilot 挂在看板"goalpilot·在跑 1"，runningCount 却是 0。
      // 判定漏了 owner/status —— 报表自己打自己脸。统一走同一判定函数。
      const bySource = {};
      const srcOf = t => {
        const r = String(t.ref || '');
        if (/^decision:/.test(r)) return 'decision';
        if (r === 'goalpilot') return 'goalpilot';
        if (/^project:/.test(r)) return 'project';
        if (r === 'chat') return 'chat';
        if (r === 'manual') return 'manual';
        if (r) return 'other';                      // 如实归入“其他”，不瞎起名
        return 'none';
      };
      all.forEach(t => {
        const k = srcOf(t);
        bySource[k] = (bySource[k] || 0) + 1;
        bySource[k + '(在跑)'] = (bySource[k + '(在跑)'] || 0) + (isRunningTask(t) ? 1 : 0);
      });

      // 按项目分组：子任务完成率是项目真实推进的一个切片（不代替手工 progress）
      const byProject = {};
      all.forEach(t => {
        if (!t.projectId) return;
        const p = byProject[t.projectId] || (byProject[t.projectId] = { projectId: t.projectId, name: t.projectName || '', total: 0, done: 0 });
        p.total += 1;
        if (t.done) p.done += 1;
      });
      Object.keys(byProject).forEach(k => {
        byProject[k].pct = byProject[k].total ? Math.round(byProject[k].done / byProject[k].total * 100) : 0;
        const pr = (db.projects || []).find(x => x.id === byProject[k].projectId);
        if (pr) byProject[k].projectStatus = pr.status;
      });

      // 决策焦点进度一并带出（第 3 条派发的指向性任务就在这些任务里）
      let focus = null;
      try { focus = require('./core/decision-focus').progress(); } catch (e) { }
      return json(res, 200, {
        ok: true, tasks: all, open, done: all.length - open.length,
        running, runningCount: running.length,
        blocked, blockedCount: blocked.length,
        overdue, overdueCount: overdue.length,
        unclaimed, unclaimedCount: unclaimed.length,
        withDue, withDueCount: withDue.length,
        bySource, byProject,
        focus
      });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b.title) return err(res, 400, 'title 必填');
      // 收口到 assign-work：建完立刻派工（第 4 条），不再出现"建了没人认领"
      const r = require('./core/assign-work').createTask(b);
      if (!r.ok) return err(res, 400, r.error);
      return json(res, 200, { ok: true, task: r.task, team: r.team, parsed: r.parsed });
    }
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      const rec = store.update('tasks', b.id, b.patch || {}, '更新任务 ' + b.id);
      if (!rec) return err(res, 404, 'task not found');
      if (b.patch && b.patch.done === true) {
        brain.evolve('任务完成：' + rec.title.slice(0, 40));
        store.push('decisions', { question: '任务完成复盘：' + rec.title, answer: '已完成' + (rec.due ? '（原定截止 ' + rec.due + '）' : '') + '，闭环已记录，相关知识建议沉淀至 /knowledge。', engine: 'task-closure', source: 'tasks' }, '任务闭环', '完成 ' + rec.title.slice(0, 50));
        // 第 6 条：任务完成 → 回填所属项目的"子任务进度"。
        // 【边界】不碰项目自己维护的 progress（那可能是手工/经营口径），只维护独立的
        // taskDone/taskTotal/taskPct，任务台与项目看板都按它展示"子任务推进"。
        if (rec.projectId) {
          const d1 = store.read();
          const pr = (d1.projects || []).find(x => x.id === rec.projectId);
          if (pr) {
            const tks = (d1.tasks || []).filter(t => t.projectId === rec.projectId);
            pr.taskDone = tks.filter(t => t.done).length;
            pr.taskTotal = tks.length;
            pr.taskPct = tks.length ? Math.round(pr.taskDone / tks.length * 100) : 0;
            store.write(d1);
          }
        }
      }
      if (b.patch && b.patch.done === false) brain.evolve('任务重开：' + rec.title.slice(0, 40));
      return json(res, 200, { ok: true, task: rec });
    }
    if (req.method === 'DELETE') {
      const b = await readBody(req);
      return json(res, 200, { ok: store.remove('tasks', b.id, '删除任务 ' + b.id) });
    }
    return err(res, 405, 'method not allowed');
  }

  // ===== 任务认领（第 6 条：把"没人认领的任务"接上人）=====
  // 前端任务台"认领未分配任务"按钮的落点。原来只有建任务时才顺带 team.assign，
  // goalpilot / decision-focus 直接建的任务由此按钮一键认领 → 进入在跑。
  if (p === '/v1/tasks/claim' && req.method === 'POST') {
    const b = await readBody(req);
    const r = require('./core/assign-work').claimPending({ autoHire: b && b.autoHire !== false });
    return json(res, 200, { ok: r.ok, error: r.error || undefined, ...r });
  }

  // ===== 决策框架库（决策中心升级：50+ 方法论真实应用）=====
  if (p === '/v1/decisions/frameworks' && req.method === 'GET') {
    return json(res, 200, { ok: true, frameworks: decision.list(), stats: decision.stats() });
  }
  if (p === '/v1/decisions/suggest' && req.method === 'GET') {
    if (gateSection(req, q, res, 'decision')) return;
    const topic = q.get('topic') || '';
    return json(res, 200, { ok: true, suggest: decision.suggest(topic) });
  }
  if (p === '/v1/decisions/accuracy' && req.method === 'GET') {
    if (gateSection(req, q, res, 'decision')) return;
    return json(res, 200, { ok: true, benchmark: decision.benchmark() });
  }
  if (p === '/v1/decisions/apply' && req.method === 'POST') {
    if (gateSection(req, q, res, 'decision')) return;
    const b = await readBody(req);
    if (!b.framework) return err(res, 400, 'framework 必填');
    try {
      const r = decision.apply(b.framework, b.topic || b.question || '', Array.isArray(b.vals) ? b.vals : undefined);
      // 应用结果沉淀为决策（真实落库，可回溯）
      store.push('decisions', {
        question: '【' + r.framework + '】' + r.topic,
        answer: r.content.slice(0, 500),
        engine: 'framework:' + b.framework,
        source: 'decision-center'
      }, '决策框架应用', r.framework + ' · ' + r.topic.slice(0, 60));
      brain.evolve('决策框架「' + r.framework + '」应用于：' + r.topic.slice(0, 40));
      return json(res, 200, { ok: true, decision: r });
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== Colibri式决策推理引擎：五步流水线（Route/Union/Place/Overlap/Learn）=====
  if (p === '/v1/decisions/infer' && req.method === 'POST') {
    if (gateSection(req, q, res, 'decision')) return;
    const b = await readBody(req);
    const topic = String(b.topic || b.question || '').trim();
    if (!topic) return err(res, 400, 'topic 必填');
    try {
      const de = require('./core/decision_engine');
      const r = de.infer(topic, { k: b.k, usePrefetch: b.usePrefetch !== false });
      return json(res, 200, r);
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 决策中心 ↔ 智能聊天 互通（第 3 条）=====
  // 之前只有一个方向：从聊天里"看"决策焦点（chatDirective）。
  // 现在补齐：文本归域、聊天自动登记焦点、当前可推进动作。
  if (p === '/v1/decision-bridge/domain' && req.method === 'GET') {
    const t = String(q.get('text') || '').trim();
    if (!t) return err(res, 400, 'text 必填');
    try {
      const B = require('./core/decision-bridge');
      const inf = B.inferDomain(t);
      return json(res, 200, {
        ok: true, text: t, domain: inf.domain, key: inf.key,
        score: inf.score, confidence: inf.confidence,
        hit: inf.hit || [], candidates: inf.candidates || [],
        reason: inf.reason,
        isDecision: B.looksLikeDecision(t)
      });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/decision-bridge/sync' && req.method === 'POST') {
    if (gateSection(req, q, res, 'decision')) return;
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!text) return err(res, 400, 'text 必填');
    try {
      const B = require('./core/decision-bridge');
      const r = await B.syncFromChat(text, { force: !!b.force });
      return json(res, 200, Object.assign({ ok: true }, r, {
        focus: require('./core/decision-focus').current(),
        progress: require('./core/decision-focus').progress()
      }));
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/decision-bridge/moves' && req.method === 'GET') {
    try {
      return json(res, 200, { ok: true, ...require('./core/decision-bridge').nextMoves() });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  // ===== Brio 只读概率：不生成、只给全框架路由概率分布 =====
  if (p === '/v1/decisions/brio' && req.method === 'GET') {
    if (gateSection(req, q, res, 'decision')) return;
    const topic = q.get('topic') || '';
    const temp = q.get('temperature') === null ? undefined : Number(q.get('temperature'));
    try {
      const de = require('./core/decision_engine');
      return json(res, 200, { ok: true, brio: de.brio(topic, temp) });
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== Brain 专家路由图谱：热度/LRU/固定位/主题关联（类比 colibri 大脑皮层）=====
  if (p === '/v1/decisions/router-graph' && req.method === 'GET') {
    try {
      const de = require('./core/decision_engine');
      return json(res, 200, { ok: true, graph: de.graph() });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 行业人才库（组织大脑升级：100+ 各行各业真实岗位）=====
  if (p === '/v1/talents' && req.method === 'GET') {
    return json(res, 200, { ok: true, total: talents.count(), industries: talents.list() });
  }
  // 自定义导入：用户自行选择岗位与数量（可给 AI 建议但不由系统定死）
  // body: { config: [{industry, role, count}] } 或旧式 { industry, perJob }
  if (p === '/v1/talents/import' && req.method === 'POST') {
    const b = await readBody(req);
    const all = talents.list();
    let added = 0;
    // 【2026-09·防卡死】这里原来是"三重嵌套循环里逐条 store.push"：
    // {industry:'all'} 实测 20 行业 × 6 岗位 = **120 次同步写盘**，
    // 在真实 1MB 库上单次写 ~100ms ⇒ 约 12 秒全程堵死事件循环 → 用户看到"服务器连接异常"。
    // 改为先把要新增的员工收集成数组，再用 store.pushMany 一次落盘（1 次写）。
    const toAdd = [];
    if (Array.isArray(b.config) && b.config.length) {
      // 自查自选：逐条 {行业, 岗位, 数量}
      for (const sel of b.config) {
        const cnt = Math.max(0, Math.min(20, Number(sel.count) || 0));
        if (!cnt) continue;
        const ind = all.find(x => x.id === sel.industry);
        if (!ind) continue;
        const job = ind.jobs.find(j => j.role === sel.role);
        if (!job) continue;
        for (let k = 0; k < cnt; k++) {
          toAdd.push({ name: ind.name + '·' + job.role, role: job.role + '（' + ind.name + '）', skills: job.skills.slice(), status: 'on', industry: ind.id, _job: job.role });
        }
      }
    } else {
      const indId = b.industry || 'all';
      const want = Math.max(1, Math.min(20, Number(b.perJob) || 1));
      const srcs = indId === 'all' ? all : all.filter(x => x.id === indId);
      if (!srcs.length) return err(res, 200, '未知行业: ' + indId);
      srcs.forEach(ind => ind.jobs.forEach(job => {
        for (let k = 0; k < want; k++) {
          toAdd.push({ name: ind.name + '·' + job.role, role: job.role + '（' + ind.name + '）', skills: job.skills.slice(), status: 'on', industry: ind.id, _job: job.role });
        }
      }));
    }
    added = toAdd.length;
    if (toAdd.length) {
      const jobs = toAdd.map(x => x._job);
      toAdd.forEach(x => { delete x._job; });
      store.pushMany('staff', toAdd, '人才导入（批量）', jobs.slice(0, 3).join('/') + (jobs.length > 3 ? ' 等 ' + jobs.length + ' 项' : ''));
    }
    if (added) brain.evolve('行业人才网导入：新增 ' + added + ' 名员工');
    return json(res, 200, { ok: true, added, staff: store.list('staff') });
  }
  // 人才配置建议：AI 按团队规模给出岗位配置（供用户参考，可在前端直接改）
  if (p === '/v1/talents/suggest' && req.method === 'GET') {
    const target = Math.max(1, Math.min(200, Number(q.get('target') || 12)));
    const all = talents.list();
    // 按"性价比"给每个行业一个基准数量（真实规则：每行业固定指向高价值岗位）
    const per = (ind, jobs) => {
      const n = Math.max(1, Math.round(target / all.length));
      return jobs.slice(0, Math.min(jobs.length, n)).map((j, i) => ({ industry: ind.id, industryName: ind.name, role: j.role, count: i === 0 ? Math.max(1, Math.round(n / 3)) : Math.max(1, Math.round(n / 6)), desc: j.desc }));
    };
    const config = all.slice(0, 6).map(ind => per(ind, ind.jobs)).flat();
    return json(res, 200, { ok: true, target, total: config.reduce((s, c) => s + c.count, 0), config });
  }
  // 员工技能实时进化：把全网检索到的新兴技术追加到在岗员工技能（自适应时代）
  if (p === '/v1/org/skills/evolve' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const db = store.read();
    const staffList = (db.staff || []).filter(s => s.status !== 'off');
    if (!staffList.length) return json(res, 200, { ok: true, updated: 0, note: '组织暂无在岗员工，先导入人才再进化技能' });
    // 从 GitHub 检索当前热门技能话题（真实抓取，失败降级用本库内置热词）
    let hotSkills = [];
    try {
      const s = await skills.discoverGit('' + (b.query || 'LLM agent MCP RAG AI'), 5);
      hotSkills = (s.items || []).slice(0, 4).map(x => x.name || x.repo.split('/').pop());
    } catch (e) { }
    if (!hotSkills.length) hotSkills = ['LLM', 'RAG', 'MCP', 'Agentic', '向量检索', '多模态', '知识图谱', '自动化'];
    let updated = 0;
    staffList.forEach(s => {
      const add = hotSkills[updated % hotSkills.length];
      if (!s.skills) s.skills = [];
      if (!s.skills.includes(add)) { s.skills.push(add); s.skills = s.skills.slice(-12); updated++; }
    });
    store.write(db);
    brain.evolve('员工技能网状进化：' + updated + ' 名员工同步最新技能');
    store.push('audit', { action: '组织·技能进化', detail: '全网热词 ' + hotSkills.join('/') + ' → ' + updated + ' 名员工技能更新', at: Date.now() });
    return json(res, 200, { ok: true, updated, hotSkills });
  }

  // ===== 24h 自主运营引擎（autopilot）=====
  if (p === '/v1/autopilot/status' && req.method === 'GET') {
    return json(res, 200, autopilot.status());
  }
  if (p === '/v1/autopilot/run' && req.method === 'POST') {
    try {
      const r = await autopilot.runOnce({ manual: true }); // 人工触发：忽略暂停状态
      return json(res, 200, { ok: true, round: r });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopilot/log' && req.method === 'GET') {
    return json(res, 200, { ok: true, log: autopilot.log(Number(q.get('n') || 20)) });
  }
  // ===== 托管控制面：启停 / 节奏 / 单步（人工兜底与排障）=====
  if (p === '/v1/autopilot/pause' && req.method === 'POST') {
    try {
      const b = await readBody(req).catch(() => ({}));
      return json(res, 200, Object.assign({ ok: true }, autopilot.pause(b && b.reason)));
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopilot/resume' && req.method === 'POST') {
    try { return json(res, 200, autopilot.resume()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopilot/interval' && req.method === 'POST') {
    try {
      const b = await readBody(req).catch(() => ({}));
      const sec = b && b.sec !== undefined ? b.sec : Number(q.get('sec'));
      const r = autopilot.setIntervalSec(sec);
      return json(res, 200, r);
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopilot/steps' && req.method === 'GET') {
    return json(res, 200, { ok: true, steps: autopilot.steps() });
  }
  if (p === '/v1/autopilot/step' && req.method === 'POST') {
    try {
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || q.get('id') || '');
      const r = await autopilot.runStep(id);
      return json(res, 200, r);
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopilot/optimize' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, advises: await autopilot.optimize() }); }
    catch (e) { return err(res, 200, e.message); }
  }
  // 漏斗每日快照
  if (p === '/v1/funnel/snapshots' && req.method === 'GET') {
    try {
      const db = store.read();
      const days = parseInt(new URL(req.url, 'http://x').searchParams.get('days') || '30');
      const arr = (db.funnelSnapshots || []).slice(0, days).reverse();
      return json(res, 200, { ok: true, days, data: arr });
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 24h 作战指挥塔（conductor：目标缺口驱动的联调执行主循环）=====
  if (p === '/v1/conductor/status' && req.method === 'GET') {
    return json(res, 200, conductor.status());
  }
  if (p === '/v1/conductor/run' && req.method === 'POST') {
    try {
      const r = await conductor.runTick();
      return json(res, 200, { ok: true, tick: r });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/conductor/train' && req.method === 'GET') {
    try { const t = require('./core/train'); return json(res, 200, { ok: true, board: t.board() }); }
    catch (e) { return err(res, 200, e.message); }
  }
  // ===== 赚钱目标无人驾驶引擎（暗线每日查询进展→优化目标→逼近目标）=====
  if (p === '/v1/goalpilot/status' && req.method === 'GET') {
    try { return json(res, 200, goalpilot.status()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/goalpilot/report' && req.method === 'GET') {
    try { return json(res, 200, goalpilot.report()); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/goalpilot/run' && req.method === 'POST') {
    try { const r = await goalpilot.daily(); return json(res, 200, { ok: true, daily: r }); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/goalpilot/weekly' && req.method === 'POST') {
    try { const r = await goalpilot.weekly(); return json(res, 200, { ok: true, weekly: r }); } catch (e) { return err(res, 200, e.message); }
  }
  // ===== CEO 晨报（跨公司学习 + 每日总裁便条）=====
  if (p === '/v1/goalpilot/brief' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, brief: goalpilot.briefs(7)[0] || null, latest: goalpilot.briefs(1)[0] || null, history: goalpilot.briefs(14) }); } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/goalpilot/brief/generate' && req.method === 'POST') {
    try { return json(res, 200, goalpilot.brief()); } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 跨公司学习系统：经验库（成功/失败/技巧，全真实事件沉淀）=====
  if (p === '/v1/lessons' && req.method === 'GET') {
    try {
      const kw = String(q.get('q') || '').trim();
      const lessons = require('./core/lessons');
      return json(res, 200, { ok: true, stats: lessons.stats(), lessons: kw ? lessons.find(kw) : lessons.find('', 20) });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/lessons' && req.method === 'POST') {
    try {
      const lessons = require('./core/lessons');
      const body = await readBody(req);
      const r = lessons.add(body || {}, visitorOf(req, q, res));
      return r.ok ? json(res, 200, { ok: true, lesson: r.lesson }) : err(res, 200, r.err || '经验登记失败');
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/leads/roi' && req.method === 'GET') {
    try { return json(res, 200, leadgen.roiBoard()); } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 自主运营·功能模块库（50+ 真实模块：列表 / 单点执行）=====
  if (p === '/v1/autopilot/modules' && req.method === 'GET') {
    const { list, get, progress } = require('./core/opmods');
    const kw = String(q.get('kw') || '').toLowerCase();
    const mods = list().filter(m => !kw || (m.id + m.name + m.cat + m.desc).toLowerCase().includes(kw));
    return json(res, 200, { ok: true, total: list().length, modules: mods, progress: progress() });
  }
  {
    const modRun = p.match(/^\/v1\/autopilot\/modules\/([a-zA-Z0-9_-]+)\/run$/);
    if (modRun && req.method === 'POST') {
      try {
        const { get, runModule } = require('./core/opmods');
        if (!get(modRun[1])) return err(res, 200, '未找到模块:' + modRun[1]);
        const r = await runModule(modRun[1], autopilot.status().roundNo);
        return json(res, 200, r);
      } catch (e) { return err(res, 200, e.message); }
    }
  }
  {
    const usedMatch = p.match(/^\/v1\/lessons\/([A-Za-z0-9]+)\/used$/);
    if (usedMatch && req.method === 'POST') {
      try {
        const lessons = require('./core/lessons');
        return json(res, 200, lessons.used(usedMatch[1]));
      } catch (e) { return err(res, 200, e.message); }
    }
  }
  // 经验库复核（RRSI 式：噪声地板 + 成本闸 + 泄漏筛，剔除过拟合/噪声经验）
  if (p === '/v1/lessons/verify' && req.method === 'POST') {
    try {
      const lessons = require('./core/lessons');
      return json(res, 200, lessons.verifyAll());
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 双模型交叉验证（生成 → 第二模型资深复核，双签才上线；非阻塞降级）=====
  if (p === '/v1/verify' && req.method === 'POST') {
    try {
      const providers = require('./core/providers');
      const body = await readBody(req);
      const v = await providers.verify({
        content: String(body.content || ''),
        brief: String(body.brief || '待复核结论').slice(0, 80),
        facts: String(body.facts || '').slice(0, 1500),
        provider: body.provider || undefined
      });
      return json(res, 200, { ok: true, ...v });
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 获客成交闭环（leadgen 看板 / 手动推进）=====
  if (p === '/v1/leadgen' && req.method === 'GET') {
    try {
      const leadgen = require('./core/leadgen');
      return json(res, 200, { ok: true, board: leadgen.board() });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/leadgen/advance' && req.method === 'POST') {
    if (gateSection(req, q, res, 'leadgen')) return;
    try {
      const leadgen = require('./core/leadgen');
      const b = await readBody(req);
      const r = await leadgen.funnelStep(Number(b.round || 0));
      return json(res, 200, { ok: true, out: r, board: leadgen.board() });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/leadgen/reset' && req.method === 'DELETE') {
    try {
      const store = require('./core/store');
      const db = store.read();
      db.leads = (db.leads || []).map(l => { if (l.stage !== '成交') l.stage = '探测'; return l; });
      store.write(db);
      return json(res, 200, { ok: true, board: require('./core/leadgen').board() });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 真实触达（真自主获客：AI 外发，人工只确认大额成交）=====
  // 读状态公开；变更类（run/config/test/mute）默认走权限闸门（回环免，远端需 X-Admin-Token）；
  // 只有 /v1/outreach/reply 是开放回调——但它被 outreachReplyToken 强校验，回环也不免。
  if (p === '/v1/outreach' && req.method === 'GET') {
    try { return json(res, 200, require('./core/outreach').status()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/outreach/config' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, config: require('./core/outreach').configMasked() }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/outreach/config' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, require('./core/outreach').setKeys(b || {}));
  }
  if (p === '/v1/outreach/run' && req.method === 'POST') {
    try {
      const ob = require('./core/outreach');
      const r = await ob.runOnce();
      return json(res, 200, Object.assign({ ok: true }, r, { status: ob.status() }));
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/outreach/test' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await require('./core/outreach').sendTest((b || {}).to || '')); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/outreach/mute' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, require('./core/outreach').mute((b || {}).id, (b || {}).mute !== false));
  }
  if (p === '/v1/outreach/reply' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await require('./core/outreach').ingestReply(b || {});
    return json(res, r.status || 200, { ok: r.ok, error: r.error, ignored: r.ignored, muted: r.muted, lead: r.lead, touch: r.touch, promoted: r.promoted, route: r.route, ticket: r.ticket, prio: r.prio, autoReply: r.autoReply, templateId: r.templateId, ackSent: r.ackSent });
  }
  // ===== 外发触达：记录查询 =====
  if (p === '/v1/outreach/records' && req.method === 'GET') {
    try {
      const db = require('./core/store').read();
      let list = db.outbound || [];
      const channel = q.get('channel');
      const date = q.get('date');
      const leadId = q.get('leadId');
      if (channel) list = list.filter(x => x.channel === channel);
      if (date) {
        const d = new Date(date);
        const next = new Date(d.getTime() + 86400000);
        list = list.filter(x => x.at >= d.getTime() && x.at < next.getTime());
      }
      if (leadId) list = list.filter(x => x.leadId === leadId);
      list = list.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 500);
      // 统计
      const stats = { sent: 0, delivered: 0, failed: 0, replied: 0, optout: 0, byChannel: {} };
      list.forEach(x => {
        const ch = x.channel || '未知';
        if (!stats.byChannel[ch]) stats.byChannel[ch] = { sent: 0, delivered: 0, failed: 0, replied: 0 };
        stats.byChannel[ch].sent++;
        if (x.ok) stats.byChannel[ch].delivered++;
        else stats.byChannel[ch].failed++;
        if (x.phase === 'reply') { stats.replied++; stats.byChannel[ch].replied++; }
        if (x.phase === 'optout') stats.optout++;
      });
      // 配额
      const sentToday = (db.outbound || []).filter(x => {
        const d = new Date(x.at || 0);
        const today = new Date();
        return d.getDate() === today.getDate() && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear() && x.ok;
      }).length;
      const limit = Number(require('./core/store').getSetting('outreach.dailyLimit')) || 200;
      return json(res, 200, { ok: true, list, stats, quota: { used: sentToday, limit, remaining: Math.max(0, limit - sentToday) } });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/outreach/stats' && req.method === 'GET') {
    try {
      const db = require('./core/store').read();
      const list = db.outbound || [];
      const byChannel = {};
      let totalSent = 0, totalDelivered = 0, totalFailed = 0, totalReplied = 0;
      list.forEach(x => {
        const ch = x.channel || '未知';
        if (!byChannel[ch]) byChannel[ch] = { sent: 0, delivered: 0, failed: 0, replied: 0 };
        byChannel[ch].sent++;
        if (x.ok) { byChannel[ch].delivered++; totalDelivered++; }
        else { byChannel[ch].failed++; totalFailed++; }
        if (x.phase === 'reply') { byChannel[ch].replied++; totalReplied++; }
        totalSent++;
      });
      return json(res, 200, { ok: true, byChannel, total: { sent: totalSent, delivered: totalDelivered, failed: totalFailed, replied: totalReplied } });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 商业化证据状态（前端面板读这个）=====
  // 诚实数据源：只聚合真实 evidence-pipeline 的数据，0 就是 0，绝不用模板填充。
  if (p === '/v1/evidence/status' && req.method === 'GET') {
    try {
      const pipe = require('./core/evidence-pipeline');
      const me = require('./core/market-evidence');
      const s = pipe.status();
      const g = me.gateCheck();
      return json(res, 200, {
        ok: true,
        total: s.total,
        confirmed: s.confirmed,
        dims: s.dims,
        retention: s.retention,
        gate: { pass: g.pass, missing: g.missing },
        recent: s.list.slice(0, 10).map(e => ({
          id: e.id, ts: e.ts, sourceType: e.sourceType, channel: e.channel,
          quote: e.quote, tags: e.tags, confirmed: e.confirmed
        }))
      });
    } catch (e) { return err(res, 500, e.message); }
  }

  // ===== 商业闭环编排器状态（获客→沟通→成交→支付→物流→履约→售后→自我进化）=====
  if (p === '/v1/commercial-loop/status' && req.method === 'GET') {
    try { return json(res, 200, require('./core/commercial-loop').status()); }
    catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/commercial-loop/skills' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, skills: require('./core/commercial-loop').listSkills() }); }
    catch (e) { return err(res, 500, e.message); }
  }

  // ===== 24/7 自主触达调度器 =====
  if (p === '/v1/scheduler/status' && req.method === 'GET') {
    try { return json(res, 200, require('./core/scheduler').status()); }
    catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/scheduler/tick' && req.method === 'POST') {
    try { return json(res, 200, await require('./core/scheduler').tick()); }
    catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/scheduler/start' && req.method === 'POST') {
    try { return json(res, 200, require('./core/scheduler').start()); }
    catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/scheduler/stop' && req.method === 'POST') {
    try { require('./core/scheduler').stop(); return json(res, 200, { ok: true }); }
    catch (e) { return err(res, 500, e.message); }
  }

  // ===== 16 工作流编排器（30s/轮全链路自动化，隐藏功能）=====
  if (p === '/v1/workflow16' && req.method === 'GET') {
    try { return json(res, 200, require('./core/workflow16').status()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/workflow16/run' && req.method === 'POST') {
    try { return json(res, 200, await require('./core/workflow16').runRound()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/workflow16/boot' && req.method === 'POST') {
    try { require('./core/workflow16').boot(); return json(res, 200, { ok: true }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/workflow16/stop' && req.method === 'POST') {
    try { require('./core/workflow16').stop(); return json(res, 200, { ok: true }); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== 24h 蜘蛛入料（隐藏功能：GitHub 周巡 + 网页深爬，前端不显示）=====
  if (p === '/v1/crawler' && req.method === 'GET') {
    try { return json(res, 200, require('./core/crawler').status()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/crawler/run' && req.method === 'POST') {
    try { return json(res, 200, await require('./core/crawler').harvestOnce()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/crawler/ingest' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await require('./core/crawler').ingest((b || {}).url || '')); }
    catch (e) { return err(res, 200, e.message); }
  }
  // 隐藏功能：把抓到的公开正文直接入网站知识库（"复制粘贴数据到网站完善"，仅站内/运营）
  if (p === '/v1/crawler/bank' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/crawler').bank(String((b || {}).name || '蜘蛛采集'), String((b || {}).url || ''), String((b || {}).content || ''))); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== 履约全链路（隐藏功能：下单→物流→签收→售后，前端不显示）=====
  if (p === '/v1/fulfillment' && req.method === 'GET') {
    try { return json(res, 200, require('./core/fulfillment').board()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/fulfillment/advance' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/fulfillment').advance((b || {}).id || '', b || {})); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/fulfillment/logistics' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/fulfillment').logisticsCallback(b || {})); }
    catch (e) { return err(res, 200, e.message); }
  }
  const mFul = p.match(/^\/v1\/fulfillment\/([\w-]+)$/);
  if (mFul && req.method === 'GET') {
    try {
      const fm = require('./core/fulfillment');
      const o = fm.board(999).rows.find(x => x.id === mFul[1] || x.orderNo === mFul[1]);
      if (!o) return json(res, 404, { ok: false, error: '订单不存在' });
      return json(res, 200, { ok: true, order: o });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 物料/库存（轻量 MRP，前端不显示）=====
  if (p === '/v1/materials' && req.method === 'GET') {
    try { return json(res, 200, require('./core/materials').status()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/materials/register' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/materials').register(b || {})); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/materials/move' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/materials').move(b || {})); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/materials/plan' && req.method === 'GET') {
    try { return json(res, 200, require('./core/materials').plan()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/materials/intent' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/materials').intent(b || {})); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/materials/confirm' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/materials').confirmIntent((b || {}).id || '')); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/materials/cancel' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, require('./core/materials').cancelIntent((b || {}).id || '')); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== 物流跟踪（快递100，未配 key 如实提示）=====
  if (p === '/v1/logistics/status' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, ...require('./core/logistics').status() }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/logistics/query' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await require('./core/logistics').query((b || {}).no || '', (b || {}).carrier || '')); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== 整体协调：明线/暗线双轨总览 =====
  if (p === '/v1/coordinator' && req.method === 'GET') {
    try {
      const c = require('./core/coordinator');
      return json(res, 200, { ok: true, visible: c.visible(), hidden: c.hidden(), actions: c.actions(), text: c.overview() });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 专家会诊 =====
  if (p === '/v1/agents' && req.method === 'GET') {
    return json(res, 200, { ok: true, agents: agents.list() });
  }
  if (p === '/v1/agents/consult' && req.method === 'POST') {
    if (gateSection(req, q, res, 'agent')) return;
    const b = await readBody(req);
    if (!b.agent || !b.question) return err(res, 400, 'agent 与 question 必填');
    try {
      const out = await agents.consult(b.agent, b.question, { lang: b.lang, depth: !!b.depth, provider: b.provider });
      return json(res, 200, { ok: true, content: out.content, engine: out.engine, agent: out.agent });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/agents/team' && req.method === 'POST') {
    if (gateSection(req, q, res, 'agent')) return;
    const b = await readBody(req);
    if (!b.question) return err(res, 400, 'question 必填');
    try {
      const ids = Array.isArray(b.ids) ? b.ids.filter(x => agents.AGENTS.some(a => a.id === x)) : null;
      const out = await agents.team(b.question, { ids, lang: b.lang, depth: !!b.depth, provider: b.provider });
      return json(res, 200, { ok: true, content: out.content, consensus: out.consensus, divergence: out.divergence, actions: out.actions, engine: out.engine, members: out.members });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 知识库 =====
  if (p === '/v1/knowledge') {
    if (req.method === 'GET') {
      if (q.get('hybrid') === '1') return json(res, 200, { ok: true, knowledge: await knowledge.hybridRecall(q.get('q'), 20), mode: 'hybrid' });
      if (q.get('q')) return json(res, 200, { ok: true, knowledge: knowledge.recall(q.get('q'), 20) });
      return json(res, 200, { ok: true, knowledge: knowledge.list(), stats: knowledge.stats() });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b.q || !b.a) return err(res, 400, 'q 与 a 必填');
      const rec = knowledge.add(b.q, b.a, b.tag || 'manual');
      // 数据归属：知识沉淀属于沉淀者本人
      try { require('./core/tenancy').markOwned('knowledge', rec, visitorOf(req, q, res)); } catch (e) { }
      brain.evolve('知识库新增：' + b.q.slice(0, 40));
      return json(res, 200, { ok: true, knowledge: rec });
    }
    if (req.method === 'DELETE') {
      const b = await readBody(req);
      return json(res, 200, { ok: knowledge.remove(b.id) });
    }
  }

  // 外部语义记忆层（supermemory）状态：确认是否启用、是否连得上
  if (p === '/v1/knowledge/memory' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, memory: await knowledge.memoryStatus() }); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== 网页抓取（可插拔后端）=====
  // GET /v1/intel/page?url=...&backend=auto|fetch|lightpanda
  if (p === '/v1/intel/page' && req.method === 'GET') {
    const u = String(q.get('url') || '').trim();
    const bad = webfetch.validateUrl(u);
    if (bad) return err(res, 400, bad);
    try { return json(res, 200, { ok: true, page: await intel.page(u, { backend: q.get('backend') || undefined, max: q.get('max') }) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  // GET /v1/intel/browse —— 当前抓取后端与 lightpanda 连通性
  if (p === '/v1/intel/browse' && req.method === 'GET') {
    try { return json(res, 200, await intel.browseStatus()); }
    catch (e) { return err(res, 200, e.message); }
  }
  // GET /v1/intel/research?url=... —— 竞品/定价情报（Markdown + 定价信号）
  if (p === '/v1/intel/research' && req.method === 'GET') {
    const u = String(q.get('url') || '').trim();
    const bad = webfetch.validateUrl(u);
    if (bad) return err(res, 400, bad);
    try { return json(res, 200, { ok: true, research: await intel.research(u, { max: q.get('max') }) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  // GET /v1/intel/research/status —— Firecrawl 是否已配置
  if (p === '/v1/intel/research/status' && req.method === 'GET') {
    try { return json(res, 200, intel.researchStatus()); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== 审计日志（含搜索/分页/CSV，支持自动下滑）=====
  if (p === '/v1/audit') {
    if (req.method === 'GET') {
      const kw = (q.get('q') || '').trim().toLowerCase();
      let rows = store.list('audit');
      if (kw) rows = rows.filter(r => (r.action + ' ' + (r.detail || '')).toLowerCase().includes(kw));
      if (q.get('format') === 'csv') {
        const csv = store.toCsv(rows, ['id', 'action', 'detail', 'at']);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit.csv"' });
        return res.end('﻿' + csv);
      }
      return json(res, 200, { ok: true, audit: rows.slice(0, Number(q.get('limit') || 300)) });
    }
  }

  // ===== 技能军械库 =====
  if (p === '/v1/skills') {
    if (req.method === 'GET') {
      const r = skills.registry(q.get('q'));
      return json(res, 200, { ok: true, total: r.total, builtin: r.builtin, external: r.external, template: r.template, byCat: r.byCat, catNames: r.catNames });
    }
  }

  // ===== 技能·执行（真正跑一次技能：装指令 → 过 LLM 网关 → 返回产出）=====
  // 【2026-10-21 补齐接线缺口】前端一直在调 /v1/skills/<name>/invoke，但两端都没有实现：
  //   · 收费墙登记表写的是 'POST /v1/skills/invoke'（技能名放 body）
  //   · 前端调的是   'POST /v1/skills/<name>/invoke'（技能名放路径）
  // 结果：点「执行」必然 404。现在两种形状都支持（路径形状由 PREFIX_RULES '/v1/skills'→skill
  // 分区照常收费墙计费），并把真实执行结果如实返回。
  // 【诚实】执行器或 LLM 不可用时**如实失败**，绝不编造产出。
  {
    const mInv = pathSkillName ? [null, pathSkillName] : null;
    if (p === '/v1/skills/invoke' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String((b && (b.name || b.skillId || b.skill)) || (mInv && mInv[1]) || '').trim();
      if (!name) return json(res, 200, { ok: false, error: '缺少技能名（name 或路径 /v1/skills/<name>/invoke）' });
      try {
        // ── ① 站点原生执行入口（首选）────────────────────────────────────
        // core/skills.js 的 invoke() 是站点既有的技能执行通道：内置运行时技能、外部技能
        // （可真实落地 clone）、本机已装载技能、模板技能，且**每次执行都写审计 + brain 记录**。
        // UI 技能面板里的 id 就是这套 id —— 走它才对。
        // 【注意】不要在这里强制要求"任务描述"：本地已装载技能与模板技能本来就不需要任务，
        // 由原生入口自己判定（它知道每类技能要什么）。
        const args = (b && b.args && typeof b.args === 'object') ? b.args : Object.assign({}, b || {});
        delete args.name; delete args.skill; delete args.skillId;
        let nativeOut = null;
        let nativeErr = null;
        try {
          nativeOut = await skills.invoke(name, args, { visitor: visitorOf(req, q, res), ip: clientIp(req) });
        } catch (e) {
          nativeErr = String((e && e.message) || e);
        }
        if (nativeOut && nativeOut.ok) {
          return json(res, 200, {
            ok: true,
            output: nativeOut.output || '',
            error: null,
            elapsedMs: nativeOut.elapsedMs || null,
            source: nativeOut.source || '',
            skill: { id: name },
          });
        }
        // ── ② pack 前缀 id（ecc:agents/code-reviewer）→ 落到 agent 执行器（真实 LLM 执行）──
        if (String(name).indexOf(':') > 0) {
          const taskText = String(args.q || args.input || args.task || args.query || '').trim();
          if (!taskText) return json(res, 200, { ok: false, error: '缺少任务描述（input）' });
          const agentPkgRoot = process.env.BD_AGENT_ROOT || path.join(__dirname, 'packages');
          const { SkillRunner } = require(path.join(agentPkgRoot, 'core', 'skills', 'runner'));
          const { LlmGateway } = require(path.join(agentPkgRoot, 'core', 'llm', 'providers'));
          // 站点 service 没有 EnvironmentFile：密钥要走 pay.envGet() 的同一口径读 .env
          const envProxy = new Proxy({}, {
            get: (_t, k) => {
              try { const v = pay.envGet(String(k)); if (v) return v; } catch (e) { /* 落到 process.env */ }
              return process.env[String(k)];
            },
          });
          const runner = new SkillRunner({ gateway: new LlmGateway({ env: envProxy }) });
          const out = await runner.run({ skillId: name, input: taskText });
          if (!out || !out.ok) {
            return json(res, 200, {
              ok: false, error: (out && (out.error || out.code)) || '技能执行失败',
              note: (out && out.note) || null, skill: (out && out.skill) || null, audited: !!(out && out.audited),
            });
          }
          return json(res, 200, {
            ok: true,
            output: (out.result && out.result.content) || '',
            error: null,
            elapsedMs: out.ms || null,
            source: ((out.result && out.result.provider) || '') + ((out.result && out.result.model) ? '/' + out.result.model : ''),
            skill: out.skill || null,
            truncated: !!out.truncated,
            truncatedNote: out.truncatedNote || null,
            usage: (out.result && out.result.usage) || null,
            audited: !!out.audited,
          });
        }
        // ── ③ 都不认识 → 如实失败（不编造产出）──
        return json(res, 200, { ok: false, error: nativeErr || ('未找到技能：' + name) });
      } catch (e) {
        // 执行器未部署 / 依赖缺失：如实说明，不假装成功
        return json(res, 200, { ok: false, error: '技能执行器不可用：' + String((e && e.message) || e).slice(0, 120) });
      }
    }
  }

  // ===== 技能·全网发现（GitHub 实时检索）=====
  if ((p === '/v1/skills/discover' || p === '/v1/skills/search') && req.method === 'GET') {
    const r = await skills.discoverGit(q.get('q') || 'agent skill', q.get('per') || 8);
    return json(res, 200, r);
  }
  // ===== 技能·仓库检视（收录前预览 README/文件）=====
  if (p === '/v1/skills/inspect' && req.method === 'GET') {
    const repo = (q.get('repo') || '').trim();
    if (!repo) return err(res, 200, '缺少 repo 参数（owner/repo）');
    const r = await skills.inspectRepo(repo);
    return json(res, 200, r);
  }
  // ===== 复用选型 SOP 检查单（先检索复用，再造）=====
  // 五维度：真实性(幻觉) / 协议(商用·闭源·传染) / 活跃度(停更·刷量) / 接入难度 / 决策
  // 拿不准一律返回 unknown 并说明原因，绝不臆断；协议不合规则直接否决，
  // 不给"先抄进来再说"留口子。
  if (p === '/v1/adoption/check' && req.method === 'GET') {
    const repo = (q.get('repo') || '').trim();
    if (!repo) return err(res, 200, '缺少 repo 参数（owner/repo）');
    const A = require('./core/adoption');
    // 现场取证：直接问 GitHub，而不是让调用方自己判断字段
    let facts = {
      license: q.get('license') || '',
      lang: q.get('lang') || '',
      reachable: true, exists: null
    };
    try {
      const intel = require('./core/intel');
      const det = await intel.gitRepo(repo).catch(() => ({ ok: false }));
      const tree = await intel.gitTree(repo).catch(() => ({ items: [] }));
      const files = (tree.items || []).map(x => String(x.name || '').toLowerCase());
      facts = {
        license: det.license || facts.license,
        lang: det.lang || facts.lang,
        stars: det.stars || 0,
        forks: det.forks || 0,
        pushedAt: det.pushedAt || det.pushed_at || det.updated || 0,
        createdAt: det.createdAt || det.created_at || 0,
        archived: det.archived === true,
        reachable: det.reach !== false,
        exists: det.ok === true ? true : (det.reach === false ? null : false),
        fileCount: (tree.items || []).length,
        hasPackageJson: files.some(f => /(^|\/)package\.json$/.test(f)),
        hasTests: files.some(f => /(^|\/)(test|tests|__tests__|spec)\//.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f)),
        hasCI: files.some(f => /^\.github\/workflows\//.test(f)),
        hasDockerfile: files.some(f => /(^|\/)dockerfile$/.test(f))
      };
    } catch (e) {
      facts.error = String(e.message || e);
    }
    return json(res, 200, { ok: true, repo, ...A.assess(repo, facts) });
  }
  // 协议速查：只问协议本身，不联网
  if (p === '/v1/adoption/license' && req.method === 'GET') {
    const A = require('./core/adoption');
    const lic = q.get('id') || '';
    if (!lic) return json(res, 200, { ok: true, rules: A.LICENSE_RULES });
    return json(res, 200, { ok: true, input: lic, ...A.classifyLicense(lic) });
  }
  // 规则表自检：改协议表后确认没写错（写错只会在某个后缀协议上静默失效）
  if (p === '/v1/adoption/selfcheck' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...require('./core/adoption').selfCheck() });
  }
  // ===== 复用选型 SOP（先检索复用，再造）=====
  // Step 0 只读门禁；完整五步走 POST（候选由调用方提供，SOP 不自己搜，保证可复算）
  if (p === '/v1/reuse-sop/gate' && req.method === 'GET') {
    const need = q.get('need') || '';
    return json(res, 200, { ok: true, ...require('./core/reuse-sop').gateFirst(need) });
  }
  if (p === '/v1/reuse-sop/run' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await require('./core/reuse-sop').run(b.need, {
      candidates: b.candidates || [],
      ownModules: b.ownModules || [],
      pick: b.pick, hourlyRate: b.hourlyRate
    });
    return json(res, 200, r);
  }

  // ===== 通用硬件自主管理内核（2026-10-25：发现/识别/分类/语义命令/生命周期）=====
  // 【宿主机边界】硬件清单与命令是宿主机级信息/能力，公网多租户下对任何访客开放 =
  // 泄露硬件拓扑 + 让陌生人重启宿主设备 → 必须管理权限（桌面回环由 adminAuthed 放行）。
  if ((p === '/v1/hw/scan' || p === '/v1/hw/events') && req.method === 'GET') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '硬件内核为宿主机能力，需管理令牌（桌面回环自动放行）' });
    if (!rateOK('hwscan:ip:' + clientIp(req), 12, 60000)) return json(res, 429, { ok: false, error: '操作过于频繁（每分钟 ≤12 次）' });
    if (p === '/v1/hw/events') return json(res, 200, require('./core/hardware-kernel').hwEvents(Number(q.get('limit') || 50)));
    return json(res, 200, await require('./core/hardware-kernel').scan());
  }
  if (p === '/v1/hw/command' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '硬件内核为宿主机能力，需管理令牌（桌面回环自动放行）' });
    if (!rateOK('hwcmd:ip:' + clientIp(req), 20, 60000)) return json(res, 429, { ok: false, error: '命令过于频繁' });
    const b = await readBody(req);
    const r = await require('./core/hardware-kernel').command(String(b.instanceId || ''), String(b.cmd || 'status'), { allowControl: b.allowControl === true, portName: b.portName, baud: b.baud, pin: b.pin, mode: b.mode });
    return json(res, r.ok ? 200 : 400, r);
  }

  // ===== 能力全景（查缺补漏的仪表盘）=====
  // 回答一个系统自己回答不了的问题：「我有什么、用户能用哪些、差在哪」。
  // 自动扫 core/ 与 server.js 生成，不维护手工清单（手工清单必然与代码漂移）。
  // 两类缺口分开报：
  //   · 够不到 —— 能力存在但前端没有出口（做出来了没人知道）
  //   · 空转   —— 机制齐全但从未运行过（自我进化闭环 totalRuns=0 这类）
  if (p === '/v1/capability/map' && req.method === 'GET') {
    try {
      const CM = require('./core/capability-map');
      const full = CM.build();
      const topic = q.get('topic');
      const b = (!topic || topic === 'all') ? full : Object.assign({}, full, {
        gapsByTopic: full.gapsByTopic.filter(g => g.topic === topic),
        unreachable: full.unreachable.filter(e => CM.topicOf(e) === topic)
      });
      return json(res, 200, Object.assign({ ok: true }, b, { idle: CM.idleMechanisms() }));
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 技能·收录（动态外部模块写入 db）=====
  if (p === '/v1/skills/inject' && req.method === 'POST') {
    const b = await readBody(req);
    const r = skills.addExternal(b || {});
    return json(res, 200, { ok: true, added: r.added, item: r.item });
  }
  // ===== 技能·移除动态收录 =====
  if (p === '/v1/skills/remove' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: skills.removeExternal(String(b.id || '')) });
  }
  // ===== 技能·自我进化核验（外部源可达性全网检测；force=1 强制重测）=====
  if (p === '/v1/skills/verify' && req.method === 'GET') {
    const force = q.get('force') === '1' || q.get('force') === 'true';
    const r = await skills.verifyRegistry(force);
    return json(res, 200, r);
  }
  // ===== 技能·自主侦察（全托管：自己把技能库长到 50+）=====
  if (p === '/v1/skills/scout/status' && req.method === 'GET') {
    return json(res, 200, skills.scoutStatus());
  }
  if (p === '/v1/skills/scout' && req.method === 'POST') {
    // 真实联网检索 GitHub，耗时可达数十秒；dry=1 只报告不收录
    const b = await readBody(req);
    const r = await skills.scoutOnce({ topics: b.topics, per: b.per, dry: b.dry === true || b.dry === '1' });
    return json(res, 200, r);
  }
  // ===== 技能·下载落地（git clone 到本地沙箱，真实下载）=====
  if (p === '/v1/skills/download' && req.method === 'POST') {
    const b = await readBody(req);
    const repo = String(b.repo || b.url || '');
    if (!repo) return err(res, 200, '缺少 repo 参数');
    const r = await skills.downloadRepo(repo, String(b.dir || '').trim());
    return json(res, 200, r);
  }
  const skMatch = p.match(/^\/v1\/skills\/([a-zA-Z0-9_.-]+)\/invoke$/);
  if (skMatch && req.method === 'POST') {
    if (gateSection(req, q, res, 'skill')) return;
    const b = await readBody(req).catch(() => ({}));
    try {
      const out = await skills.invoke(skMatch[1], b || {}, { lang: store.getSetting('lang') });
      return json(res, 200, out);
    } catch (e) {
      try { store.push('audit', { action: '技能执行失败', detail: '技能 ' + skMatch[1] + ' 抛错：' + String(e.message || e).slice(0, 160) }, null, null); } catch (e2) { }
      return err(res, 200, e.message);
    }
  }

  // ===== 模型密钥（用户级 .env，打包环境真实可配）=====
  if (p === '/v1/settings/keys' && req.method === 'POST') {
    const b = await readBody(req);
    const r = providers.saveUserKeys(b);
    if (!r.ok) return err(res, 200, r.error);
    return json(res, 200, { ok: true, path: r.path, wrote: r.wrote, providers: providers.list() });
  }

  // ===== 系统设置（十色主题/警告声/默认模型/语言）=====
  // 安全：敏感键（token/secret/邮件授权之类）永不外泄，也禁止通过此口写入（只能经 .env / 专用管理端点）。
  const PROTECTED_SETTINGS = ['adminToken', 'visitorSecret', 'mailAuth', 'smtpAuth', 'smtpPass', 'outreachReplyToken'];
  const stripSecrets = s => { const o = {}; Object.keys(s || {}).forEach(k => { if (!PROTECTED_SETTINGS.includes(k)) o[k] = s[k]; }); return o; };
  if (p === '/v1/settings') {
    if (req.method === 'GET') { const db = store.read(); return json(res, 200, { ok: true, settings: stripSecrets(db.settings) }); }
    if (req.method === 'POST' || req.method === 'PATCH') {
      // 【第 7 条】走设置注册表：统一校验 + 统一审计 + 未登记键明确拒绝。
      // 原实现是"直接把 body 里的键塞进 db.settings"：
      //   · 键名拼错（如 alertEmial）会静默写进去，没人发现
      //   · 数值型不校验范围（orcaSlots 写 999 也能存进去）
      //   · 邮箱/JSON 不校验格式
      // 现在由 settings-registry 声明式校验，非法值会被拒绝并说明原因。
      const b = await readBody(req);
      try {
        const SR = require('./core/settings-registry');
        const registered = {};
        SR.ITEMS.forEach(it => { registered[it.key] = true; });
        // theme/goals 有独立的 UI 与模块（goals 走 add/setPrimary/remove），不在注册表里，
        // 仍按原逻辑直写。
        const LEGACY_OK = ['theme', 'goals', 'soundKind'];

        // 【严重 bug·已修】原来写成：
        //     const known = {}; SR.ITEMS.forEach(it => { known[it.key] = true; });
        //     Object.keys(b).forEach(k => { (known[k] ? known : passthrough)[k] = b[k]; });
        // 看着像在分流，实际 `known` 已经装着**全部 22 个注册键的 true**，
        // 于是 SR.set(known) 会把 lang/theme/paywallOn/autopilot… 全部写成 true ——
        // 一次 POST /v1/settings 就把收费墙打开了、把语言设成了 true。
        // 表现是 E2E 的 pay/settle/checkout 三个套件突然大面积"订单不存在"。
        // 教训：不要用同一个对象既当集合又当载荷。
        const known = {};        // 只装本次请求里、且注册表登记过的键
        const passthrough = {};  // 本次的其它键
        Object.keys(b).forEach(k => {
          if (registered[k]) known[k] = b[k];
          else passthrough[k] = b[k];
        });

        // 【安全漏洞·已修】/v1/settings 是公开无鉴权接口，而 adminToken/visitorSecret
        // 等受保护键同时登记在 settings-registry（走 known）和直写（passthrough）两份路径。
        // 远程匿名者 POST /v1/settings {adminToken:'H4X0R'} 就能把管理令牌改成已知值，
        // 拿到全部运营/资金权限（confirm/rotate/reset 等）。修复：任何受保护键都必须
        // 在写入前从两条路径剔除，并记审计留证；普通设置接口永远不允许改 secrets，
        // 只能经管理端专用入口（subs/rotate-admin-token 等）。
        const PROTECTED_TRIED = [];
        Object.keys(passthrough).forEach(k => {
          if (PROTECTED_SETTINGS.includes(k)) { PROTECTED_TRIED.push(k); delete passthrough[k]; }
        });
        Object.keys(known).forEach(k => {
          if (PROTECTED_SETTINGS.includes(k)) { PROTECTED_TRIED.push(k); delete known[k]; }
        });

        // 【严重漏洞·已修】非回环 + 无管理令牌的来源，只能改「界面偏好」键。
        // 收费墙开关 / 收款码 / 收款账号 / 自主运营开关等一律拒绝，否则匿名者即可关墙或劫持收款。
        const DENIED_KEYS = [];
        if (!adminAuthed(req)) {
          Object.keys(known).forEach(k => { if (!PUBLIC_SETTING_KEYS.has(k)) { DENIED_KEYS.push(k); delete known[k]; } });
          Object.keys(passthrough).forEach(k => { if (!PUBLIC_SETTING_KEYS.has(k)) { DENIED_KEYS.push(k); delete passthrough[k]; } });
        }

        const r = SR.set(known);
        const unknownKeys = Object.keys(passthrough).filter(k => LEGACY_OK.indexOf(k) < 0);
        const db = store.read();
        if (!db.settings) db.settings = {};
        Object.keys(passthrough).forEach(k => { db.settings[k] = passthrough[k]; });
        if (PROTECTED_TRIED.length) {
          if (!db.audit) db.audit = [];
          db.audit.push({ id: store.uid(), action: '拒绝写入受保护设置', detail: '尝试写入受保护键: ' + PROTECTED_TRIED.join(','), at: Date.now() });
        }
        if (DENIED_KEYS.length) {
          if (!db.audit) db.audit = [];
          db.audit.push({ id: store.uid(), action: '拒绝匿名写入运营设置', detail: '非授权来源尝试写入: ' + DENIED_KEYS.join(','), at: Date.now() });
        }
        if (Object.keys(passthrough).length || PROTECTED_TRIED.length) {
          if (!db.audit) db.audit = [];
          Object.keys(passthrough).forEach(k => db.audit.push({ id: store.uid(), action: '修改设置', detail: k + '=' + passthrough[k], at: Date.now() }));
          store.write(db);
        }
        return json(res, 200, {
          ok: r.ok && !unknownKeys.length && !DENIED_KEYS.length,
          applied: r.applied,
          rejected: r.rejected.concat(PROTECTED_TRIED.map(k => ({ key: k, error: '受保护设置键（只能经管理端专用接口修改）' }))).concat(DENIED_KEYS.map(k => ({ key: k, error: '运营设置：非授权来源不可修改（需管理令牌或本机操作）' }))).concat(unknownKeys.map(k => ({ key: k, error: '未登记的设置键（注册表里没有），请先在 settings-registry 登记' }))),
          settings: stripSecrets(db.settings)
        });
      } catch (e) {
        return err(res, 200, '设置写入失败：' + String(e.message || e));
      }
    }
  }

  // ===== 设置中枢（第 7 条：管理整个系统设置的平台）=====
  if (p === '/v1/settings/registry' && req.method === 'GET') {
    try {
      const SR = require('./core/settings-registry');
      return json(res, 200, Object.assign({ ok: true }, SR.list({ includeAdvanced: q.get('advanced') === '1' })));
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/settings/coverage' && req.method === 'GET') {
    try {
      return json(res, 200, { ok: true, ...require('./core/settings-registry').coverage() });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/settings/health' && req.method === 'GET') {
    try {
      return json(res, 200, { ok: true, ...require('./core/settings-registry').health() });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }

  // ===== 全模块记忆·学习·进化中枢（第 8 条）=====
  if (p === '/v1/memory-hub' && req.method === 'GET') {
    return json(res, 200, { ok: true, dashboard: require('./core/memory-hub').dashboard() });
  }
  if (p === '/v1/memory-hub/entries' && req.method === 'GET') {
    const hub = require('./core/memory-hub');
    const list = hub.entries({ mod: q.get('mod') || undefined, limit: Number(q.get('limit') || 100) });
    return json(res, 200, { ok: true, entries: list });
  }

  // 读取音频文件为 data URI，供前端直接播放。
  // 上限 12MB：再大就该走 Range 请求分片了，直接内联会把响应体撑爆。
  const AUDIO_INLINE_MAX = 12 * 1024 * 1024;
  const MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
  function readAudio(file) {
    try {
      if (!file || !fs.existsSync(file)) return null;
      const st = fs.statSync(file);
      if (st.size > AUDIO_INLINE_MAX) return null;   // 太大就不内联，返回 null 而不是把响应撑爆
      const ext = path.extname(file).toLowerCase();
      return 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + fs.readFileSync(file).toString('base64');
    } catch (e) { return null; }
  }

  // ===== 音乐制作（第 14 条）=====
  if (p === '/v1/music/capability' && req.method === 'GET') {
    try { return json(res, 200, require('./core/music').capability()); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/music/jobs' && req.method === 'GET') {
    return json(res, 200, { ok: true, jobs: require('./core/music').jobs(q.get('limit')) });
  }
  if (p === '/v1/music/produce' && req.method === 'POST') {
    const b = await readBody(req);
    // 真实 DSP 合成，8 小节约 20 秒音频——同步算会让事件循环卡住（之前踩过同样的坑）
    return json(res, 200, await new Promise(resolve => {
      setImmediate(async () => {
        try {
          const r = require('./core/music').produce(b);
          resolve(json(res, 200, { ok: true, ...r, audio: readAudio(r.file) }));
        } catch (e) {
          // 诚实报告，不伪造"已生成"
          resolve(json(res, 200, { ok: false, error: String(e.message || e).slice(0, 160) }));
        }
      });
    }));
  }

  // ===== 七层架构 + 七种编排 + 自适应注册（第 1、2、7 条）=====
  if (p === '/v1/arch/layers' && req.method === 'GET') {
    const L = require('./core/layers');
    const [a, h] = await Promise.all([L.architecture(), L.loopHealth()]);
    return json(res, 200, { ok: true, architecture: a, loop: h });
  }
  if (p === '/v1/arch/orchestrators' && req.method === 'GET') {
    const O = require('./core/orchestrators');
    return json(res, 200, { ok: true, ...O.history(Number(q.get('limit') || 60)) });
  }
  if (p === '/v1/arch/run' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.task) return err(res, 400, 'task 必填');
    if (!b.kind) {
      // 未指定架构时给推荐，不静默选
      const rec = require('./core/orchestrators').recommend(b.task);
      return json(res, 200, { ok: true, recommended: rec.top, all: rec.all, needKind: true });
    }
    const r = await require('./core/orchestrators').run(b.kind, b.task, b);
    return json(res, 200, { ok: true, result: r });
  }
  if (p === '/v1/arch/recommend' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, ...require('./core/orchestrators').recommend(b.task || '') });
  }
  // ===== Graphify 语义知识图谱（喂给记忆层/七层架构/学习闭环）=====
  if (p === '/v1/graph' && req.method === 'GET') {
    const G = require('./core/graphify');
    const g = G.build();
    // 邻域查询：?node=xxx&depth=2
    if (q.get('node')) {
      const nb = G.neighborhood(q.get('node'), Number(q.get('depth') || 1));
      return json(res, 200, { ok: true, neighborhood: nb });
    }
    return json(res, 200, {
      ok: true,
      totals: g.totals, byKind: g.byKind, byType: g.byType,
      kinds: G.NODE_KINDS,
      top: G.centrality(20),
      // 孤立节点是有诊断价值的：它指出"哪些功能存在于系统却没和任何东西连起来"
      isolated: { count: g.totals.isolated, sample: g.isolatedSample },
      summary: G.summary()
    });
  }
  if (p === '/v1/graph/path' && req.method === 'GET') {
    const G = require('./core/graphify');
    if (!q.get('from') || !q.get('to')) return err(res, 400, 'from 与 to 必填');
    return json(res, 200, { ok: true, ...G.shortestPath(q.get('from'), q.get('to')) });
  }
  if (p === '/v1/graph/orphans' && req.method === 'GET') {
    return json(res, 200, { ok: true, orphans: require('./core/graphify').orphans(q.get('kind')) });
  }

  // ===== PDE 产出大项（四级：助手化 / 流程化 / 系统化 / 原生化）=====
  // 每一级都由 core/pde.js 的真实探测得出，不接受"已完成"这种人工声明。
  if (p === '/v1/pde' && req.method === 'GET') {
    try {
      const PDE = require('./core/pde');
      const a = PDE.assess();
      return json(res, 200, {
        ok: true, rate: a.rate, grade: a.grade, verdict: a.verdict,
        weakest: a.weakest, stages: a.stages,
        next: PDE.nextActions().slice(0, 8)
      });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/pde/stage' && req.method === 'GET') {
    try {
      const a = require('./core/pde').assess();
      const key = q.get('key');
      const st = a.stages.find(x => x.key === key);
      if (!st) return err(res, 400, '未知级别：' + key + '（可选 ' + a.stages.map(x => x.key).join('/') + '）');
      return json(res, 200, { ok: true, stage: st });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }

  // ===== 材料 / 演示文稿生成（PDE 助手化的真实落点）=====
  if (p === '/v1/deck' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const r = require('./core/deck').build({
        format: b.format || 'html',
        title: b.title || '',
        save: b.save !== false
      });
      return json(res, 200, r);
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/deck/list' && req.method === 'GET') {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(store.dataPath(), 'decks');
    try {
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => /^deck-/.test(f)).sort().reverse().slice(0, 30)
          .map(f => ({ file: f, size: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtimeMs }))
        : [];
      return json(res, 200, { ok: true, count: files.length, files });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }

  // ===== MetaGPT SOP 流水线 + Orca 指挥台（第 3、9 条）=====
  if (p === '/v1/sop/stages' && req.method === 'GET') {
    return json(res, 200, { ok: true, stages: require('./core/sop').stagesInfo() });
  }
  if (p === '/v1/sop/run' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.requirement) return err(res, 400, 'requirement 必填（这正是 MetaGPT 的「一行需求」）');
    // SOP 五阶段串行，每阶段带 Review/Revise 闸门，耗时可达数分钟
    return json(res, 200, await require('./core/sop').run(b.requirement, b));
  }
  if (p === '/v1/sop/board' && req.method === 'GET') {
    return json(res, 200, { ok: true, board: require('./core/sop').board(q.get('limit')) });
  }

  if (p === '/v1/orca' && req.method === 'GET') {
    return json(res, 200, { ok: true, board: require('./core/orca').board(), jobs: require('./core/orca').jobs(10) });
  }
  if (p === '/v1/orca/enqueue' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, require('./core/orca').enqueue(b));
  }
  if (p === '/v1/orca/run' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.id) return json(res, 200, await require('./core/orca').runItem(b.id, b));
    return json(res, 200, await require('./core/orca').runAll(b));
  }
  if (p === '/v1/orca/slots' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, slots: require('./core/orca').setSlots(b.slots) });
  }
  if (p === '/v1/orca/job' && req.method === 'POST') {
    const b = await readBody(req);
    const orca = require('./core/orca');
    if (b.runId) return json(res, 200, await orca.runJob(b.runId));
    return json(res, 200, { ok: true, job: orca.createJob(b) });
  }
  if (p === '/v1/orca/jobs' && req.method === 'GET') {
    return json(res, 200, { ok: true, jobs: require('./core/orca').jobs(q.get('limit')) });
  }
  // ===== Orca 实时指挥台增强端点 =====
  if (p === '/v1/orca/chart' && req.method === 'GET') {
    return json(res, 200, require('./core/orca').chartData());
  }
  if (p === '/v1/orca/pulse' && req.method === 'GET') {
    return json(res, 200, require('./core/orca').pulseMap());
  }
  if (p === '/v1/orca/scene' && req.method === 'GET') {
    return json(res, 200, require('./core/orca').sceneGraph());
  }
  if (p === '/v1/orca/ws' && req.method === 'GET') {
    // WebSocket 升级请求由 server.on('upgrade') 接管，不会落到 HTTP 路由；
    // 走得到这里说明客户端没带 Upgrade: websocket 头。
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', 'Upgrade': 'websocket' });
    return res.end('此端点需要 WebSocket 升级握手（浏览器 new WebSocket() 会自动附带 Upgrade 头）');
  }

  // —— 编排统一内核：控制命令 / 链路 / 学习 / 混沌 ——
  if (p === '/v1/arch/cmd' && req.method === 'POST') {
    const b = await readBody(req);
    const K = require('./core/orkernel');
    const r = await K.cmd(b.line || b.cmd || '');
    if (!r) return err(res, 400, '未知命令。可用：' + K.commandList().map(c => c.cmd).join(' '));
    return json(res, 200, { ok: true, ...r, commands: K.commandList() });
  }
  if (p === '/v1/arch/commands' && req.method === 'GET') {
    return json(res, 200, { ok: true, commands: require('./core/orkernel').commandList(), maxDepth: require('./core/orkernel').MAX_RELAY_DEPTH });
  }
  if (p === '/v1/arch/learn' && req.method === 'GET') {
    const K = require('./core/orkernel');
    return json(res, 200, { ok: true, learn: K.learn() });
  }
  if (p === '/v1/arch/recommend-learned' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, ...require('./core/orkernel').recommendLearned(b.task || '') });
  }
  if (p === '/v1/arch/chaos' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, ...(await require('./core/orkernel').chaos(b.rounds)) });
  }
  if (p === '/v1/arch/chaos' && req.method === 'GET') {
    const log = store.list('chaosLog', 20);
    const last = log[0] || null;
    return json(res, 200, { ok: true, runs: log.length, last });
  }
  if (p === '/v1/arch/chains' && req.method === 'GET') {
    return json(res, 200, { ok: true, chains: require('./core/orkernel').chains() });
  }
  if (p === '/v1/arch/chains' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, chain: require('./core/orkernel').defineChain(b.name, b.stages) });
  }
  if (p === '/v1/arch/chains/run' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, ...(await require('./core/orkernel').runChain(b.id, b.task, b)) });
  }

  // —— 自适应注册：解析 / 建点 / 验证 ——
  if (p === '/v1/registry/discover' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...require('./core/registry').discover() });
  }
  if (p === '/v1/registry/register' && req.method === 'POST') {
    const b = await readBody(req);
    const R = require('./core/registry');
    const src = Array.isArray(b.items) ? b.items : R.discover().candidates.filter(x => x.ok && !x.registered);
    return json(res, 200, { ok: true, ...R.register(src) });
  }
  if (p === '/v1/registry/verify' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, ...require('./core/registry').verify({ limit: b.limit }) });
  }
  if (p === '/v1/registry/audit' && req.method === 'GET') {
    return json(res, 200, { ok: true, audit: require('./core/registry').auditEndpoints(), caps: require('./core/registry').registry().length });
  }

  // ===== 多 Agent 协作网（第 10 条）=====
  if (p === '/v1/paperclip' && req.method === 'GET') {
    return json(res, 200, await require('./core/paperclip').status());
  }
  if (p === '/v1/paperclip/handoff' && req.method === 'GET') {
    return json(res, 200, require('./core/paperclip').handoff({ limit: Number(q.get('limit') || 10) }));
  }
  if (p === '/v1/agentmesh' && req.method === 'GET') {
    return json(res, 200, { ok: true, board: await require('./core/agentmesh').board() });
  }
  if (p === '/v1/guard' && req.method === 'GET') {
    return json(res, 200, await require('./core/guard').status());
  }
  if (p === '/v1/guard/analyze' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, await require('./core/guard').analyze(body));
  }
  if (p === '/v1/guard/case' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, require('./core/guard').recordCase(body));
  }
  if (p === '/v1/guard/pattern' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, require('./core/guard').recordPattern(body));
  }
  if (p === '/v1/guard/sync-skills' && req.method === 'POST') {
    return json(res, 200, await require('./core/guard').syncPsychologySkills());
  }
  if (p === '/v1/guard/load-skills' && req.method === 'POST') {
    return json(res, 200, await require('./core/guard').loadPsychologyPacks());
  }
  if (p === '/v1/agentmesh/consult' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.question) return err(res, 400, 'question 必填');
    return json(res, 200, { ok: true, result: await require('./core/agentmesh').consult(b.question, b) });
  }
  if (p === '/v1/agentmesh/debate' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.question) return err(res, 400, 'question 必填');
    // 真并发 + 单后端超时，避免最慢的一个拖垮整场
    return json(res, 200, { ok: true, debate: await require('./core/agentmesh').debate(b.question, b) });
  }
  if (p === '/v1/agentmesh/packs' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...(await require('./core/agentmesh').discoverPacks()) });
  }
  if (p === '/v1/agentmesh/pack/load' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.repo) return err(res, 400, 'repo 必填');
    return json(res, 200, await require('./core/agentmesh').loadPack(b.repo, b.name));
  }

  // ===== 创作工坊 · 全媒体发布队列（第 11 条）=====
  if (p === '/v1/publish/queue' && req.method === 'GET') {
    return json(res, 200, require('./core/publisher').board());
  }
  if (p === '/v1/publish/platforms' && req.method === 'GET') {
    return json(res, 200, require('./core/publisher').platforms());
  }
  if (p === '/v1/publish/enqueue' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, require('./core/publisher').enqueue(b));
  }
  if (p === '/v1/publish/content' && req.method === 'POST') {
    const b = await readBody(req);
    const c = await require('./core/publisher').createContent(b);
    return json(res, 200, { ok: true, content: c });
  }
  if (p === '/v1/publish/credentials' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, require('./core/publisher').setCredential(b.platform, b.key, b.value));
  }
  if (p === '/v1/publish/feedback' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, require('./core/publisher').recordFeedback(b));
  }
  if (p === '/v1/publish/keywords' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, keywords: require('./core/publisher').setKeywords(b.keywords) });
  }
  if (p === '/v1/publish/harvest' && req.method === 'POST') {
    return json(res, 200, await require('./core/publisher').harvest({ keywords: (await readBody(req) || {}).keywords }));
  }
  if (p === '/v1/publish/auto' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, require('./core/publisher').setAuto(b.platform, b.on));
  }
  if (p === '/v1/publish/flush' && req.method === 'POST') {
    return json(res, 200, await require('./core/publisher').flush(true));
  }
  if (p === '/v1/publish/manual-release' && req.method === 'POST') {
    // 第 11 条：无 API 凭证时运营者真实发布后的手动登记（需要核验依据，见 core/publisher.js）
    const b = await readBody(req);
    return json(res, 200, require('./core/publisher').manualRelease(b.itemId, b));
  }

  // ===== 收费墙治理（第 15 条）=====
  if (p === '/v1/paywall' && req.method === 'GET') {
    const pw = require('./core/paywall');
    // 【重要】覆盖率必须以**全部已声明端点**为分母，而不是"启动后被调用过的端点"。
    // 初版用运行时收集的 _ENDPOINT_REGISTRY 做分母，于是刚启动时只有 21 个，
    // 显示 68% ——一个误导性的数字：用户会以为"还有 32% 没收费"，
    // 而实际上剩下的是"还没被访问过"，不是"漏了"。这样覆盖率就无法证明覆盖率。
    // 现在分母 = 静态解析 server.js 得到的全部端点 ∪ 运行时见过的端点。
    registerEndpoint('GET', '/v1/paywall');
    const all = allDeclaredEndpoints();
    // 【2026-10-21】把**严格管理端点名单**一并交给覆盖率：这些端点必须带管理令牌
    // （回环也不例外），本来就不该上墙，也不该被算成"真漏网"。
    const cov = pw.coverage(all, { opsPaths: STRICT_ADMIN_PATHS });
    return json(res, 200, {
      ok: true,
      ledger: pw.ledger(),
      coverage: cov,
      runtimeSeen: _ENDPOINT_REGISTRY.size,
      enabled: PAYWALL_ENABLED(),
      state: paywallState()
    });
  }
  if (p === '/v1/paywall/toggle' && req.method === 'POST') {
    const b = await readBody(req);
    store.setSetting('paywallOn', b.on === true);
    store.push('audit', {
      action: '收费墙开关',
      detail: b.on === true ? '开启（恢复收费）' : '暂停（功能未修完前不阻断使用）',
      at: Date.now()
    });
    return json(res, 200, { ok: true, enabled: b.on === true, state: paywallState() });
  }

  // 收费墙覆盖率自检（部署门禁）。【2026-10-24 补实现】FLOW_OPS 早已把本端点登记为
  // "部署门禁（管理令牌）"，但路由从未存在 → 门禁本身是空头支票：谁也查不到覆盖率。
  // coverage()/allDeclaredEndpoints()/STRICT_ADMIN_PATHS 都是现成的，只差这条路由。
  // uncovered>0 = 有真实端点既没上墙也没登记免费/流程端点 —— 部署前必须清零。
  if (p === '/v1/paywall/coverage' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：覆盖率自检需管理令牌' });
    }
    return json(res, 200, Object.assign(
      { ok: true, state: paywallState() },
      require('./core/paywall').coverage(allDeclaredEndpoints(), { opsPaths: STRICT_ADMIN_PATHS })
    ));
  }

  // ===== 收费墙·免费额度滥用观测（只记不判）=====
  // 运营看板：哪些 IP 在反复撞墙 / 清 Cookie 制造大量访客身份。纯诊断，不改任何判定语义。
  // 暴露 IP，故限管理令牌（严格模式：回环也需令牌）；只读，不写任何状态。
  if (p === '/v1/wall/stats' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：滥用观测台账限管理令牌' });
    }
    try {
      const wg = require('./core/wallguard');
      return json(res, 200, Object.assign({ ok: true }, wg.stats(q.get('range') || '7d')));
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e).slice(0, 120) });
    }
  }

  // ===== 技能军械库中枢（第 9 条：分类 / 边界 / 可用性）=====
  if (p === '/v1/skillspace' && req.method === 'GET') {
    const S = require('./core/skillspace');
    // 走 audit() 这一个入口：UI 和测试拿的是同一套结论，不会各算各的
    return json(res, 200, Object.assign({ ok: true }, S.audit()));
  }

  // ===== 作战数据底座（第 12 条指挥塔 + 第 13 条战情室 + 守护智慧库）=====
  if (p === '/v1/warboard' && req.method === 'GET') {
    const W = require('./core/warboard');
    const what = q.get('what') || 'all';
    if (what === 'modules') return json(res, 200, { ok: true, modules: W.modules() });
    if (what === 'advice') return json(res, 200, { ok: true, advisories: W.advisories() });
    if (what === 'charts') return json(res, 200, { ok: true, charts: W.charts() });
    if (what === 'wisdom') return json(res, 200, { ok: true, wisdom: W.wisdom() });
    return json(res, 200, { ok: true, snapshot: W.snapshot() });
  }

  // ===== 组织大脑·动态组队（第 4 条：人数不定 / 自选员工 / 学习进化）=====
  if (p === '/v1/org/team' && req.method === 'GET') {
    const team = require('./core/team');
    let focus = null;
    try { focus = require('./core/decision-focus').progress(); } catch (e) { }
    return json(res, 200, { ok: true, board: team.board(), focus });
  }
  if (p === '/v1/org/assign' && req.method === 'POST') {
    const b = await readBody(req);
    const r = require('./core/team').assign({ autoHire: b.autoHire !== false, cap: b.cap });
    return json(res, 200, { ok: true, ...r, board: require('./core/team').board() });
  }
  // 线索认领：线索也是"待办工作"，但原来只派任务，导致 462 条线索全部无人认领。
  // GET  只看产能现状（不写库）；POST 才真正认领。
  if (p === '/v1/org/lead-assign' && req.method === 'GET') {
    const db = store.read();
    const L = db.leads || [];
    const team = require('./core/team');
    const pool = team.staff().filter(s => s.status !== 'off');
    const owned = L.filter(l => l.owner);
    const byOwner = {};
    owned.forEach(l => { byOwner[l.ownerName || l.owner] = (byOwner[l.ownerName || l.owner] || 0) + 1; });
    return json(res, 200, {
      ok: true,
      total: L.length,
      owned: owned.length,
      unowned: L.length - owned.length,
      byOwner,
      staff: pool.length,
      note: '线索按获客能力认领；超出人均产能的部分不派，如实上报'
    });
  }
  if (p === '/v1/org/lead-assign' && req.method === 'POST') {
    const b = await readBody(req);
    const team = require('./core/team');
    const r = team.assignLeads({ capacity: b.capacity });
    return json(res, 200, { ok: true, ...r, board: team.board() });
  }
  // 决策焦点联动：一设焦点就重新组队（第 3 条 → 第 4 条的接缝）
  if (p === '/v1/org/sync' && req.method === 'POST') {
    const r = require('./core/team').syncWithFocus();
    if (!r.ok) return json(res, 400, r);
    return json(res, 200, { ok: true, ...r, board: require('./core/team').board() });
  }
  if (p === '/v1/org/evolve' && req.method === 'POST') {
    const b = await readBody(req);
    const r = require('./core/team').evolve(b.taskId);
    if (!r.ok) return json(res, 404, r);
    return json(res, 200, { ok: true, ...r, board: require('./core/team').board() });
  }

  // ===== 决策焦点（第 3 条：选定领域 → 指向性任务目标）=====
  if (p === '/v1/decision/focus' && req.method === 'GET') {
    const DF = require('./core/decision-focus');
    return json(res, 200, { ok: true, progress: DF.progress(), domains: DF.allDomains() });
  }
  if (p === '/v1/decision/focus' && req.method === 'POST') {
    const b = await readBody(req);
    const DF = require('./core/decision-focus');
    const r = DF.set(b.domain, b.topic, b);
    if (!r.ok) return json(res, 400, r);
    // 第 3 条 → 第 4 条：焦点一设，任务派出来就得有人认领，否则又是断的
    let team = null;
    try { team = require('./core/team').syncWithFocus(); } catch (e) { team = { ok: false, error: e.message }; }
    return json(res, 200, { ok: true, ...r, progress: DF.progress(), team });
  }
  if (p === '/v1/decision/focus' && req.method === 'DELETE') {
    const DF = require('./core/decision-focus');
    const r = DF.close((await readBody(req) || {}).id);
    if (!r.ok) return json(res, 404, r);
    return json(res, 200, { ok: true, progress: DF.progress() });
  }

  // ===== 目标任务（第 16 条：可添加多条，其中一条为"最核心指导目标"）=====
  if (p === '/v1/goals' && req.method === 'GET') {
    // pace：把目标折算成"每日需新增多少"，第 16 条说的"最核心指导目标"
    // 只有能落到具体动作上才算真的在指导（见 core/goals.js pace() 注释）
    return json(res, 200, { ok: true, goals: goals.all(), alignment: goals.alignment(), pace: goals.pace() });
  }
  if (p === '/v1/goals' && req.method === 'POST') {
    const b = await readBody(req);
    if (!String(b.title || '').trim()) return json(res, 400, { ok: false, error: '目标名称不能为空' });
    const g = goals.add(b);
    return json(res, 200, { ok: true, goal: g, goals: goals.all(), alignment: goals.alignment(), pace: goals.pace() });
  }
  if (p === '/v1/goals/primary' && req.method === 'POST') {
    const b = await readBody(req);
    const g = goals.setPrimary(b.id);
    if (!g) return json(res, 404, { ok: false, error: '目标不存在' });
    return json(res, 200, { ok: true, primary: g, goals: goals.all(), alignment: goals.alignment() });
  }
  if (p === '/v1/goals' && req.method === 'DELETE') {
    const b = await readBody(req);
    const r = goals.remove(b.id);
    if (r && r.ok === false) {
      return json(res, 400, { ok: false, error: '内置核心目标不可删除，可先切换核心目标', reason: r.reason });
    }
    return json(res, 200, { ok: true, goals: goals.all(), alignment: goals.alignment(), pace: goals.pace() });
  }

  // ===== 自我更新（检查新版本；本地暂无远程源，返回当前版本）=====
  if (p === '/v1/update/check' && req.method === 'GET') {
    return json(res, 200, { ok: true, current: VERSION, latest: VERSION, hasUpdate: false, note: '本地构建，暂无远程更新源' });
  }

  // ===== 警告声触发记录（声音本体在前端 WebAudio 播）=====
  if (p === '/v1/sound' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    store.push('audit', { action: '播放警告声', detail: (b && b.reason) || 'manual' }, '警告声', (b && b.reason) || 'manual');
    return json(res, 200, { ok: true });
  }

  // ===== 六型决策人格（FINAL-1.1 P2 抉择测试）=====
  if (p === '/v1/persona/questions' && req.method === 'GET') {
    return json(res, 200, { ok: true, total: persona.QUESTIONS.length, types: persona.TYPES, questions: persona.QUESTIONS });
  }
  if (p === '/v1/persona/test' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, persona.runTest(b.answers, b)); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/persona/quick' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, persona.runQuick(b.answers || [], b)); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/persona/history' && req.method === 'GET') {
    return json(res, 200, { ok: true, history: store.list('persona').slice(0, 50) });
  }

  // ===== 活下去手册（FINAL-1.1 §2.8：12 本 + 尊严扫描 + 危机转介）=====
  if (p === '/v1/manuals' && req.method === 'GET') {
    return json(res, 200, { ok: true, total: manuals.list().length, manuals: manuals.list(), hotline: manuals.HOTLINE });
  }
  const manMatch = p.match(/^\/v1\/manuals\/([A-Za-z0-9_\-]+)$/);
  if (manMatch && req.method === 'GET') {
    const m = manuals.get(manMatch[1]);
    if (!m) return err(res, 200, '手册不存在');
    return json(res, 200, { ok: true, ...m });
  }
  if (p === '/v1/manuals/scan' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '');
    if (!text) return err(res, 200, '缺 text');
    const crisis = manuals.scanCrisis(text);
    const dignity = manuals.scanDignity(text);
    store.push('audit', { action: '尊严禁词/危机扫描', detail: 'crisis=' + crisis.crisis + ' hits=' + (crisis.hits.length || 0) }, '尊严禁词扫描', text.slice(0, 30));
    return json(res, 200, { ok: true, crisis: crisis.crisis, crisisHits: crisis.hits, dignity: dignity.passes, dignityHits: dignity.hits, card: crisis.card });
  }

  // ===== 同路人（FINAL-1.1 §2.9：T1 灯角/T2 递一把/T3 被帮账本）=====
  if (p === '/v1/peers/guas' && req.method === 'GET') {
    return json(res, 200, { ok: true, guas: peers.GUAS });
  }
  if (p === '/v1/peers/gua' && req.method === 'GET') {
    const g = peers.guaOf(q.get('topic') || '');
    return json(res, 200, { ok: true, gua: g.id, name: g.name });
  }
  if (p === '/v1/peers/lighthouse' && req.method === 'GET') {
    const gua = q.get('gua') || 'S01';
    return json(res, 200, { ok: true, gua, name: peers.findGua(gua).name, lights: peers.lighthouse(gua), counts: peers.countLights() });
  }
  if (p === '/v1/peers/lighthouse' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...peers.submitT1(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/peers/lighthouse/view' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...peers.view(String(b.id || '')) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/peers/handoff' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...peers.handoff(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/peers/thank' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...peers.thank(String(b.id || ''), String(b.from || '')) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/peers/board' && req.method === 'GET') {
    return json(res, 200, { ok: true, board: peers.leaderboard(), stats: peers.stats() });
  }

  // ===== 年度决策报告 + 止损线 L1–L4（v19 §1 / FINAL-2.0 §10.4）=====
  if (p === '/v1/annual' && req.method === 'GET') {
    return json(res, 200, { ok: true, report: annual.annual() });
  }
  if (p === '/v1/annual/stoploss' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...annual.stopLines() });
  }
  if (p === '/v1/annual/month' && req.method === 'GET') {
    return json(res, 200, { ok: true, sheet: annual.monthSheet() });
  }

  // ===== 内容复用器 E1（FINAL-2.0 §1：一料五吃）=====
  if (p === '/v1/repurpose' && req.method === 'GET') {
    return json(res, 200, { ok: true, list: repurpose.list() });
  }
  if (p === '/v1/repurpose/feed' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...repurpose.feedMaterial(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/repurpose/run' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...repurpose.repurpose(String(b.id || ''), b.grants || []) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/repurpose/grant' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...repurpose.grant(String(b.id || ''), b.keys || []) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/repurpose/resources' && req.method === 'GET') {
    return json(res, 200, { ok: true, whitelist: peers.RESOURCE_WHITELIST });
  }

  // ===== 自主发布引擎 L1（Playwright 控制浏览器发布，真实可验证）=====
  if (p === '/v1/autopub/overview' && req.method === 'GET') {
    return json(res, 200, { ok: true, list: autopub.overview() });
  }
  if (p === '/v1/autopub/status' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...(await autopub.statusOne(String(b.platform || ''))) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopub/publish' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...(await autopub.publish(String(b.platform || ''), b.draft || {}, { dryRun: b.dryRun !== false })) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopub/log' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, log: autopub.logAll(String(b.platform || '')) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/autopub/assets' && req.method === 'GET') {
    return json(res, 200, { ok: true, assets: autopub.listAssets(20) });
  }

  // ===== 七段决策报告（FINAL-1.1 §2.2：宪法级 · 第7段灯角）=====
  if (p === '/v1/report/seven' && req.method === 'POST') {
    // 【2026-10-21 去重统计】/v1/report/* 命中 paywall 前缀规则（evolve 池），
    // autoGate 已在进入路由前按池计数；此前这里再走 gateContent(subs.gate)
    // 会把同一次使用**重复记账**（既扣 evolve 池又扣账号级 freeLeft+used）——
    // 免费期被"记两笔"提前到墙。统一以 autoGate/gatePool 为唯一计量点。
    // 【含义修正】gate() 还无视 paywall 开关：运营关闭全站墙时，唯独这个路由仍然扣量
    // ——「无谓限制」的来源之一。现在与全站口径一致（paywallOn=false ⇒ 免费）。
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, report: report.seven(b.topic, b.answer, visitorOf(req, q, res)) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/report/list' && req.method === 'GET') {
    return json(res, 200, { ok: true, list: report.list(), stats: report.stats() });
  }
  if (p.indexOf('/v1/report/') === 0 && p.length > '/v1/report/'.length && req.method === 'GET') {
    const rid = decodeURIComponent(p.slice('/v1/report/'.length)).trim();
    const r = report.get(rid);
    if (!r) return err(res, 200, 'report not found: ' + rid);
    return json(res, 200, { ok: true, report: { ...r, verifyUrl: report.verifyUrl(rid) } });
  }

  // ===== E3 单人客服工单（FINAL-2.0 §3）=====
  if (p === '/v1/tickets' && req.method === 'GET') {
    return json(res, 200, { ok: true, list: store.list('tickets').slice(0, 50), sla: tickets.SLA, channels: tickets.CHANNELS, stats: tickets.stats(), compliance: tickets.compliance() });
  }
  if (p === '/v1/tickets/board' && req.method === 'GET') {
    return json(res, 200, { ok: true, weekly: tickets.weekly(), slaWatch: tickets.slaWatch() });
  }
  if (p === '/v1/tickets' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...tickets.create(b, b.channel) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/tickets/respond' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...tickets.respond(String(b.id || ''), b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/tickets/conclude' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...tickets.conclude(String(b.id || ''), b.conclusion) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/tickets/refund' && req.method === 'POST') {
    const b = await readBody(req);
    // 退款必须带 revId + evidence：缺了服务端会拒（不再出现「账上没退、工单却写已退」）
    try { return json(res, 200, { ok: true, ...tickets.refund(String(b.id || ''), b.processed === true, b.note, { revId: b.revId, evidence: b.evidence }) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/tickets/batch' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...tickets.batchApprove(String(b.id || ''), b.decision, b.note) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/tickets/batch/sunday' && req.method === 'POST') {
    try { return json(res, 200, { ok: true, ...tickets.sundayBatch() }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/tickets/batch/history' && req.method === 'GET') {
    return json(res, 200, { ok: true, history: tickets.batchHistory() });
  }

  // ===== E4 发布列车（FINAL-2.0 §4：版本火车）=====
  if (p === '/v1/train' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...train.board() });
  }
  if (p === '/v1/train/load' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...train.load(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/train/depart' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...train.depart(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/train/park' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...train.park(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/train/lot' && req.method === 'POST') {
    // 从 parking lot 提取想法装车本班（尊重：lot 不删，只标记 taken）
    const b = await readBody(req);
    try {
      if (!['growth', 'retention', 'debt'].includes(b.slot)) throw new Error('slot 必须为 growth/retention/debt');
      return json(res, 200, { ok: true, ...train.takeFromLot(String(b.id || ''), undefined, b.slot) });
    }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/train/debt' && req.method === 'GET') {
    return json(res, 200, { ok: true, debt: train.techDebt() });
  }

  // ===== E2 冷启动 Playbook（FINAL-2.0 §2：D1–D30）=====
  if (p === '/v1/playbook' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...playbook.board() });
  }
  if (p === '/v1/playbook/launch' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...playbook.launch(b.ms) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/playbook/check' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const t = playbook.today();
      const day = b.day !== undefined && b.day !== null && b.day !== '' ? b.day : (t ? t.day : 1);
      return json(res, 200, { ok: true, ...playbook.checkDay(day, b.late === true) });
    }
    catch (e) { return err(res, 200, e.message); }
  }
  // GET /v1/playbook/honest —— 诚实三数：实测/挂账/台账严格分离
  if (p === '/v1/playbook/honest' && req.method === 'GET') {
    return json(res, 200, { ok: true, honest: playbook.honestCounts() });
  }

  if (p === '/v1/playbook/tally' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, tally: playbook.tally(b), gate: playbook.gate() }); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== 故事工厂（doc2/FINAL-1.2：S1–S9 半托管流水线）=====
  if (p === '/v1/foundry' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...foundry.board() });
  }
  if (p === '/v1/foundry/grant' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...foundry.grantAuth(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/foundry/sources' && req.method === 'GET') {
    return json(res, 200, { ok: true, sources: foundry.sources() });
  }
  if (p === '/v1/foundry/works' && req.method === 'GET') {
    return json(res, 200, {
      ok: true, works: store.list('foundry').map(w => ({
        id: w.id, title: w.title, station: w.station, tier: w.tier,
        published: !!w.published, rewriteSatisfied: w.rewriteSatisfied,
        chapterCount: w.reworkedChs || 0, protoCount: w.protoCount
      }))
    });
  }
  if (p === '/v1/foundry' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...foundry.create(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/foundry/advance' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const id = String(b.id || '');
      const st = String(b.station || '');
      let out;
      if (st === 'S3') out = foundry.outline(id);
      else if (st === 'S4') out = foundry.humanReview(id, b);
      else if (st === 'S5') out = foundry.draft(id);
      else if (st === 'S6') out = foundry.humanRewrite(id, b);
      else if (st === 'S7') out = foundry.qc(id);
      else if (st === 'S8') out = foundry.finalReview(id, b);
      else if (st === 'S9') out = foundry.publish(id);
      else return err(res, 200, 'station 必须 S3–S9');
      return json(res, 200, { ok: true, ...out });
    } catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/foundry/share' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...foundry.revenueShare(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }

  // ===== A13 MCP Agent-ready（FINAL-2.0 §6）=====
  if (p === '/v1/mcp/tools' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...mcp.tools() });
  }
  if (p === '/v1/mcp/keys' && req.method === 'POST') {
    // 鉴权红线：签发 API key 属运营动作。此前无鉴权 → 任何人可自助签发（安全漏洞）。
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限：签发 MCP key 需管理员令牌' });
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...mcp.issueKey(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/mcp/recharge' && req.method === 'POST') {
    // 鉴权红线：充值直接写 mcpKeys.balance 且不接支付。
    // 原实现任何人 POST {"key":"x","amt":99999} 即可给自己加无限余额（收入线被击穿）。
    // 现在仅运营可操作，且**必须走人工确认到账**后才记账，绝不接受自报金额入账。
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限：MCP 充值需管理员令牌' });
    const b = await readBody(req);
    const amt = Number(b.amt || 0);
    if (!(amt > 0)) return json(res, 200, { ok: false, error: '充值金额必须 > 0' });
    if (b.evidence === undefined || String(b.evidence).trim() === '') {
      return json(res, 200, { ok: false, error: '充值必须提供到账凭证（evidence）：先收款、核对流水，再登记余额。不接受自报金额。' });
    }
    try { return json(res, 200, { ok: true, ...mcp.recharge(String(b.key || ''), amt, String(b.evidence || '')) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/mcp/call' && req.method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...mcp.call(b) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/mcp/stats' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...mcp.stats() });
  }

  // ===== 24h 监控哨兵 =====
  // 事件循环阻塞 + 慢写盘 + 启动耗时 联合报告：把"卡"和"慢"变成可归因的数字
  if (p === '/v1/diag/loop' && req.method === 'GET') {
    return json(res, 200, Object.assign({
      ok: true,
      uptimeMs: Math.round(process.uptime() * 1000),
      boot: Object.fromEntries(Object.entries(BOOT.marks).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      nodeStartToListenMs: Math.round((BOOT.readyMs || 0) * 10) / 10
    }, loopWatch.report(), {
      store: require('./core/store').stats(),
      slowWrites: require('./core/store').slowWrites(),
      // 谁在堵：loopWatch 说"堵了多久"，这里说"哪个后台任务干的"
      tasks: require('./core/tasktime').report()
    }));
  }

  if (p === '/v1/watch' && req.method === 'GET') {
    const w = watchdog.status();
    return json(res, 200, { ok: true, ...w });
  }
  if (p === '/v1/watch/scan' && (req.method === 'GET' || req.method === 'POST')) {
    const s = watchdog.scanNow();
    const d = await watchdog.dispatch(s);
    return json(res, 200, { ok: true, count: s.length, anomalies: s, alert: d });
  }
  if (p === '/v1/watch/patrol' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await watchdog.patrol(!!b.force);
    return json(res, 200, { ok: true, ...r });
  }

  // ===== 24h 监控自修复闭环（第 15 条）=====
  // 原 /v1/watch/scan 只做「发现异常 + 发邮件」，发现之后就没人管了 ——
  // watchdog 的 healOnce() 只覆盖 11 个告警项中的 1 个。
  // 这里接上 core/self-heal.js 的三段式闭环：诊断 → 处置 → 复检。
  if (p === '/v1/watch/heal' && req.method === 'POST') {
    const b = await readBody(req);
    let list = null;
    // 默认用刚扫出来的异常；也可以显式传入，便于测试与复盘
    if (!b.list) {
      try { list = await watchdog.scanNow(); } catch (e) { list = null; }
    } else {
      list = b.list;
    }
    try {
      const H = require('./core/self-heal');
      const r = await H.runOnce({ list });
      return json(res, 200, { ok: true, ...r, scanned: (list || []).length });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/watch/heal/coverage' && req.method === 'GET') {
    try {
      return json(res, 200, { ok: true, ...require('./core/self-heal').coverage() });
    } catch (e) { return err(res, 200, String(e.message || e)); }
  }
  if (p === '/v1/mail' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.to) b.to = store.getSetting('alertEmail') || watchdog.DEFAULT_INBOX;
    const r = await mailer.send(b.to, String(b.subject || 'BingDashan 测试邮件').slice(0, 100), String(b.html || b.text || '测试正文'));
    return json(res, 200, { ok: r.ok, ...r });
  }
  if (p === '/v1/mail/log' && req.method === 'GET') {
    return json(res, 200, { ok: true, mails: mailer.log(Number(q.get('limit') || 20)) });
  }

  // ===== 订阅 / 收费墙 =====
  if (p === '/v1/subs/identity' && req.method === 'POST') {
    const b = await readBody(req);
    const key = String(b.key || visitorOf(req, q, res)).slice(0, 64);
    return json(res, 200, { ok: true, vid: subs.issue(key).vid, status: subs.status(key) });
  }
  if (p === '/v1/subs/status' && req.method === 'GET') {
    return json(res, 200, subs.status(visitorOf(req, q, res)));
  }
  // GET /v1/subs = /v1/subs/status 的短路径别名。【2026-10-24 补实现】
  // PUBLIC 登记表早已承诺 "GET /v1/subs 查自己的订阅状态与套餐"，但路由从未存在，
  // 外部集成方按登记表调用只能拿到 404（注册≠存在，运行时探针实证）。
  if (p === '/v1/subs' && req.method === 'GET') {
    return json(res, 200, subs.status(visitorOf(req, q, res)));
  }
  // ===== 额度说明（公开）：买之前把"能用多少"讲清楚 =====
  // 竞品 2026-07 因"额度口径不透明"被集中投诉 → 我们把额度作为**公开事实**给出，
  // 数据直接来自收费墙登记表（core/paywall.js quotaInfo），不手抄、不会漂移。
  if (p === '/v1/subs/quota' && req.method === 'GET') {
    try {
      const pwq = require('./core/paywall');
      return json(res, 200, Object.assign({ ok: true }, pwq.quotaInfo()));
    } catch (e) {
      return err(res, 200, e.message);
    }
  }
  // 成熟度校准报告（2026-10-23）：只读接口，返回各分区当前成熟度 + 用量 + 升降级建议
  // 供运营后台定期查看；修改 maturity 需人工改 core/paywall.js SECTIONS 后重启
  if (p === '/v1/maturity/report' && req.method === 'GET') {
    try {
      const mat = require('./core/maturity');
      return json(res, 200, Object.assign({ ok: true }, mat.report()));
    } catch (e) {
      return err(res, 200, e.message);
    }
  }
  // 用量 × 毛利看板（2026-10-23，借鉴 apinebula.ai 的「实时用量监控 + 导出账单」）
  //
  // 【为什么需要】收入侧精确（money.credit 幂等），成本侧虽有 core/cost.js 台账，
  // 但**没有任何接口暴露它** → 经营上看不到"这单赚不赚钱"，毛利一直是黑箱。
  // 这里把两边放在同一口径下：营收只算已结算且非自测的 CNY 收入，
  // 成本只算拿到 usage 的调用（估算价），并明确标注估算覆盖率与不可入账性。
  //
  // 【权限】含经营数据 → 必须管理令牌（回环也不例外）。
  if (p === '/v1/usage/margin' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：毛利看板需管理令牌' });
    }
    try {
      const cost = require('./core/cost');
      const money = require('./core/money');
      const pw = require('./core/paywall');
      // 注意：q 是 URLSearchParams，必须用 q.get('days')（属性访问永远 undefined）
      const days = Math.max(1, Math.min(365, Number(q.get('days')) || 30));
      const since = Date.now() - days * 86400000;
      const c = cost.summary(since);
      const k = money.kpi();

      // —— 同期营收回算（与 money.kpi 同口径：settled + 非自测 + 仅 CNY）——
      const orderById = new Map(require('./core/store').list('orders').map(o => [String(o.id), o]));
      let rev = 0, revRows = 0, undated = 0, test = 0, refunded = 0;
      require('./core/store').list('revenue').forEach(r => {
        if (!r || !r.amt) return;
        if (r.currency && r.currency !== 'CNY') return;
        const t = Number(r.at || r.createdAt || 0);
        if (!t) { undated++; return; }
        if (t < since) return;
        if (money.isSettled(r)) {
          if (money.isSelfTest(r, orderById)) { test += Number(r.amt); return; }
          rev += Number(r.amt); revRows++;
        } else if (r.refunded === true || r.status === 'refunded') {
          refunded += Number(r.amt);
        }
      });

      const rounded = n => Math.round(n * 10000) / 10000;
      const margin = rounded(rev - c.cny);
      const pricedRate = c.calls ? Math.round(c.pricedCalls / c.calls * 100) : null;
      // 【诚实口径】一次成本都没记到（calls=0）时，"毛利 100%"是假象 ——
      // 那说明成本侧还没开张（LLM 未接），不是真的高毛利。此时不给毛利率。
      const costKnown = c.calls > 0 && c.pricedCalls > 0;
      return json(res, 200, {
        ok: true,
        windowDays: days,
        since,
        revenue: rounded(rev), revenueRows: revRows,
        selfTestRevenue: rounded(test), refunded: rounded(refunded),
        undatedRevenueRows: undated,          // 没有时间戳的历史行：不计入窗口（诚实计数）
        cost: c.cny, costCalls: c.calls, pricedCalls: c.pricedCalls,
        pricedCoverage: pricedRate,           // 成本估算覆盖率（未取到 usage 的调用不计金额）
        costKnown,                            // false = 成本台账还没有数据，毛利不可信
        margin: costKnown ? margin : null,
        marginRate: (costKnown && rev > 0) ? Math.round(margin / rev * 1000) / 10 : null,
        byProvider: c.byProvider,
        usageToday: pw.ledger().usageToday,
        allTimeRevenue: k.revenue,            // 全期真实到账（目标口径，不含自测）
        notes: {
          revenue: '仅已结算、非自测、CNY 收入；与 money.kpi().revenue 同口径',
          cost: c.note,
          margin: '毛利 = 期间实收 − 期间 LLM 成本估算；成本覆盖率 <100% 时毛利偏高（乐观值）',
          notInvoice: '本接口是经营参考，不是财务凭证；对账以 money 台账与银行流水为准',
        },
      });
    } catch (e) {
      return err(res, 200, e.message);
    }
  }
  // ===== 订阅商业闭环体检（2026-10-23）=====
  // 回答"端到端闭环成立吗"：访问→参与→试用→付费→激活→留存→续费→转介绍，
  // 每段用真实台账算，外加断裂检查（付钱无权益/开通不使用/凭证悬挂/退款悬空）。
  if (p === '/v1/loop/saas' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：闭环体检需管理令牌' });
    try {
      const loop = require('./core/saas-loop');
      return json(res, 200, loop.report());
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 远程协助（协调通道，不含屏幕控制）=====
  // 客户主动发起：问题 + 范围 + 同意书 → 运营队列 → 接单 → 完成，全程留痕。
  if (p === '/v1/assist/request' && req.method === 'POST') {
    if (!rateOK('assist:ip:' + clientIp(req), 5, 3600000)) {
      return json(res, 429, { ok: false, error: '协助请求过于频繁，请稍后再试' });
    }
    const b = await readBody(req).catch(() => ({}));
    const who = visitorOf(req, q, res);
    return json(res, 200, require('./core/assist').request(who, b));
  }
  if (p === '/v1/assist/status' && req.method === 'GET') {
    return json(res, 200, require('./core/assist').status(visitorOf(req, q, res)));
  }
  if (p === '/v1/assist/cancel' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/assist').cancel(b.id, visitorOf(req, q, res)));
  }
  if (p === '/v1/assist/queue' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, require('./core/assist').queue(q.get('all') === '1'));
  }
  if (p === '/v1/assist/stats' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, require('./core/assist').stats());
  }
  if (p === '/v1/assist/accept' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/assist').accept(b.id, b.opsName));
  }
  if (p === '/v1/assist/complete' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/assist').complete(b.id, b.note));
  }

  // ===== 陪护闭环（2026-10-23）：建档/绑定/设备/告警/任务/资料 =====
  // 责任链：老人本人同意建档 → 子女凭邀请码加入 → 设备心跳 → 出事告警 → SLA 升级 → 接单/闭环 → 审计
  if (p === '/v1/care/family/create' && req.method === 'POST') {
    if (!rateOK('care:create:' + clientIp(req), 5, 3600000)) return json(res, 429, { ok: false, error: '建档过于频繁' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').createFamily(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/family/join' && req.method === 'POST') {
    if (!rateOK('care:join:' + clientIp(req), 10, 3600000)) return json(res, 429, { ok: false, error: '操作过于频繁' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').joinFamily(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/family' && req.method === 'GET') {
    return json(res, 200, require('./core/care').familyView(careVisitorOf(req, q, res)));
  }
  if (p === '/v1/care/profile' && req.method === 'GET') {
    return json(res, 200, require('./core/care').getProfile(careVisitorOf(req, q, res), q.get('familyId')));
  }
  if (p === '/v1/care/profile' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').saveProfile(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/device/register' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').registerDevice(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/device/heartbeat' && req.method === 'POST') {
    if (!rateOK('care:hb:' + clientIp(req), 240, 60000)) return json(res, 429, { ok: false, error: '心跳过于频繁' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').heartbeat(String(b.token || ''), b));
  }
  if (p === '/v1/care/alert' && req.method === 'POST') {
    if (!rateOK('care:alert:' + clientIp(req), 10, 60000)) return json(res, 429, { ok: false, error: '告警过于频繁' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').raiseAlert(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/alert/ack' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const ops = adminAuthedStrict(req);
    return json(res, 200, require('./core/care').ackAlert(careVisitorOf(req, q, res), b, { ops }));
  }
  if (p === '/v1/care/alert/resolve' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const ops = adminAuthedStrict(req);
    return json(res, 200, require('./core/care').resolveAlert(careVisitorOf(req, q, res), b, { ops }));
  }
  if (p === '/v1/care/alerts' && req.method === 'GET') {
    return json(res, 200, require('./core/care').listAlerts(careVisitorOf(req, q, res), q.get('familyId'), { openOnly: q.get('open') === '1' }));
  }
  if (p === '/v1/care/task' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').createTask(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/task/done' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').completeTask(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/tasks' && req.method === 'GET') {
    return json(res, 200, require('./core/care').listTasks(careVisitorOf(req, q, res), q.get('familyId')));
  }
  if (p === '/v1/care/doc' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').addDoc(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/docs' && req.method === 'GET') {
    return json(res, 200, require('./core/care').listDocs(careVisitorOf(req, q, res), q.get('familyId')));
  }
  if (p === '/v1/care/doc/file' && req.method === 'GET') {
    const ops = adminAuthedStrict(req);
    const r = require('./core/care').openDoc(careVisitorOf(req, q, res), q.get('id'), { ops, grantId: q.get('grantId') });
    if (!r.ok) return json(res, 200, r);
    // 加密信封资料：openDoc 已解密成 buf，直接回字节（Content-Length 用真实明文长度）
    if (r.buf) {
      res.writeHead(200, {
        'Content-Type': r.mime, 'Content-Length': r.buf.length,
        'Content-Disposition': 'inline; filename="' + encodeURIComponent(r.title || 'doc') + '"',
        'Cache-Control': 'no-store',
      });
      return res.end(r.buf);
    }
    // 旧版明文文件（迁移前存量）：流式返回
    try {
      const st = require('fs').statSync(r.path);
      res.writeHead(200, {
        'Content-Type': r.mime, 'Content-Length': st.size,
        'Content-Disposition': 'inline; filename="' + encodeURIComponent(r.title || 'doc') + '"',
        'Cache-Control': 'no-store',
      });
      return require('fs').createReadStream(r.path).pipe(res);
    } catch (e) { return json(res, 200, { ok: false, error: '文件读取失败' }); }
  }
  if (p === '/v1/care/center' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：监控中心需管理令牌' });
    return json(res, 200, require('./core/care').center());
  }
  if (p === '/v1/care/loop' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：陪护闭环体检需管理令牌' });
    return json(res, 200, require('./core/care').loop());
  }
  if (p === '/v1/care/report' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, require('./core/care').report());
  }

  // ===== 陪护：定价/订阅/通知/资料治理/临时授权（2026-10-24 商业闭环收口）=====
  // 定价对外只读（改价在服务端 settings.carePlan，属商业决策）
  if (p === '/v1/care/plans' && req.method === 'GET') {
    return json(res, 200, require('./core/care').carePlan());
  }
  // 子女开通订阅：pending 订单（付清才生效；人工/网关核账后 fulfill）
  if (p === '/v1/care/order' && req.method === 'POST') {
    if (!rateOK('care:order:' + clientIp(req), 10, 3600000)) return json(res, 429, { ok: false, error: '开单过于频繁' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').createCareOrder(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/orders' && req.method === 'GET') {
    return json(res, 200, require('./core/care').careOrderView(careVisitorOf(req, q, res), q.get('familyId')));
  }
  // 运营/人工核账：确认到账后开通（走既有 money 口径的凭据由运营侧记录）
  if (p === '/v1/care/order/fulfill' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：开通陪护订阅需管理令牌' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').fulfillCareOrder('ops', b.orderId, b.proofId));
  }
  // 家属删除自己的资料（PIPL 删除权）
  if (p === '/v1/care/doc/delete' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').deleteDoc(careVisitorOf(req, q, res), b.id));
  }
  // 家属给运营/协助员开“单份资料临时授权窗口”
  if (p === '/v1/care/grant' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').grantDoc(careVisitorOf(req, q, res), b));
  }
  if (p === '/v1/care/grant/revoke' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, require('./core/care').revokeGrant(careVisitorOf(req, q, res), b.id));
  }
  // 通知队列（短信/邮件兜底/预算）与重发
  if (p === '/v1/care/notifies' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, require('./core/care').notifiesSummary());
  }
  if (p === '/v1/care/notifies/flush' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, require('./core/care').flushNotifies());
  }
  // 存量健康数据加密迁移（PIPL）：明文档案 → 字段级密文；明文资料文件 → CENC1 信封。
  // 幂等可重入；失败项如实计数（不虚报成功）。闭环体检的 health_data_unencrypted 断点指向这里。
  if (p === '/v1/care/profile/migrate' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：加密迁移需管理令牌' });
    return json(res, 200, require('./core/care').migrateEncryption());
  }

  // ===== 客户档案（资料统一视图）=====
  // 一个客户的全部事实：订单/凭证/权益/退款/工单/交付物/协助请求 + 待办清单。
  // 解决"资料散在 6 个表里、客服要开 6 个页面才能回答客户一个问题"。
  if (p === '/v1/customer/file' && req.method === 'GET') {
    try {
      const vid = visitorOf(req, q, res);
      const subs = require('./core/subs');
      const st = subs.status(vid);
      const orders = store.findAllBy('orders', 'visitor', vid)
        .sort((a, b) => Number(b.at || 0) - Number(a.at || 0)).slice(0, 20)
        .map(o => ({
          id: o.id, plan: o.plan, amount: o.amount, currency: o.currency,
          status: o.status, paid: !!o.paid, at: o.at,
          manualStatus: o.manualStatus || null,
          proofAt: o.proofAt || null, proofCount: Number(o.proofCount || 0),
        }));
      const refunds = store.findAllBy('refundRequests', 'visitor', vid)
        .sort((a, b) => Number(b.at || 0) - Number(a.at || 0)).slice(0, 10);
      const tickets = store.findAllBy('tickets', 'visitor', vid)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 10)
        .map(t => ({ id: t.id, subject: t.subject || t.title || '', status: t.status, prio: t.prio, createdAt: t.createdAt }));
      const assists = require('./core/assist').status(vid).items.slice(0, 10);
      let assets = null;
      try { assets = require('./core/tenancy').myDataSummary(vid); } catch (e) { assets = null; }
      const todo = [];
      if (st.needProof) todo.push({ code: 'proof', text: '补交支付凭证（当前订单待核账）', orderId: st.needProofOrderId });
      if (st.provisional) todo.push({ code: 'provisional', text: '权益已临时开通，运营核账后会转正', until: st.tempUntil });
      if (st.sub && Number(st.sub.daysLeft) <= 7) todo.push({ code: 'renew', text: '订阅将在 ' + st.sub.daysLeft + ' 天后到期', expireAt: st.sub.expireAt });
      if (!st.sub && !st.unlimited) todo.push({ code: 'subscribe', text: '免费额度剩余 ' + (st.freeLeft == null ? 0 : st.freeLeft) + ' 次' });
      const latestOrder = orders[0] || null;
      return json(res, 200, {
        ok: true, visitor: vid,
        identity: { visitor: vid, sub: st.sub, unlimited: st.unlimited, provisional: st.provisional, freeLeft: st.freeLeft, trialUsed: st.trialUsed },
        orders, refunds, tickets, assists, assets,
        todo,
        loopState: latestOrder && (latestOrder.paid || latestOrder.status === 'paid')
          ? (st.sub ? 'entitled' : (st.provisional ? 'provisional' : 'paid_no_entitlement'))
          : (orders.length ? 'ordered_not_paid' : 'visitor'),
        note: '本档案只含当前访客自己的数据；金额与权益以订单/订阅台账为准，不含运营内部成本信息。',
      });
    } catch (e) { return err(res, 200, e.message); }
  }
  // 访客键规范化：身份只认服务端签发（signature-first）。传 vid 先验证取裸 key，
  // 保证与收费墙同一身份（避免 vid 全长与裸 key 建出两条访客记录）。
  // 旧实现 `verify(k) || k.slice(0,64)` 无条件接受任意未签名字符串——
  // 攻击者可随便换 raw key 让 visitorBy 建出满配额新访客：绕过付费墙（免费额度/每日 pools
  // 全部重置）+ 无限刷 ¥1 体验单 + db 爆炸。现在未签名 key 一律回落 cookie/anon 身份。
  const canonKey = raw => subs.verify(String(raw || '')) || null;
  // 定价页（只读）。【2026-10-24 补实现】core/paywall.js 的 PUBLIC 早已登记
  // GET /v1/plans（"定价页：收费墙要展示价格"），但路由从未实现 → 注册≠存在，
  // 任何调用方只能拿到 404。现补上：套餐与 subs.status() 同源（PLANS_CN/EN，
  // 不造第二份口径），并带免费额度说明与收费墙当前状态，定价页一次取齐。
  if (p === '/v1/plans' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      plans: { CN: subs.PLANS_CN, EN: subs.PLANS_EN },
      quota: require('./core/paywall').quotaInfo(),
      wall: paywallState(),
    });
  }
  if (p === '/v1/subs/gate' && req.method === 'POST') {
    const b = await readBody(req);
    const r = subs.gate(canonKey(b.key) || visitorOf(req, q, res));
    return json(res, 200, r);
  }
  if (p === '/v1/subs/order' && req.method === 'POST') {
    const b = await readBody(req);
    const r = subs.order(canonKey(b.key) || visitorOf(req, q, res), String(b.plan || 'm'), b.lang, clientIp(req), b.email);
    return json(res, 200, r);
  }
  // 买家给**自己的**订单补邮箱（付款弹窗里填）。
  // 【为什么放在这里】站点订单按 visitor 令牌追踪，从不存邮箱 → 商业闭环的通知段
  //   永远只能记 skipped/no_email，客户拿不到付款凭证。采集邮箱是闭环能送达的前提。
  // 【安全】邮箱不是身份凭证；且只能改「订单自己的访客」的订单（subs.attachEmail 校验）。
  if (p === '/v1/subs/order/email' && req.method === 'POST') {
    if (!rateOK('subsemail:ip:' + clientIp(req), 20, 60000)) {
      return json(res, 429, { ok: false, error: '提交过于频繁，请稍后再试' });
    }
    const b = await readBody(req);
    const r = subs.attachEmail(String(b.orderId || ''), canonKey(b.key) || visitorOf(req, q, res), b.email);
    return json(res, 200, r);
  }
  // ===== 免费试用 2 天（获客件，2026-10-25）=====
  // 领取即激活、无需付款；防刷与限次全部在 subs.claimFreeTrial 内（每人一次 + IP 台账）。
  // 这里只做一层 IP 限流（每 IP 每小时 6 次尝试），把枚举/脚本打的噪音挡在业务逻辑外。
  if (p === '/v1/subs/free-trial' && req.method === 'POST') {
    if (!rateOK('freetrial:ip:' + clientIp(req), 6, 3600000)) {
      return json(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
    }
    const r = subs.claimFreeTrial(visitorOf(req, q, res), clientIp(req));
    return json(res, r.ok ? 200 : 400, r);
  }
  // ===== 支付网关：结账 / 状态 / 回调 =====
  // ===== 内嵌付款码的落点：/pay/go/<订单号> → 302 到真实网关收银台 =====
  // 二维码里只编码我们自己的短链（网关 URL 太长，超出二维码容量且参数一变就失效）。
  // 服务端拿着订单号查内存里的真实链接再跳转：目标地址永远由服务端决定，
  // 不信任任何客户端传入的 URL（防钓鱼：不能让人用我们的域名跳去任意网站）。
  if (p && p.indexOf('/pay/go/') === 0 && (req.method === 'GET' || req.method === 'HEAD')) {
    const oid = p.slice('/pay/go/'.length).split('?')[0];
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(oid)) return err(res, 400, '订单号格式非法');
    const target = pay.gatewayLink(oid);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>付款链接已过期</title>'
        + '<body style="font:15px/1.7 system-ui;padding:40px;text-align:center">'
        + '<h2>该付款二维码已过期</h2><p>请返回软件重新点击「订阅」，生成新的付款码。</p></body>');
    }
    res.writeHead(302, { Location: target });
    return res.end();
  }
  // ===== 智能二维码落点：/pay/smart/<订单号> → 根据订单币种自动路由 =====
  // CNY → 手动收款页（支付宝/微信二维码）
  // USD → PayPal/Moltspay 网关收银台
  // 这样买家只需扫一枚码，服务端自动识别币种并跳转到正确的支付流程
  if (p && p.indexOf('/pay/smart/') === 0 && (req.method === 'GET' || req.method === 'HEAD')) {
    const oid = p.slice('/pay/smart/'.length).split('?')[0];
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(oid)) return err(res, 400, '订单号格式非法');
    // 查找订单
    const o = store.findBy('orders', 'id', oid);
    if (!o) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>订单不存在</title>'
        + '<body style="font:15px/1.7 system-ui;padding:40px;text-align:center">'
        + '<h2>订单不存在</h2><p>请返回软件重新点击「订阅」，生成新的付款码。</p></body>');
    }
    const currency = (o.currency || 'CNY').toUpperCase();
    let target;
    if (currency === 'USD') {
      // USD → 走网关，先调用 checkout 获取网关链接
      const pw = await pay.checkout({ orderId: oid, amount: o.amount, currency: 'USD' });
      target = (pw && pw.payUrl) || pay.gatewayLink(oid);
      if (!target) target = pay.publicUrl('/#subs'); // 兜底：回到软件订阅页
    } else {
      // CNY / 其他 → 手动收款页（前端会渲染支付宝/微信二维码）
      target = pay.publicUrl('/#subs?order=' + encodeURIComponent(oid) + '&manual=1');
    }
    res.writeHead(302, { Location: target });
    return res.end();
  }
  if (p === '/v1/pay/checkout' && req.method === 'POST') {
    // 【限流】公开端点。同一订单重复出付款链接会让买家看到多张不同的收款页，
    // 且每次都要查单 + 可能触发网关请求。按订单号与来源双维度限流。
    if (!rateOK('checkout:ip:' + clientIp(req), 30, 60000)) {
      return json(res, 429, { ok: false, error: '下单过于频繁，请稍后再试' });
    }
    const b = await readBody(req);
    const r = await pay.checkout({ orderId: String(b.orderId || b.order || ''), plan: b.plan, amount: b.amount, currency: b.currency, channel: b.channel });
    return json(res, 200, r);
  }
  if (p === '/v1/pay/status' && req.method === 'GET') {
    const oid = String(q.get('order') || '');
    let o = store.findBy('orders', 'id', oid);
    if (!o) return json(res, 200, { ok: false, error: '订单不存在' });
    // 【付款即开通兜底】回调可能延迟或丢失（回调地址短时不可达、网关重推排队）。
    // 待支付单在前端轮询时顺带主动向网关查单一次，确认到账即本地幂等结算 + 开通。
    // 严格限频：每单 ≥8s 一次 + 全局 60s ≤60 次；任一失败一律静默，绝不影响轮询返回。
    if (!o.paid && String(o.status || '') !== 'expired') {
      const last = _paySyncAt[oid] || 0;
      if (Date.now() - last > 8000 && rateOK('paysync:global', 60, 60000)) {
        _paySyncAt[oid] = Date.now();
        try {
          if (String(o.currency || 'CNY') === 'USD') {
            // PayPal：买家在收银台批准后单子是 APPROVED，必须由我们 capture 才算收到钱。
            // 前端轮询顺带 capture 一次：买家不回跳（关了页面）也能开通。
            // 只对本单确实是 PayPal 通道的单生效：人工/其它 USD 单不该去问 PayPal。
            if (String(o.channel || '') === 'paypal' || o.paypalOrderId) {
              try { await pay.paypalQuery(oid); } catch (e) { }
            }
          } else {
            const st = pay.channelStatus();
            // 按本单实际通道查单：微信单只能问微信，问支付宝永远查不到（回调一丢就卡住）。
            // 无 channel 字段的老单 → 维持原「支付宝优先」兜底，向后兼容。
            const ch = String(o.channel || '');
            if (ch === 'wechat') {
              if (st.wechatReady) await pay.wechatQuery(oid);
            } else if (ch === 'moltspay') {
              // 海外第三方收银台：无主动查单兜底，到账只认回调
            } else if (st.alipayReady) {
              await pay.alipayQuery(oid);
            } else if (ch !== 'alipay' && st.wechatReady) {
              await pay.wechatQuery(oid);
            }
          }
        } catch (e) { }
        o = store.findBy('orders', 'id', oid) || o;
      }
    }
    // 【最小暴露】此前直接回整单对象，含 visitor（访客身份串）与 invitedBy。
    // 订单号会出现在回跳 URL / 收款链接里，属于「可被第三方看到」的值；能拿到单号的人
    // 不该顺带读到别单的访客身份。前端只读 ok/paid，这里只回渲染所需字段。
    const pub = {
      id: o.id, plan: o.plan, amount: o.amount, currency: o.currency, months: o.months,
      status: o.status, paid: !!o.paid, at: o.at, paidAt: o.paidAt, trial: !!o.trial
    };
    // 【2026-10-24 诚实化】channel 此前按币种硬编码（USD→paypal / CNY→alipay），
    // 个人收款码单（channel='manual'）与微信单都会被谎报成 alipay。
    // 如实回本单实际结算通道，仅在老单没有 channel 字段时才退回旧推断。
    return json(res, 200, { ok: true, paid: !!o.paid, order: pub, channel: String(o.channel || (o.currency === 'USD' ? 'paypal' : 'alipay')) });
  }
  // 通道就绪状况（买家端据此显示"扫码/跳转/联系客服"，不做任何虚假承诺）
  if (p === '/v1/pay/channels' && req.method === 'GET') {
    // 【自动探针】探针过期时后台补一次真实下单探针（不阻塞本次响应）。
    // 目的：通道可用性永远反映"实测"结果，而不是"凭据配没配"。
    // 账户资质修好后，无需改代码、无需重启，下一次请求就会亮起来。
    //
    // 【为什么要三道闸】探针会真下单（PayPal 0.01 USD / 支付宝 0.01 CNY），
    // 并发请求若各踢一轮，就会刷出一堆探针单、污染支付后台，还把网关打爆。
    //   1) 60s 冷却：两次自动探针至少隔 60s
    //   2) in-flight 锁：同一时刻只允许一轮探针在跑
    //   3) 内部缓存：不传 force，各通道自带 10 分钟缓存
    try {
      const now = Date.now();
      if ((!pay.channelProbesFresh || !pay.channelProbesFresh()) &&
        now - (_probeKickAt || 0) > 60000 && !_probeInFlight) {
        _probeKickAt = now;
        _probeInFlight = true;
        setTimeout(() => {
          Promise.all([
            (async () => { try { await pay.alipayProbe(); } catch (e) { } })(),
            (async () => { try { await pay.wechatProbe(); } catch (e) { } })(),
            (async () => { try { await pay.paypalProbe(); } catch (e) { } })()
          ]).finally(() => { _probeInFlight = false; });
        }, 0);
      }
    } catch (e) { }
    const st = pay.channelStatus();
    // 【动态可用】通道由实测探针决定：支付宝/微信只有"真能下单"才对外亮，
    // 人工通道（个人收款码）永远兜底可用。账户资质一修好，无需改代码就自动上架。
    // 【客户可选的支付方式】当前主收款方式 = 微信/支付宝个人收款码（收款码配好即可收钱）。
    // 后期官方网关探针实测通过后，checkout 自动切到网关，客户界面与操作完全不变。
    // 所以对外只暴露「客户能付的方式」，不暴露内部「人工/自动」实现细节。
    const cc = pay.customerChannels();
    return json(res, 200, {
      ok: true,
      channels: cc.list,
      alipay: {
        // qrReady=收款码可收钱（当前路径）；gatewayReady=官方网关探针通过（后期路径）
        ready: !!(cc.alipay.qrReady || cc.alipay.gatewayReady),
        qrReady: cc.alipay.qrReady,
        gatewayReady: cc.alipay.gatewayReady,
        via: cc.alipay.via,
        reason: cc.alipay.reason
      },
      wechat: {
        ready: !!(cc.wechat.qrReady || cc.wechat.gatewayReady),
        qrReady: cc.wechat.qrReady,
        gatewayReady: cc.wechat.gatewayReady,
        via: cc.wechat.via,
        reason: cc.wechat.reason
      },
      paypal: {
        ready: !!cc.paypal.ready,
        verified: !!cc.paypal.ready,
        reason: cc.paypal.reason || ''
      },
      moltspay: { configured: st.moltspay.configured, mode: st.moltspay.mode, reason: st.moltspay.reason },
      manual: true,
      reason: cc.list.length ? ('可用支付方式：' + cc.list.join(' / ')) : ('收款渠道正在配置中：运营尚未上传支付/微信收款码，买家暂无法扫码付款。')
    });
  }
  // 买家点「我已转账」：只回传凭证（留痕 + 提醒运营核账），绝不开通。
  // 开通必须走两条真路之一：网关回调验签 / 运营带管理令牌确认（/v1/subs/confirm）。
  if (p === '/v1/pay/manual-confirm' && req.method === 'POST') {
    if (!rateOK('payproof:ip:' + clientIp(req), 10, 60000)) {
      return json(res, 429, { ok: false, error: '提交过于频繁，请稍后再试' });
    }
    // 截图走 base64 data URL，body 上限放宽到 5MB（图片本体上限 3MB，服务端再校验）
    const b = await readBody(req, 5 * 1024 * 1024).catch(() => ({}));
    const oid = String((b && b.orderId) || '');
    const who = String((b && b.visitor) || '');
    const note = String((b && b.note) || '');
    const img = String((b && b.image) || '');
    if (!oid) return json(res, 200, { ok: false, error: '缺少订单号' });
    // 上传凭证 = 立即开通（24h 内系统内部核账；超时未确认自动回收并要求补交截图）
    const r = pay.recordTransferProof(oid, who, note, img);
    if (r && r.ok) {
      // 回传开通后的订阅状态，前端据此立刻放行。
      // 【关键】用「订单自己的 visitor」，不是客户端传的 who——客户端可以随便填，
      // 用错 visitor 会让前端拿到一个不相干访客的订阅状态（看起来像没开通）。
      const ord = store.findBy('orders', 'id', oid);
      const st = subs.status(ord ? ord.visitor : who);
      r.sub = st.sub; r.unlimited = st.unlimited; r.wall = st.wall; r.tempPass = st.tempPass;
      r.needProof = st.needProof;
    }
    return json(res, 200, r);
  }
  // 客户补交支付截图：24h 内无内部确认后，订单转 needProof，客户重新提交凭证。
  // 重新开启一个 24h 核账窗口（不是直接放行）。
  if (p === '/v1/pay/manual-resubmit' && req.method === 'POST') {
    if (!rateOK('payproof2:ip:' + clientIp(req), 10, 60000)) {
      return json(res, 429, { ok: false, error: '提交过于频繁，请稍后再试' });
    }
    // 截图走 base64 data URL，body 上限放宽到 5MB（图片本体上限 3MB，服务端再校验）
    const b = await readBody(req, 5 * 1024 * 1024).catch(() => ({}));
    const oid = String((b && b.orderId) || '');
    const who = String((b && b.visitor) || '');
    const note = String((b && b.note) || '');
    const img = String((b && b.image) || '');
    if (!oid) return json(res, 200, { ok: false, error: '缺少订单号' });
    const r = pay.resubmitProof(oid, who, note, img);
    if (r && r.ok) {
      const ord = store.findBy('orders', 'id', oid);
      const st = subs.status(ord ? ord.visitor : who);
      r.sub = st.sub; r.unlimited = st.unlimited; r.wall = st.wall; r.tempPass = st.tempPass;
      r.needProof = st.needProof;
    }
    return json(res, 200, r);
  }
  // 人工通道内部确认到账（运营令牌）：临时权益转正 + 记账。
  // 不对外暴露：必须带 x-admin-token，且回环也免不掉。
  if (p === '/v1/pay/manual-verify' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：人工核账确认需管理令牌' });
    }
    const b = await readBody(req).catch(() => ({}));
    const oid = String((b && b.orderId) || '');
    if (!oid) return json(res, 200, { ok: false, error: '缺少订单号' });
    return json(res, 200, pay.confirmManual(oid, 'ops'));
  }
  // ===== 退款：客户申请 → 运营实际转账 → 运营确认 =====
  // 【为什么必须有】闭环的「退款」段一直没有真实来源：客户只能找人工，运营手工改库。
  //   这里把它变成有状态流程：申请（requested）→ 出款确认（refunded）。
  // 【绝不谎称】申请不等于已退款；没实际转账前，任何界面都不得显示「已退款」。
  if (p === '/v1/pay/refund' && req.method === 'POST') {
    if (!rateOK('refund:ip:' + clientIp(req), 10, 3600000)) {
      return json(res, 429, { ok: false, error: '退款申请过于频繁，请稍后再试' });
    }
    const b = await readBody(req).catch(() => ({}));
    const r = refund.request(String(b.orderId || ''), canonKey(b.key) || visitorOf(req, q, res), b.reason);
    if (r && r.ok) {
      // 回传当前状态（前端据此显示「已受理，等待出款」而不是「已退款」）
      const st = refund.getRequest(r.request.orderId);
      r.status = st ? st.status : 'requested';
    }
    return json(res, 200, r);
  }
  // 退款状态查询（公开，但只能查自己的订单）
  if (p === '/v1/pay/refund/status' && req.method === 'GET') {
    const oid = String(q.get('orderId') || '');
    const st = refund.getRequest(oid);
    if (!st) return json(res, 200, { ok: true, found: false });
    const v = subs.visitorBy(canonKey(q.get('key')) || visitorOf(req, q, res));
    if (!v || v.visitor !== st.visitor) return json(res, 403, { ok: false, error: '无权查询该订单' });
    return json(res, 200, { ok: true, found: true, status: st.status, amount: st.amount, currency: st.currency, createdAt: st.createdAt });
  }
  // 运营确认已实际转账（唯一能把退款推进到「已退」的入口）
  if (p === '/v1/pay/refund/confirm' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：退款出款确认需管理令牌' });
    }
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, refund.confirm(String(b.orderId || ''), 'ops'));
  }
  // 运营退款待办台：列出所有退款申请（待出款 / 已出款）
  // 【为什么必须有】原来只有「客户查自己的单条状态」和「按订单号确认出款」两个接口，
  //   运营根本看不到"有哪些退款在等我处理" → 退款只会越积越多，最后靠翻 db.json。
  //   这张台就是人工通道的工单列表。
  // 【资金数据】必须带管理令牌，回环也免不掉：否则本机任意脚本可拉全部退款单与金额。
  if (p === '/v1/pay/refund/queue' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：退款待办台需管理令牌' });
    }
    const all = refund.listRequests(999) || [];
    // 【2026-10-21 全量】退款待办要关联**全部**订单（窗口外的老单会显示成空）
    const orderById = new Map(store.list('orders').map((o) => [String(o.id), o]));
    const rows = all.map((r) => {
      const o = orderById.get(String(r.orderId)) || null;
      return {
        id: r.id,
        orderId: r.orderId,
        amount: r.amount,
        currency: r.currency,
        status: r.status || 'requested',
        reason: r.reason || '',
        visitor: r.visitor || '',
        email: r.email || '',
        createdAt: r.createdAt || null,
        paidOutBy: r.paidOutBy || null,
        paidOutAt: r.paidOutAt || null,
        orderPlan: o ? o.plan : null,
        orderPaid: o ? !!o.paid : null,
        // 订单是否已付：没付过钱的"退款"是异常，要人工看一眼
        suspicious: o ? (o.paid !== true) : true,
      };
    }).sort((a, b) => (Number(b.createdAt || 0)) - (Number(a.createdAt || 0)));
    const stat = {
      pending: rows.filter((x) => x.status === 'requested').length,
      refunded: rows.filter((x) => x.status === 'refunded').length,
      suspicious: rows.filter((x) => x.suspicious).length,
    };
    return json(res, 200, { ok: true, rows, stat, now: Date.now() });
  }
  // 收款监听自动开通（内部通道）：到账信号 → 与待支付订单**严格唯一匹配** → 自动开通。
  // 客户只管扫码付款，开通由系统完成（客户零操作过墙）。
  // 匹配不唯一 / 金额对不上 / 超出时间窗 → 绝不开通（返回未匹配并留痕，转人工）。
  if (p === '/v1/pay/auto-settle' && req.method === 'POST') {
    if (!notifyAuthed(req)) {
      return json(res, 403, { ok: false, error: '无通知通道权限：自动开通需本机回环 + 通知密钥/管理令牌' });
    }
    const b = await readBody(req).catch(() => ({}));
    const r = payNotify.settleFromNotification({
      amount: Number(b && b.amount),
      currency: String((b && b.currency) || 'CNY').toUpperCase(),
      channel: String((b && b.channel) || ''),
      tradeNo: String((b && b.tradeNo) || ''),
      ref: String((b && b.ref) || ''),
      source: String((b && b.source) || 'notify'),
      paidAt: Number(b && b.paidAt) || Date.now(),
    });
    return json(res, 200, r);
  }
  // 收款监听通道就绪视图（运营/巡检用）：如实报告待支付订单量与匹配参数
  if (p === '/v1/pay/auto-settle/status' && req.method === 'GET') {
    if (!notifyAuthed(req)) {
      return json(res, 403, { ok: false, error: '无通知通道权限' });
    }
    return json(res, 200, payNotify.status());
  }
  // 主动查单（无公网 notify_url 时的到账确认路径：C 方案）
  // ===== 支付宝通道诊断（运营用）：本地自检 + 远端签名一致性 =====
  // 用途：改完支付宝控制台的应用公钥后，用它确认是否真的生效（force=1 绕过 5 分钟缓存）。
  if (p === '/v1/pay/alipay/check' && req.method === 'GET') {
    // 资金通道诊断：回环也必须带令牌（否则本机任意脚本可触发支付宝远程调用）
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：通道诊断限本机回环或管理令牌' });
    }
    try {
      const force = q.get('force') === '1';
      const local = pay.alipayChannelCheck(force);
      const remote = await pay.alipayRemoteCheck(force);
      // 真实下单探针（0.01 元）：这是"能否真的收钱"的唯一可信证据
      const probe = await pay.alipayProbe(force).catch(e => ({ ok: false, error: String(e && e.message ? e.message : e) }));
      // 【唯一可信口径】usable 必须"实测能下单"。密钥齐备/能验签都不算数。
      const usable = local.ok && remote.signatureOk !== false && !!(probe && probe.verified);
      const verdict = !local.ok ? '本地自检未通过：' + local.reason
        : remote.signatureOk === false ? '远端拒签：控制台应用公钥与本地私钥不配对'
          : (probe && probe.verified) ? '实测可下单（探针 0.01 元单已创建）'
            : (probe && probe.probeReason) ? probe.probeReason
              : '未实测';
      return json(res, 200, {
        ok: true, usable,
        verdict: verdict,
        local, remote, probe
      });
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== MoltSpay 异步回调 =====
  if (p === '/v1/pay/moltspay/notify') {
    if (req.method === 'GET') { return json(res, 400, { ok: false, error: '仅支持 POST 回调' }); }
    // 【限流·必须在读 body 之前】回调端点是公开入口（网关无鉴权头可校验）。
    // 不限流时任何人可以高频 POST：每次都要读 body + HMAC 验签 + 查库比单，
    // 足以把事件循环打满（DoS）。放在 readBody 前，连大 body 都不必解析。
    const srcIp = clientIp(req);
    if (!rateOK('notify:moltspay:ip:' + srcIp, 60, 60000)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('too many requests');
    }
    const b = await readBody(req, 256 * 1024, true);
    const r = pay.moltspayHandleNotify(b);
    if (r.ok) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('success');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('fail');
  }
  // ===== 支付宝主动查单（管理端：实时核单）=====关并直接触发本地 settleOrder（改订单/记账状态），
  // 公开 GET 等于让任意人凭 orderId 反复打网关 + 越权推进结算。故：限本机回环或管理令牌 + 限流。
  if (p === '/v1/pay/query' && (req.method === 'GET' || req.method === 'POST')) {
    // 主动查单会触碰真实支付通道：回环也必须带令牌
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：主动查单限本机回环或管理令牌' });
    }
    let oid = String(q.get('order') || '');
    if (req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      oid = String((b && b.order) || oid);
    }
    oid = oid.trim();
    if (!oid) return err(res, 400, '缺少 order 参数');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(oid)) return err(res, 400, 'order 参数格式非法');
    // 限流：单订单 60s 内 ≤6 次；全局 60s 内 ≤60 次（防止拿大量 orderId 刷网关）
    if (!rateOK('payq:order:' + oid, 6, 60000) || !rateOK('payq:global', 60, 60000)) {
      return json(res, 429, { ok: false, error: '查单过于频繁，请稍后再试' });
    }
    const r = await pay.alipayQuery(oid);
    return json(res, 200, r);
  }
  if (p === '/v1/pay/alipay/notify' && req.method === 'POST') {
    // 支付宝异步通知：验签 → 校验币种/金额 → 幂等入账开通。回包必须是**纯文本 success**，
    // 否则支付宝判定失败并持续重推（返回 JSON 会被当成失败）。
    // 【为什么加 try/catch】验签/解析遇到畸形报文可能抛错；抛出去会让本函数 500，
    // 但更糟的是——同文件尾部还留着一份返回 JSON 的旧处理器，一旦本块被改动/跳过，
    // 就会被那份接住并回错格式。此处就地兜住，统一回 fail 让支付宝重推。
    // 【限流】微信/ Moltspay 的通知都有按 IP 限流，唯独这里此前没有：公网任何人
    // 都能 POST 垃圾报文，每个请求都触发一次 RSA 验签（CPU 作业），可持续放大。
    // 阈值放到 120/分（支付宝重推是低频的，正常业务量远达不到），回 429 让它稍后重推。
    const notifyIp = clientIp(req);
    if (!rateOK('notify:alipay:ip:' + notifyIp, 120, 60000)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('too many requests');
    }
    try {
      const raw = await readRawBody(req);
      const qp = qs.parse(raw);
      const r = pay.alipayHandleNotify(qp);
      return res.end(r.ok ? 'success' : 'fail');
    } catch (e) {
      return res.end('fail');
    }
  }
  if (p === '/v1/pay/alipay/return' && req.method === 'GET') {
    // 买家从支付宝跳回：若是 GET 仅展示结果，账面以 NOTIFY 为准
    const oid = String(q.get('out_trade_no') || '');
    const o = store.findBy('orders', 'id', oid);
    const paid = !!(o && o.paid);
    res.writeHead(302, { Location: '/#' + (paid ? 'subs' : 'subs') });
    return res.end();
  }
  // ===== 微信支付 v3（Native 扫码）异步回调 =====
  if (p === '/v1/pay/wechat/notify' && req.method === 'POST') {
    const srcIp = clientIp(req);
    if (!rateOK('notify:wechat:ip:' + srcIp, 60, 60000)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('too many requests');
    }
    const raw = await readRawBody(req);
    const r = await pay.wechatHandleNotify(req.headers, raw);
    // 微信要求：受理成功回 200 + {"code":"SUCCESS"}；否则回 {"code":"FAIL"} 使其重推
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(r.ok ? { code: 'SUCCESS', message: '成功' } : { code: 'FAIL', message: r.error || '失败' }));
  }
  // 微信主动查单（运营用：无公网回调时确认到账）
  if (p === '/v1/pay/wechat/query' && (req.method === 'GET' || req.method === 'POST')) {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：主动查单限本机回环或管理令牌' });
    }
    let oid = String(q.get('order') || '');
    if (req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      oid = String((b && b.order) || oid);
    }
    oid = oid.trim();
    if (!oid) return err(res, 400, '缺少 order 参数');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(oid)) return err(res, 400, 'order 参数格式非法');
    if (!rateOK('payq:wx:order:' + oid, 6, 60000) || !rateOK('payq:wx:global', 60, 60000)) {
      return json(res, 429, { ok: false, error: '查单过于频繁，请稍后再试' });
    }
    return json(res, 200, await pay.wechatQuery(oid));
  }
  // 微信通道诊断（运营用）：只报凭据齐备情况，不外呼
  if (p === '/v1/pay/wechat/check' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：通道诊断限本机回环或管理令牌' });
    }
    const probe = await pay.wechatProbe(true);
    const c = pay.wechatChannelCheck();
    return json(res, 200, { ok: true, usable: c.ok && c.verified, wechat: c, probe });
  }
  if (p === '/v1/pay/paypal/success' && req.method === 'GET') {
    const oid = String(q.get('order') || '');
    const token = String(q.get('token') || '');
    const r = await pay.paypalCapture(oid, token);
    if (r.ok) pay.settleOrder(oid);
    res.writeHead(302, { Location: '/#subs' });
    return res.end();
  }
  if (p === '/v1/subs/confirm' && req.method === 'POST') {
    // 记账鉴权：确认到账会直接开通订阅，是白嫖风险最高的一处。
    // 【为什么这里比别处严】普通运营接口 isLoopback 就放行（本机桌面调试需要），
    // 但这一处不行——任何本机进程/网页脚本拿到订单号就能把订单置 paid。
    // 所以必须带正确管理令牌，回环也不例外。
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：确认到账需管理令牌（资金操作，回环也不免）' });
    }
    const b = await readBody(req);
    try { const r = subs.confirm(String(b.orderId || '')); return json(res, 200, r); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/subs/bind' && req.method === 'POST') {
    const b = await readBody(req);
    const r = subs.bindInvite(canonKey(b.key) || visitorOf(req, q, res), String(b.code || ''));
    return json(res, 200, r);
  }
  if (p === '/v1/subs/orders' && req.method === 'GET') {
    // 【数据隔离】这个端点是公开的（客户要查自己的订单）。
    //   原来直接返回全库订单 → **任何访客都能看到所有人的订单号/金额/方案**。
    //   现在：普通访客只拿自己的；运营（带管理令牌）或本机回环才拿全量（核账台要用）。
    const lim = Number(q.get('limit') || 30);
    if (adminAuthedStrict(req) || isLoopback(req)) {
      return json(res, 200, { ok: true, orders: subs.orders(lim) });
    }
    const vkey = canonKey(q.get('key')) || visitorOf(req, q, res);
    return json(res, 200, { ok: true, orders: subs.ordersOf(vkey, lim) });
  }
  // ===== 审计结论（运营台一屏看清闭环是否健康）=====
  // 【2026-10-21】把"审计闭环"的结果接到运营台：
  //   ① 定时巡检报告（data/runtime/audit_latest.json，由 bd-audit.timer 写）
  //   ② 现场即时数（订单/收入/已作废虚拟单）
  //   ③ 收费墙覆盖率（真漏网数 —— 门禁看的就是它）
  //   ④ 工作流队列健康（深度/被拒/已消费）
  // 鉴权：**管理令牌**（回环也不例外）—— 里面是钱账真相。
  if (p === '/v1/audit/summary' && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '需要管理令牌（审计结论含钱账真相）' });
    try {
      const fsx = require('fs');
      const pathx = require('path');
      const dataDir = pathx.join(__dirname, 'data');
      let report = null;
      try { report = JSON.parse(fsx.readFileSync(pathx.join(dataDir, 'runtime', 'audit_latest.json'), 'utf8')); } catch (e) { report = null; }
      const dbx = store.read();
      const orders = Array.isArray(dbx.orders) ? dbx.orders : [];
      const revenues = Array.isArray(dbx.revenue) ? dbx.revenue : [];
      let queues = null;
      try {
        const st = JSON.parse(fsx.readFileSync(pathx.join(dataDir, 'workflows', 'state.json'), 'utf8'));
        const depths = {};
        Object.keys(st).forEach((k) => { if (Array.isArray(st[k])) depths[k] = st[k].length; });
        queues = { meta: st.meta || {}, depths };
      } catch (e) { queues = null; }
      const pw = require('./core/paywall');
      const cov = pw.coverage(allDeclaredEndpoints(), { opsPaths: STRICT_ADMIN_PATHS });
      const realRev = revenues.filter((r) => !r.selfTest && !r.synthetic);
      return json(res, 200, {
        ok: true,
        at: Date.now(),
        auditReport: report,                 // 定时巡检的完整报告（可能为 null：首次巡检前）
        live: {
          orders: orders.length,
          paid: orders.filter((o) => o.paid).length,
          voidedVirtual: orders.filter((o) => o.status === 'void_test').length,
          revenueRecords: revenues.length,
          revenueRealRecords: realRev.length,
          revenueRealAmount: Math.round(realRev.reduce((a, r) => a + (Number(r.amt) || 0), 0) * 100) / 100,
        },
        wall: {
          total: cov.total, covered: cov.covered, rate: cov.rate,
          uncoveredCount: cov.uncoveredCount, uncovered: cov.uncovered,
          flowOpsCount: cov.flowOpsCount,
        },
        queues,
      });
    } catch (e) {
      return err(res, 200, e.message);
    }
  }

  // ===== 续费与返利（复购链路）=====
  if (p === '/v1/subs/renewal' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, renewal: subs.renewalState(canonKey(q.get('key')) || visitorOf(req, q, res)) }); }
    catch (e) { return err(res, 200, e.message); }
  }
  if (p === '/v1/subs/redeem' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      return json(res, 200, subs.redeemMonthsCredit(canonKey(b.key) || visitorOf(req, q, res)));
    } catch (e) { return err(res, 200, e.message); }
  }
  // ===== 人工通道核账台（内部）：列出待核账订单 =====
  // 内部使用：24h 内系统自行核账；客户不参与。运营只在内部看到这张表。
  if (p === '/v1/pay/manual-queue' && req.method === 'GET') {
    // 【资金数据】必须带管理令牌，回环也免不掉：否则本机任意脚本可拉全部人工订单与金额
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：人工核账台需管理令牌' });
    const now = Date.now();
    const all = store.list('orders');
    const rows = all.filter(o => o.manualStatus || o.channel === 'manual' || o.paidBy === 'manual-provisional')
      .map(o => ({
        id: o.id,
        amount: o.amount,
        currency: o.currency,
        plan: o.plan,
        status: o.status,
        paid: !!o.paid,
        paidAt: o.paidAt || null,
        paidBy: o.paidBy || null,
        manualStatus: o.manualStatus || null,
        proofAt: o.proofAt || null,
        proofCount: Number(o.proofCount || 0),
        proofNote: o.proofNote || '',
        proofImage: o.proofImage || null,
        proofImageAt: o.proofImageAt || null,
        reviewUntil: o.reviewUntil || null,
        needProof: !!o.needProof,
        confirmedAt: o.confirmedAt || null,
        confirmedBy: o.confirmedBy || null,
        // 距核账窗口结束的剩余小时数（<=0 表示已超时待回收）
        hoursLeft: o.reviewUntil ? Math.round((Number(o.reviewUntil) - now) / 3600000 * 10) / 10 : null
      }))
      .sort((a, b) => {
        // 待确认优先，其次按超时紧急度
        const rank = x => x.manualStatus === 'provisionally_active' ? 0 : x.manualStatus === 'needProof' ? 1 : 2;
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return (a.reviewUntil || 0) - (b.reviewUntil || 0);
      });
    const stat = {
      pending: rows.filter(x => x.manualStatus === 'provisionally_active').length,
      needProof: rows.filter(x => x.needProof).length,
      confirmed: rows.filter(x => x.manualStatus === 'confirmed').length
    };
    return json(res, 200, { ok: true, rows, stat, now });
  }
  // 滥用防护参数（人工通道乐观开通）：管理令牌保护
  if (p === '/v1/pay/manual-guard') {
    if (!adminAuthedStrict(req)) {
      return json(res, 403, { ok: false, error: '无运营权限：防护参数需管理令牌' });
    }
    const num = k => {
      const v = store.getSetting(k);
      return v === undefined ? null : Number(v);
    };
    const cur = {
      minOrderAgeSec: num('manualMinOrderAgeSec') === null ? 30 : num('manualMinOrderAgeSec'),
      maxPerDay: num('manualMaxProvisionalPerDay') === null ? 2 : num('manualMaxProvisionalPerDay'),
      maxConcurrent: num('manualMaxConcurrentProvisional') === null ? 1 : num('manualMaxConcurrentProvisional')
    };
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, minOrderAgeSec: cur.minOrderAgeSec, maxPerDay: cur.maxPerDay, maxConcurrent: cur.maxConcurrent });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (b.minOrderAgeSec !== undefined) {
        const n = Math.max(0, Math.min(86400, Number(b.minOrderAgeSec) || 0));
        store.setSetting('manualMinOrderAgeSec', n);
      }
      if (b.maxPerDay !== undefined) {
        const n = Math.max(0, Math.min(100, Number(b.maxPerDay) || 0));
        store.setSetting('manualMaxProvisionalPerDay', n);
      }
      if (b.maxConcurrent !== undefined) {
        const n = Math.max(0, Math.min(20, Number(b.maxConcurrent) || 0));
        store.setSetting('manualMaxConcurrentProvisional', n);
      }
      return json(res, 200, {
        ok: true,
        minOrderAgeSec: store.getSetting('manualMinOrderAgeSec'),
        maxPerDay: store.getSetting('manualMaxProvisionalPerDay'),
        maxConcurrent: store.getSetting('manualMaxConcurrentProvisional')
      });
    }
    return json(res, 405, { ok: false, error: '仅 GET/POST' });
  }
  // 支付凭证截图查看（运营核账台用）：必须带管理令牌，回环也免不掉
  if (p && p.indexOf('/v1/pay/proof-image/') === 0 && req.method === 'GET') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：凭证截图需管理令牌' });
    const fn = decodeURIComponent(p.slice('/v1/pay/proof-image/'.length));
    const img = pay.readProofImage(fn);
    if (!img) return json(res, 404, { ok: false, error: '截图不存在' });
    res.writeHead(200, {
      'Content-Type': img.mime,
      'Content-Length': img.buf.length,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(img.buf);
  }
  // 人工通道内部核账：立即执行一次超时回收（运营可手动触发，不必等定时器）
  if (p === '/v1/pay/manual-sweep' && req.method === 'POST') {
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：核账回收需管理令牌' });
    return json(res, 200, pay.sweepManual());
  }

  if (p === '/v1/subs/due' && req.method === 'GET') {
    // 运营侧：临期订阅清单（主动召回的唯一抓手）
    try { if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' }); return json(res, 200, subs.dueList(Number(q.get('within') || 7))); }
    catch (e) { return err(res, 200, e.message); }
  }
  // ===== 运营管理：收费墙重置 / 管理令牌轮换（限本机或 X-Admin-Token）=====
  // adminAuthed / adminTokenOf 已上移到模块作用域（见 isLoopback 之后）：
  // 之前它们定义在这里，但 partner/mcp/subs-due 等路由在 handle() 内更早的位置就要用，
  // 触发 TDZ（Cannot access 'adminAuthed' before initialization）→ 该路由 500。
  if (p === '/v1/subs/reset-visitors' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, subs.resetVisitors());
  }
  if (p === '/v1/subs/rotate-admin-token' && req.method === 'POST') {
    // 轮换令牌是凭据操作：回环也必须带**正确**的旧令牌，否则本机任意脚本可
    // 把自己提权成运营（拿到新令牌后就能确认到账、开通订阅）。
    if (!adminAuthedStrict(req)) return json(res, 403, { ok: false, error: '无运营权限：轮换令牌需管理令牌' });
    return json(res, 200, subs.rotateAdminToken());
  }
  if (p === '/v1/subs/pay-config' && req.method === 'GET') {
    // 只回显 mask 后内容，令牌等敏感键不回吐
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const c = {
      receiveAccount: store.getSetting('receiveAccount') || '',
      receiveQrAlipay: store.getSetting('receiveQrAlipay') || '',
      receiveQrWechat: store.getSetting('receiveQrWechat') || ''
    };
    return json(res, 200, { ok: true, config: c });
  }
  if (p === '/v1/subs/pay-config' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    for (const k of ['receiveAccount', 'receiveQrAlipay', 'receiveQrWechat']) {
      if (b[k] !== undefined) store.setSetting(k, String(b[k]).slice(0, 2000));
    }
    return json(res, 200, { ok: true });
  }

  // ===== 多 agent 协同账本 =====
  if (p === '/v1/deliberation/review' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...deliberation.review(Number(q.get('limit') || 20)) });
  }
  if (p === '/v1/deliberation/convene' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = deliberation.convene(b);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/deliberation/adjudicate' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = deliberation.adjudicate(b.roundId, b.rowId, b.verdict, b.reason);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/deliberation/action' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = deliberation.addAction(b);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/deliberation/grade' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = deliberation.gradeAction(b.actionId, b.grade, b.proof);
    return json(res, r.ok ? 200 : 400, r);
  }

  // ===== 收款信息（只回显脱敏）与付款指令 =====
  if (p === '/v1/payout/config' && req.method === 'GET') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const v = payout.validate();
    return json(res, 200, { ok: v.ok, error: v.error, missing: v.missing || [], masked: payout.masked() });
  }
  if (p === '/v1/payout/config' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = payout.save(b);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/payout/pending' && req.method === 'GET') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, { ok: true, pending: payout.pendingList() });
  }
  if (p === '/v1/payout/instruction' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = payout.instruction(b);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/payout/dunning' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    // 缺 overdueDays 时按应收挂起天数自动算，避免手填错
    let overdueDays = Number(b.overdueDays);
    if (!Number.isFinite(overdueDays) || overdueDays < 0) {
      const q = money.receivableAll().find(r => r.revId === b.revId);
      overdueDays = q ? Math.max(0, Math.floor((Date.now() - (q.at || Date.now())) / 86400000)) : 0;
    }
    const r = payout.dunningLetter(Object.assign({}, b, { overdueDays }));
    if (r.ok) {
      // 催款要留痕进工单，否则「催过了」这件事没人记得
      try {
        const tk = tickets.create({
          subject: '催款 · ' + (b.title || b.revId),
          message: '第 ' + r.round + ' 次催款函已生成：' + r.file,
          channel: '资金'
        });
        r.ticket = tk && tk.id;
      } catch (e) { r.ticketError = e.message; }
    }
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/money/writeoff' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = money.writeoff(b.revId, b.reason, b.note);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/money/writeoffs' && req.method === 'GET') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, { ok: true, writeoffs: money.writeoffAll() });
  }
  // ===== 合规声明与隐私权（PCI-DSS / GDPR / CAN-SPAM）=====
  if (p === '/v1/compliance/clauses' && req.method === 'GET') {
    // 公开：页面按场景取的合规声明（payment/lead/outreach/partner/global）
    const ctx = String(q.get('context') || 'global');
    return json(res, 200, require('./core/compliance').disclosuresFor(ctx));
  }
  if (p === '/v1/compliance/audit' && req.method === 'GET') {
    // 自审：把未落地项如实摆出来，而不是宣称"合规已覆盖"
    return json(res, 200, require('./core/compliance').auditSelfCheck());
  }
  if (p === '/v1/privacy/erasure' && req.method === 'POST') {
    // 被遗忘权：匿名化某 leadId 的个人数据（保留财务凭证的统计口径）
    const b = await readBody(req);
    const r = require('./core/privacy').erasure(b.leadId, { deep: b.deep === true });
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/v1/privacy/portability' && req.method === 'GET') {
    // 可携带权：导出某 leadId 现有全部个人数据
    const r = require('./core/privacy').portability(q.get('leadId'));
    return json(res, r.ok ? 200 : 400, r);
  }

  // ===== 排行榜（前一名严格 ≥ 后一名+1，谁补录谁重排）=====
  if (p === '/v1/rank' && req.method === 'GET') {
    return json(res, 200, rank.board(String(q.get('field') || 'score')));
  }
  if (p === '/v1/rank/enter' && req.method === 'POST') {
    const b = await readBody(req);
    const r = rank.enter({ name: b.name, field: b.field, score: b.score, note: b.note });
    return json(res, 200, r);
  }
  if (p === '/v1/rank/gap' && req.method === 'GET') {
    const field = String(q.get('field') || 'score');
    return json(res, 200, { ok: true, ...rank.gapOk(field) });
  }

  // ===== 经营记账：营收（入账支付宝）/ 5% 推广费 / 半年千万 KPI =====
  if (p === '/v1/money/kpi' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...money.kpi() });
  }
  if (p === '/v1/money/credit' && req.method === 'POST') {
    // 记账会直接抬高 revenue/KPI。此前无鉴权：任何人都能给自己记一笔「已到账」营收。
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    // settled 默认 true（钱已到账）；显式传 settled:false 则只挂账不计 KPI
    const r = money.credit(Number(b.amt || 0), b.source, b.method, { settled: b.settled !== false });
    return json(res, 200, r);
  }
  if (p === '/v1/money/spend' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    // channel：把这笔真实投放归因到具体渠道，ROI 看板据此计算真实 ROI（不留 channel 则不参与归因，不摊派）
    const r = money.spend(Number(b.amt || 0), b.note, { channel: b.channel });
    return json(res, 200, r);
  }
  if (p === '/v1/money/budget' && req.method === 'GET') {
    return json(res, 200, { ok: true, budget: money.budget(), revenues: money.revenueAll(), promos: money.promoAll() });
  }
  if (p === '/v1/money/leads' && req.method === 'GET') {
    return json(res, 200, { ok: true, leads: store.list('leads', Number(q.get('limit') || 50)) });
  }
  if (p === '/v1/money/leads/funnel' && req.method === 'GET') {
    // 转化漏斗：按阶段聚合线索数 + 金额
    try {
      const stage = q.get('stage');
      const db = store.read();
      const leads = db.leads || [];
      let list = leads;
      if (stage) list = leads.filter(l => l.stage === stage);
      const byStage = {};
      let totalAmt = 0;
      list.forEach(l => {
        const s = l.stage || 'new';
        byStage[s] = byStage[s] || { count: 0, amount: 0 };
        byStage[s].count++;
        byStage[s].amount += Number(l.amt || 0);
        totalAmt += Number(l.amt || 0);
      });
      const funnel = Object.entries(byStage).map(([stage, d]) => ({
        stage, label: stage, count: d.count, amount: d.amount,
        color: { new: '#3b82f6', contacted: '#8b5cf6', qualified: '#06b6d4', proposal: '#f59e0b', negotiation: '#ec4899', won: '#10b981', lost: '#ef4444' }[stage] || '#64748b'
      })).sort((a, b) => b.count - a.count);
      return json(res, 200, { ok: true, funnel, total: leads.length, totalAmt, at: Date.now() });
    } catch (e) { return err(res, 200, e.message); }
  }

  // ===== 客户地理定位（GPS）=====
  // 上报：客户端主动上报坐标（需用户授权）。访客/潜在线索/付费客户三类都收。
  // 查询：后台读取（地域分布 + 明细）。
  if (p === '/v1/geo/report' && req.method === 'POST') {
    const b = await readBody(req);
    const kind = ['visitor', 'lead', 'customer'].includes(b.kind) ? b.kind : 'visitor';
    // visitor/customer 强制用服务端签发身份，不接受前端传 id（防伪造他人定位）
    const id = kind === 'lead'
      ? String(b.id || '').slice(0, 60)
      : visitorOf(req, q, res);
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    return json(res, 200, await geo.report(kind, id, b));
  }
  if (p === '/v1/geo/clients' && req.method === 'GET') {
    return json(res, 200, geo.query({
      kind: q.get('kind') || '',
      limit: Math.min(500, Number(q.get('limit') || 200))
    }));
  }
  // 人工确认一次**真实触达**：漏斗里唯一能推进 touch 的入口。
  // 机器的 promote() 只排计划、不碰 touch；close() 的商机候选门槛只看 touch，
  // 所以这条路由是"商机候选"能否出现的唯一决定因素（需运营权限）。
  if (p === '/v1/money/leads/touch' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    return json(res, 200, leadgen.markTouched(b.id, b.channel, b.evidence));
  }

  // 人工确认成交：唯一把「商机候选」转「待成交」的合法入口（需运营权限 + 真实金额）
  // 账实分离：确认成交 = 买家承诺付款 ≠ 钱已到账。故记挂账（不计 KPI）+ 开应收台账，
  // 钱到账后由 /v1/money/settle 带凭证转实收。
  if (p === '/v1/money/leads/convert' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = leadgen.convert(b.id, b.amount);
    if (r.ok) {
      const channel = String(b.channel || 'moltspay').slice(0, 20);
      const c = await money.credit(b.amount, 'leadgen 人工确认成交：' + (r.lead.name || r.lead.id), channel, { settled: false });
      // 在线网关通道直接设为 settled（由网关回调最终确认）；非在线挂应收
      const online = b.online === true || /支付宝|微信|PayPal|moltspay|alipay/i.test(channel);
      if (c.ok && !online) {
        c.receivable = store.push('receivable', {
          amt: Number(b.amount) || 0, revId: c.rec.id,
          payer: (r.lead && (r.lead.name || r.lead.id)) || '',
          source: 'leadgen 人工确认成交', channel,
          target: String(b.target || '').slice(0, 60),
          status: 'awaiting_fund', evidence: '',
          note: '账面已确认成交（人工），实际资金尚未到账；买家打款后回传凭证方可置 received'
        }, '应收挂账', '¥' + (Number(b.amount) || 0) + ' 待回款（' + channel + '）');
      }
      // 【不要在这里转实收】确认成交 = 买家承诺付款，钱还没到。
      // 实收的唯一合法入口是网关回调（pay.settleFulfillment），它会验签 + 核对金额后才记账。
      // 在此处自动 settle 等于凭空虚增营收，且与回调记账重复（同一笔钱记两遍）。
      // 创建履约订单并发起在线支付
      try {
        const ff = require('./core/fulfillment');
        const ord = ff.createFromDeal(r.lead.id);
        if (ord.ok) {
          const pay = require('./core/pay');
          const chk = await pay.checkout({ orderId: ord.order.id, channel: channel.toLowerCase() });
          c.fulfillment = ord;
          c.checkout = chk;
        }
      } catch (e) { c.payError = String(e.message || e); }
    }
    return json(res, r.ok ? 200 : 400, r);
  }
  // 应收台账（含付款方与收款账号，限运营权限）
  if (p === '/v1/money/receivable' && req.method === 'GET') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, { ok: true, summary: money.receivableSummary(), rows: money.receivableAll() });
  }
  // 结算到账：把挂账转实收的唯一合法入口（需运营权限 + 必填回款凭证，缺凭证一律拒绝）
  if (p === '/v1/money/settle' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    const r = money.settle(b.id || b.revId, b.evidence, { method: b.method });
    return json(res, r.ok ? 200 : 400, r);
  }

  // ===== Agent 管理中心：paseo 落地 / daemon 生命周期 / Agent 联动联调（协同流水）=====
  // 读状态公开；落地与一切变更操作限本机或 X-Admin-Token（防止远程滥用拉起本地进程）
  if (p === '/v1/agentcenter' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...agentcenter.status() });
  }
  if (p === '/v1/agentcenter/coop' && req.method === 'GET') {
    return json(res, 200, { ok: true, log: agentcenter.coopLog(Number(q.get('limit') || 30)) });
  }
  if (p === '/v1/agentcenter/coop' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    return json(res, 200, agentcenter.coord('coop', b.agentId, b.detail));
  }
  if (p === '/v1/agentcenter/install' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, await agentcenter.installPaseo());
  }
  if (p === '/v1/agentcenter/daemon/start' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, await agentcenter.daemonStart());
  }
  if (p === '/v1/agentcenter/daemon/restart' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, await agentcenter.daemonRestart());
  }
  if (p === '/v1/agentcenter/daemon/stop' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    return json(res, 200, await agentcenter.daemonStop());
  }
  if (p === '/v1/agentcenter/daemon/status' && req.method === 'GET') {
    return json(res, 200, await agentcenter.daemonStatus());
  }
  if (p === '/v1/agentcenter/agents' && req.method === 'GET') {
    return json(res, 200, await agentcenter.listAgents());
  }
  if (p === '/v1/agentcenter/agents/run' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    return json(res, 200, await agentcenter.agentRun(b));
  }
  if (p === '/v1/agentcenter/agents/send' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    return json(res, 200, await agentcenter.agentSend(b));
  }
  if (p === '/v1/agentcenter/agents/stop' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    return json(res, 200, await agentcenter.agentStop(b));
  }
  if (p === '/v1/agentcenter/agents/logs' && req.method === 'POST') {
    if (!adminAuthed(req)) return json(res, 403, { ok: false, error: '无运营权限' });
    const b = await readBody(req);
    return json(res, 200, await agentcenter.agentLogs(b));
  }
  if (p === '/v1/agentcenter/log' && req.method === 'GET') {
    return json(res, 200, { ok: true, log: store.list('agentcenter_log', Number(q.get('limit') || 20)) });
  }

  // ===== 七段报告验证页（公开：/verify/<id>，报告公告性质，任何人可核验）=====
  if (p.indexOf('/verify/') === 0 && req.method === 'GET') {
    const rid = decodeURIComponent(p.slice('/verify/'.length)).trim();
    const r = report.get(rid);
    const hot = manuals.HOTLINE || { main: '12356', backup: '—', legal: '12348', labor: '12333' };
    if (!r) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>验证页不存在</h2><p>报告 id 无效或已被清理。</p><p>如果链接来自某份七段报告，请回到来源核对。</p></body></html>');
    }
    const body = ['<html lang="zh-CN"><head><meta charset="UTF-8"><title>七段决策报告验证 · ' + esc(r.topic) + '</title>',
      '<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}',
      '.hd{border-left:4px solid #1f6feb;padding:0 14px;margin-bottom:18px}h1{font-size:20px;margin:0 0 6px}',
      '.meta{color:#666;font-size:13px}.box{background:#f6f8fa;border:1px solid #d8dee4;border-radius:8px;padding:16px;white-space:pre-wrap}',
      '.tag{display:inline-block;background:#eef;color:#1f6feb;border-radius:12px;padding:2px 10px;font-size:12px;margin-right:6px}',
      '.crisis{background:#fff4f4;border-color:#ea4b4b}.crisis-tag{background:#ea4b4b;color:#fff}',
      '.foot{margin-top:18px;color:#888;font-size:12px;border-top:1px solid #eee;padding-top:10px}</style></head><body>',
    '<div class="hd"><h1>七段决策报告 · 验证页</h1><div class="meta">报告编号 <b>' + esc(r.id) + '</b> · 生成于 ' + new Date(r.generatedAt).toLocaleString('zh-CN', { hour12: false }) + ' · 版本 ' + esc(r.version || 'FINAL-1.1 §2.2') + '</div></div>',
    '<div class="meta" style="margin-bottom:12px">' +
    (r.crisis ? '<span class="tag crisis-tag">⚠ 危机语境</span>' : '') +
    '<span class="tag">处境卦 ' + esc(r.gua) + '</span>' +
    '<span class="tag">灯角 ' + (r.lights || 0) + '</span>' +
    '<span class="tag">主题：' + esc(r.topic) + '</span></div>',
    '<div class="box' + (r.crisis ? ' crisis' : '') + '">' + esc(r.content || '') + '</div>',
    r.crisis ? '<div class="box crisis" style="margin-top:14px"><b>如有伤害自己的想法</b>：拨打 <b>' + esc(hot.main) + '</b>（24h，全国统一热线）→ 立即转介，优先于一切功能。备线 ' + esc(hot.backup) + ' · 法律援助 ' + esc(hot.legal) + ' · 人社服务 ' + esc(hot.labor) + '</div>' : '',
      '<div class="foot">本页由「丙大山AI · 我一直在」为报告核验提供。参考书目在报告正文第 7 段。声明：工具不替代专业援助。</div>',
      '</body></html>'].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(body);
  }

  // ===== 支付网关回调 =====
  if (p === '/v1/pay/moltspay/notify' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sig = req.headers['x-moltspay-signature'] || req.headers['signature'] || '';
      const r = await require('./core/payment-gateways').moltspayHandleCallback(body, sig);
      return json(res, 200, r);
    } catch (e) { return err(res, 500, e.message); }
  }
  if (p === '/v1/pay/paypal/webhook' && req.method === 'POST') {
    // 【验签】这是公开入口（网关不携带管理令牌），必须验证 PayPal 签名，
    // 否则任何人都能 POST 伪造事件，反复触发 capture 请求消耗配额。
    try {
      const rb = await readBodyRaw(req, 1024 * 1024);
      const v = await pay.paypalVerifyWebhook(req.headers, rb.raw || '');
      if (!v.ok) {
        store.push('audit', { action: 'PayPal webhook 验签失败', detail: String(v.error || '').slice(0, 160), at: Date.now() }, null, null);
        return json(res, 400, { ok: false, error: '签名校验失败' });
      }
      const r = await require('./core/payment-gateways').handleCallback('paypal', rb.json || {}, req.headers);
      return json(res, 200, r);
    } catch (e) { return err(res, 500, e.message); }
  }
  // 创建支付订单（前端调用）
  if (p === '/v1/pay/create' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const { gateway, outTradeNo, amount, currency, subject, notifyUrl, returnUrl, cancelUrl } = b || {};
      const r = await require('./core/payment-gateways').createPaymentOrder(gateway, outTradeNo, amount, currency, subject, notifyUrl, returnUrl, cancelUrl);
      return json(res, 200, r);
    } catch (e) { return err(res, 500, e.message); }
  }

  // ===== 静态 =====
  // HEAD 也走这里：下载管理器/浏览器有时先用 HEAD 探大小与类型，
  // 回 404 会让它以为文件不存在而放弃。serveStatic 里对 HEAD 只发头、不发 body。
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);

  return err(res, 404, 'no route: ' + p);
}

// ===== 进程级安全网：单个后台任务出错绝不能拖死整个应用 =====
//
// 【2026-09·防拖死】实测踩到：core/goalpilot.js 的周任务定时器里
// `weekly().catch(...)`，而 weekly() 的幂等早退分支返回的是**普通对象**（不是 Promise），
// 于是 `.catch` 抛 TypeError。**定时器回调中的未捕获异常会直接终止整个 Node 进程** ——
// 表现是"应用跑着跑着整个消失"，而不是某个功能坏掉。
//
// 这里装两道兜底：
//   1) unhandledRejection：Promise 被拒绝但没人接（后台任务最常见的死法）
//   2) uncaughtException：同步抛出且没人抓
// 两者都记审计 + 打日志，**不退出进程**。代价是可能有部分状态不一致，
// 但对"自主运营 + 收费"这类长跑应用来说，可观测地降级远优于静默消失。
//
// 例外：显式 SIGINT/SIGTERM 不在此列（进程仍可正常关闭）。
let _fatalLogged = 0;
function recordBackgroundFailure(kind, err) {
  const msg = String((err && (err.stack || err.message)) || err || 'unknown');
  const first = _fatalLogged < 5;
  _fatalLogged++;
  console.error('[BingDashanAI] ' + kind + '（已兜住，进程继续运行 #' + _fatalLogged + '）：' + msg);
  try {
    if (first) {
      require('./core/store').push('audit', {
        action: '后台任务异常·已兜住',
        detail: kind + '：' + msg.slice(0, 300) + (first ? '（首次同类异常，完整栈见控制台）' : ''),
        at: Date.now()
      }, null, null);
    }
  } catch (e) { /* store 本身出问题就只打日志 */ }
}
process.on('unhandledRejection', (reason) => recordBackgroundFailure('未处理的 Promise 拒绝', reason));
process.on('uncaughtException', (err) => recordBackgroundFailure('未捕获异常', err));

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    try { err(res, (e && e.status) || 500, e.message || 'server error'); } catch (e2) { }
  });
});

server.listen(PORT, HOST, () => {
  BOOT.marks.listening = performance.now() - BOOT.t0;
  // 固定下来：不能在诊断端点里现算，否则读到的是"当前时刻 - 启动时刻"（已运行几十秒）
  BOOT.readyMs = BOOT.marks.listening;
  // 打印**真实**端口：PORT=0 时（测试/多实例）由 OS 分配端口，
  // 打印常量 0 会让调用方根本不知道该连哪个。
  const realPort = (server.address && server.address() && server.address().port) || PORT;
  console.log('[BingDashanAI] listening http://' + HOST + ':' + realPort);
  console.log('[BingDashanAI] web root: ' + WEB_ROOT);
  console.log('[BingDashanAI] 启动耗时: ' + JSON.stringify(
    Object.fromEntries(Object.entries(BOOT.marks).map(([k, v]) => [k, Math.round(v * 10) / 10 + 'ms']))));
});
server.on('error', e => {
  console.error('[BingDashanAI] listen error: ' + e.message);
});
// WebSocket 升级不走普通 HTTP 路由（携带 Upgrade: websocket 的请求直接派发到这里）。
// 只对 /v1/orca/ws 放行，其余 upgrade 一律断开——避免未经审计的第三方 WS 端点混入。
server.on('upgrade', (req, socket, head) => {
  let pathname, u;
  try { u = new URL(req.url, 'http://x'); pathname = u.pathname; } catch (e) { try { socket.destroy(); } catch (_) { } return; }
  if (pathname === '/v1/orca/ws' && (req.headers.upgrade || '').toLowerCase() === 'websocket') {
    // 【账务/墙协同·已修】upgrade 请求在 handle() 之外分派，原 path 的 autoGate 完全
    // 不会作用于它。开闸后，/v1/orca/ws 的「warboard」分区截停对 WS 失效——
    // 任何来源都能连上推送订阅板。这里把同样的判定复刻到握手前：不通过时明文回 402
    // 并断开，浏览器的 new WebSocket() 即可感知失败；不影响后端路由语义。
    try {
      const pw = require('./core/paywall');
      const sec = pw.sectionOf('GET', pathname);
      if (PAYWALL_ENABLED() && sec && sec !== '@public') {
        const v = visitorOf(req, u.searchParams, { setHeader() { } });
        const g = subs.gatePool(v, sec);
        if (!g.allowed) {
          const st = subs.status(v);
          socket.write('HTTP/1.1 402 Payment Required\r\nContent-Type: application/json; charset=utf-8\r\n\r\n' +
            JSON.stringify({
              ok: false, code: 402, wall: true, section: sec,
              msg: g.msg || '订阅后继续使用', plans: st && st.plans,
              // 诚实化：已订阅者撞重值日限时的 402 带订阅上下文（与 gateSection 同口径）
              unlimited: !!(st && st.unlimited), sub: (st && st.sub) || null,
              used: g.used, quota: g.quota, trialUsed: st && st.trialUsed,
              trialAvail: !!(st && st.freeTrialAvailable)
            }));
          try { socket.destroy(); } catch (_) { }
          return;
        }
      }
    } catch (e) {
      // 判定自身异常绝不能变成 500 把功能打挂——放行并记审计，与 handle 的 autoGate 兜底一致
      try { store.push('audit', { action: 'WS 收费墙判定异常', detail: String(e.message || e).slice(0, 80), at: Date.now() }); } catch (_) { }
    }
    handleOrcaWS(req, socket);
  } else {
    try { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); } catch (_) { }
  }
});

// 24/7 自主触达调度器：每 5 分钟跑一轮（搜仓库→提取邮箱→SPARK 写邮件→SMTP 发出）
// 频率控制：每小时最多 5 封，每天最多 30 封（QQ 邮箱安全线）
// 持久化：所有触达记录写入 db.outbound，重启可恢复
try {
  const sch = require('./core/scheduler');
  sch.start(5 * 60 * 1000);
  console.log('[scheduler] 24/7 自主触达已启动（每5分钟一轮，每小时≤5封，每天≤30封）');
} catch (e) {
  console.error('[scheduler] 启动失败:', e.message);
}

module.exports = server;
