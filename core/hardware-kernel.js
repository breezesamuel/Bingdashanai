// core/hardware-kernel.js — 通用硬件自主管理内核（2026-10-25，Windows 首版）
//
// 【定位与诚实边界】目标语义：任何硬件 → 即插即用 → 自我描述 → 自动适配 →
// 生命周期全托管 → 统一语义命令。本内核把其中**可验证为真**的部分做实：
//   ✔ 发现：真实枚举本机全部 PnP/USB 设备（Windows CIM，零硬编码设备清单）
//   ✔ 识别：VID/PID/厂商/类/服务/驱动状态逐台提取
//   ✔ 理解：按 PNPClass/Service → 语义档案（kind + 能力集 + 可执行命令集），
//           档案是"类驱动"的——新增任意品牌 U 盘/串口板/键鼠自动落入对应档案，无需改代码
//   ✔ 命令：统一语义命令（status/ports/disable/enable/restart），控制类操作
//           需显式 allowControl（默认关）+ 管理员权限，失败如实报错绝不谎报成功
//   ✔ 记忆/学习：快照与动作结果落库（hwDevices/hwLog），新设备出现触发 evolve
//   ✘ 边界：无法凭空获得私协议 datasheet 的板子寄存器语义——那需要厂商 SDK；
//           内核对这类设备如实标注 profile='opaque'，给出可用的公共层命令
//（枚举/电源管理/端口），绝不说"已完全接管"。
'use strict';
const { execFile } = require('child_process');
const store = require('./store');

// —— 类驱动档案：PNPClass / Service → 语义能力（新增设备自动归类，零硬编码机型）——
const PROFILES = [
  { match: { PNPClass: ['USB', 'USBDevice', 'HIDClass', 'Mouse', 'Keyboard'], Service: ['HidUsb', 'kbdhid', 'mouhid'] },
    kind: 'hid', label: '人机接口（键鼠/手柄/HID 板）',
    caps: ['input', 'leds?'], cmds: ['status'] },
  { match: { PNPClass: ['DiskDrive', 'Volume', 'USBSTOR'] }, kind: 'storage', label: '存储（U盘/移动硬盘/读卡器）',
    caps: ['block-storage', 'mount'], cmds: ['status'] },
  { match: { Service: ['Serial', 'usbser', 'Usbser', 'WUDFRd'], PNPClass: ['Ports', 'Modem'] },
    kind: 'serial', label: '串口（Arduino/ESP32/CH340/CP210x/调试板）',
    caps: ['tty', 'line-io'], cmds: ['status', 'ports'] },
  { match: { PNPClass: ['Net', 'MEDIA'], Service: ['usbnet', 'NDIS', 'usbrndis6', 'RNDIS'] },
    kind: 'net', label: '网络/网卡（含 USB 网卡/RNDIS）', caps: ['link'], cmds: ['status'] },
  { match: { PNPClass: ['Camera', 'Image'] }, kind: 'camera', label: '摄像头/影像采集', caps: ['capture'], cmds: ['status'] },
  { match: { PNPClass: ['Bluetooth', 'BTH'] }, kind: 'bluetooth', label: '蓝牙（含 BLE 适配器）', caps: ['ble'], cmds: ['status'] },
  { match: { PNPClass: ['Monitor', 'Display'] }, kind: 'display', label: '显示输出', caps: ['video-out'], cmds: ['status'] },
  { match: { PNPClass: ['Printer'] }, kind: 'printer', label: '打印设备', caps: ['print'], cmds: ['status'] },
  { match: { PNPClass: ['AudioEndpoint', 'MEDIA'] }, kind: 'audio', label: '音频设备', caps: ['audio-io'], cmds: ['status'] },
];
function classify(d) {
  const cls = String(d.PNPClass || d.pnpClass || ''), svc = String(d.Service || d.service || '');
  for (const p of PROFILES) {
    const hitCls = (p.match.PNPClass || []).some(c => cls.toLowerCase() === c.toLowerCase());
    const hitSvc = (p.match.Service || []).some(s => svc.toLowerCase() === s.toLowerCase());
    if (hitCls || hitSvc) return { kind: p.kind, label: p.label, caps: p.caps, cmds: p.cmds };
  }
  return { kind: 'opaque', label: '未建档设备（公共层可管：枚举/电源/状态；私有协议需厂商 SDK）', caps: ['pnp'], cmds: ['status'] };
}

