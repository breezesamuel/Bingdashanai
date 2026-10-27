// core/playbook.js — E2 冷启动 Playbook（FINAL-2.0 §2 落地：D1–D30 日级作战表）
// 假设起点：W6 末测试与快速问已可用，平台店铺已开，语料 ≥300 本、案例卡 ≥500 张。
// 全程人力：每日 ≤3 小时，内容全部复用器供料；冷启动期不投一分广告费。
// D30 Go/No-Go：注册 ≥300 且付费 ≥3 单 → 进 W10 回访上线；否则全停外部动作一周，
//   回修 D0 完读漏斗（留存先于增长铁律的日级应用）。
// 落库 db.playbook：{day, status: done|done-late|pending, at} 真实打卡，可复盘。

const store = require('./store');
const evidence = require('./evidence');

const PHASE = [
  { r: '第 1 周（D1–D7）种子 50 人', days: [
    { d: 1, task: '朋友圈/熟人招募"首批 50 位见证官"（送永久 6 次额度，条件：完成全周期 + 一句反馈）——杀熟是冷启动最快的真数据源', detail: '发出招募帖，记录 50 位见证官清单与发放额度' },
    { d: 2, task: '知乎高流量问题写长答（"该不该辞职"类，答案=真推演样例 + 出处展示，文末挂测试）第 1 篇', detail: '40 分钟/篇；答案用七段报告段2镜像 + 手册案例卡，全部带出处' },
    { d: 3, task: '知乎写长答第 2 篇', detail: '真推演样例 + 出处展示' },
    { d: 4, task: '知乎写长答第 3 篇', detail: '真推演样例 + 出处展示' },
    { d: 5, task: '小红书发"我把曾国藩家书做成了决策库"工程日志第 1 篇', detail: '复用器供料 + 人工 10 分钟打磨' },
    { d: 6, task: '反馈收集表回收；把种子用户拉进一个群（唯一一次建群，此后不再扩群——防社群变第二个工作）', detail: '设计反馈表：完成度 / 最有用处 / 一句话反馈' },
    { d: 7, task: '建群完成并发布群公告（限群用途：服务首批见证，不扩群）', detail: '发布"服务首批见证"边界说明' }
  ] },
  { r: '第 2 周（D8–D14）内容滚轮', days: [
    { d: 8, task: '发布"第一批用户的 10 个真实难题与同局先贤"脱敏合集（授权过的）', detail: '复用器 R2 + T1 灯角素材，全部已授权' },
    { d: 9, task: '每日一贴（复用器产出 + 人工 10 分钟打磨）：主题"被裁后第一个 72 小时"', detail: '手册 #1 素材' },
    { d: 10, task: '每日一贴：主题"负债上岸的第一步"', detail: '手册 #2 素材' },
    { d: 11, task: '每日一贴：主题"毕业即失业的空窗期"', detail: '手册 #3 素材' },
    { d: 12, task: '每日一贴：主题"35+ 求职被拒 20 次之后"', detail: '手册 #8 素材' },
    { d: 13, task: '每日一贴：主题"gap 一年不是废物" + 小红书包 B 计划：找 5 位心理学/职业咨询素人博主置换（互推免费额度，不付钱）', detail: 'B 计划清单 5 人 + 置换话术' },
    { d: 14, task: '第一周数据复盘：注册 / 完读 / 首付费三数入台账', detail: '三数写入 audit / 台账' }
  ] },
  { r: '第 3 周（D15–D21）付费验证', days: [
    { d: 15, task: '面包多/知识星球正式挂单（9.9 与 39.9 两档）', detail: '两档定价 + 48h 可退条款挂出' },
    { d: 16, task: '完成 ≥3 单为通过', detail: '不足 → 触发 FINAL-1.1 §7.0 重测一轮规则' },
    { d: 17, task: '继续促单（完成 ≥3 单为通过）', detail: '复用于 D2–D4 长答流量' },
    { d: 18, task: '付费验证截止：≥3 单判定', detail: '记入台账' },
    { d: 19, task: '快速问灰度放开至全部注册用户', detail: '卡库需 ≥500 张闸门' },
    { d: 20, task: '第一次"灯角"点亮测试（哪怕只有 1 个真故事）', detail: '用 peers.lighthouse 实测灯角点亮流程' },
    { d: 21, task: '周复盘：CAC 自然值基线记录（此后所有获客成本以此为参照）', detail: '记入 memory' }
  ] },
  { r: '第 4 周（D22–D30）放大与固化', days: [
    { d: 22, task: '把 D1–D21 表现最好的 3 条内容各做一个变体重发（复用器 E1 一料五吃）', detail: '变体来自 repurpose 产物' },
    { d: 23, task: '变体重发第 2 条', detail: '复制性能最好样式' },
    { d: 24, task: '变体重发第 3 条', detail: '复制性能最好样式' },
    { d: 25, task: '内容效果复查：哪条自然流量最稳，为 D26 里程碑帖攒素材', detail: '记录 TOP 数据' },
    { d: 26, task: '里程碑帖："上线 30 天：N 人推演、M 人迈出了第一步、0 条编造引用"（诚实数字=内容本身）', detail: '数据公开姿态从第一天开始' },
    { d: 27, task: '见证官访谈 5 人（录音授权，喂 T1 素材井）', detail: '授权 + 脱敏 + 写入 peers 素材井' },
    { d: 28, task: '见证官访谈整理入库', detail: '写入 T1/T2 素材台账' },
    { d: 29, task: '月数据入周资产表首月版', detail: '资产六问首月填报' },
    { d: 30, task: 'Go/No-Go 门：注册 ≥300 且付费 ≥3 单 → 进 W10 回访上线；否则全停外部动作一周，回修 D0 完读漏斗', detail: '留存在于增长铁律的日级应用' }
  ] }
];

