#!/usr/bin/env node
// scripts/evidence-capture.js — 人工录入一条真实对话为证据
//
// 用法：
//   node scripts/evidence-capture.js --sourceType=email --channel=邮件 --quote="客户原话>=8字" --name=某团队
//
// 铁律：quote 必须是真实发生的逐字原话，>=8 字。绝不编造。
// 录入后默认「待确认」，用 scripts/evidence-confirm.js <id> 确认后才计入门禁。

const pipe = require('../core/evidence-pipeline');

function arg(name) {
  const m = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return m ? m.slice(name.length + 3) : null;
}

function main() {
  const sourceType = arg('sourceType');
  const channel = arg('channel') || 'unknown';
  const quote = arg('quote');
  const name = arg('name') || null;
  const note = arg('note') || null;

  if (!sourceType || !quote) {
    console.error('用法: node scripts/evidence-capture.js --sourceType=email --channel=邮件 --quote="客户原话>=8字" [--name=某团队]');
    console.error('');
    console.error('sourceType 可选: chat/dm/email/post/issue/order/payment/review/ticket/comment/conversation/survey/interview ...');
    process.exit(1);
  }

  const r = pipe.captureManual({ sourceType, channel, quote, name, note });
  if (!r.ok) {
    console.error('[FAIL]', r.error);
    process.exit(1);
  }
  console.log('[OK] 证据已录入（待确认）');
  console.log('  id:', r.evidence.id);
  console.log('  sourceType:', r.evidence.sourceType);
  console.log('  channel:', r.evidence.channel);
  console.log('  tags:', (r.evidence.tags || []).join(',') || '(无)');
  console.log('  quote:', r.evidence.quote.slice(0, 80));
  console.log('');
  console.log('确认后计入门禁: node scripts/evidence-confirm.js ' + r.evidence.id);
}

main();