// —— 真实发现：Windows CIM 全量 PnP 枚举（PowerShell → JSON）——
function runPS(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', args], { timeout: timeoutMs || 20000, windowsHide: true },
      (err, stdout) => resolve({ ok: !err && !!stdout, out: String(stdout || ''), err: err ? String(err.message) : '' }));
  });
}
function parseVidPid(deviceId) {
  const m = /VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})/i.exec(String(deviceId || ''));
  return m ? { vid: '0x' + m[1].toUpperCase(), pid: '0x' + m[2].toUpperCase() } : {};
}
async function scan() {
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "Get-CimInstance Win32_PnPEntity | Where-Object {$_.DeviceID} | Select-Object DeviceID,Name,PNPClass,Service,Manufacturer,Status,ConfigManagerErrorCode | ConvertTo-Json -Compress";
  const r = await runPS(ps, 25000);
  if (!r.ok) return { ok: false, error: 'PnP 枚举失败（PowerShell/CIM 不可达）：' + r.err.slice(0, 120) };
  let raw;
  try { raw = JSON.parse(r.out); } catch (e) { return { ok: false, error: 'CIM 输出解析失败：' + e.message }; }
  const list = Array.isArray(raw) ? raw : [raw];
  const devices = list.filter(d => d && d.DeviceID).map((d, i) => {
    const prof = classify(d);
    return {
      id: d.DeviceID, name: d.Name || '', pnpClass: d.PNPClass || '', service: d.Service || '',
      vendor: d.Manufacturer || '', status: d.Status || '', errCode: Number(d.ConfigManagerErrorCode || 0),
      ...parseVidPid(d.DeviceID), ...prof,
      bus: /^USB/i.test(String(d.DeviceID)) ? 'usb' : (/^PCI/i.test(String(d.DeviceID)) ? 'pci' : 'other'),
    };
  });
  // 记忆 + 学习信号：快照落库；新 VID:PID 首次出现 → evolve（无 store 写失败也不影响扫描）
  try {
    const db = store.read();
    const known = new Set((db.hwDevices || []).map(x => x.vidpid).filter(Boolean));
    let fresh = 0;
    for (const d of devices) {
      const vp = d.vid ? d.vid + ':' + d.pid : '';
      if (vp && !known.has(vp)) { fresh++; known.add(vp); }
    }
    db.hwDevices = devices.map(d => ({ vidpid: d.vid ? d.vid + ':' + d.pid : null, name: d.name, kind: d.kind, seenAt: Date.now() }));
    store.write(db);
    if (fresh > 0) { try { require('./brain').evolve('硬件内核：发现 ' + fresh + ' 个新型号设备'); } catch (e) {} }
  } catch (e) {}
  const byKind = {};
  devices.forEach(d => { byKind[d.kind] = (byKind[d.kind] || 0) + 1; });
  return { ok: true, total: devices.length, usb: devices.filter(d => d.bus === 'usb').length, byKind, devices };
}

// —— 串口清单（serial 类设备的真实端口名）——
async function serialPorts() {
  const r = await runPS("[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Description | ConvertTo-Json -Compress", 15000);
  if (!r.ok) return [];
  try { const j = JSON.parse(r.out); return (Array.isArray(j) ? j : [j]).filter(x => x && x.DeviceID); } catch (e) { return []; }
}

