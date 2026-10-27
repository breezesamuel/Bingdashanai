// core/smtp.js — 复用长连接的 SMTP 发送器
//
// 背景（逆向工程结论）：
//   QQ SMTP（smtp.qq.com:465）会在短时间窗口内「静默丢弃新建连接」——TCP/TLS 能连上，
//   但服务端不回 220 问候，客户端只能等到超时。实测：连续 6 次「每次新建连接」成功，
//   第 7 次开始超时；同进程内复用 1 条连接则稳定。
//   这正是此前「脚本能发、队列/服务端间歇性超时」的真正原因：不是代码路径问题，
//   而是每次发送都新建连接，触发了服务端的连接频率限制。旧实现每次 new tls.connect，
//   在密集重试时几乎必然踩中限流。
//
// 方案：
//   1. 每个 (host:port|user) 只维持 1 条长连接；
//   2. 所有发送全局串行（互斥队列），绝不并发新建连接；
//   3. 连接失效（error/close/超时）自动作废，下次发送时重连；
//   4. 单次发送失败按次数重试（默认 2 次），仍失败则如实抛出——绝不谎报成功。

const net = require('net');
const tls = require('tls');

// 诊断开关：SMTP_DEBUG=1 时打印原始 SMTP 会话（用于定位「脚本能发、服务端被拒」类问题）
const DEBUG = process.env.SMTP_DEBUG === '1';
const dbg = (...a) => { if (DEBUG) console.log('[smtp]', ...a); };

const b64 = x => Buffer.from(String(x), 'utf8').toString('base64');

// RFC 2045：base64 正文必须折行（每行 ≤ 76 字符）；RFC 5321 限制正文单行 ≤ 998 octets。
// 之前把整段 base64 写成一行的做法会让 QQ 直接回 `500 Line too long` —— 这正是 24 小时
// 内「验证码邮件永远发不出去」的真凶。
function wrapBase64(s) {
  const wrapped = String(s).replace(/.{1,76}/g, '$&\r\n');
  return wrapped.replace(/\r\n$/, '');
}

function headersFor(cfg, to, subject, html) {
  return 'From: =?UTF-8?B?' + b64(cfg.from) + '?= <' + cfg.from + '>\r\n' +
    'To: <' + to + '>\r\n' +
    'Subject: =?UTF-8?B?' + b64(subject) + '?=\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/html; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    wrapBase64(Buffer.from(html, 'utf8').toString('base64'));
}

const DEFAULT_TIMEOUT_MS = 20000;
const IDLE_CLOSE_MS = 10 * 60 * 1000; // 空闲 10 分钟后主动断开，避免长期占用

