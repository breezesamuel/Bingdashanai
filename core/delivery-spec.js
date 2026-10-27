// core/delivery-spec.js — 交付说明书 + 前置筛查闸
//
// 解决的唯一问题：把「2万种如果」变成「下单前已经决定过的事」。
//
// 三层机制（见 COMMERCIAL-AUDIT.md 第 8 节）：
//   ① 合同前置   不可预测的异议（改稿轮次/范围/日期）在下单前写死并计价
//   ② 交付物化   "不满意"必须有可检查的定义——验收清单逐条可勾
//   ③ 退出条款   预演好的出口：触发条件→退款比例，签字生效
//
// 诚实红线（比功能更重要）：
//   · 绝不替客户勾选任何确认项。买家未确认=说明书未生效。
//   · 拒单也是产品功能：screen() 判定"交付不了"时必须如实说，不许为了赚钱接下来。
//   · 说明书里不出现任何我们没有的东西（席位/BYOK/团队档——都还没有）。
//   · 每一个交付项必须能被 honestly 检查；写不出验收标准的项不许进清单。
//
// 与 payment/order 的关系：本模块只产出一页「可签字的说明书」与「是否放行」，
// 不碰钱、不建订单。真正的下单仍走 subs.order()（等支付能力恢复后接入）。

// —— 前置筛查：把"不可能交付的单"挡在付钱之前 ——
// 判定规则刻意保守：宁可拒单，不接烂单。宁可退钱，不做毁约方。
const HARD_STOPS = [
  { id: 'no-first-money', ask: '第一笔钱从哪来？',
    test: a => !/的钱|收入|客户|订单|工资|融资|货款|利润|回款/.test(String(a.firstMoney || '')),
    say: '交付不了：说不清第一笔钱从哪来，"搭公司"目前无法变成可验收的东西。别浪费你的钱。' },
  { id: 'mega-corp', ask: '想要的是"大型公司"？',
    test: a => /大型|集团|上市公司|万人|帝国/.test(String(a.goal || '')),
    say: '交付不了：大型公司是多年组织工程，不是能交付的产品。我可以交付的是"第一个能收钱的最小单位"。' },
  { id: 'open-scope', ask: '要的是"全都要""看着办"？',
    test: a => /全都|都要|你看着|随便|无限|所有/.test(String(a.scope || '')),
    say: '交付不了：范围不封闭就无法验收，无法验收就必然有一方不满意。请圈定一个具体物件。' },
  { id: 'no-deadline', ask: '什么时候要？',
    test: a => !String(a.deadline || '').trim(),
    say: '交付不了：没有截止日期的需求会无限膨胀。请给一个日期。' },
  { id: 'immediate', ask: '现在/今天就要？',
    test: a => /现在|今天|马上|立刻|1天|一天内/.test(String(a.deadline || '')),
    say: '交付不了：仓促交付=必然返工。最早可交付的日期写在方案里。' },
  { id: 'satisfaction-only', ask: '要的是"让我满意"？',
    test: a => /满意|开心|舒服|喜欢/.test(String(a.success || '')) && !/条|份|个|篇|封|张/.test(String(a.success || '')),
    say: '交付不了："满意"没有验收标准。请改成可数的东西（几份/几条/几个）。' }
];

const MAX_REVISION_ROUNDS = 3;

// 买家可确认的条款（每一条都必须由买家主动确认，不许默认勾选）
function terms(opts) {
  const o = opts || {};
  return [
    { id: 'scope', label: '交付范围仅限上方清单，清单外一律不做', detail: '范围外需求另立单' },
    { id: 'rounds', label: '含 ' + MAX_REVISION_ROUNDS + ' 轮改稿，超出按次另计', detail: '从交付初稿起算' },
    { id: 'acceptance', label: '验收标准=清单逐项打勾，不靠"感觉"', detail: '买家按单验收' },
    { id: 'exit', label: '未达验收项可申请退出（见下方退款条款）', detail: '预演好的出口' },
    { id: 'no-hidden', label: '不含任何未列明的服务', detail: '清单外一律不做' }
  ];
}

// 验收项：每一项必须可数、可检查。写不出验收标准的项不允许进清单。
function acceptance(items) {
  return (items || []).filter(x => x && String(x.what || '').trim()).map((x, i) => ({
    n: i + 1,
    what: String(x.what).slice(0, 120),
    unit: String(x.unit || '份').slice(0, 6),
    count: Math.max(1, Number(x.count) || 1),
    check: String(x.check || '').slice(0, 200),
    done: false,                          // 买家验收时才置 true
    rejectedReason: ''                    // 买家写不通过的原因（不是"不满意"三个字）
  }));
}

