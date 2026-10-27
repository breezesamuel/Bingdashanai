#!/usr/bin/env node
// scripts/evidence-status.js — 一键查看商业化证据现状（诚实版，0 就是 0）
const pipe = require('../core/evidence-pipeline');
const me = require('../core/market-evidence');

function main() {
  const s = pipe.status();
  console.log('=== 商业化证据现状 ===');
  console.log('总证据条数:', s.total, '| 已确认:', s.confirmed);
  console.log('');
  const dimW = Math.max(...s.dims.map(d => d.dim.length), 6);
  console.log('维度'.padEnd(dimW), '已确认'.padStart(6), '总计'.padStart(6), '状态');
  console.log('-'.repeat(dimW + 24));
  for (const d of s.dims) {
    console.log(
      d.dim.padEnd(dimW),
      String(d.confirmed).padStart(6),
      String(d.total).padStart(6),
      d.confirmed >= 1 ? 'OK' : '缺'
    );
  }
  console.log('');
  const g = me.gateCheck();
  console.log('商业化门禁:', g.pass ? 'PASS' : 'NO-GO（缺: ' + g.missing.join(', ') + '）');
  if (!g.pass) {
    console.log('');
    console.log('下一步：去 outreach 真实触达，收到客户回复后会自动沉淀为 evidence。');
    console.log('      或用 scripts/evidence-capture.js 人工录入真实对话（必须带原话）。');
  }
  if (s.list.length) {
    console.log('');
    console.log('=== 最近 5 条证据 ===');
    for (const e of s.list.slice(0, 5)) {
      const d = new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ');
      console.log(' -', d, '|', e.sourceType, '|', e.channel, '|', e.confirmed ? '已确认' : '待确认', '|', e.quote.slice(0, 60));
    }
  } else {
    console.log('');
    console.log('（当前无任何证据。这是诚实的起点，不是错误。）');
  }
}

main();