const TOTAL = 30;

// 全部日任务（展平）
function allDays() {
  return PHASE.reduce((a, p) => a.concat(p.days), []);
}

// 打卡某天完成（done / done-late）
function checkDay(d, late) {
  const day = Number(d);
  if (!(day >= 1 && day <= TOTAL)) throw new Error('D 必须 1–30');
  const cur = store.read();
  if (!cur.playbook) cur.playbook = [];
  const exist = cur.playbook.find(x => x.day === day);
  if (exist) {
    exist.status = late ? 'done-late' : 'done';
    exist.at = Date.now();
  } else {
    cur.playbook.push({ day, status: late ? 'done-late' : 'done', at: Date.now() });
  }
  if (!cur.audit) cur.audit = [];
  cur.audit.push({ id: store.uid(), action: 'Playbook 打卡', detail: 'D' + day + (late ? '（补打）' : ''), at: Date.now() });
  store.write(cur);
  return { day, status: late ? 'done-late' : 'done' };
}

// 回执：今天该做什么（date→day）
function today(now) {
  const start = playbookStart(now);
  if (!start) return null;
  const d = start.day !== undefined ? start.day : start.d;
  const out = { day: d, label: String(d), task: start.task, detail: start.detail };
  // 附证据分级：这条要花多少、影响多大、凭什么信
  const ev = typeof d === 'number' ? evidence.of(d) : null;
  if (ev) {
    out.cost = evidence.COST[ev.c] ? evidence.COST[ev.c].label : ev.c;
    out.impact = ev.imp;
    out.evidence = ev.ev;
    out.evidenceDesc = evidence.GRADE[ev.ev] ? evidence.GRADE[ev.ev].desc : '';
    out.metric = ev.m;
    out.roi = evidence.roi(d);
  }
  return out;
}

