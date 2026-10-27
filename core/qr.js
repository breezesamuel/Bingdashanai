// core/qr.js — 零依赖二维码编码器（Byte 模式 + ECC-M + 掩码自动选择）
//
// 【为什么自己写】服务器（ECS 阿里云境内）装 npm 包慢且不稳，境外二维码渲染服务
// （quickchart 等）在境内访问不可达。收银台必须「打开就能出码」，不能依赖第三方。
// 只实现 URL 需要的范围：版本 1–10、ECC M、字节模式——足够容纳
// https://域名/pay/go/<订单号> 这类短链（≤ 216 字节）。
//
// 输出为 data:image/svg+xml —— 矢量、体积小（几百字节）、任意尺寸清晰，
// 且天然嵌进 JSON 响应里（前端 <img src> 直接渲染，不走静态文件路径）。
//
// 矩阵取值约定：
//   0/1 = 功能图案（定位/校正/时序）的明暗，不可改
//   3   = 为格式信息/版本信息预留的位置（先占位，数据流必须绕开）
//   null= 数据区（放码字，再按掩码决定是否翻转）

'use strict';

const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// 生成 n 个纠错字节的生成多项式
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

// 版本 1–10 · ECC M 的分块表：[每块纠错字节, 组1块数, 组1数据字节, 组2块数, 组2数据字节]
const BLOCKS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44]
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

function dataCapacityBytes(ver) {
  const b = BLOCKS_M[ver];
  return b[1] * b[2] + b[3] * b[4];
}

// 数据位流：模式 0100(字节) + 计数位 + 数据 + 终止 + 填充
function buildBitStream(text, ver) {
  const bytes = Buffer.from(String(text), 'utf8');
  const capBits = dataCapacityBytes(ver) * 8;
  const ccBits = ver <= 9 ? 8 : 16;
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ccBits);
  for (const byte of bytes) push(byte, 8);
  const term = Math.min(4, capBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pad = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capBits) {
    push(pad[pi % 2], 8);
    pi++;
  }
  const bytesOut = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    bytesOut.push(byte);
  }
  return bytesOut;
}

// 纠错编码 + 交织 → 最终码字序列
function buildCodewords(dataBytes, ver) {
  const [ecPer, n1, d1, n2, d2] = BLOCKS_M[ver];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < n1; i++) { blocks.push(dataBytes.slice(offset, offset + d1)); offset += d1; }
  for (let i = 0; i < n2; i++) { blocks.push(dataBytes.slice(offset, offset + d2)); offset += d2; }
  const gen = rsGenerator(ecPer);
  const ecBlocks = blocks.map(block => {
    const rem = new Array(ecPer).fill(0);
    for (const byte of block) {
      const factor = byte ^ rem[0];
      rem.shift();
      rem.push(0);
      if (factor !== 0) {
        for (let i = 0; i < ecPer; i++) rem[i] ^= gfMul(gen[i + 1], factor);
      }
    }
    return rem;
  });
  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < blocks[b].length) out.push(blocks[b][i]);
  }
  for (let i = 0; i < ecPer; i++) {
    for (let b = 0; b < ecBlocks.length; b++) out.push(ecBlocks[b][i]);
  }
  return out;
}

function newMatrix(size) {
  const m = new Array(size);
  for (let i = 0; i < size; i++) m[i] = new Array(size).fill(null);
  return m;
}

function placeFinder(m, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = dark ? 1 : 0;
    }
  }
}

function placeAlignment(m, ver) {
  const centers = ALIGN[ver];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === m.length - 7) || (r === m.length - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = dark ? 1 : 0;
        }
      }
    }
  }
}

function placeTiming(m) {
  for (let i = 8; i < m.length - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = v;
    if (m[i][6] === null) m[i][6] = v;
  }
}

// 【关键】把格式信息/版本信息的落脚点先占成 3（预留），数据流必须绕开它们。
// 少了这一步，码字会流进格式区，随后 placeFormat 覆盖它们 → 数据被改写，扫码必失败。
function reserveInfoAreas(m, ver) {
  const size = m.length;
  // 左上：第 8 行 0–8 列 + 第 8 列 0–8 行
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] === null) m[8][i] = 3;
    if (m[i][8] === null) m[i][8] = 3;
  }
  // 左下（第 8 列，末 8 行）+ 右上（第 8 行，末 8 列）
  for (let i = 0; i < 8; i++) {
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 3;
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 3;
  }
  // 版本 ≥7：版本信息块（左下 3×6 + 右上 6×3）
  if (ver >= 7) {
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 3; b++) {
        if (m[size - 11 + b][a] === null) m[size - 11 + b][a] = 3;
        if (m[a][size - 11 + b] === null) m[a][size - 11 + b] = 3;
      }
    }
  }
}

const FORMAT_BCH = [
  0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
  0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976,
  0x1689, 0x13BE, 0x1CE7, 0x19D0, 0x0762, 0x0255, 0x0D0C, 0x083B,
  0x355F, 0x3068, 0x3F31, 0x3A06, 0x24B4, 0x2183, 0x2EDA, 0x2BED
];
function placeFormat(m, mask) {
  // 5 位数据 = ECC 等级(2 位) << 3 | 掩码(3 位)；M = 0b00 → 索引就是掩码号。
  // 顺序写反会取到 Q/H 等级的格式位，扫码直接失败。
  const fmt = FORMAT_BCH[((0b00) << 3) | (mask & 7)];
  const size = m.length;
  const bits = [];
  for (let i = 0; i < 15; i++) bits.push((fmt >> i) & 1); // bits[i] = 第 i 位（低位在前）
  // 第一份（环绕左上定位图案）——行/列别写反：参考 ISO 18004 与 nayuki QR 实现
  for (let i = 0; i <= 5; i++) m[i][8] = bits[i];   // bits0–5 → 第8列 0–5行
  m[7][8] = bits[6];
  m[8][8] = bits[7];
  m[8][7] = bits[8];
  for (let i = 9; i <= 14; i++) m[8][14 - i] = bits[i]; // bits9–14 → 第8行 5–0列
  // 第二份：右上（第8行，末8列）+ 左下（第8列，末8行）
  for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bits[i];
  for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bits[i];
  m[size - 8][8] = 1; // 固定黑模块
}

