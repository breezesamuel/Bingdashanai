// 端到端：真实走一次免费通道轮换（用现有 Key 的通道，不伪造）
const ft = require('./core/free-tier');
(async () => {
  // 先刷新，拿到最新可用模型
  const rr = await ft.refreshAll();
  console.log('refresh:', JSON.stringify(rr).slice(0, 300), '\n');

  for (const tier of [1, 2, 3]) {
    console.log('=== tier', tier, '候选:', ft.candidates({ tier }).join(','), '===');
    const r = await ft.chat({
      tier,
      messages: [{ role: 'user', content: '用一句话说明什么是"边际成本"。' }],
      temperature: 0.3
    });
    if (r.ok) {
      console.log('  ✅', r.providerName + '/' + r.model, '(' + r.elapsed + 'ms)');
      console.log('  →', String(r.content).replace(/\s+/g, ' ').slice(0, 100));
    } else {
      console.log('  ❌', r.error);
      (r.tried || []).forEach(t => console.log('     ·', t.id, '→', t.error));
    }
  }
  console.log('\n--- 健康状态 ---');
  ft.status().providers.filter(p => p.hasKey).forEach(p =>
    console.log(p.name.padEnd(22), 'ok', p.ok, 'fail', p.fail, 'lat', p.latencyMs + 'ms', 'usable', p.usable));
})();