function playbookStart(now) {
  const dbStart = store.read().playbookStartedAt;
  const t = now || Date.now();
  const startMs = dbStart || t;
  const d = Math.floor((t - startMs) / 86400000) + 1;
  if (d < 1) return null;
  if (d > TOTAL) return { day: 'D' + TOTAL + '+', task: '冷启动期已结束——进入日常运营，回写 D30 复盘', detail: '超时' };
  return allDays()[d - 1];
}

// D30 门评估：注册/deep使用/付费三数 + Go/No-Go
//
// 纪律：台账若与系统实测口径冲突，必须显式暴露，不能静默采信任何一方。
// 已付一律以「已结算实收」为准 —— 挂账未到账不算付费，台账也不能凭空把成交记成已付。
function gate() {
  const db = store.read();
  const ledgerReg = db.coldstart ? Number(db.coldstart.reg || 0) : null;
  const ledgerPaid = db.coldstart ? Number(db.coldstart.paid || 0) : null;
  const estReg = estimateReg();
  const estPaid = estimatePaid();
  // 付费只认实测：成交未到账不计入，台账高报会被压下去并记账为冲突
  const paid = estPaid;
  const reg = ledgerReg === null ? estReg : ledgerReg;

  const conflicts = [];
  if (ledgerPaid !== null && ledgerPaid !== estPaid) {
    conflicts.push('付费数：台账 ' + ledgerPaid + ' ≠ 实测已结算实收 ' + estPaid
      + '（按纪律以实测为准；挂账未到账不计为已付）');
  }
  if (ledgerReg !== null && ledgerReg < estReg) {
    conflicts.push('注册数：台账 ' + ledgerReg + ' < 实测数据量 ' + estReg + '（台账偏低，以台账为准但请复核）');
  }

  const go = reg >= 300 && paid >= 3;
  const note = go ? 'GO：注册 ≥300 且付费 ≥3 单 → 进 W10 回访上线' : 'NO-GO：全停外部动作一周，回修 D0 完读漏斗（留存先于增长）';
  return {
    day: 30, reg, paid, go, note, decidedAt: Date.now(),
    ledger: ledgerReg === null ? null : { reg: ledgerReg, paid: ledgerPaid },
    measured: { reg: estReg, paid: estPaid },
    conflicts,
    sources: ledgerReg === null ? '估算（无台账时以注册/付费近似）' : '付费=实测已结算实收；注册=台账'
  };
}

// 真实可算：无台账时，用现有数据量近似注册与付费（尽力而为，标注"估算"）
function estimateReg() { const db = store.read(); return Math.max((db.persona || []).length, (db.decisions || []).length, (db.peers || []).length); }
// 只数已结算实收（成交未到账不算已付）
function estimatePaid() { const m = require('./money'); const db = store.read(); const byId = new Map((db.orders || []).map(o => [String(o.id), o])); return (db.revenue || []).filter(x => m.isSettled(x) && !m.isSelfTest(x, byId) && Number(x.amt || x.amount || 0) > 0).length; }

// 进度看板
function board() {
  const cur = store.read();
  const pb = cur.playbook || [];
  const done = pb.filter(x => x.status !== 'pending').length;
  const late = pb.filter(x => x.status === 'done-late').length;
  const now = Date.now();
  const dayOf = playbookStart(now);
  const doneDays = pb.filter(x => x.status !== 'pending').map(x => x.day);
  const allD = allDays().map(x => (x.day !== undefined ? x.day : x.d));
  return {
    total: TOTAL, done, late, remaining: TOTAL - done,
    startedAt: cur.playbookStartedAt || null,
    current: dayOf ? (dayOf.day === 'D30+' ? { day: 'D30+', title: dayOf.task } : { day: 'D' + String(dayOf.day !== undefined ? dayOf.day : dayOf.d), title: dayOf.task, detail: dayOf.detail }) : { day: '—', title: '未启动' },
    gate: gate(),
    phase: PHASE.map(p => ({ round: p.r, done: p.days.filter(x => pb.some(y => y.day === x.d)).length, total: p.days.length })),
    evidence: evidence.summary(allD),
    honesty: evidence.honestyCheck(allD, doneDays)
  };
}