function placeVersion(m, ver) {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  const v = (ver << 12) | rem;
  const size = m.length;
  for (let i = 0; i < 18; i++) {
    const bit = (v >> i) & 1;
    const a = Math.floor(i / 3), b = i % 3;
    m[size - 11 + b][a] = bit;
    m[a][size - 11 + b] = bit;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

// 数据放置：从右下角开始、两列一组、向上/向下蛇形；只填 null 的数据区
function placeData(m, codewords) {
  const size = m.length;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  const isData = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖向时序图案列
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (m[r][c] !== null) continue; // 0/1=功能图案，3=预留信息区，都要绕开
        let bit = 0;
        if (bitIdx < totalBits) {
          const byte = codewords[bitIdx >> 3];
          bit = (byte >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        m[r][c] = bit;
        isData.push([r, c]);
      }
    }
    upward = !upward;
  }
  return isData;
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  const at = (r, c) => (m[r][c] & 1);
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (at(r, c) === at(r, c - 1)) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (at(r, c) === at(r - 1, c)) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }
  const pat = [1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 7; c++) {
      let ok = true;
      for (let i = 0; i < 7; i++) if (at(r, c + i) !== pat[i]) { ok = false; break; }
      if (ok) score += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 7; r++) {
      let ok = true;
      for (let i = 0; i < 7; i++) if (at(r + i, c) !== pat[i]) { ok = false; break; }
      if (ok) score += 40;
    }
  }
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += at(r, c);
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function pickVersion(bytesLen) {
  for (let v = 1; v <= 10; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + bytesLen * 8 <= dataCapacityBytes(v) * 8) return v;
  }
  return 0;
}

// 指定掩码编码（测试/对拍用：与参考实现逐格比对）
function encodeWithMask(text, mask) {
  const bytes = Buffer.from(String(text), 'utf8');
  const ver = pickVersion(bytes.length);
  if (!ver) throw new Error('QR: 内容过长');
  const size = 17 + ver * 4;
  const codewords = buildCodewords(buildBitStream(text, ver), ver);
  const m = newMatrix(size);
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  placeAlignment(m, ver);
  placeTiming(m);
  placeVersion(m, ver);
  reserveInfoAreas(m, ver);
  const isData = placeData(m, codewords);
  for (const [r, c] of isData) if (MASKS[mask & 7](r, c)) m[r][c] ^= 1;
  placeFormat(m, mask & 7);
  return { size, modules: m, mask: mask & 7, version: ver };
}

function encodeMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const ver = pickVersion(bytes.length);
  if (!ver) throw new Error('QR: 内容过长（> ' + dataCapacityBytes(10) + ' 字节，实际 ' + bytes.length + '）');
  const size = 17 + ver * 4;
  const codewords = buildCodewords(buildBitStream(text, ver), ver);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = newMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, ver);
    placeTiming(m);
    placeVersion(m, ver);
    reserveInfoAreas(m, ver);
    const isData = placeData(m, codewords);
    for (const [r, c] of isData) if (MASKS[mask](r, c)) m[r][c] ^= 1;
    placeFormat(m, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, m, mask, ver };
  }
  return { size, modules: best.m, mask: best.mask, version: ver };
}

function toSvg(matrix, opts) {
  const o = opts || {};
  const quiet = o.quiet === undefined ? 4 : Number(o.quiet);
  const scale = Number(o.scale || 8);
  const dark = o.dark || '#0b1220';
  const light = o.light || '#ffffff';
  const n = matrix.size;
  const dim = (n + quiet * 2) * scale;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if ((matrix.modules[r][c] & 1) === 1) {
        path += 'M' + (c + quiet) * scale + ' ' + (r + quiet) * scale + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
      }
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">'
    + '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>'
    + '<path fill="' + dark + '" shape-rendering="crispEdges" d="' + path + '"/></svg>';
}

// data URL（Base64 编码的 SVG）：直接进 JSON，前端 <img src> 零路径依赖
// 【为什么用 base64】部分扫码 App（微信/支付宝）对 data:image/svg+xml;utf8, 的 SVG 兼容性略差，
// Base64 不需要 encodeURIComponent，避免 #/%23、&amp; 等转义导致某些扫码引擎解析异常。
function svgDataUrl(text, opts) {
  const svg = toSvg(encodeMatrix(text), opts);
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

// 测试用：输出 PGM 灰度图（本地用 OpenCV 解码验证，不参与线上逻辑）
function toPgm(text, scale) {
  const q = 4, s = Number(scale || 6);
  const matrix = encodeMatrix(text);
  const n = matrix.size, dim = (n + q * 2) * s;
  const buf = Buffer.alloc(dim * dim);
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const rr = r - q * s, cc = c - q * s;
      let v = 255;
      if (rr >= 0 && cc >= 0 && rr < n * s && cc < n * s) {
        v = (matrix.modules[Math.floor(rr / s)][Math.floor(cc / s)] & 1) ? 0 : 255;
      }
      buf[r * dim + c] = v;
    }
  }
  const header = Buffer.from('P5\n' + dim + ' ' + dim + '\n255\n', 'ascii');
  return Buffer.concat([header, buf]);
}

module.exports = { encodeMatrix, encodeWithMask, toSvg, svgDataUrl, toPgm, dataCapacityBytes };
