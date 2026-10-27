// test/e2e/suites/delivery-spec-e2e.js — 交付说明书 + 前置筛查闸
//
// 守护的纪律：
//   1. 【拒单是功能】scope 不封闭/说不清第一笔钱/要"满意"/要"全都要" → 一律放行 false，
//      且必须给出可执行的理由。不许为了接单降低门禁。
//   2. 【不许默认勾选】说明书出厂时 confirmedTerms=[], buyerAgreed=false ——
//      替买家勾选确认项 = 伪造同意，比不写说明书更糟。
//   3. 【验收必须可检查】写不出验收标准的项不得进清单；"让我满意"不是验收标准。
//   4. 【退款条款必须先谈好】触发条件/比例/方式齐备，且不覆盖范围蔓延。
//   5. 【零元单拒收】0 元无法界定交付责任。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { requireIsolated } = require('./_guard');
const ds = require(ROOT + '/core/delivery-spec');
const BASE = requireIsolated('delivery-spec-e2e');

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}

// —— 一组合法输入（每个前置问题都答得上来）——
const GOOD = {
  buyer: 'buyer-test-001',
  goal: '跑通第一个能收钱的最小单位：一个垂直行业的获客落地页',
  firstMoney: '第一个客户付的样品费',
  deadline: '2026-11-20',
  amount: 999,
  items: [{ what: '获客落地页', unit: '个', count: 1, check: '含表单+支付链接，可提交并收到通知' },
    { what: '首发邮件', unit: '封', count: 10, check: '每封有依据，无承诺性用语' }]
};

