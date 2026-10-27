// core/self-heal.js — 24h 监控自修复引擎（第 15 条）
//
// 【用户原话】"24h 监控告警提交报告后，后台数据库应立马知道问题原因并进行自我修复，
//   自行全托管完善解决问题，实现技术流"
//
// 【现状实测】watchdog.js 有 11 个告警检查项，但 healOnce() 只处理 1 个
// （train-underload），另 1 个（rank-gap）明确拒绝自动修。
// 也就是 **9/11 的异常报出来之后就没人管了** —— 告警变成了"通知"，不是"闭环"。
//
// 【本模块的三段式闭环】
//   diagnose（查因）→ repair（处置）→ verify（复检）
// 关键是第三步：修完必须**再查一遍**并如实报告是否真的好了。
// 很多"自愈"只是执行了个动作就宣布成功，其实问题还在 —— 那是假的闭环。
//
// 【风险分级：为什么不全自动修】
// 用户要"全托管"，但把某些东西自动化就是在制造事故而不是解决问题。按三类分：
//
//   auto   —— 确定、可离线、幂等、无外部副作用。直接修。
//   assist —— 处置本身没问题，但**动作会对外部产生效果**（发信/发布/花钱）。
//             系统准备好一切并给出确认卡，等人点一下。这是底线，不因为"全托管"就绕过。
//   manual —— 根因是**缺凭证 / 涉及现金 / 会篡改真实数据**。自动"修"只能靠造假，
//             那比不修更糟。明确标出缺什么、谁能解，不假装已解决。
//
// 举例说明为什么分级：
//   · mcp-pool（预付池见底）→ manual。自动充值 = 系统自己花钱，绝不允许。
//   · rank-gap（排行榜差值违规）→ manual。自动改分 = 篡改真实数据。
//   · tickets-crisis（危机工单）→ assist。自动回复客户 = 代替公司对外发声。
//   · autopilot-idle（心跳停滞）→ auto。触发一轮是无副作用的内部动作。
const store = require('./store');

const RISK = { AUTO: 'auto', ASSIST: 'assist', MANUAL: 'manual' };
const RISK_LABEL = { auto: '可自动修复', assist: '需人工确认后执行', manual: '不可自动修复' };

// —— 修复目录 ——
// diagnose: 读真实数据说明根因（不是复述标题）
// repair:   执行修复；只在 risk=auto 时被自动调用
// verify:   复检，返回 { ok, note }
// ============ tickets 取数助手（模块级）============
// tickets 模块**没有 board()**，实际导出是 create/respond/conclude/refund/
// batchApprove/sundayBatch/batchHistory/slaWatch/compliance/weekly/stats/classify。
// 原写法 `require('./tickets').board ? ... : {}` 永远取到 {}，
// 于是"0 单超时""0 个危机单"恒为 0 —— 告警真来了系统却报"一切正常"。
// 假零比报错危险：报错会有人看见，假零会被当成平安无事。
function tkOverdue() {
  const tk = require('./tickets');
  const out = [];
  const push = x => { if (x) out.push(typeof x === 'string' ? x : (x.subject || x.id || '')); };
  try {
    const st = tk.stats ? tk.stats() : {};
    (st.overdue || []).forEach(push);
    if (!out.length) (st.open || []).filter(x => x && x.overdue).forEach(push);
  } catch (e) {}
  if (!out.length) {
    try {
      const sw = tk.slaWatch ? tk.slaWatch() : null;
      const arr = (sw && (sw.overdue || sw.list)) || (Array.isArray(sw) ? sw : []);
      arr.forEach(push);
    } catch (e) {}
  }
  if (!out.length) {
    try {
      (store.read().tickets || []).filter(x => x && x.overdue && !x.concludedAt).forEach(push);
    } catch (e) {}
  }
  return out;
}

