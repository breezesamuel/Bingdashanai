// 回归测试：收款通道探针的**污染与预算**纪律
// 红线：
//   ① 探针是**真实单据**（0.01 元，不可删除）→ 自动探针必须有每日预算 + 低频；
//   ② 验签探针只能有**一份实现**（避免同一规则两份实现漂移）；
//   ③ 预算状态要能被运营看到（进通道视图）。
const fs = require('fs');
const path = require('path');

const SITE = process.env.BD_SITE_ROOT || path.join(__dirname, '..');   // 相对本文件解析（服务器上是 /opt/bingdashan）
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 220) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

const pay = fs.readFileSync(path.join(SITE, 'core', 'pay.js'), 'utf8');
const srv = fs.readFileSync(path.join(SITE, 'server.js'), 'utf8');

section('1. 探针预算：真实单据不能无限造');
ok(/probeBudgetState/.test(pay) && /probeBudgetConsume/.test(pay), '预算状态与扣减函数在（按天持久化）');
ok(/今日探针预算已用完/.test(pay), '预算用尽时明确拒绝再造探针单（不静默）');
ok(/PROBE_BUDGET_DEFAULT = 6/.test(pay), '默认每日预算有上限（6 笔）');
const alipayProbe = pay.slice(pay.indexOf('async function alipayProbe'), pay.indexOf('async function alipayProbe') + 900);
ok(alipayProbe.indexOf('probeBudgetConsume') >= 0, '支付宝探针受预算约束');
const ppProbe = pay.slice(pay.indexOf('async function paypalProbe'), pay.indexOf('async function paypalProbe') + 900);
ok(ppProbe.indexOf('probeBudgetConsume') >= 0, 'PayPal 探针受预算约束（它也建真实单）');

section('2. 自动探针频率已降到 6 小时（30 分钟 = 每天 48 笔垃圾单）');
const autoProbes = srv.split('\n').filter((l) => /setInterval\(.*Probe\(true\)/.test(l));
ok(autoProbes.length >= 3, '找到自动探针定时器', autoProbes.length);
ok(autoProbes.every((l) => /6 \* 3600 \* 1000/.test(l)), '全部自动探针都是 6 小时一轮', autoProbes.map((l) => l.trim().slice(0, 60)));

section('3. 验签探针只有一份实现（不重复造轮子）');
const sentinel = (pay.match(/alipayRemoteCheck/g) || []).length;
ok(sentinel >= 1, '存在哨兵验签实现 alipayRemoteCheck', sentinel);
ok(!/function alipayVerifySignature/.test(pay), '没有第二份重复实现（我加过，已删）');
ok(/alipay\.trade\.query/.test(pay) && /TRADE_NOT_EXIST/.test(pay), '哨兵用不存在的单号查 → 零污染');

section('4. 预算进通道视图（运营可见）');
ok(/probeBudget,/.test(pay), 'channelStatus 返回 probeBudget');
ok(/probeBudgetState\(\)/.test(pay), '预算状态从持久化设置读取（重启不重置）');

console.log('\npass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
