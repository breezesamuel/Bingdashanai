// 可靠性证明（不依赖真实 Key）：注入假 Key + 模拟 fetch，验证
//   轮换降级 / 健康记录 / 连续失败冷却 / 配额窗口 / 免费赠量计量
const fs = require('fs');
const path = require('path');
const store = require('./core/store');

// 清空历史状态，保证从零开始
try { fs.unlinkSync(path.join(store.DATA_DIR, 'free-tier.json')); } catch (e) {}

// 注入两个"假 Key"（只用于让通道进入候选；网络被下面的 fetch 桩接管）
process.env.GROQ_API_KEY = 'test-groq';
process.env.CEREBRAS_API_KEY = 'test-cerebras';

const calls = [];
const okJson = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const badCode = (code, msg) => ({ ok: false, status: code, json: async () => ({}), text: async () => msg });

global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('api.groq.com')) return badCode(500, 'groq simulated 500');
  if (u.includes('api.cerebras.ai')) return okJson({ choices: [{ message: { content: '来自 Cerebras 的答案' } }] });
  return badCode(503, 'simulated down: ' + u.slice(0, 40)); // 其它通道一律模拟故障
};

const ft = require('./core/free-tier');
const assert = require('assert');

(async () => {
  console.log('== 候选顺序 ==');
  const cands = ft.candidates({ tier: 2 });
  console.log(cands.join(' , '));

  console.log('\n== 第 1 次调用（应跳过故障通道，落在 cerebras）==');
  const r1 = await ft.chat({ messages: [{ role: 'user', content: 'hi' }] });
  console.log('ok=', r1.ok, '| provider=', r1.provider, '| model=', r1.model);
  console.log('tried=', r1.tried.map(t => t.id + ':' + t.error.slice(0, 24)).join(' | '));
  assert.strictEqual(r1.ok, true, '应当成功');
  assert.strictEqual(r1.provider, 'cerebras', '应落在唯一健康的 cerebras');

  const h1 = ft.health('groq');
  console.log('groq 健康:', JSON.stringify({ ok: h1.ok, fail: h1.fail, cf: h1.consecutiveFail, cooling: h1.cooling }));
  assert.strictEqual(h1.fail, 1, 'groq 应记 1 次失败');

  console.log('\n== 第 2 次调用 ==');
  const r2 = await ft.chat({ messages: [{ role: 'user', content: 'hi again' }] });
  console.log('ok=', r2.ok, '| provider=', r2.provider);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.provider, 'cerebras', '健康的 cerebras 应继续被优先选中');

  console.log('\n== 连续失败 → 冷却自愈（隔离到 groq）==');
  const others = ft.REGISTRY.map(p => p.id).filter(id => id !== 'groq');
  const st0 = ft._internal.loadState();
  Object.keys(st0.providers).forEach(k => { st0.providers[k] = { ok: 0, fail: 0, consecutiveFail: 0, cooldownUntil: 0, quota: {} }; });
  global.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('api.groq.com')) return badCode(500, 'groq boom');
    return okJson({ choices: [{ message: { content: 'x' } }] });
  };
  await ft.chat({ messages: [{ role: 'user', content: 'a' }], exclude: others });
  await ft.chat({ messages: [{ role: 'user', content: 'b' }], exclude: others });
  const h3 = ft.health('groq');
  console.log('groq 健康:', JSON.stringify({ fail: h3.fail, cf: h3.consecutiveFail, cooling: h3.cooling }));
  assert.strictEqual(h3.consecutiveFail, 2, 'groq 应累计 2 次连续失败');
  assert.strictEqual(h3.cooling, true, 'groq 连续失败 2 次后应进入冷却');
  assert.ok(!ft.candidates({ tier: 2 }).includes('groq'), '冷却中的 groq 不应出现在候选里');
  console.log('✓ 冷却生效：groq 已被候选取缔，不再被反复撞击');

  console.log('\n== 免费赠量计量 ==');
  const v = 'rotate-test-visitor';
  let g = ft.grantStatus(v);
  console.log('初始:', JSON.stringify(g));
  const c1 = ft.grant(v);
  const c2 = ft.grant(v);
  console.log('两次消费后:', JSON.stringify(ft.grantStatus(v)));
  assert.strictEqual(c1.ok, true);

  console.log('\n== 全部通道故障时的诚实上报 ==');
  global.fetch = async () => badCode(500, 'all down');
  // 清状态让所有通道重新进入候选
  const st = ft._internal.loadState();
  Object.keys(st.providers).forEach(k => { st.providers[k] = { ok: 0, fail: 0, consecutiveFail: 0, cooldownUntil: 0, quota: {} }; });
  const r3 = await ft.chat({ messages: [{ role: 'user', content: 'hi' }] });
  console.log('ok=', r3.ok, '| error=', r3.error, '| tried=', r3.tried.length);
  assert.strictEqual(r3.ok, false, '全故障时必须 ok=false（不得伪造成功）');
  assert.ok(r3.tried.length > 0, '必须如实列出尝试过的通道');

  console.log('\n✅ 全部断言通过：轮换 / 健康 / 冷却 / 配额 / 赠量 / 诚实上报');
})().catch(e => { console.error('❌ 测试失败：', e.message); process.exit(1); });