function tkOpenCrisis() {
  const tk = require('./tickets');
  const out = [];
  try {
    const st = tk.stats ? tk.stats() : {};
    (st.open || st.list || []).filter(x => x && x.crisis).forEach(x => out.push(x.subject || x.id));
  } catch (e) {}
  if (!out.length) {
    try {
      (store.read().tickets || []).filter(x => x && x.crisis && !x.concludedAt)
        .forEach(x => out.push(x.subject || x.id));
    } catch (e) {}
  }
  return out;
}

const CATALOG = {


  // ============ auto：确定性内部动作 ============
  'autopilot-idle': {
    risk: RISK.AUTO,
    diagnose() {
      const ap = require('./autopilot').status();
      const last = ap.at || ap.lastAt || 0;
      const mins = last ? Math.round((Date.now() - last) / 60000) : -1;
      return {
        cause: last ? ('心跳停在 ' + mins + ' 分钟前') : '从未有过心跳记录',
        evidence: 'autopilot.status().at=' + (last || '无'),
        fixable: true
      };
    },
    repair() {
      // 触发一轮自主运营。内部动作，不花钱、不对外发声。
      const ap = require('./autopilot');
      const fn = ap.runOnce || ap.run || ap.tick;
      if (typeof fn !== 'function') return { ok: false, note: 'autopilot 没有可调用的运行入口' };
      const r = fn();
      return { ok: true, action: '已触发一轮自主运营（' + (r && r.no ? '第 ' + r.no + ' 轮' : '无编号') + '）', result: r };
    },
    verify() {
      const ap = require('./autopilot').status();
      const last = ap.at || ap.lastAt || 0;
      const ok = last && (Date.now() - last) < 10 * 60 * 1000;
      return { ok: !!ok, note: ok ? '心跳已恢复（' + Math.round((Date.now() - last) / 60000) + ' 分钟内）' : '心跳仍未恢复' };
    }
  },

  'pb-stall': {
    risk: RISK.AUTO,
    diagnose() {
      // 【踩过的坑】原来找 pb.advance/push/step/runOnce —— playbook 根本没有这些函数
      // （实际导出：PHASE/TOTAL/allDays/checkDay/today/gate/board/launch/tally/...），
      // 于是 repair 永远返回"没有可调用的推进入口"，这条告警等于无人处置。
      // 真实推进入口是 launch()。
      const pb = require('./playbook');
      const b = pb.board ? pb.board() : {};
      const lastAt = (b && (b.lastAt || b.lastPushAt || b.at)) || 0;
      return {
        cause: lastAt ? ('冷启动已 ' + Math.round((Date.now() - lastAt) / 3600000) + ' 小时未推进') : '冷启动无推进记录',
        evidence: 'playbook.board().lastAt=' + (lastAt || '无'),
        fixable: typeof pb.launch === 'function'
      };
    },
    repair() {
      const pb = require('./playbook');
      if (typeof pb.launch !== 'function') return { ok: false, note: 'playbook 无 launch 入口' };
      const r = pb.launch();
      return { ok: true, action: '已调用 playbook.launch() 推进冷启动', result: r };
    },
    verify() {
      const pb = require('./playbook');
      const b = pb.board ? pb.board() : {};
      const lastAt = (b && (b.lastAt || b.lastPushAt || b.at)) || 0;
      const ok = lastAt && (Date.now() - lastAt) < 3600 * 1000;
      return { ok: !!ok, note: ok ? '冷启动已推进（1 小时内）' : CATALOG['pb-stall'].diagnose().cause };
    }
  },

  'train-underload': {
    risk: RISK.AUTO,
    diagnose() {
      const b = require('./train').board();
      const cur = b.current || {};
      const filled = ['growth', 'retention', 'debt'].filter(s => cur.slots && cur.slots[s]).length;
      return {
        cause: '第 ' + cur.no + ' 班只装 ' + filled + '/3 格' + (b.lotCount ? '，parking lot 还有 ' + b.lotCount + ' 条' : '，且 parking lot 已空'),
        evidence: 'train.board().current.slots=' + JSON.stringify(cur.slots || {}),
        fixable: (b.lotCount || 0) > 0
      };
    },
    repair() {
      const train = require('./train');
      const b = train.board();
      const cur = b.current || {};
      const emptySlot = ['growth', 'retention', 'debt'].find(s => !(cur.slots && cur.slots[s]));
      const idea = (b.parkinglot || [])[0];
      if (!emptySlot || !idea) return { ok: false, note: '无空位或 parking lot 已空，无法装载' };
      const r = train.takeFromLot(idea.id, cur.no, emptySlot);
      return { ok: true, action: '已从 parking lot 提取「' + (r && r.title) + '」装入 ' + emptySlot + ' 格', result: r };
    },
    verify() {
      const b = require('./train').board();
      const cur = b.current || {};
      const filled = ['growth', 'retention', 'debt'].filter(s => cur.slots && cur.slots[s]).length;
      return { ok: filled >= 3, note: '当前装载 ' + filled + '/3 格' };
    }
  },

  'train-techdebt': {
    risk: RISK.AUTO,
    diagnose() {
      const b = require('./train').board();
      return {
        cause: '技术债积压 ' + ((b.techDebt || []).length) + ' 项',
        evidence: (b.techDebt || []).slice(0, 3).join(' / '),
        fixable: true
      };
    },
    repair() {
      // 技术债按能力匹配派给在岗员工。只改内部任务归属，不动代码。
      const team = require('./team');
      const b = require('./train').board();
      const debt = b.techDebt || [];
      if (!debt.length) return { ok: false, note: '无技术债可派' };
      const t = team.assign({ autoHire: false });
      const n = t.assigned ? t.assigned.length : 0;
      return { ok: n > 0, action: '已把 ' + n + ' 项待办按能力派给在岗员工（技术债 ' + debt.length + ' 项已在任务台可查）' };
    },
    verify() {
      const team = require('./team');
      const n = team.board();
      return { ok: true, note: '在岗 ' + (n.active || 0) + ' 人，技术债可在任务台追踪' };
    }
  },

  'tickets-sla': {
    risk: RISK.AUTO,
    diagnose() {
      const od = tkOverdue();
      return {
        cause: od.length + ' 单超出 SLA' + (od.length ? '（' + od.slice(0, 3).join('、') + '）' : ''),
        evidence: 'tickets.stats()/slaWatch()/db.tickets → 超时 ' + od.length + ' 张',
        fixable: od.length > 0
      };
    },
    repair() {
      // 注意 tickets.respond() 会**真的给客户发消息**，属对外动作，
      // 绝不在 auto 级调用。auto 级只做内部巡检 + 催办清单。
      const tk = require('./tickets');
      if (typeof tk.slaWatch !== 'function') return { ok: false, note: 'tickets 无 slaWatch 入口' };
      const r = tk.slaWatch();
      const od = tkOverdue();
      return {
        ok: true,
        action: '已执行 SLA 巡检并生成催办清单（超时 ' + od.length + ' 张，**未对客户发送任何内容**）',
        result: r
      };
    },
    verify() {
      const left = tkOverdue().length;
      return { ok: left === 0, note: left === 0 ? 'SLA 超时已清零' : '仍有 ' + left + ' 张超时（对外回复需人工确认）' };
    }
  },

  // ============ assist：处置本身安全，但动作有外部效果 ============
  'tickets-crisis': {
    risk: RISK.ASSIST,
    diagnose() {
      const c = tkOpenCrisis();
      return {
        cause: c.length + ' 个危机工单未结',
        evidence: c.slice(0, 3).join('、') || '无',
        fixable: c.length > 0,
        whyNeedsHuman: '危机回复等于代表公司对外发声（tickets.respond 会真的发出消息），自动发出可能造成不可逆的口碑损害'
      };
    },
    prepare() {
      const c = tkOpenCrisis();
      const draft = c.map(subject => ({
        subject,
        suggestion: '先确认已收到 → 给出初步结论与时间点 → 不追问细节、不承诺赔偿 → 24h 内给正式答复'
      }));
      store.push('audit', { action: '监控·危机工单待人工确认', detail: '已生成 ' + draft.length + ' 条回复草稿（未发送）', at: Date.now() });
      return { ok: true, action: '已生成 ' + draft.length + ' 条危机回复草稿并留痕，**需人工确认后才会发出**', drafts: draft };
    },
    verify() {
      const c = tkOpenCrisis();
      return { ok: c.length === 0, note: c.length ? c.length + ' 个危机单仍未结（对外回复待人工）' : '危机单已清零' };
    }
  },

  // ============ manual：根因是缺凭证 / 涉现金 / 会篡改数据 ============
  'mcp-pool': {
    risk: RISK.MANUAL,
    diagnose() {
      // mcp 没有 status()，实际导出是 stats()。
      const ms = require('./mcp').stats ? require('./mcp').stats() : {};
      const pool = ms.balancePool !== undefined ? ms.balancePool : (ms.balance !== undefined ? ms.balance : 0);
      return {
        cause: 'MCP 预付池 ¥' + pool + ' < ¥20 底限',
        evidence: 'mcp.stats() balancePool=' + pool,
        fixable: false,
        whyNeedsHuman: '自动充值 = 系统自己花钱。绝不允许自动动钱，只能提示'
      };
    },
    manualGuide: '请人工在「系统设置 · 密钥与资金」补充 MCP 预付池（mcp.recharge 需人工执行）；或下调该工具的调用配额以降低消耗。'
  },

  'rank-gap': {
    risk: RISK.MANUAL,
    diagnose() {
      const r = require('./rank').gapOk ? require('./rank').gapOk() : { bad: [] };
      const bad = r.bad || [];
      return {
        cause: '排行榜相邻名次差值违规 ' + bad.length + ' 处',
        // 【修】原来直接 join，空数组时 evidence 变成空串 —— 测试断言"必须有证据"
        // 就会红，但更重要的是：告警里没有可核对的依据，人也没法判断真假。
        // 空时明说"当前无违规记录"，不留白。
        evidence: bad.length ? bad.slice(0, 2).map(x => x.name + ' vs ' + x.next).join(' / ')
          : 'rank.gapOk() 未发现违规（若告警仍触发，说明检查与判定口径不一致，需人工核对）',
        fixable: false,
        whyNeedsHuman: '自动"修正"只能改分数或重排名次，那是篡改真实数据。必须人工核对原始工作量后重算'
      };
    },
    manualGuide: '请人工在「排行榜」页面核对这三人的真实完成量，按实际数据重算；不要直接改分。'
  },

  'mail-down': {
    risk: RISK.MANUAL,
    diagnose() {
      const ml = (store.read().audit || []).filter(x => /监控/.test(x.action || ''));
      const last = ml[ml.length - 1] || null;
      return {
        cause: '告警邮件发送失败' + (last ? '：' + String(last.detail || '').slice(0, 60) : ''),
        evidence: 'audit 中最近一条监控相关记录',
        fixable: false,
        whyNeedsHuman: '缺的是邮箱授权码这类凭证，系统无法自行生成；伪造"已发送"比不发更糟'
      };
    },
    manualGuide: '请在「系统设置 · 密钥与凭据」填写 MAIL_SENDER 与 MAIL_AUTH（QQ 邮箱需用授权码，不是登录密码）。'
  },

  'kpi-slow': {
    risk: RISK.MANUAL,
    diagnose() {
      const m = require('./money');
      const k = m.kpi();
      const behind = (k.needDaily || 0) > 0 && (k.regDaily || 0) < (k.needDaily || 0);
      return {
        cause: behind ? ('实收日均 ¥' + Math.round(k.regDaily) + ' < 达标需 ¥' + Math.round(k.needDaily)) : '进度正常',
        evidence: 'money.kpi() regDaily/needDaily',
        fixable: false,
        whyNeedsHuman: '营收落后是**商业决策**不是技术故障，系统可以给出诊断但不该替你决定是提价、加投放还是砍成本'
      };
    },
    manualGuide: '建议：在决策中心把焦点设为「增长」或「定价」，系统会据此派发指向性任务。'
  },

  'foundry-human': {
    risk: RISK.ASSIST,
    diagnose() {
      const b = require('./foundry') && require('./foundry').board ? require('./foundry').board() : {};
      const stuck = b.stuck || b.waitingHuman || b.humanQueue || [];
      return {
        cause: stuck.length + ' 部作品停在人工站',
        evidence: stuck.length ? stuck.map(x => x.station || x.title || '待裁决').join(' / ')
          : 'foundry.board() 未返回待裁决清单（若告警仍触发，说明检查与看板口径不一致）',
        fixable: true,
        whyNeedsHuman: '人工裁决站是设计上的底线——不代跑人工判断，否则质量控制就形同虚设'
      };
    },
    prepare() {
      store.push('audit', { action: '监控·待人工裁决提醒', detail: '已生成待裁决清单，需人工处理', at: Date.now() });
      return { ok: true, action: '已生成待人工裁决清单（不代跑人工站）' };
    },
    verify() {
      const b = require('./foundry') && require('./foundry').board ? require('./foundry').board() : {};
      const n = (b.stuck || []).length;
      return { ok: n === 0, note: n ? n + ' 部仍待人工裁决' : '待裁决已清空' };
    }
  }
};