// 退款条款：先谈好怎么散，才不会吵到散
function exitClause(amount, days) {
  const d = Math.max(1, Number(days) || 7);
  return {
    trigger: '交付初稿后 ' + d + ' 天内，验收项未全部通过',
    refundPct: 100,
    how: '提交未通过项编号 + 具体原因 → 原路退回，无需说明"为什么不满意"',
    notCovered: '买家超过 ' + MAX_REVISION_ROUNDS + '轮改稿后仍未通过的部分，视为范围蔓延，另立单'
  };
}

// 生成一页可签字的说明书
function generate(input) {
  const inp = input || {};
  const buyer = String(inp.buyer || '').trim().slice(0, 60);
  const items = acceptance(inp.items);
  const amount = Math.max(0, Number(inp.amount) || 0);

  if (!buyer) return { ok: false, error: '缺买家标识（联系方式/账号）' };
  if (!items.length) return { ok: false, error: '至少一项可验收的交付物（且必须能写出验收标准）' };
  if (!(amount > 0)) return { ok: false, error: '金额必须大于 0（0 元无法界定交付责任）' };

  const spec = {
    id: 'SPEC-' + Date.now().toString(36).toUpperCase(),
    buyer, amount, currency: String(inp.currency || 'CNY').slice(0, 6),
    goal: String(inp.goal || '').slice(0, 200),
    firstMoney: String(inp.firstMoney || '').slice(0, 200),
    deadline: String(inp.deadline || '').slice(0, 40),
    items,
    terms: terms(),
    exit: exitClause(amount, inp.days),
    // 未签字的状态：默认全部未确认，买家主动确认后才生效
    confirmedTerms: [],
    buyerAgreed: false,
    createdAt: Date.now()
  };
  return { ok: true, spec, note: '说明书已生成，等待买家逐条确认后才生效' };
}

// 前置筛查闸：返回放行/拒单 + 理由。拒单也是正常输出，不是失败。
function screen(answers) {
  const hits = HARD_STOPS.filter(h => h.test(answers || {}));
  if (!hits.length) {
    return { ok: true, pass: true, note: '可进入方案阶段' };
  }
  return {
    ok: true,               // ⚠️ ok=true 是"筛查成功执行"，不是"接单"
    pass: false,
    stopped: hits.map(h => ({ id: h.id, ask: h.ask, say: h.say })),
    // 给买家一句能带走的话，而不是一句冷拒
    next: '把上面任一条改成可验收的形式，再回来。改不动就先别付钱。'
  };
}

// 渲染成可打印的一页文本（买家看得懂，不写黑话）
function render(spec) {
  if (!spec || !spec.id) return '（无有效说明书）';
  const L = [];
  L.push('════════ 交付说明书 ' + spec.id + ' ════════');
  L.push('买家：' + spec.buyer + '　金额：' + spec.amount + ' ' + spec.currency + '　期望日期：' + (spec.deadline || '未填'));
  L.push('');
  L.push('你要的东西：' + (spec.goal || '（未填）'));
  L.push('第一笔钱从哪来：' + (spec.firstMoney || '（未填）'));
  L.push('');
  L.push('—— 交付清单（逐项验收，不靠感觉）——');
  spec.items.forEach(it => {
    L.push('  ' + it.n + '. ' + it.what + '　(' + it.count + ' ' + it.unit + ')');
    if (it.check) L.push('     验收：' + it.check);
  });
  L.push('');
  L.push('—— 条款 ——');
  spec.terms.forEach((t, i) => {
    const on = spec.confirmedTerms.indexOf(t.id) >= 0 ? '☑' : '☐';
    L.push('  ' + on + ' ' + t.label + '　（' + t.detail + '）');
  });
  L.push('');
  L.push('—— 退出条款 ——');
  L.push('  触发：' + spec.exit.trigger);
  L.push('  退款：' + spec.exit.refundPct + '%　方式：' + spec.exit.how);
  L.push('  不含：' + spec.exit.notCovered);
  L.push('');
  if (spec.buyerAgreed) L.push('买家已确认。本说明书生效。');
  else L.push('⚠ 买家尚未逐条确认 —— 本说明书【未生效】。');
  L.push('════════════════════════════');
  return L.join('\n');
}

module.exports = { generate, screen, render, acceptance, terms, exitClause, HARD_STOPS, MAX_REVISION_ROUNDS };
