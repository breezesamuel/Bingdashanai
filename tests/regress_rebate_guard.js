// 回归测试：返利兑换与发码限流（两个"钱/滥用"口子）
// 红线：
//   ① 返利月数兑换出的订阅**必须带明确档位**：tier 缺失会被当作 legacy
//      （老订阅"全不限次"的承诺）→ 重耗分区日限被绕过 → 白嫖算力。
//   ② 兑换幂等：兑完再兑不能多给时长。
//   ③ 发码端点必须有 IP 限流（否则可用我们的 SMTP 批量轰炸任意邮箱）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-rebate-'));
process.env.BINGDASHAN_DATA_DIR = DATA;
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 220) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

(async () => {
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const subs = require(path.join(ROOT, 'core', 'subs.js'));
  const now = Date.now();
  const key = 'ip:6.6.6.6:rebate1';
  store.push('visitors', { id: 'v-rb', visitor: key, freeLeft: 10, used: 0, paid: 0, monthsCredit: 3, invite: [], invitedBy: null, inviteCode: 'BDRB01', trialUsed: false, createdAt: now }, '测试：返利用户', key);

  section('1. 兑换出的订阅带明确档位（不得是 legacy = 不限次）');
  const r = subs.redeemMonthsCredit(key);
  ok(r && r.ok, '兑换成功', r && (r.error || r.mode));
  const sub = store.list('sublist').find((s) => s.visitor === key);
  ok(sub && sub.tier === 'basic', '兑换出的订阅 tier=basic（重耗日限按 3× 生效）', sub && { tier: sub.tier, plan: sub.plan });
  ok(!(sub && sub.tier === 'legacy'), '绝不是 legacy（否则重耗分区不限次 = 白嫖算力）');

  section('2. 兑换幂等：兑完再兑不多给');
  const r2 = subs.redeemMonthsCredit(key);
  ok(r2 && r2.ok === false, '再兑一次被拒（无待兑现月数）', r2 && r2.error);
  const sub2 = store.list('sublist').filter((s) => s.visitor === key);
  ok(sub2.length === 1, '订阅记录只有一条（没多给时长）', 'count=' + sub2.length);
  const v2 = store.findBy('visitors', 'id', 'v-rb');
  ok(v2 && (v2.monthsCredit || 0) === 0, '返利月数已清零', v2 && v2.monthsCredit);

  section('3. 重耗分区日限对兑换用户生效（不因 legacy 绕过）');
  const g = subs.gatePool(key, 'studio');   // studio 是重耗分区
  ok(g && g.allowed === true && g.quota !== Infinity, '首次调用被计次（日限存在，不是无限）', g && { allowed: g.allowed, used: g.used, quota: g.quota });

  section('4. 发码端点有 IP 限流（防邮件轰炸）');
  const ext = fs.readFileSync(path.join(ROOT, 'core', 'server-ext-routes.js'), 'utf8');
  ok(/authRateOk\(ip, 10, 3600000\)/.test(ext), 'send-code 有每小时 10 次的 IP 限流');
  ok(/authRateOk\(ip, 20, 3600000\)/.test(ext), 'verify-code / login 有每小时 20 次的 IP 限流');
  const sendBlock = ext.slice(ext.indexOf("/v1/auth/send-code"), ext.indexOf("/v1/auth/verify-code"));
  ok(sendBlock.indexOf('authRateOk') >= 0, '限流代码在 send-code 处理器内（不是写在别处）');

  section('5. 所有新建 sublist 的地方都必须带 tier（防 legacy 绕过重耗日限）');
  // 逐个文件检查：push('sublist' 之后的对象字面量里必须有 tier
  const files = ['core/subs.js', 'core/auth.js', 'core/license.js'];
  const misses = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    let idx = 0;
    while ((idx = src.indexOf("push('sublist'", idx)) >= 0) {
      const win = src.slice(idx, idx + 420);
      if (win.indexOf('tier') < 0) misses.push(f + ' @' + idx);
      idx += 12;
    }
  }
  ok(misses.length === 0, '每个 sublist 创建点都写了 tier（否则 = 重耗不限次）', misses.join(' | '));

  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})();