// —— 主流程：诊断 → 处置 → 复检 ——
async function runOnce(opt) {
  const o = opt || {};
  const now = Date.now();
  const results = [];

  // 1) 拿当前异常列表：优先用 watchdog 自己扫的，没有就现扫
  let list = o.list;
  if (!list) {
    try {
      const wd = require('./watchdog');
      const st = wd.status();
      list = (st.alerts && st.alerts.length) ? st.alerts : (wd.scanNow ? (await wd.scanNow()) || [] : []);
    } catch (e) {
      list = [];
    }
  }
  list = list || [];

  for (const alert of list) {
    const key = alert.key;
    const rule = CATALOG[key];
    const r = { key, level: alert.level, title: alert.title, detail: alert.detail };

    // 1) 诊断
    let diag = null;
    try { diag = rule && typeof rule.diagnose === 'function' ? rule.diagnose() : null; }
    catch (e) { r.diagnoseError = String(e.message || e).slice(0, 80); }
    r.diagnosis = diag;
    r.risk = rule ? rule.risk : RISK.MANUAL;
    r.riskLabel = rule ? RISK_LABEL[rule.risk] : '未登记修复策略（按不可自动处理）';

    // 2) 处置
    if (!rule) {
      r.action = 'none';
      r.reason = '该异常没有登记修复策略，不做猜测性处置，转人工';
      results.push(r);
      continue;
    }

    if (rule.risk === RISK.AUTO && typeof rule.repair === 'function') {
      try {
        const rep = rule.repair();
        r.repair = rep;
        r.action = rep && rep.ok ? 'repaired' : 'repair_failed';
        r.reason = (rep && rep.action) || (rep && rep.note) || '';
      } catch (e) {
        r.action = 'repair_failed';
        r.reason = '修复执行出错：' + String(e.message || e).slice(0, 90);
      }
    } else if (rule.risk === RISK.ASSIST && typeof rule.prepare === 'function') {
      try {
        const rep = rule.prepare();
        r.repair = rep;
        r.action = 'prepared';
        r.reason = (rep && rep.action) || '';
        r.awaitingHuman = true;
      } catch (e) {
        r.action = 'repair_failed';
        r.reason = '准备待确认动作出错：' + String(e.message || e).slice(0, 90);
      }
    } else {
      r.action = 'manual_required';
      r.reason = (diag && diag.whyNeedsHuman) || '根因不在技术侧，自动处置会越界';
      r.guide = rule.manualGuide || '';
    }

    // 3) 复检：修完必须再查一遍，不能执行完就宣布成功
    if (typeof rule.verify === 'function' && (r.action === 'repaired' || r.action === 'prepared')) {
      try {
        const v = rule.verify();
        r.verified = v;
        // 关键：动作成功 ≠ 问题解决。复检不过就如实说没收好。
        r.closed = !!v.ok;
        if (!v.ok) r.closureNote = '已执行处置，但复检未通过：' + v.note;
      } catch (e) {
        r.verified = { ok: false, note: '复检出错：' + String(e.message || e).slice(0, 80) };
        r.closed = false;
      }
    } else {
      r.closed = false;
    }

    results.push(r);
  }

  const sum = {
    total: results.length,
    repaired: results.filter(x => x.action === 'repaired' && x.closed).length,
    repairedNotClosed: results.filter(x => x.action === 'repaired' && !x.closed).length,
    prepared: results.filter(x => x.action === 'prepared').length,
    manual: results.filter(x => x.action === 'manual_required').length,
    failed: results.filter(x => x.action === 'repair_failed' || x.action === 'none').length
  };
  sum.closureRate = sum.total ? Math.round((sum.repaired / sum.total) * 100) : 100;

  const report = {
    at: now,
    summary: sum,
    items: results,
    verdict: buildVerdict(sum, results)
  };

  // 留痕：整条链路的诊断/处置/复检都要可审计
  try {
    store.push('audit', {
      action: '监控·自修复闭环',
      detail: '诊断 ' + sum.total + ' 项 · 自动修复并复检通过 ' + sum.repaired
        + ' · 已备好待人工确认 ' + sum.prepared + ' · 需人工 ' + sum.manual + ' · 失败 ' + sum.failed,
      at: now
    });
  } catch (e) {}

  return report;
}

