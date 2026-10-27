// test/e2e/suites/lightning-e2e.js — Agent Lightning 式「模型代理层」的本地实现守卫
//
// 守护的纪律：
//   1. 奖励函数是**可计算的**（不是摆设）：task_done / no_error / fast / few_steps + composite 加权。
//   2. 一次 rollout 的轨迹必须真的落盘（JSONL）且可回放：模型调用 + 工具调用都记。
//   3. 代理层不改 agent 业务代码：proxyRaw 走 OpenAI 兼容通道，原样回传上游 JSON 并留痕。
//   4. 训练样本（dataset）能导出：一条 rollout = (轨迹, 奖励) 可喂外部 RL 管线。
//   5. 全链路运营级鉴权：无令牌 403（代理层会用本机密钥出站，绝不对买家开放）。
// 诚实边界：真正的 RL 训练（verl+vLLM+CUDA）不在本机跑，本套件只验证"可落地的那半"。
const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');

const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;   // 必须在 require store/lightning 之前
const lightning = require(ROOT + '/core/lightning');
const providers = require(ROOT + '/core/providers');
const BASE = requireIsolated('lightning-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
const T = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : ';')); };

async function req(method, p, body, withToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (withToken && ADMIN) headers['X-Admin-Token'] = ADMIN;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { status: r.status, json: j, text: txt };
}

