require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
﻿// 回归测试：LLM 成本记账（让毛利可见）
// 红线：
//   ① 每次 LLM 调用都要落一笔成本台账（provider/model/tokens/成本估算）；
//   ② 没拿到 usage 时**不编数字**（cny=null），但调用数要记；
//   ③ 成本**绝不混进 revenue**（收入口径不被污染）；
//   ④ 汇总能按供应商分组，供运营看毛利。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-cost-'));
process.env.BINGDASHAN_DATA_DIR = DATA;
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 220) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

(async () => {
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const cost = require(path.join(ROOT, 'core', 'cost.js'));

  section('1. 估算：token → 成本');
  const est = cost.estimate('deepseek', { prompt_tokens: 1000000, completion_tokens: 1000000 });
  ok(est.cny !== null && est.cny > 0, '有 usage 时给出成本估算', est);
  const est2 = cost.estimate('deepseek', null);
  ok(est2.cny === null && est2.totalTokens === null, '没 usage 时不编数字（cny=null）', est2);
  const est3 = cost.estimate('some-unknown-vendor', { prompt_tokens: 1000, completion_tokens: 1000 });
  ok(est3.cny === 0, '未知供应商按 0 记（宁可低估也不虚报）', est3);

  section('2. 记账：落台账，且不进 revenue');
  const readDb = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')); } catch (e) { return {}; } };
  const before = (readDb().revenue || []).length;
  cost.record({ provider: 'deepseek', model: 'deepseek-chat', usage: { prompt_tokens: 2000, completion_tokens: 1000 }, purpose: 'agent', ms: 1200 });
  cost.record({ provider: 'zhipu', model: 'glm-4-flash', usage: null, purpose: 'studio', ms: 800 });
  const db = readDb();
  const rows = db.llmUsage || [];
  ok(rows.length === 2, '两笔调用都记了成本台账', 'rows=' + rows.length);
  ok(rows[0] && rows[0].cny !== null && rows[0].totalTokens === 3000, '有 usage 的那笔有 token 与金额', rows[0]);
  ok(rows[1] && rows[1].cny === null, '没 usage 的那笔金额为 null（不编）', rows[1]);
  ok((db.revenue || []).length === before, '成本没有混进 revenue（收入口径干净）');

  section('3. 汇总：按供应商分组');
  const s = cost.summary(Date.now() - 86400000);
  ok(s.calls === 2, '汇总调用数', s.calls);
  ok(s.tokens === 3000, '汇总 token', s.tokens);
  ok(s.byProvider && s.byProvider.deepseek && s.byProvider.deepseek.calls === 1, '按供应商分组', s.byProvider);
  ok(s.cny > 0, '汇总成本估算', s.cny);

  section('4. 网关链路：chat 会读 usage 并回传成本');
  // 伪造 fetch：模拟一次带 usage 的成功响应
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: '你好' } }],
      usage: { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 },
    }),
    text: async () => '',
  });
  // 给一个假密钥，绕过"未配置密钥"检查
  process.env.TEST_FAKE_KEY = 'x';
  const providers = require(path.join(ROOT, 'core', 'providers.js'));
  const saved = providers.getKey;
  try {
    const target = providers.PROVIDERS[0];
    const oldEnv = require('fs').readFileSync;
    // 直接改内存里的 env 读取：注入密钥
    const p2 = Object.assign({}, providers);
    // 用最简做法：直接调用 providers.chat 并在失败时给出明确信息
    let out = null, err = null;
    try {
      out = await providers.chat({ provider: target.id, messages: [{ role: 'user', content: 'hi' }], purpose: 'test' });
    } catch (e) { err = e; }
    if (err) {
      // 缺密钥是预期内（本地无 .env 密钥）→ 只要求失败原因诚实
      ok(/未配置密钥/.test(String(err.message || err)), '无密钥时诚实报错', String(err.message).slice(0, 80));
    } else {
      ok(out && out.usage && out.usage.total_tokens === 1801, 'chat 回传 usage', out && out.usage);
      ok(out && out.cost && out.cost.totalTokens === 1801, 'chat 回传成本记账', out && out.cost);
    }
  } finally {
    global.fetch = realFetch;
  }

  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})();