(async () => {
  // ===== 前置筛查闸 =====
  const okScr = ds.screen({ firstMoney: '客户付的钱', goal: '跑通收入', scope: '一个落地页', deadline: '2026-11-20', success: '1 个可提交的页面' });
  T('合法输入放行', okScr.pass === true, JSON.stringify(okScr).slice(0, 120));

  const noMoney = ds.screen({ firstMoney: '不知道', goal: '搭个公司', scope: '一个页面', deadline: '2026-11-20' });
  T('说不清第一笔钱 → 拒单', noMoney.pass === false && noMoney.stopped.some(s => s.id === 'no-first-money'),
    JSON.stringify(noMoney.stopped || []).slice(0, 120));
  T('拒单给出可执行的话（不是冷拒）', noMoney.pass === false && String(noMoney.next || '').length > 10);

  const mega = ds.screen({ firstMoney: '以后再说', goal: '想要大型集团公司', scope: '一个页面', deadline: '2026-11-20' });
  T('要"大型公司" → 拒单', mega.pass === false && mega.stopped.some(s => s.id === 'mega-corp'));
  const megaSay = mega.stopped.find(s => s.id === 'mega-corp') || {};
  T('拒单理由说清"能交付什么"', /最小单位/.test(megaSay.say || ''), (megaSay.say || '').slice(0, 80));

  const openScope = ds.screen({ firstMoney: '客户的钱', goal: '全都做', scope: '所有模块都要，你看着办', deadline: '2026-11-20' });
  T('范围不封闭 → 拒单', openScope.pass === false && openScope.stopped.some(s => s.id === 'open-scope'));

  const noDdl = ds.screen({ firstMoney: '客户的钱', goal: '跑通收入', scope: '一个页面', deadline: '' });
  T('无截止日期 → 拒单', noDdl.pass === false && noDdl.stopped.some(s => s.id === 'no-deadline'));

  const now = ds.screen({ firstMoney: '客户的钱', goal: '跑通收入', scope: '一个页面', deadline: '现在就要' });
  T('要求"现在/今天" → 拒单', now.pass === false && now.stopped.some(s => s.id === 'immediate'));

  const sat = ds.screen({ firstMoney: '客户的钱', goal: '跑通收入', scope: '一个页面', deadline: '2026-11-20', success: '让我满意就行' });
  T('只要求"满意" → 拒单', sat.pass === false && sat.stopped.some(s => s.id === 'satisfaction-only'));
  const sat2 = ds.screen({ firstMoney: '客户的钱', goal: '跑通收入', scope: '一个页面', deadline: '2026-11-20', success: '1 个可提交页面 + 10 封邮件' });
  T('可数的达标标准 → 放行', sat2.pass === true);

  const empty = ds.screen({});
  // 空答案只命中"该问的"两条：说不清钱 + 没给日期。范围/达标标准为空时
  // 正则在空串上不命中是对的——不硬塞莫须有的问题给买家。
  T('空答案 → 拒单且命中核心卡点', empty.pass === false && empty.stopped.length >= 2, 'stopped=' + (empty.stopped || []).length);

  // ===== 说明书生成 =====
  const g = ds.generate(GOOD);
  T('合法输入生成说明书', g.ok === true && !!g.spec.id, JSON.stringify(g).slice(0, 100));
  const spec = g.spec;

  T('出厂未勾选任何条款（不许替买家确认）', Array.isArray(spec.confirmedTerms) && spec.confirmedTerms.length === 0,
    JSON.stringify(spec.confirmedTerms));
  T('出厂 buyerAgreed=false（未生效）', spec.buyerAgreed === false);
  T('渲染文本明示"未生效"', /尚未逐条确认.*未生效/.test(ds.render(spec)), ds.render(spec).slice(-80));

  T('验收项默认 done=false', spec.items.every(i => i.done === false && i.rejectedReason === ''));
  T('验收项可数（每条有 unit/count/check）',
    spec.items.every(i => Number(i.count) >= 1 && String(i.unit || '').length > 0 && String(i.check || '').length > 0),
    JSON.stringify(spec.items.map(i => [i.count, i.unit])));

  // ===== 拒收不合规输入 =====
  const noItems = ds.generate({ buyer: 'b', amount: 100, items: [] });
  T('无可验收交付物 → 拒收', noItems.ok === false && !!noItems.error);
  const badItem = ds.generate({ buyer: 'b', amount: 100, items: [{ what: '   ' }] });
  T('空白交付物 → 拒收', badItem.ok === false);
  const zero = ds.generate({ buyer: 'b', amount: 0, items: GOOD.items });
  T('0 元 → 拒收（无法界定交付责任）', zero.ok === false && /金额/.test(zero.error), zero.error);
  const noBuyer = ds.generate({ amount: 100, items: GOOD.items });
  T('缺买家标识 → 拒收', noBuyer.ok === false);

  // ===== 退款条款 =====
  const ex = spec.exit;
  T('退款条款含触发条件', typeof ex.trigger === 'string' && /验收项未全部通过/.test(ex.trigger), ex.trigger);
  T('退款比例与方式齐备', Number(ex.refundPct) === 100 && String(ex.how || '').length > 5);
  T('退款条款不覆盖范围蔓延（写清边界）', /范围蔓延|另立单/.test(ex.notCovered || ''), ex.notCovered);
  T('改稿轮次有硬上限', ds.MAX_REVISION_ROUNDS === 3, 'rounds=' + ds.MAX_REVISION_ROUNDS);
  T('条款里声明"不含未列明服务"',
    spec.terms.some(t => /不含任何未列明的服务/.test(t.label)), spec.terms.map(t => t.label).join(' | '));

  // ===== 渲染可读性 =====
  const txt = ds.render(spec);
  T('渲染含交付清单', txt.indexOf('获客落地页') >= 0 && txt.indexOf('首发邮件') >= 0);
  T('渲染含逐项验收标准', txt.indexOf('验收：') >= 0);
  // 不能出现的产品黑话：席位/BYOK/多租户/团队档 都还没实现（见 COMMERCIAL-AUDIT.md 第7节）
  // 注意：这里查的是"承诺了未上线能力"，不是"范围蔓延"这类正常措辞。
  T('渲染不含未上线能力黑话（席位/BYOK/多租户/团队档）',
    !/席位|BYOK|多租户|团队档/.test(txt), '发现黑话');

  // ===== 确认后生效 =====
  const agreed = JSON.parse(JSON.stringify(spec));
  agreed.confirmedTerms = spec.terms.map(t => t.id);
  agreed.buyerAgreed = true;
  const txt2 = ds.render(agreed);
  T('买家全部确认后渲染"生效"', /本说明书生效/.test(txt2));
  T('渲染用 ☑ 表示已确认', (txt2.match(/☑/g) || []).length === spec.terms.length);

  // ===== 诚实红线：确认不可被伪造 =====
  const half = JSON.parse(JSON.stringify(spec));
  half.confirmedTerms = [spec.terms[0].id];   // 只确认 1 条
  T('只确认部分条款 → 仍显示未生效（不许伪造全同意）', /尚未逐条确认/.test(ds.render(half)));

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  require('./_exit').finish(fail ? 1 : 0);
})().catch(e => { console.log('FAIL 套件异常: ' + (e && e.stack || e)); console.log('===== ' + pass + ' PASS / ' + (fail + 1) + ' FAIL ====='); require('./_exit').finish(1); });
