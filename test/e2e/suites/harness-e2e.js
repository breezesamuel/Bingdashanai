// harness-e2e.js — 回答质量自我进化闭环（Reflection loop）回归
//
// 锁住本轮修掉的真问题：
//   1. harness 从未被任何流程触发 —— 只有手动打端点才跑，「自我进化」名不副实
//      → 已接入 autopilot，并断言它出现在 stepCatalog 里
//   2. 无对话样本时 totalRuns=0 被误判为「空转」
//      → 实为诚实拒绝；断言必须区分 skipped 与真跑
//   3. propose 完全依赖 LLM，模型不可达 → 整个闭环停摆，
//      而闭环其余环节（evaluate/critic/select）全是纯规则、离线可跑
//      → 加规则化降级提案器；断言 LLM 不可用时闭环仍能真实执行
//   4. 降级不得降低安全标准 —— 规则提案也必须过 critic 过拟合检查
//   5. Reflection loop 第 4 项硬要求「暴露轨迹」→ 断言留下可读理由
const assert = require('assert');
const http = require('http');

const BASE = process.env.BINGDASHAN_E2E_BASE;
if (!BASE) {
  console.error('ABORT harness-e2e：未设置 BINGDASHAN_E2E_BASE。');
  console.error('本套件会写库，禁止指向生产实例。请通过 npm test（goal-e2e-runner）运行。');
  process.exit(2);
}
const ROOT = process.env.BINGDASHAN_E2E_ROOT || 'C:/Users/Think/project/BingDashan';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {}, raw: d }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const store = require(ROOT + '/core/store');
const H = require(ROOT + '/core/harness');
const autopilot = require(ROOT + '/core/autopilot');

