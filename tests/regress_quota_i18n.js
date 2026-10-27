// regress_quota_i18n.js — 额度链路本地化泄漏回归（2026-10-23）
//
// 背景：quotaDailyDone/quotaDailyHint 的键名泄漏修好后，同一链路上还有三类
// 「语言混杂」缺陷，英文/阿文客户仍会看到中文：
//   E. biz.js 的 I18N（墙标题/网络提示）缺 ar 键 → 阿文界面回落中文
//   F. quotaToast 里「」与「、」与（每项额度已用完）是硬编码中文标点/句子
//   G. 额度表把分区名、套餐名、/日、note、maturityNote 直接渲染中文
//
// 本回归同时检查服务端三语映射与前端取值路径。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};

const biz = fs.readFileSync(path.join(ROOT, 'web', 'biz.js'), 'utf8');
const pw = require(path.join(ROOT, 'core', 'paywall.js'));

// ===== E. I18N 三语齐全（含 ar）=====
const i18nStart = biz.indexOf('const I18N = {');
const i18nEnd = biz.indexOf('const T = ');
const I18N_SRC = biz.slice(i18nStart, i18nEnd);
ok(I18N_SRC.includes('zh: {'), 'I18N 有 zh');
ok(I18N_SRC.includes('en: {'), 'I18N 有 en');
ok(I18N_SRC.includes('ar: {'), 'I18N 有 ar（此前缺失 → 阿文回落中文）');
for (const k of ['wallT', 'wallM', 'netShort', 'wallHint', 'quotaDailyDone', 'quotaDailyHint', 'quotaFreeHead', 'quotaHeavyTag', 'quotaUnlimitedTag', 'quotaTrialTag']) {
  const n = (I18N_SRC.match(new RegExp(k + ':', 'g')) || []).length;
  ok(n >= 3, `I18N 三语包含 ${k}`, `出现 ${n} 次（需 ≥3）`);
}

