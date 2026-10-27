// 一次性自检：free-tier 模块加载 + 状态输出
const ft = require('./core/free-tier');
console.log('--- 加载 OK ---');
const st = ft.status();
console.log('providers:', st.totalProviders, '| 模型(种子/发现):', st.totalModels, '| 当前可用:', st.usableProviders, '| 每日免费额度:', st.freeDailyQuota);
console.log('--- 各通道 ---');
st.providers.forEach(p => {
  console.log(
    (p.hasKey ? '[有Key]' : '[无Key]').padEnd(7),
    p.name.padEnd(24),
    '模型', String(p.modelCount).padStart(3),
    '| 可用', p.usable ? 'Y' : 'N',
    '| 冷却', p.cooling ? 'Y' : 'N',
    '| 延迟', String(p.latencyMs).padStart(5) + 'ms',
    '|', p.env
  );
});
console.log('--- 轮换候选(tier=2) ---');
console.log(ft.candidates({ tier: 2 }));
console.log('--- 候选(tier=3 强) ---');
console.log(ft.candidates({ tier: 3 }));
const g = ft.grantStatus('selftest-visitor');
console.log('--- 免费赠量 ---', JSON.stringify(g));