// 诚实三数（D14 的产物）：把「可实测」「需人工」「仅估算」三类严格分开
// 目的是让人无法用估算值冒充实测值去做 D30 决策
function honestCounts() {
  const db = store.read();
  const measuredPaid = estimatePaid();
  const measuredReg = estimateReg();
  const ledger = db.coldstart || null;
  const rev = db.revenue || [];
  const pendingCnt = rev.filter(x => !require('./money').isSettled(x)).length;
  const pendingAmt = rev.filter(x => !require('./money').isSettled(x))
    .reduce((a, x) => a + Number(x.amt || x.amount || 0), 0);
  const g = gate();
  return {
    measured: {
      label: '系统可实测（唯一可信口径）',
      reg: measuredReg,
      paid: measuredPaid,
      note: '注册取库内数据量下界；付费仅计已结算实收'
    },
    pending: {
      label: '已成交但未到账（不得计为付费）',
      count: pendingCnt,
      amount: pendingAmt,
      note: '需收齐回单后走 /v1/money/settle 才会转入 paid'
    },
    ledger: ledger ? {
      label: '台账手填（无系统凭据）',
      reg: ledger.reg !== undefined ? Number(ledger.reg) : null,
      paid: ledger.paid !== undefined ? Number(ledger.paid) : null
    } : null,
    gate: { go: g.go, reg: g.reg, paid: g.paid, conflicts: g.conflicts },
    honestAnswer: g.conflicts.length
      ? '台账与实测冲突，D30 判定已改用实测口径：' + g.conflicts[0]
      : '台账与实测一致，判定可信'
  };
}

// 按性价比排序的冷启动打法（不按阶段顺序——零成本高收益排最前）
function ranked(days) {
  return evidence.ranked(days || allDays().map(x => (x.day !== undefined ? x.day : x.d)));
}

// 启动（playbook 起点：传 D1 上线日的毫秒，默认今日）
function launch(ms) {
  const cur = store.read();
  cur.playbookStartedAt = ms || Date.now();
  if (!cur.coldstart) cur.coldstart = {};
  if (!cur.audit) cur.audit = [];
  cur.audit.push({ id: store.uid(), action: '冷启动 Playbook 启动', detail: 'D1 = ' + new Date(cur.playbookStartedAt).toISOString().slice(0, 10), at: Date.now() });
  store.write(cur);
  return { startedAt: cur.playbookStartedAt, d1: new Date(cur.playbookStartedAt).toISOString().slice(0, 10) };
}

// 台账：注册/付费人工录入（D30 门的数据源）
// 录入时即时校验：手填的付费数若高于系统实测的已结算实收，说明把「成交」当成了「已收」，
// 这类高报必须当场标记出来，否则会一路污染 D30 判定。
function tally(body) {
  const cur = store.read();
  if (!cur.coldstart) cur.coldstart = {};
  const warnings = [];
  if (body.reg !== undefined) cur.coldstart.reg = Number(body.reg) || 0;
  if (body.paid !== undefined) {
    const p = Number(body.paid) || 0;
    cur.coldstart.paid = p;
    const measured = estimatePaid();
    if (p > measured) {
      warnings.push('手填付费 ' + p + ' 高于系统实测已结算实收 ' + measured
        + '：差额 ' + (p - measured) + ' 笔应为挂账未到账，不应计为已付（已记入审计）');
    }
  }
  if (!cur.audit) cur.audit = [];
  cur.audit.push({
    id: store.uid(), action: '冷启动台账录入', at: Date.now(),
    detail: JSON.stringify(body),
    warnings: warnings.length ? warnings : undefined
  });
  store.write(cur);
  return Object.assign({ warnings }, cur.coldstart);
}

module.exports = { PHASE, TOTAL, allDays, checkDay, today, gate, board, launch, tally, estimateReg, estimatePaid, ranked, honestCounts };