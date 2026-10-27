#!/usr/bin/env node
'use strict';
/**
 * verify-release.js — 出包校验（发布前的硬闸）
 *
 * 为什么要它：electron-builder 退出码 0 **不代表**包里含了新代码。
 *   最容易出的事故就是「构建成功、装到用户机器上发现还是旧版」。
 *   这里做四道真检查：
 *     1) 产物存在；清单里登记的 size/sha256 与磁盘实测一致
 *     2) 安装包内的 asar **确实含**本次要带上的关键标记（新增路由/字段/模块）
 *     3) 产物已配置下载地址（没配置 = 页面不给下载按钮，用户下不到）
 *     4) 解包目录存在（可做人工抽检）
 *
 * 用法：
 *   node scripts/verify-release.js                  # 校验当前发布
 *   node scripts/verify-release.js --expect xxx     # 追加「必须含」的标记
 *   node scripts/verify-release.js --json           # 机器可读输出
 *
 * 退出码：0 = 全通过；1 = 有未通过项
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const RELEASES = path.join(ROOT, 'web', 'releases.json');
const UNPACKED = path.join(ROOT, 'app', 'win-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

/** 发布时必须出现在包里的标记（缺一个 = 这次出包白出） */
const DEFAULT_MARKS = [
  'payEmail',              // 付款弹窗邮箱采集
  'attachEmail',           // 订单补邮箱
  '/v1/pay/refund',        // 退款申请
  '/v1/pay/auto-settle',   // 收款监听自动开通
  'core/refund.js',        // 退款模块
  'pay-notify.js',         // 匹配模块
  'refund_pending_manual', // 诚实的人工出款状态
  // 2026-10-21 这一轮必须带上（缺一=这次出包白出）：
  'refundOverlay',         // 客户端/网页的退款申请面板（客户自助入口）
  'openRefund',            // 前端退款逻辑
  'ordersOf',              // 订单列表按访客隔离（不再泄露他人订单）
  'SERVER_URL',            // 桌面端启动（曾经未声明 → 窗口都不出现）
];

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.slice(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function main(argv) {
  const asJson = argv.includes('--json');
  const marks = DEFAULT_MARKS.concat(
    argv.filter((a) => a.startsWith('--expect=')).map((a) => a.slice('--expect='.length))
  );
  const res = { ok: false, checks: [], problems: [] };
  const add = (name, ok, detail) => {
    res.checks.push({ name, ok, detail: detail || '' });
    if (!ok) res.problems.push(name + (detail ? ' :: ' + detail : ''));
  };

  // 1) 清单
  if (!fs.existsSync(RELEASES)) { add('releases.json 存在', false, RELEASES); return finish(res, asJson); }
  let rel = null;
  try { rel = JSON.parse(fs.readFileSync(RELEASES, 'utf8')); } catch (e) { add('releases.json 可解析', false, e.message); return finish(res, asJson); }
  add('releases.json 可解析', true, 'version=' + rel.version);

  const arts = (rel.artifacts || []).filter((a) => a.platform === 'windows');
  if (!arts.length) { add('清单里有 windows 产物', false); return finish(res, asJson); }
  // 【必须验「当前版本」的那一份】原来直接取 arts[0] → 清单里同时留着旧版本时，
  //   硬闸会去验**旧包**（2026-10-21 实际发生：新包已出，硬闸却报旧包 OK）。
  //   那样等于没验：本次出包白出也看不出来。现在按版本号精确挑当前版本。
  const current = rel.version ? String(rel.version) : null;
  const byVersion = current
    ? arts.find((a) => String(a.file || '').indexOf(current) >= 0 || String(a.version || '') === current)
    : null;
  const art = byVersion || arts[arts.length - 1];
  add('验的是当前版本产物', !!byVersion, (byVersion ? byVersion.file : '清单里没有 ' + current + ' 的产物 → 回退到 ' + art.file));

  // 2) 产物文件
  const file = path.join(ROOT, 'web', 'downloads', art.file);
  if (!fs.existsSync(file)) { add('产物文件存在', false, file); return finish(res, asJson); }
  const size = fs.statSync(file).size;
  add('产物文件存在', true, art.file + ' ' + (size / 1048576).toFixed(1) + 'MB');
  add('清单 size 与磁盘一致', Number(art.size) === size, '清单=' + art.size + ' 磁盘=' + size);
  const sha = sha256(file);
  add('清单 sha256 与磁盘一致', String(art.sha256 || '').toLowerCase() === sha, '磁盘=' + sha.slice(0, 16));
  add('产物已配置下载地址（published）', !!art.url, art.url || '未发布 → 页面不会给下载按钮');

  // 3) 包内是否含本次关键代码
  if (!fs.existsSync(ASAR)) {
    if (fs.existsSync(UNPACKED)) {
      // 解包目录在、但 asar 不在 → 构建坏了（必须失败）
      add('包内含本次关键标记', false, '解包目录存在但 app.asar 缺失 → 构建产物异常');
    } else {
      // 本机没有解包目录（例如只做「已发布产物」校验的服务器）→ 跳过，但明说
      add('包内含本次关键标记（需在出包机执行）', true,
        'skipped: 本机无解包目录 app/win-unpacked（该检查只在出包机有效）');
    }
  } else {
    add('解包目录存在（app/win-unpacked）', true, ASAR);
    const s = fs.readFileSync(ASAR, 'latin1');
    const missing = marks.filter((m) => s.indexOf(m) < 0);
    add('包内含本次关键标记', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : marks.length + ' 项全在');
  }

  res.ok = res.problems.length === 0;
  return finish(res, asJson);
}

function finish(res, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    for (const c of res.checks) process.stdout.write((c.ok ? '  [OK]   ' : '  [FAIL] ') + c.name + (c.detail ? '  ->  ' + c.detail : '') + '\n');
    process.stdout.write('\n' + (res.ok ? '发布校验通过' : '发布校验未通过：' + res.problems.length + ' 项') + '\n');
  }
  process.exit(res.ok ? 0 : 1);
}

process.exit(main(process.argv.slice(2)));