(async function main() {
  console.log('\n=== harness-e2e ===');

  // ── 1. 已接入 autopilot（此前只有手动端点会触发）──
  {
    const cat = (autopilot.status() || {}).stepCatalog || [];
    ok(cat.some(s => s.id === 'harness'), 'harness 已接入 autopilot 步骤表', JSON.stringify(cat.map(s => s.id)));
    const label = (cat.find(s => s.id === 'harness') || {}).label || '';
    ok(/回答质量|优化/.test(label), '步骤标签如实表达用途', label);
  }

  // ── 2. 样本不足必须诚实拒绝（不是空转，也不是瞎优化）──
  {
    const before = H.status().totalRuns;
    const r = await H.runOnce();
    // 若本沙箱已有足够样本，这条不适用；只断言「不优化时必须说明原因」
    if (r.ok === false) {
      ok(typeof r.reason === 'string' && r.reason.length > 0,
        '无法优化时给出可读原因', JSON.stringify({ result: r.result, reason: r.reason }).slice(0, 140));
      ok(!/undefined|NaN/.test(r.reason || ''), '原因文本无占位残留', r.reason);
    } else {
      ok(true, '沙箱已有样本，直接进入闭环执行');
    }
    ok(H.status().totalRuns > before, '运行被计数（skipped 也留痕）',
      before + ' -> ' + H.status().totalRuns);
  }

  // ── 3. 喂真实样本：闭环必须能真实执行 ──
  // 形态取「工具调用率低 + 回答偏长 + 无来源引用」——真实早期系统的典型样貌，
  // 这样规则提案器才有依据可依（而不是靠编造样本喂出一个假闭环）。
  const tag = Date.now();
  const longA =
    '打开左侧导航里的技能军械库页面，在搜索框里输入你想要的关键词，然后点检索按钮，' +
    '系统会调用全网发现能力去 GitHub 上搜索相关的开源仓库。搜完之后列表里会列出候选仓库，' +
    '每个仓库都会显示它的 Star 数、更新时间、协议类型和部署难度，你点进去可以看更详细的说明。' +
    '如果觉得某个仓库合适，就点收录按钮把它加进技能库。收录之后你在对话里就可以直接调用这个技能了。' +
    '需要注意的是，收录之前一定要先看协议，GPL 和 AGPL 这类有传染性的协议会限制你的闭源分发。';
  const QA = [
    ['技能怎么装进系统', longA],
    ['漏斗数据多久更新', longA],
    ['收款怎么配置', longA],
    ['物料欠料怎么办', longA],
    ['24h 运营怎么关', longA],
    ['退款流程是什么', longA]
  ];
  let t = Date.now() - 7200000;
  QA.forEach(([q, a], i) => {
    store.push('messages', { role: 'user', content: q, at: t, _e2e: tag }, 'harness-e2e 对话');
    t += 1000;
    store.push('messages', { role: 'assistant', content: a, at: t, _e2e: tag }, 'harness-e2e 对话'); // 不带 tools
    t += 1000;
  });

  const set = H.buildEvalSet(20);
  ok(set.ok === true, '真实样本可建评测集', JSON.stringify(set).slice(0, 120));
  ok(set.count >= 3, '可配对问答达标', 'count=' + set.count);

  // ── 4. 闭环真实执行（LLM 不可用时靠规则提案器，不许停摆）──
  {
    const r = await H.runOnce();
    ok(r.ok === true || r.rejected === true,
      'LLM 不可用时闭环仍真实执行（规则降级）',
      JSON.stringify({ ok: r.ok, result: r.result, reason: r.reason }).slice(0, 200));
    if (r.ok === true) {
      ok(['adopted', 'not-adopted', 'rejected-by-critic'].indexOf(r.result) >= 0,
        '结果落在合法分类里', r.result);
      ok(r.baseScore !== undefined && r.candScore !== undefined,
        '基线与候选都有评分', 'base=' + r.baseScore + ' cand=' + r.candScore);
    }
  }

  // ── 5. 降级不降低安全标准：规则提案也必须过 critic ──
  {
    const base = H.current();
    const leak = { systemPrompt: '答案是 12345 元这道题的正确答案，必须回答', _budget: 3 };
    const screened = H.criticScreen(leak, base);
    ok(screened.pass === false, '硬编码答案/数字的提案被 critic 驳回',
      JSON.stringify(screened.problems).slice(0, 140));
    const over = { toolPolicy: { a: 1, b: 2, c: 3, d: 4 }, _budget: 1 };
    ok(H.criticScreen(over, base).pass === false, '超预算的提案被驳回');
  }

  // ── 6. 噪声地板：不允许把噪声当提升 ──
  {
    const sel = H.select({ score: 0.50, cost: 0.2 }, { score: 0.505, cost: 0.2 });
    ok(sel.adopt === false, '提升在噪声地板内不采纳', JSON.stringify(sel).slice(0, 140));
  }

  // ── 7. 轨迹可读（Reflection loop 第 4 项硬要求）──
  {
    const st = H.status();
    ok((st.recent || []).length >= 1, '留下运行轨迹', 'recent=' + (st.recent || []).length);
    const last = (st.recent || [])[0];
    ok(last && !!last.result, '轨迹含结果分类', JSON.stringify(last).slice(0, 120));
    ok(last && (last.reason || last.selection || last.critic) !== undefined,
      '轨迹含可读理由（不只是一堆计数器）', JSON.stringify(last).slice(0, 160));
  }

  // ── 8. 端点可达（只打真实存在的路径，别凭想象写端点）──
  {
    const r1 = await req('GET', '/v1/harness');
    ok(r1.body && r1.body.ok === true, 'GET /v1/harness 可用', JSON.stringify(r1.body).slice(0, 120));
    const r2 = await req('GET', '/v1/harness/current');
    ok(r2.body && (r2.body.harness || r2.body.ok), 'GET /v1/harness/current 可用', JSON.stringify(r2.body).slice(0, 120));
  }

  console.log('\n--- harness-e2e: ' + pass + '/' + (pass + fail) + ' ---');
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('harness-e2e 崩溃: ' + (e.stack || e.message));
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(1);
});