// —— 即插即用感知：轮询 diff（自感应）——
// watch() 每 intervalMs 扫一次，与上一快照按 DeviceID 集合比对 → added/removed 事件
// 落 hwEvents 台账（cap 500）+ brain.evolve（学习信号）。返回 stop() 句柄。
const _watchState = { timer: null, last: new Set(), busy: false, intervalMs: 0 };
async function _watchTick() {
  if (_watchState.busy) return;
  _watchState.busy = true;
  try {
    const s = await scan();
    if (!s.ok) return;
    const now = new Set(s.devices.map(d => d.id));
    const events = [];
    for (const id of now) if (!_watchState.last.has(id)) {
      const d = s.devices.find(x => x.id === id);
      events.push({ type: 'added', id, name: d.name, kind: d.kind, vid: d.vid, pid: d.pid, at: Date.now() });
    }
    for (const id of _watchState.last) if (!now.has(id)) {
      events.push({ type: 'removed', id, at: Date.now() });
    }
    _watchState.last = now;
    if (events.length) {
      try {
        const db = store.read();
        db.hwEvents = (db.hwEvents || []).concat(events).slice(-500);
        store.write(db);
        try { require('./brain').evolve('硬件热插拔：' + events.map(e => e.type + ' ' + (e.name || e.id.slice(0, 24))).join('；')); } catch (e) {}
      } catch (e) {}
    }
  } catch (e) { /* 单轮失败不打断轮询 */ }
  finally { _watchState.busy = false; }
}
function watch(intervalMs) {
  if (_watchState.timer) return { ok: true, already: true, intervalMs: _watchState.intervalMs };
  const ms = Math.max(5000, Number(intervalMs) || 10000);
  _watchState.intervalMs = ms;
  _watchTick();                                  // 立即建基线
  _watchState.timer = setInterval(_watchTick, ms);
  if (_watchState.timer.unref) _watchState.timer.unref();
  return { ok: true, intervalMs: ms };
}
function watchStatus() {
  return { watching: !!_watchState.timer, intervalMs: _watchState.intervalMs };
}
// 快照 diff 独立导出（可单测，不依赖真实设备变化）
function diffSnapshots(prevIds, nextDevices) {
  const prev = new Set(prevIds);
  const next = new Set(nextDevices.map(d => d.id));
  return {
    added: nextDevices.filter(d => !prev.has(d.id)).map(d => ({ type: 'added', id: d.id, name: d.name, kind: d.kind })),
    removed: [...prev].filter(id => !next.has(id)).map(id => ({ type: 'removed', id })),
  };
}
function hwEvents(limit) {
  try { return { ok: true, events: (store.read().hwEvents || []).slice(-Math.min(Number(limit) || 50, 500)).reverse() }; }
  catch (e) { return { ok: false, error: String(e.message) }; }
}

// —— 真实串口 IO（零 npm 依赖：PowerShell .NET System.IO.Ports）——
// 「正确配置引脚」的诚实实现分两层：
//   · OS 层（config 命令）：端口参数 波特率/校验/数据位/停止位 —— `mode COMx` 真实生效
//   · 板层（firmata 命令）：SET_PIN_MODE (0xF4)+pin+mode 标准协议字节真发到板子——
//     烧了 Firmata 固件的 Arduino/ESP32 会真实改变引脚配置；无应答则如实报告
//     「已发送、无应答（板子可能未刷 Firmata 固件）」，绝不谎报"配置成功"
async function runSerial(portName, body, timeoutMs) {
  const ps = "$ErrorActionPreference='Stop';try{$p=New-Object System.IO.Ports.SerialPort('" +
    String(portName).replace(/[^A-Za-z0-9]/g, '') + "'," + Number(body.baud || 115200) +
    ",'None',8,'One');$p.ReadTimeout=" + Number(timeoutMs || 900) + ";$p.Open();" + body.script +
    ";$p.Close();}catch{Write-Output ('ERR ' + $_.Exception.Message)}";
  const r = await runPS(ps, 15000);
  return { ok: r.ok && !/^ERR/m.test(r.out), out: r.out.trim(), err: r.err };
}
const FIRMATA_MODES = { input: 0x00, output: 0x01, analog: 0x02, pwm: 0x03, servo: 0x04 };

