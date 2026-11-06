// QR code region cropper — parses REAL image dimensions, returns crop box
//
// 【去假化 2026-11-06】旧版 left/top=100 占位 + width/height=0（不解析图片）。
// 现在真实解析 PNG/JPEG/GIF/BMP/WebP 头部得宽高，再按 0.8 系数算居中裁剪框；
// 解析不了就如实报 dimensions_unavailable，不脑补坐标。
const fs = require('fs');

const QR_CORNER_RATIO = 0.8; // QR 码通常占卡片约 80%

// 真实解析图片头部得 {width,height,format}；失败返回 null（不造假）
function readImageDims(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { format: 'bmp', width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xFF) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xD8 || marker === 0xD9) { off += 2; continue; }
      if (marker === 0xC0 || marker === 0xC2) {
        return { format: 'jpeg', width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
      }
      const segLen = buf.readUInt16BE(off + 2);
      off += 2 + segLen;
    }
    return { format: 'jpeg', width: 0, height: 0 };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') return { format: 'webp', width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    if (fourcc === 'VP8L') {
      const b22 = buf[22], b23 = buf[23], b24 = buf[24], b25 = buf[25];
      const x0 = b22 | (b23 << 8);
      const y0 = (b23 >> 6) | (b24 << 2) | (b25 << 10);
      return { format: 'webp', width: (x0 & 0x3fff) + 1, height: (y0 & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8 ') return { format: 'webp', width: buf.readUInt16LE(26), height: buf.readUInt16LE(28) };
  }
  return null;
}

async function cropQR(inputPath, outputPath) {
  const buf = fs.readFileSync(inputPath);
  const dims = readImageDims(buf);
  if (!dims || !dims.width || !dims.height) {
    return { ok: false, reason: 'dimensions_unavailable', format: dims ? dims.format : 'unknown', note: '无法解析图片尺寸（格式不支持或文件损坏）；不脑补坐标。' };
  }
  const qrSize = Math.round(Math.min(dims.width, dims.height) * QR_CORNER_RATIO);
  const left = Math.round((dims.width - qrSize) / 2);
  const top = Math.round((dims.height - qrSize) / 2);
  return {
    ok: true,
    sourceWidth: dims.width, sourceHeight: dims.height, format: dims.format,
    cropLeft: left, cropTop: top, cropWidth: qrSize, cropHeight: qrSize,
    outputPath: outputPath || null,
    note: '真实解析 ' + dims.format + ' 头部 ' + dims.width + 'x' + dims.height + '；裁剪框按 0.8 系数居中。实际像素裁剪需 sharp（未装则只给真实坐标）。'
  };
}

module.exports = { cropQR, readImageDims };
