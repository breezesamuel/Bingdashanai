const wf = require('C:/Users/Think/project/BingDashan/core/workflow16');

(async () => {
  for (let i = 1; i <= 3; i++) {
    console.log('\n══════════ 第 ' + i + ' 轮 ══════════');
    const t0 = Date.now();
    const r = await wf.runRound();
    const ms = Date.now() - t0;
    console.log('pass=' + r.pass + ' fail=' + r.fail + ' 轮内耗时=' + r.totalDur + 'ms（墙钟 ' + ms + 'ms）');
    (r.logs || []).forEach((l, idx) => {
      const n = String(idx + 1).padStart(2, '0');
      const tag = l.ok ? (l.skipped ? '⏭️' : '✅') : '❌';
      let res = '';
      const x = l.result || {};
      if (l.skipped || x.skipped) res = '跳过：' + String(x.reason || 'circuit').slice(0, 60);
      else if (l.error) res = 'ERR: ' + l.error.slice(0, 60);
      else res = JSON.stringify(x).slice(0, 70);
      console.log('  ' + tag + ' ' + n + ' ' + String(l.name).padEnd(18) + String((l.dur || 0) + 'ms').padStart(8) + '  ' + res);
    });
  }
  console.log('\n结论：fail=' + (require('C:/Users/Think/project/BingDashan/core/store').read().workflow16 || [])[0].fail);
})();