// —— 统一语义命令（控制类需 allowControl + 管理员；一切失败如实回报）——
async function command(instanceId, cmd, opts) {
  const id = String(instanceId || '');
  const o = opts || {};
  if (!id) return { ok: false, error: 'instanceId（设备 DeviceID）必填' };
  const log = (okk, detail) => { try { store.push('hwLog', { id, cmd, ok: okk, detail: String(detail).slice(0, 200), at: Date.now() }, '硬件命令', cmd); } catch (e) {} };
  if (cmd === 'status') {
    const s = await scan();
    const dev = s.ok && s.devices.find(d => d.id === id);
    if (!dev) { log(false, 'not-found'); return { ok: false, error: '设备未找到（可能已拔出）' }; }
    log(true, dev.status); return { ok: true, device: dev };
  }
  if (cmd === 'ports') {
    const p = await serialPorts();
    log(true, p.length + ' ports'); return { ok: true, ports: p };
  }
  // 串口通讯：真实打开端口、写一字节握手、读回显（连接证明）
  if (cmd === 'ping') {
    const portName = String(o.portName || '').trim();
    if (!/^(COM\d{1,3})$/i.test(portName)) return { ok: false, error: 'portName 必填且形如 COM3' };
    const r = await runSerial(portName, { baud: o.baud, script: "$p.Write([byte[]](0xF9),0,1);Start-Sleep -Milliseconds 120;Write-Output ('RX ' + $p.BytesToRead + 'B')" }, 900);
    const heard = /RX [1-9]/.test(r.out);
    log(heard, portName + ' ' + (heard ? '应答' : '无应答'));
    return heard ? { ok: true, port: portName, heard: true, detail: '端口打开成功且板子有应答字节（Firmata 握手回包）' }
      : { ok: r.ok, port: portName, heard: false, detail: r.ok
          ? '端口打开与写入成功，但无应答（板子未刷 Firmata 固件或波特率不符——通讯链路已通，协议层未握上手）'
          : '端口打开失败：' + (r.out || r.err).slice(0, 140) };
  }
  // OS 层引脚/端口配置：mode COMx 真实生效（波特率/校验/数据位/停止位）
  if (cmd === 'config') {
    const portName = String(o.portName || '').trim();
    if (!/^(COM\d{1,3})$/i.test(portName)) return { ok: false, error: 'portName 必填且形如 COM3' };
    const baud = Number(o.baud || 115200);
    if (![9600, 19200, 38400, 57600, 115200, 230400].includes(baud)) return { ok: false, error: 'baud 仅支持 9600-230400 标准档' };
    const r = await runPS('mode ' + portName + ': BAUD=' + baud + ' PARITY=' + (o.parity || 'N') + ' DATA=' + (o.dataBits || 8) + ' STOP=' + (o.stopBits || 1), 12000);
    const okk = r.ok && !r.err && !/非法|invalid|error/i.test(r.out);
    log(okk, portName + ' BAUD=' + baud + (okk ? '' : ' ' + (r.out || r.err).slice(0, 80)));
    return okk ? { ok: true, port: portName, baud, detail: '端口参数已生效（OS 串口配置层）' }
      : { ok: false, error: '配置未生效：' + (r.out || r.err).slice(0, 140) };
  }
  // 板层引脚配置：Firmata SET_PIN_MODE 真发协议字节
  if (cmd === 'firmata') {
    const portName = String(o.portName || '').trim();
    const pin = Number(o.pin), mode = FIRMATA_MODES[String(o.mode || '').toLowerCase()];
    if (!/^(COM\d{1,3})$/i.test(portName)) return { ok: false, error: 'portName 必填且形如 COM3' };
    if (!Number.isInteger(pin) || pin < 0 || pin > 127) return { ok: false, error: 'pin 必须是 0-127 整数' };
    if (mode === undefined) return { ok: false, error: 'mode 必须是 input/output/analog/pwm/servo' };
    const bytes = '0xF4,0x' + pin.toString(16) + ',0x0' + mode;
    const r = await runSerial(portName, { baud: 57600, script: "$p.Write([byte[]](" + bytes + "),0,3);Start-Sleep -Milliseconds 100;Write-Output 'SENT'" }, 900);
    const sent = /SENT/.test(r.out);
    log(sent, portName + ' pin' + pin + '=' + o.mode + (sent ? ' 发送成功' : ' 失败'));
    return sent ? { ok: true, port: portName, pin, mode: o.mode, detail: 'Firmata SET_PIN_MODE 字节已真实发送（板子刷有 Firmata 固件则引脚配置即时生效）' }
      : { ok: false, error: '串口打开/写入失败：' + (r.out || r.err).slice(0, 140) };
  }
  if (['disable', 'enable', 'restart'].includes(cmd)) {
    if (!o.allowControl) return { ok: false, error: '控制类命令需显式 allowControl:true（默认只读）' };
    const flag = cmd === 'restart' ? '/restart-device' : (cmd === 'disable' ? '/disable-device' : '/enable-device');
    const r = await runPS('pnputil ' + flag + ' "' + id.replace(/"/g, '') + '"', 20000);
    const okk = /已|success|restart|enab|disab/i.test(r.out) && !r.err;
    log(okk, r.out.slice(0, 120) || r.err.slice(0, 120));
    return okk ? { ok: true, output: r.out.trim().slice(0, 400) }
      : { ok: false, error: '命令未生效（通常需要管理员权限运行本服务）：' + (r.out || r.err).slice(0, 160) };
  }
  return { ok: false, error: '未知命令：' + cmd + '（可用：status/ports/ping/config/firmata/disable/enable/restart）' };
}

module.exports = { scan, command, serialPorts, classify, PROFILES, watch, watchStatus, diffSnapshots, hwEvents, runSerial, FIRMATA_MODES };