// 一条可复用的 SMTP 连接：把「命令 → 应答」封装成可 await 的调用。
class Conn {
  constructor(cfg, timeoutMs) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.buf = '';
    this.q = [];        // 已收到、未被取走的响应码
    this.waiter = null; // { resolve, timer }
    this.dead = true;
  }

  _onLine(line) {
    const m = /^(\d{3})([ -]?)/.exec(line);
    if (!m) { dbg('S(raw):', line); return; }
    dbg('S:', line);
    if (m[2] === '-') return; // 多行响应的中间行，等最后一行
    this.q.push(parseInt(m[1], 10));
    if (this.waiter && this.q.length) {
      const w = this.waiter; this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(this.q.shift());
    }
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line) this._onLine(line);
    }
  }

  _fail(reason) {
    this.dead = true;
    if (this.waiter) {
      const w = this.waiter; this.waiter = null;
      clearTimeout(w.timer);
      w.reject(reason instanceof Error ? reason : new Error(String(reason)));
    }
  }

  _next() {
    if (this.q.length) return Promise.resolve(this.q.shift());
    if (this.dead) return Promise.reject(new Error('SMTP 连接不可用'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this._destroy();
        reject(new Error('SMTP 超时'));
      }, this.cfg.timeoutMs || 20000);
      this.waiter = { resolve, reject, timer };
    });
  }

  _destroy() {
    this.dead = true;
    try { if (this.sock) this.sock.destroy(); } catch (e) {}
    this.sock = null;
  }

  async _cmd(text, expect) {
    if (this.dead || !this.sock) throw new Error('SMTP 连接不可用');
    dbg('C:', text.slice(0, 40));
    this.sock.write(text + '\r\n');
    const code = await this._next();
    if (expect && code !== expect) throw new Error('SMTP 期望 ' + expect + ' 得到 ' + code);
    return code;
  }

  async open() {
    const cfg = this.cfg;
    dbg('CONNECT', cfg.host + ':' + cfg.port, 'secure=' + cfg.secure, 'user=' + String(cfg.user || '').slice(0, 3) + '***', 'from=' + cfg.from);
    this.dead = false;
    this.buf = ''; this.q = []; this.waiter = null;
    const sock = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', d => this._onData(d));
    sock.on('error', e => this._fail(e));
    sock.on('close', () => this._fail(new Error('SMTP 连接被关闭')));

    const greet = await this._next();          // 若被服务端限流丢弃，这里会等到超时
    if (greet !== 220) throw new Error('SMTP 问候异常 ' + greet);
    await this._cmd('EHLO bingdashan.local', 250);
    await this._cmd('AUTH LOGIN', 334);
    await this._cmd(b64(cfg.user), 334);
    const auth = await this._cmd(b64(cfg.pass));
    if (auth !== 235) throw new Error('SMTP 认证失败 ' + auth);
  }

  async send(to, subject, html) {
    await this._cmd('MAIL FROM:<' + this.cfg.from + '>', 250);
    await this._cmd('RCPT TO:<' + to + '>', 250);
    await this._cmd('DATA', 354);
    if (this.dead || !this.sock) throw new Error('SMTP 连接不可用');
    dbg('C: <message body, bytes=' + Buffer.byteLength(headersFor(this.cfg, to, subject, html)) + '>');
    this.sock.write(headersFor(this.cfg, to, subject, html) + '\r\n.\r\n');
    const code = await this._next();
    if (code !== 250) throw new Error('SMTP 投递被拒绝 ' + code);
    return code;
  }
}

// key -> { cfg, conn, timer }
const POOLS = new Map();
let chain = Promise.resolve(); // 全局串行队列：同一时刻只做一次 SMTP 交互

function poolKey(cfg) {
  return cfg.host + ':' + cfg.port + '|' + cfg.user;
}

function scheduleIdleClose(state) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    if (state.conn) { try { state.conn._destroy(); } catch (e) {} state.conn = null; }
  }, state.idleMs || 10 * 60 * 1000);
  if (state.timer.unref) state.timer.unref();
}

// 发送一封邮件。cfg: transport() 返回的 smtp 配置。
// 返回 Promise<number>（SMTP 结束码，通常 250）；失败抛出真实错误。
function send(cfg, to, subject, html, opts) {
  const o = opts || {};
  const attempts = Number(o.attempts) > 0 ? Number(o.attempts) : 2;
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 20000;
  const email = String(to || '').trim();
  if (!email) return Promise.reject(new Error('收件地址必填'));

  const key = poolKey(cfg);
  let state = POOLS.get(key);
  if (!state) { state = { cfg: null, conn: null, timer: null }; POOLS.set(key, state); }

  const run = async () => {
    state.cfg = Object.assign({}, cfg, { timeoutMs });
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        if (!state.conn || state.conn.dead) {
          state.conn = new Conn(state.cfg);
          await state.conn.open();
        }
        const code = await state.conn.send(email, subject, html);
        scheduleIdleClose(state);
        return code;
      } catch (e) {
        lastErr = e;
        if (state.conn) { state.conn._destroy(); state.conn = null; }
        // 连接被限流/失效：稍作退避后重试（新建连接）
        if (i < attempts) await new Promise(r => setTimeout(r, 800 * i));
      }
    }
    throw lastErr || new Error('SMTP 发送失败');
  };

  // 串行化：避免并发新建连接触发限流
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

function closeAll() {
  for (const [, state] of POOLS) {
    if (state.timer) clearTimeout(state.timer);
    if (state.conn) { try { state.conn._destroy(); } catch (e) {} }
    state.conn = null;
  }
}

// 运行状态（诊断用）：每条连接是否仍然可用
function stats() {
  const out = {};
  for (const [key, state] of POOLS.entries()) {
    out[key] = { alive: !!(state.conn && !state.conn.dead) };
  }
  return out;
}

module.exports = { send, closeAll, stats, headersFor };
