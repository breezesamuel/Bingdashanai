'use strict';
// scripts/gen-icons.js — 零依赖生成 PWA / 桌面 / 移动端需要的位图图标。
//
// 为什么自己生成：本项目坚持零框架依赖（原生 http），不引入 sharp/canvas 这类
// 需要编译或下载原生二进制的重型依赖。PNG 容器 + zlib 压缩是 Node 自带的，
// 一个纯 JS 的 PNG 编码器（CRC32 + IHDR/IDAT/IEND）就能产出所有尺寸的图标。
//
// 产出（web/icons/）：
//   favicon-32.png / favicon-64.png
//   icon-192.png / icon-512.png            —— Android / PWA 通用
//   maskable-512.png                        —— Android 自适应图标（安全区内缩）
//   apple-touch-icon-180.png                —— iOS 主屏图标（必须 PNG，不支持 SVG）
//
// 图形：品牌祖母绿渐变底 + 白色山峰（"山"）+ 琥珀色太阳，3x3 超采样抗锯齿。
// 山峰是可计算的几何图形，不依赖任何字体（避免目标机器缺字导致图标空白）。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  return Buffer.concat([u32(data.length), typeBuf, data, u32(crc32(body))]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 图形（归一化 0..1 坐标） ----------
const BRAND = [16, 122, 90];
const BRAND_DARK = [10, 74, 55];
const SNOW = [245, 247, 244];
const SNOW_SHADE = [206, 214, 209];
const SUN = [245, 180, 40];

function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function inCircle(x, y, cx, cy, r) { const dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= r * r; }
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const u = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const hasNeg = (s < 0) || (t < 0) || (u < 0);
  const hasPos = (s > 0) || (t > 0) || (u > 0);
  return !(hasNeg && hasPos);
}

function sampleColor(x, y, cornerRadius) {
  if (cornerRadius > 0) {
    const r = cornerRadius;
    let inCorner = false;
    if (x < r && y < r) inCorner = Math.hypot(x - r, y - r) > r;
    else if (x > 1 - r && y < r) inCorner = Math.hypot(x - (1 - r), y - r) > r;
    else if (x < r && y > 1 - r) inCorner = Math.hypot(x - r, y - (1 - r)) > r;
    else if (x > 1 - r && y > 1 - r) inCorner = Math.hypot(x - (1 - r), y - (1 - r)) > r;
    if (inCorner) return null;
  }
  let col = mix(BRAND, BRAND_DARK, Math.min(1, Math.max(0, y)));
  if (inCircle(x, y, 0.72, 0.30, 0.135)) col = SUN;
  const left = inTri(x, y, 0.20, 0.80, 0.52, 0.26, 0.85, 0.80);
  const right = inTri(x, y, 0.44, 0.80, 0.68, 0.44, 0.94, 0.80);
  if (left) col = (y < 0.40) ? mix(SNOW, SNOW_SHADE, 0.25) : SNOW;
  if (right) col = SNOW;
  return col;
}

function render(size, opts) {
  const cornerRadius = opts.cornerRadius || 0;
  const maskScale = opts.maskScale || 1;
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3;
  const n = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          let nx = (px + (sx + 0.5) / SS) / size;
          let ny = (py + (sy + 0.5) / SS) / size;
          if (maskScale !== 1) { nx = (nx - 0.5) / maskScale + 0.5; ny = (ny - 0.5) / maskScale + 0.5; }
          if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
          const c = sampleColor(nx, ny, cornerRadius);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const i = (py * size + px) * 4;
      const cov = a / (255 * n);
      if (cov > 0) {
        rgba[i] = Math.round(r / (n * cov));
        rgba[i + 1] = Math.round(g / (n * cov));
        rgba[i + 2] = Math.round(b / (n * cov));
      }
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, rgba);
}

const OUT = path.join(__dirname, '..', 'web', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  ['favicon-32.png', 32, { cornerRadius: 0.18 }],
  ['favicon-64.png', 64, { cornerRadius: 0.18 }],
  ['icon-192.png', 192, { cornerRadius: 0.20 }],
  ['icon-512.png', 512, { cornerRadius: 0.20 }],
  ['apple-touch-icon-180.png', 180, { cornerRadius: 0.0 }],
  ['maskable-512.png', 512, { maskScale: 0.8 }]
];

for (const [name, size, opts] of TARGETS) {
  const png = render(size, opts);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('wrote web/icons/' + name + ' (' + size + 'x' + size + ', ' + png.length + ' bytes)');
}
console.log('done: ' + OUT);