// ===== F. toast 不再硬编码中文标点/句子 =====
const toastSrc = biz.slice(biz.indexOf('function quotaToast'), biz.indexOf('window.fetch = async (input, init)'));
ok(!/「'/.test(toastSrc) || toastSrc.includes("PTf('quotaSecQuote'"), 'toast 的「」改为 PTf 模板');
ok(toastSrc.includes("PT('quotaEachUsedUp')"), '多分区提示改为 PT(quotaEachUsedUp)');
ok(!toastSrc.includes("'（每项额度已用完）'"), '硬编码「（每项额度已用完）」已移除');
ok(!toastSrc.includes("join('、')"), "硬编码顿号 join 已移除");
ok(toastSrc.includes("join(PT('quotaSecJoin'))"), '分区连接符走 PT(quotaSecJoin)');
// 单分区用量括号用半角（跨语言通用）
ok(/body = secs\.length === 1[\s\S]{0,120}\(' \+ pend/.test(toastSrc), '单分区用量用半角括号');

// ===== G1. 服务端三语映射 =====
const qi = pw.quotaInfo();
ok(Array.isArray(qi.free) && qi.free.length === 11, 'quotaInfo.free 11 条');
qi.free.forEach(f => {
  ok(f.labelI18n && f.labelI18n.zh && f.labelI18n.en && f.labelI18n.ar, `free[${f.key}].labelI18n 三语齐全`, JSON.stringify(f.labelI18n));
  ok(f.descI18n && f.descI18n.zh && f.descI18n.en && f.descI18n.ar, `free[${f.key}].descI18n 三语齐全`);
});
(qi.tiers || []).forEach(t => {
  ok(t.labelI18n && t.labelI18n.zh && t.labelI18n.en, `tier[${t.id}].labelI18n 有 zh/en`, JSON.stringify(t.labelI18n));
  ok(!/[\u4e00-\u9fa5]/.test(t.labelI18n.en), `tier[${t.id}] 英文名不含中文`, t.labelI18n.en);
});
ok(qi.noteI18n && qi.noteI18n.en && qi.maturityNoteI18n && qi.maturityNoteI18n.en, 'note/maturityNote 有三语映射');
ok(!/[\u4e00-\u9fa5]/.test(qi.noteI18n.en), 'noteI18n.en 不含中文', qi.noteI18n.en.slice(0, 40));
ok(!/[\u4e00-\u9fa5]/.test(qi.maturityNoteI18n.en), 'maturityNoteI18n.en 不含中文');

// ===== G2. 前端取值路径 =====
ok(biz.includes('labelI18n'), '前端读取 labelI18n');
ok(biz.includes('descI18n'), '前端读取 descI18n');
ok(biz.includes('noteI18n'), '前端读取 noteI18n');
ok(biz.includes('maturityNoteI18n'), '前端读取 maturityNoteI18n');
ok(biz.includes("PT('quotaPerDay')"), '每日单位走 PT(quotaPerDay)');
ok(!biz.includes("f.perDay + '/日'"), '硬编码 /日 已移除');
ok(!/<td>' \+ esc\(t\.label\)/.test(biz), '套餐名不再直接渲染中文 label');
ok(!biz.includes("'</b>：'"), '蓝图表单冒号不再硬编码全角中文冒号');
// Blueprint 正文仅中文原文：非中文界面必须收起正文，避免"英文标签 + 中文长段落"
ok(biz.includes('bpTextAvailable'), 'Blueprint 正文按语言门控');
ok(biz.includes("PT('bpZhOnly')"), '非中文界面给出诚实说明（bpZhOnly）');

// ===== 三语 quota 新增键都在 PL =====
const plIdx = biz.indexOf('const PL = {');
const ptIdx = biz.indexOf('const PT =');
const PL_SRC = biz.slice(plIdx, ptIdx);
for (const k of ['quotaPerDay', 'quotaEachUsedUp', 'quotaSecQuote', 'quotaSecJoin']) {
  const n = (PL_SRC.match(new RegExp(k + ':', 'g')) || []).length;
  ok(n >= 3, `PL 三语包含 ${k}`, `出现 ${n} 次（需 ≥3）`);
}

// ===== H. 全局键名完整性：任何 PT('key') 必须在 zh/en/ar 三语都存在 =====
// 这是从 quotaDailyDone 事故里提炼出的**第一道防线**：
// 以后新增任何文案键，只要漏了某一语，这个测试立刻失败 —— 而不是等客户
// 在界面上看到 "quotaDailyDone" 这种键名。
const PL_REGION = biz.slice(plIdx, ptIdx);
const blockOf = (lang) => {
  const start = PL_REGION.indexOf('\n    ' + lang + ': {');
  if (start < 0) return '';
  const nexts = ['zh', 'en', 'ar']
    .map(l => PL_REGION.indexOf('\n    ' + l + ': {', start + 5))
    .filter(i => i > start);
  const end = nexts.length ? Math.min.apply(null, nexts) : PL_REGION.length;
  return PL_REGION.slice(start, end);
};
const keysOf = (src) => {
  const out = new Set();
  // 值的引号可能是单引号也可能是双引号（英文文案里含撇号 "Today's" 时常写双引号），
  // 第一版只认单引号 → 漏判 quotaDailyDone 为"缺失"（误报）。两种都收。
  const re = /(?:^|[\s,{])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*['"]/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
};
const K = { zh: keysOf(blockOf('zh')), en: keysOf(blockOf('en')), ar: keysOf(blockOf('ar')) };
ok(K.zh.size > 50 && K.en.size > 50 && K.ar.size > 50,
  '三语词典解析成功', `zh=${K.zh.size} en=${K.en.size} ar=${K.ar.size}`);

// 收集所有静态调用点：PT('x') / PTf('x', ...)
const used = new Set();
const useRe = /\bPTf?\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g;
let mu;
while ((mu = useRe.exec(biz))) used.add(mu[1]);
ok(used.size > 30, '扫描到足够多的 PT 调用点', 'count=' + used.size);

const missing = { zh: [], en: [], ar: [] };
used.forEach(k => {
  ['zh', 'en', 'ar'].forEach(l => { if (!K[l].has(k)) missing[l].push(k); });
});
['zh', 'en', 'ar'].forEach(l => {
  ok(missing[l].length === 0, `所有 PT 键在 ${l} 中都存在（防键名泄漏）`, missing[l].join(', '));
});
// 反向：zh 有而 en/ar 没有（新增文案只补中文的常见事故）
const onlyZh = [...K.zh].filter(k => !K.en.has(k) || !K.ar.has(k));
ok(onlyZh.length === 0, '中文新增的键都已同步到 en/ar', onlyZh.join(', '));

console.log('pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