function buildVerdict(sum, items) {
  if (!sum.total) return '当前没有异常，无需处置。';
  const parts = [];
  parts.push('共 ' + sum.total + ' 项异常');
  if (sum.repaired) parts.push(sum.repaired + ' 项已自动修复且复检通过');
  if (sum.repairedNotClosed) parts.push(sum.repairedNotClosed + ' 项已执行但复检未通过（没收干净）');
  if (sum.prepared) parts.push(sum.prepared + ' 项已备好方案待人工确认');
  if (sum.manual) parts.push(sum.manual + ' 项不可自动处理');
  if (sum.failed) parts.push(sum.failed + ' 项处置失败');
  const m = items.find(x => x.action === 'manual_required' && x.guide);
  if (m) parts.push('最需要你处理的是「' + m.title + '」：' + m.guide);
  return parts.join('；') + '。';
}

// —— 覆盖度自检：告警项是否都有对应策略 ——
// 【为什么要这个】watchdog 新增检查项时，若忘了在 CATALOG 登记，
// 系统就会对新的异常"没有任何策略"。不检查的话，这个洞会一直静默存在。
function coverage(watchdogSrc) {
  let src = watchdogSrc;
  if (src === undefined) {
    try {
      src = require('fs').readFileSync(require('path').join(__dirname, 'watchdog.js'), 'utf8');
    } catch (e) { src = ''; }
  }
  const keys = [...new Set((String(src).match(/key:\s*'([a-z0-9-]+)'/g) || [])
    .map(s => s.replace(/key:\s*'/, '').replace(/'/, '')))];
  const uncovered = keys.filter(k => !CATALOG[k]);
  const orphan = Object.keys(CATALOG).filter(k => keys.indexOf(k) < 0);
  return {
    alertKeys: keys.length,
    catalogKeys: Object.keys(CATALOG).length,
    covered: keys.filter(k => CATALOG[k]).length,
    uncovered,
    orphan,
    rate: keys.length ? Math.round(keys.filter(k => CATALOG[k]).length * 100 / keys.length) : 100,
    verdict: uncovered.length
      ? (uncovered.length + ' 个告警项没有修复策略：' + uncovered.join(',') + ' —— 这些异常报出来后会无人处置')
      : ('全部 ' + keys.length + ' 个告警项都有对应策略（覆盖 100%）')
  };
}

module.exports = { runOnce, coverage, CATALOG, RISK, RISK_LABEL };