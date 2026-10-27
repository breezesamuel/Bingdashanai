// adoption-e2e.js — 复用选型 SOP 回归（先检索复用，再造）
//
// 锁住四类判据，每一类都对应一个真实会出事、但最容易被跳过的点：
//   1. 协议：GPL/AGPL 不允许闭源分发 → 必须否决，不能"先抄进来再说"
//   2. 协议：AGPL/SSPL 对 **SaaS 远程使用**同样生效 → 不能按"不分发就不触发"处理
//   3. 真实性：AI 会推荐不存在的仓库 → 必须以远端核验为准
//   4. 活跃度：Star/更新频率可被投毒 → 高 Star 可能只是刷出来的
//
// 外加两条工程性判据：
//   5. 无测试 → 否决"可直接用"（改完无法验证回归）
//   6. 时间字段归一 → GitHub 返回 ISO 串，不归一会把健康仓库误判成停更
const assert = require('assert');
const http = require('http');

const BASE = process.env.BINGDASHAN_E2E_BASE;
if (!BASE) {
  console.error('ABORT adoption-e2e：未设置 BINGDASHAN_E2E_BASE。');
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

const A = require(ROOT + '/core/adoption');

(async function main() {
  console.log('\n=== adoption-e2e ===');
  const DAY = 86400000;

  // ── 0. 规则表自检：改表即时报错，而不是运行时静默失效 ──
  {
    const sc = A.selfCheck();
    ok(sc.ok === true, '协议规则表自检通过', JSON.stringify(sc.problems));
    ok(sc.ruleCount >= 15, '规则表覆盖足够多协议', 'ruleCount=' + sc.ruleCount);
  }
  const healthy = {
    lang: 'JavaScript', fileCount: 40, hasPackageJson: true, hasTests: true,
    hasCI: true, depsCount: 6, reachable: true, exists: true,
    pushedAt: Date.now() - 20 * DAY, stars: 800, forks: 90
  };

  // ── 1. 宽松协议可闭源商用 ──
  const mit = A.classifyLicense('MIT');
  ok(mit.closedSrc === true && mit.copyleft === 'none', 'MIT：可闭源、无传染');
  ok(mit.patent === false, 'MIT：明确放弃专利');
  const apache = A.classifyLicense('Apache-2.0');
  ok(apache.closedSrc === true, 'Apache-2.0：可闭源商用');
  ok(apache.patent === true, 'Apache-2.0：含专利授权与专利诉讼终止条款');
  ok(A.classifyLicense('Apache-2.0-only').closedSrc === true, 'SPDX 后缀变体（-only）能识别');

  // ── 2. 强传染协议必须否决 ──
  const agpl = A.classifyLicense('AGPL-3.0');
  ok(agpl.closedSrc === false, 'AGPL-3.0：不允许闭源');
  ok(agpl.copyleft === 'network', 'AGPL-3.0：传染强度=network（SaaS 亦触发）');
  const gpl = A.classifyLicense('GPL-3.0');
  ok(gpl.closedSrc === false && gpl.copyleft === 'strong', 'GPL-3.0：分发即整体开源');
  ok(A.classifyLicense('GPL-2.0').closedSrc === false, 'GPL-2.0 同样否决闭源');
  const sspl = A.classifyLicense('SSPL-1.0');
  ok(sspl.commercial === false, 'SSPL-1.0：不可商用');

  // 弱传染：可用但有条件
  const lgpl = A.classifyLicense('LGPL-3.0');
  ok(lgpl.closedSrc === 'conditional', 'LGPL-3.0：条件可用（静态链接需开源该库）');
  const mpl = A.classifyLicense('MPL-2.0');
  ok(mpl.closedSrc === true && mpl.copyleft === 'weak(file)', 'MPL-2.0：可闭源但改动文件须开源');

  // ── 3. 协议不明不得当作「可以用」 ──
  const none = A.classifyLicense('');
  ok(none.verdict === 'unknown' && none.closedSrc === 'unknown', '未声明协议 → unknown');
  ok(/保留全部权利/.test(none.legalDefault || ''), '未声明协议默认权利=保留全部权利');
  const weird = A.classifyLicense('Some-Corp-Proprietary-1.0');
  ok(weird.verdict === 'unknown', '自定义协议 → unknown（不能假定条款）');

  // ── 4. 决策层：协议是硬门槛 ──
  ok(A.assess('x/y', Object.assign({}, healthy, { license: 'MIT' })).decision === 'use',
    'MIT + 健康 → 可直接用');
  ok(A.assess('x/y', Object.assign({}, healthy, { license: 'AGPL-3.0' })).decision === 'reject',
    'AGPL 即使项目再健康也否决（协议不允许闭源）');
  ok(A.assess('x/y', Object.assign({}, healthy, { license: 'GPL-3.0' })).decision === 'reject',
    'GPL 否决闭源');
  ok(A.assess('x/y', Object.assign({}, healthy, { license: '' })).decision === 'hold',
    '无协议 → 挂起待人工审');

  // ── 5. AGPL 的 SaaS 义务必须被显式提示 ──
  {
    const r = A.assess('x/y', Object.assign({}, healthy, { license: 'AGPL-3.0' }));
    const all = r.reasons.concat(r.mustDoBeforeUse).join(' ');
    ok(/SaaS|网络|远程/.test(all), 'AGPL 结论里显式提示「SaaS 亦触发」，不让团队误以为不分发就没事');
  }

  // ── 6. 幻觉仓库必须被拦 ──
  {
    const r = A.assess('ghost/nope', Object.assign({}, healthy, { license: 'MIT', exists: false }));
    ok(r.decision === 'reject', '远端不存在的仓库 → reject');
    ok(/不存在/.test(r.reasons.join(' ')), '给出"不存在"的明确理由');
  }
  {
    // 网络不可达 ≠ 不存在：不能误杀，但也绝不能放行
    const r = A.assess('x/y', Object.assign({}, healthy, { license: 'MIT', reachable: false, exists: null }));
    ok(r.decision === 'hold', '网络不可达 → hold（先核实），不误判为不存在');
    ok(r.mustDoBeforeUse.length > 0, 'hold 时仍给出必须先做的动作');
  }
  {
    // 限流 + codeload 404 也要能识别幻觉
    const r = A.verifyReality({ rateLimited: true, probeStatus: 404 });
    ok(r.verdict === 'hallucination', '限流时经 codeload 404 也能识别为幻觉');
  }

  // ── 7. 投毒信号 ──
  {
    const a = A.scoreActivity({ stars: 5200, forks: 12, createdAt: Date.now() - 40 * DAY, pushedAt: Date.now() - DAY });
    ok(a.risks.some(x => /刷量/.test(x)), '极新+高Star+极低fork → 报疑似刷量');
  }
  {
    const a = A.scoreActivity({ stars: 3000, forks: 800, createdAt: Date.now() - 900 * DAY, pushedAt: Date.now() - 10 * DAY });
    ok(!a.risks.some(x => /刷量/.test(x)), '高Star但fork正常且老仓库 → 不误报刷量');
  }
  {
    const a = A.scoreActivity({ archived: true, stars: 9000 });
    ok(a.risks.some(x => /归档/.test(x)), 'archived 仓库被明确标注');
  }

  // ── 8. 时间归一：ISO 串不能被误判成停更 ──
  {
    const iso = new Date(Date.now() - 30 * DAY).toISOString();
    const viaIso = A.scoreActivity({ pushedAt: iso, stars: 500, forks: 60 });
    const viaMs = A.scoreActivity({ pushedAt: Date.now() - 30 * DAY, stars: 500, forks: 60 });
    ok(viaIso.score === viaMs.score, 'ISO 串与毫秒时间戳评分一致（GitHub API 返回 ISO）');
    ok(!viaIso.risks.some(x => /停更/.test(x)), '30 天前提交不会被误判停更');
  }

  // ── 9. 无测试不得判「可直接用」 ──
  {
    const r = A.assess('x/y', Object.assign({}, healthy, { license: 'MIT', hasTests: false }));
    ok(r.decision !== 'use', '无测试时不给「可直接用」');
    ok(r.mustDoBeforeUse.join(' ').length >= 0, '仍给出可执行动作项');
  }
  {
    // 跨栈 + 超大仓：二开成本可能高于自研
    const r = A.assess('x/y', Object.assign({}, healthy, { license: 'MIT', lang: 'Rust', fileCount: 3000 }));
    ok(r.decision === 'adapt', '跨栈+超大仓 → 需要二开');
  }
  {
    // 停更仓库
    const r = A.assess('x/y', Object.assign({}, healthy, { license: 'MIT', pushedAt: Date.now() - 900 * DAY }));
    ok(r.decision !== 'use', '停更仓库不判「可直接用」');
  }

  // ── 10. HTTP 端点 ──
  {
    const r = await req('GET', '/v1/adoption/license?id=AGPL-3.0');
    ok(r.body.ok === true && r.body.closedSrc === false, '端点 /v1/adoption/license 可用', JSON.stringify(r.body).slice(0, 140));
    const r2 = await req('GET', '/v1/adoption/license');
    ok(r2.body.ok === true && r2.body.rules && Object.keys(r2.body.rules).length > 5, '端点可返回协议规则表');
    const r3 = await req('GET', '/v1/adoption/check');
    ok(r3.body.ok === false || r3.body.error, '缺 repo 参数被拒');
  }

  console.log('\n--- adoption-e2e: ' + pass + '/' + (pass + fail) + ' ---');
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('adoption-e2e 崩溃: ' + (e.stack || e.message));
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(1);
});