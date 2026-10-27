// 验证：在线动态发现（这是"不会过期"的关键）
const ft = require('./core/free-tier');
(async () => {
  for (const id of ['nvidia', 'github', 'ollama-local', 'openrouter']) {
    const r = await ft.discover(id);
    console.log(id.padEnd(14), JSON.stringify(r).slice(0, 220));
  }
})();