(async () => {
  const timer = setTimeout(() => { console.log('FAIL lightning suite timeout'); process.exit(1); }, 90000);
  try {
    // ---------- 1. 奖励函数：纯逻辑 ----------
    T('task_done 成功=1', lightning.scoreSignals({ success: true }, { fn: 'task_done' }).reward === 1);
    T('task_done 失败=0', lightning.scoreSignals({ success: false }, { fn: 'task_done' }).reward === 0);
    T('no_error 无错=1', lightning.scoreSignals({ errors: 0 }, { fn: 'no_error' }).reward === 1);
    T('no_error 有错=0', lightning.scoreSignals({ errors: 2 }, { fn: 'no_error' }).reward === 0);
    T('fast 零延迟=1', lightning.scoreSignals({ latencyMs: 0 }, { fn: 'fast' }).reward === 1);
    T('fast 30s 封顶=0', lightning.scoreSignals({ latencyMs: 30000 }, { fn: 'fast' }).reward === 0);
    T('fast 超过 30s 夹到 0（不为负）', lightning.scoreSignals({ latencyMs: 999999 }, { fn: 'fast' }).reward === 0);
    T('few_steps 零调用=1', lightning.scoreSignals({ modelCalls: 0 }, { fn: 'few_steps' }).reward === 1);
    T('few_steps 20 次=0', lightning.scoreSignals({ modelCalls: 20 }, { fn: 'few_steps' }).reward === 0);
    const perfect = lightning.scoreSignals({ success: true, errors: 0, modelCalls: 0, toolCalls: 0, latencyMs: 0 });
    T('composite 全优=1', perfect.reward === 1, 'weights=' + JSON.stringify(lightning.DEFAULT_WEIGHTS));
    const bad = lightning.scoreSignals({ success: false, errors: 3, modelCalls: 12, latencyMs: 20000 });
    T('composite 失败<1 且>0', bad.reward < 1 && bad.reward > 0, 'reward=' + bad.reward);
    T('composite 返回分项 parts', !!(bad.parts && bad.parts.task_done !== undefined && bad.parts.no_error !== undefined));
    let threw = false;
    try { lightning.scoreSignals({}, { fn: 'not_a_fn' }); } catch (e) { threw = true; }
    T('未知奖励函数抛错', threw);

    // ---------- 2. rollout 生命周期（进程内）----------
    const r1 = lightning.startRollout({ kind: 'e2e', note: '代理层自检' });
    T('startRollout 返回 id', !!(r1 && r1.ok && r1.id), 'id=' + (r1 && r1.id));
    lightning.recordModelCall({ rolloutId: r1.id, provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }], content: '你好，我在', latencyMs: 120 });
    lightning.recordModelCall({ rolloutId: r1.id, provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: '再来' }], content: '', latencyMs: 80, error: '上游 500' });
    lightning.recordToolCall({ rolloutId: r1.id, name: 'case_search', args: { q: 'x' }, result: { n: 1 }, latencyMs: 15 });
    const r1full = lightning.getRollout(r1.id);
    T('recordModelCall 累计次数+延迟+错误', r1full.modelCalls === 2 && r1full.errors === 1 && r1full.latencyMs === 215,
      'calls=' + r1full.modelCalls + ' ms=' + r1full.latencyMs + '(120+80+tool15) err=' + r1full.errors);
    T('recordToolCall 累计工具次数', r1full.toolCalls === 1, 'tools=' + r1full.toolCalls);
    T('getRollout 带回轨迹事件（model/tool）', (r1full.events || []).some(e => e.type === 'model_call') && (r1full.events || []).some(e => e.type === 'tool_call'),
      'events=' + (r1full.events || []).length);
    const end1 = lightning.endRollout(r1.id, { success: false });
    T('endRollout 产出奖励(0..1)', end1.ok && end1.reward >= 0 && end1.reward < 1, 'reward=' + end1.reward);
    T('endRollout 奖励分项可解释', !!(end1.parts && end1.parts.task_done === 0 && end1.parts.no_error === 0), JSON.stringify(end1.parts));

    // 第二条：全成功、零延迟 → reward 应接近 1
    const r2 = lightning.startRollout({ kind: 'e2e' });
    const end2 = lightning.endRollout(r2.id, { success: true });
    T('成功且无错的 rollout 奖励=1', end2.reward === 1, 'reward=' + end2.reward);

    // 训练样本导出
    const ds = lightning.dataset(50);
    const s1 = ds.find(x => x.rolloutId === r1.id);
    T('dataset 含样本且带 reward', !!s1 && s1.reward === end1.reward, 'n=' + ds.length);
    T('dataset 样本带轨迹', !!s1 && Array.isArray(s1.trajectory) && s1.trajectory.length >= 3, 'traj=' + (s1 && s1.trajectory && s1.trajectory.length));
    const jsonl = lightning.datasetJsonl(50);
    const lines = jsonl.split('\n').filter(Boolean);
    let allParse = lines.length > 0;
    for (const l of lines) { try { JSON.parse(l); } catch (e) { allParse = false; } }
    T('datasetJsonl 每行合法 JSON', allParse, 'lines=' + lines.length);
    const st = lightning.stats();
    T('stats 统计 closed 数与奖励函数名', st.closed >= 2 && Array.isArray(st.rewardFns) && st.rewardFns.indexOf('task_done') >= 0,
      'closed=' + st.closed + ' fns=' + (st.rewardFns || []).join('/'));

    // ---------- 3. proxyRaw：零改代码代理（stub fetch，不打真网）----------
    const model = 'deepseek-chat';
    T('providerForModel 解析到服务商', !!(lightning.providerForModel(model) && lightning.providerForModel(model).base), (lightning.providerForModel(model) || {}).id);
    const origGetKey = providers.getKey, origFetch = global.fetch;
    providers.getKey = () => 'test-key';
    try {
      global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: '代理回包' } }] }) });
      const pr = lightning.startRollout({ kind: 'proxy' });
      const j = await lightning.proxyRaw({ model, messages: [{ role: 'user', content: 'hi' }] }, pr.id);
      T('proxyRaw 原样返回上游 OpenAI JSON', j && j.choices && j.choices[0].message.content === '代理回包');
      const prFull = lightning.getRollout(pr.id);
      T('proxyRaw 记录了这次模型调用', (prFull.events || []).some(e => e.type === 'model_call' && /代理回包/.test(e.content || '')),
        'events=' + (prFull.events || []).length);

      global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
      const pr2 = lightning.startRollout({ kind: 'proxy-fail' });
      let err2 = null;
      try { await lightning.proxyRaw({ model, messages: [] }, pr2.id); } catch (e) { err2 = e; }
      T('proxyRaw 上游非 2xx 时抛错并带 status', !!err2 && err2.status === 500, 'err=' + (err2 && err2.message));
      T('proxyRaw 失败也留痕（error 事件）', lightning.getRollout(pr2.id).errors >= 1, 'errs=' + lightning.getRollout(pr2.id).errors);
    } finally { providers.getKey = origGetKey; global.fetch = origFetch; }

    // ---------- 3.5 旁观者采集：不改 agent 代码，靠 AsyncLocalStorage 归轨迹 ----------
    const fsx = require('fs'), pthx = require('path');
    const store = require(ROOT + '/core/store');
    const jsonlPath = pthx.join(store.dataPath(), 'lightning.jsonl');
    const readLines = () => (fsx.existsSync(jsonlPath) ? fsx.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).length : 0);

    lightning.refreshSettings();
    T('采集默认开·正文默认关（隐私）', lightning.captureEnabled() === true && lightning.captureContent() === false,
      'on=' + lightning.captureEnabled() + ' content=' + lightning.captureContent());

    const _of = global.fetch, _og = providers.getKey;
    providers.getKey = () => 'test-key';
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '旁观者回包' } }] }) });
    try {
      await lightning.withRollout({ path: '/v1/ambient' }, async () => {
        await providers.chat({ provider: 'deepseek', messages: [{ role: 'user', content: '绝密正文A' }] });
        await providers.chat({ provider: 'deepseek', messages: [{ role: 'user', content: '绝密正文B' }] });
      });
    } finally { providers.getKey = _og; global.fetch = _of; }

    const amb = lightning.trajectories(200).filter(t => t.ambient);
    T('一次请求内的多次模型调用归到同一条(ambient)轨迹', amb.length >= 1 && amb[0].modelCalls === 2, 'mc=' + (amb[0] && amb[0].modelCalls));
    T('ambient 轨迹有 start/end 与可计算奖励', !!(amb[0] && amb[0].startedAt && amb[0].endedAt && amb[0].reward !== null),
      'reward=' + (amb[0] && amb[0].reward));
    const raw1 = fsx.existsSync(jsonlPath) ? fsx.readFileSync(jsonlPath, 'utf8') : '';
    T('默认不把用户对话正文写进轨迹（隐私红线）', raw1.indexOf('绝密正文A') < 0 && raw1.indexOf('绝密正文B') < 0);

    store.setSetting('lightningCaptureContent', true); lightning.refreshSettings();
    providers.getKey = () => 'test-key';
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '回' } }] }) });
    try {
      await lightning.withRollout({ path: '/v1/ambient2' }, async () => {
        await providers.chat({ provider: 'deepseek', messages: [{ role: 'user', content: '显式要记的正文' }] });
      });
    } finally { providers.getKey = _og; global.fetch = _of; }
    const raw2 = fsx.existsSync(jsonlPath) ? fsx.readFileSync(jsonlPath, 'utf8') : '';
    T('打开正文开关后才记正文（可训练）', raw2.indexOf('显式要记的正文') >= 0);
    store.setSetting('lightningCaptureContent', false); lightning.refreshSettings();

    store.setSetting('lightningCapture', false); lightning.refreshSettings();
    const beforeN = readLines();
    let ranFlag = false;
    const outOff = lightning.withRollout({ x: 1 }, () => { ranFlag = true; return 'ran'; });
    T('关闭采集：withRollout 照常执行', ranFlag === true && outOff === 'ran');
    T('关闭采集：不落盘任何记录', readLines() === beforeN, beforeN + '→' + readLines());
    store.setSetting('lightningCapture', true); lightning.refreshSettings();

    // ---------- 4. HTTP 路由（运营鉴权 + 端到端）----------
    const noTok = await req('GET', '/v1/lightning/stats', null, false);
    T('无管理令牌 /v1/lightning/stats → 403', noTok.status === 403, 'status=' + noTok.status);

    const sc = await req('POST', '/v1/lightning/score', { signals: { success: true, errors: 0, modelCalls: 0, latencyMs: 0 } }, true);
    T('HTTP score 全优=1', sc.status === 200 && sc.json && sc.json.reward === 1, JSON.stringify(sc.json));

    const hr = await req('POST', '/v1/lightning/rollout', { meta: { kind: 'http' } }, true);
    T('HTTP 开 rollout', hr.json && hr.json.ok && !!hr.json.id, JSON.stringify(hr.json));
    await req('POST', '/v1/lightning/tool', { rolloutId: hr.json.id, name: 'manual_get', ms: 3, latencyMs: 3 }, true);
    const he = await req('POST', '/v1/lightning/end', { id: hr.json.id, success: true }, true);
    T('HTTP 结束 rollout 得奖励', he.json && he.json.ok && he.json.reward >= 0, JSON.stringify(he.json));
    const hg = await req('GET', '/v1/lightning/rollout?id=' + encodeURIComponent(hr.json.id), null, true);
    T('HTTP 查 rollout 带回服务端写入的事件', hg.json && hg.json.ok && (hg.json.rollout.events || []).some(e => e.type === 'tool_call'),
      'events=' + (hg.json && hg.json.rollout && (hg.json.rollout.events || []).length));

    const hd = await req('GET', '/v1/lightning/dataset?format=jsonl&limit=200', null, true);
    T('HTTP dataset(JSONL) 非空且每行带 rolloutId', hd.status === 200 && hd.text.indexOf('"rolloutId"') >= 0, 'len=' + hd.text.length);

    const hs = await req('GET', '/v1/lightning/stats', null, true);
    T('HTTP stats 可用且含奖励函数表', hs.json && hs.json.ok !== false && Array.isArray(hs.json.rewardFns), JSON.stringify(hs.json && hs.json.rewardFns));

    const hlist = await req('GET', '/v1/lightning/rollouts?limit=5', null, true);
    T('HTTP rollouts 列表', hlist.json && Array.isArray(hlist.json.rollouts) && hlist.json.rollouts.length >= 1, 'n=' + (hlist.json && hlist.json.rollouts.length));

    const htraj = await req('GET', '/v1/lightning/trajectories?limit=5', null, true);
    T('HTTP trajectories 可用', htraj.status === 200 && htraj.json && Array.isArray(htraj.json.trajectories) && 'captureEnabled' in htraj.json,
      'status=' + htraj.status);
    const hcfg = await req('POST', '/v1/lightning/config', { content: false }, true);
    T('HTTP config 读回开关', hcfg.status === 200 && hcfg.json && hcfg.json.ok === true && hcfg.json.content === false, JSON.stringify(hcfg.json));
    const hcfgDenied = await req('POST', '/v1/lightning/config', { capture: true }, false);
    T('无令牌 /v1/lightning/config → 403', hcfgDenied.status === 403, 'status=' + hcfgDenied.status);

    console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
    clearTimeout(timer);
    return require('./_exit').finish(fail ? 1 : 0);
  } catch (e) {
    console.log('FAIL 套件异常: ' + (e && e.stack || e));
    console.log('===== ' + pass + ' PASS / ' + (fail + 1) + ' FAIL =====');
    clearTimeout(timer);
    return require('./_exit').finish(1);
  }
})();
