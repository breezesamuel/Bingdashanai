// orca-ws-e2e: Orca WebSocket 实时推送回归——曾因双重 101 写头 + net.Socket.send/readyState
// 用法错误导致功能从未工作过。现在验证握手正确、服务器真的会发 5s 一帧的 board/pulse。
const { finish } = require('./_exit');
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const { requireIsolated } = require('./_guard');
const BASE = requireIsolated('orca-ws-e2e');
const u = new URL(BASE);
const HOST = u.hostname, PORT = Number(u.port || 80);

let pass = 0, fail = 0;
const T = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' . ' + extra : ';')); };

(async () => {
  // 非升级的常规 GET 应该拿到 426 提示而不是挂死
  await new Promise(res => {
    const r = http.get(BASE + '/v1/orca/ws', resp => {
      T('plain GET /v1/orca/ws -> 426', resp.statusCode === 426, 'code=' + resp.statusCode); res();
    });
    r.on('error', () => { T('plain GET /v1/orca/ws -> 426', false, 'req error'); res(); });
    r.setTimeout(5000, () => { r.destroy(); T('plain GET /v1/orca/ws -> 426', false, 'timeout'); res(); });
  });

  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(PORT, HOST);
  let handshaked = false, buf = '', got = false;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      T('WS orca push arrives within 8s', false, 'timeout');
      try { sock.destroy(); } catch (e) {}
      resolve();
    }, 8000);

    sock.on('connect', () => {
      sock.write('GET /v1/orca/ws HTTP/1.1\r\nHost: ' + HOST + ':' + PORT +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
        '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('data', d => {
      buf += d.toString('binary');
      if (!handshaked) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx);
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        T('WS handshake is single 101 with correct accept', /^HTTP\/1.1 101/.test(head) && head.includes(accept),
          'firstLine=' + head.split('\r\n')[0]);
        handshaked = true;
        buf = buf.slice(idx + 4);
      }
      while (handshaked && buf.length >= 2) {
        const b0 = buf.charCodeAt(0);
        if ((b0 & 0x0f) !== 1) { T('WS framed text frame', false, 'byte0=0x' + b0.toString(16)); try { sock.destroy(); } catch (e) {} clearTimeout(timer); resolve(); return; }
        let len = buf.charCodeAt(1) & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = (buf.charCodeAt(2) << 8) | buf.charCodeAt(3); off = 4; }
        if (buf.length < off + len) return;
        try {
          const payload = JSON.parse(Buffer.from(buf.slice(off, off + len), 'binary').toString('utf8'));
          if (payload.type === 'orca') {
            T('WS orca push arrives within 8s', true, 'keys=' + Object.keys(payload.data || {}).join(','));
            got = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) {}
            resolve();
          }
        } catch (e) { T('WS orca push arrives within 8s', false, 'bad payload'); }
        buf = buf.slice(off + len);
      }
    });
    sock.on('error', () => {});
  });
  if (!handshaked) T('WS handshake is single 101 with correct accept', false, 'never upgraded');
  if (!got) T('WS orca push arrives within 8s', false, 'no frame');
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail ? 1 : 0);
})();
