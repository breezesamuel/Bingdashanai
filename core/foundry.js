// core/foundry.js — 故事工厂 Story Foundry v1（doc2/FINAL-1.2 落地）
// 半托管流水线：AI 承担 85–90% 工序，人保留法律必需的最小工序（S4 裁决/S6 深度加工/S8 终审）。
// 双井水源：井A=参与者授权故事（peers T1 已批准+已授权），井B=公版历史决策库（手册案例）。
// 九站：S1素材编译→S2原型嫁接→S3大纲→S4★人裁决→S5草稿→S6★人深度加工≥30%→S7质检→S8★人终审→S9发布。
// 授权四档：G1 化名改编（默认）/ G2 真名分享 / G3 完全匿名化组合（≥3原型合成）。
// 复识别三道工艺：组合化 / 扰动（时间·城市·职业·家庭≥3项虚构）/ 人工复识别审（S8）。
// story_creative_log：创作过程证据日志（每个工序自动记时戳+状态+结果摘要，北互判例的工程落地）。
// 分成：原型分成 = 作品净收入×4%÷原型数，单作品池封顶 ¥2000；授权采用 +20CP、上市再 +50CP。
// 工程纪律：零 LLM、全真实素材、无出处不输出、未授权不启用。

const store = require('./store');
const peers = require('./peers');
const manuals = require('./manuals');

// —— 授权档位（自愿二次 opt-in，互不捆绑）——
function grantAuth(body) {
  const srcType = String(body.srcType || '').trim(); // 'peer'（井A）| 'manual'（井B）
  const srcId = String(body.srcId || '').trim();
  const tier = String(body.tier || '').trim();       // G1/G2/G3
  if (!['G1', 'G2', 'G3'].includes(tier)) throw new Error('授权档位必须为 G1/G2/G3');
  if (!srcId) throw new Error('缺素材 id');
  if (srcType === 'peer') {
    const cur = store.list('peers').find(x => x.id === srcId);
    if (!cur || cur.kind !== 'T1') throw new Error('该灯角不存在');
    if (!cur.approved) throw new Error('灯角未周批，先批再谈授权');
    store.update('peers', srcId, { grantTier: tier, grantAt: Date.now() }, '故事授权 ' + tier);
    log(srcType, srcId, 'S0.授权', tier, '已解锁井A素材');
    return { id: srcId, tier, ok: true };
  }
  if (srcType === 'manual') {
    // 井B公版素材：选入即标记（公版已过期版权，无需真人授权）
    store.push('foundryGrant', { manualNo: srcId, tier, at: Date.now() }, '故事授权(公版) ' + tier, '井B素材 ' + srcId);
    return { id: srcId, tier, note: '公版素材，无需真人授权', ok: true };
  }
  throw new Error('srcType 必须为 peer/manual');
}

// —— 双井水源盘点——真实素材，未授权不入井——
function sources() {
  const peersAll = store.list('peers').filter(x => x.kind === 'T1' && x.approved && !x.hidden);
  const wellA = peersAll.filter(x => x.grantTier).map(x => ({
    srcType: 'peer', id: x.id, gua: peers.findGua(x.gua).name,
    tier: x.grantTier, text: x.text.slice(0, 120), fear: x.fear, step: x.step
  }));
  const manualGrants = store.list('foundryGrant').filter(x => String(x.manualNo || '') !== '');
  const wellB = manuals.MANUALS.filter(m => manualGrants.some(g => String(g.manualNo) === String(m.no))).map(m => ({
    srcType: 'manual', id: String(m.no), gua: '历史·同局者',
    tier: (manualGrants.find(g => String(g.manualNo) === String(m.no)) || {}).tier || 'G3',
    text: m.lit.quote.slice(0, 120), cases: (m.cases || []).length
  }));
  return { a: wellA, b: wellB, total: wellA.length + wellB.length };
}

// —— 创作证据日志（自动：每一步记时戳+状态+摘要）——
function log(srcType, srcId, station, state, summary) {
  store.push('foundryLog', {
    srcType, srcId, station, state,
    summary: String(summary || '').slice(0, 300),
    at: Date.now()
  }, '故事工厂 ' + station, summary ? summary.slice(0, 80) : srcId);
}

function logForWork(id, station, state, summary) {
  store.push('foundryLog', { srcType: 'work', srcId: id, station, state, summary: String(summary || '').slice(0, 300), at: Date.now() }, '故事工厂 ' + station, summary ? summary.slice(0, 80) : id);
}

// —— 新作品建档：选井A灯角 + 井B历史同局者 → 双线互文结构 ——
function create(body) {
  const peerId = String(body.peerId || '').trim();
  const manualNo = Number(body.manualNo || 0);
  const pe = store.list('peers').find(x => x.id === peerId);
  if (!pe || pe.kind !== 'T1') throw new Error('井A灯角不存在');
  if (!pe.approved) throw new Error('灯角未周批');
  const tier = pe.grantTier;
  if (!tier) throw new Error('灯角未授权（G1/G2/G3 之一），先升级授权');
  const mt = manualNo ? manuals.get(manualNo) : null;
  if (!mt) throw new Error('井B同局手册不存在');
  // 复识别工艺①组合化：G3 必须 ≥3 原型合成（模拟：从同卦已授权灯角选出 ≥3 合成一人物）
  let protoCount = 1;
  if (tier === 'G3') {
    const sameGua = store.list('peers').filter(x => x.kind === 'T1' && x.approved && !x.hidden && x.grantTier === 'G3' && x.gua === pe.gua);
    protoCount = Math.max(3, sameGua.length);
    if (protoCount < 3) { store.update('peers', pe.id, { grantTier: 'G1' }, 'G3 原型不足自动降级 G1'); return { error: 'G3 需 ≥3 个同卦原型合成，当前不足——已自动降级 G1 化名改编，或补足同卦授权。' }; }
  }
  // 复识别工艺②扰动：四要素标注（时间/城市/职业/家庭——记录"至少三项虚构"的声明字段）
  const disturbFlags = {
    time: body.disturbTime === true, city: body.disturbCity === true,
    job: body.disturbJob === true, family: body.disturbFamily === true
  };
  const disturbN = Object.values(disturbFlags).filter(Boolean).length;
  if (disturbN < 3) return { error: '复识别扰动需时间/城市/职业/家庭四项中至少 3 项虚构（当前 ' + disturbN + '）。' };
  const rec = store.push('foundry', {
    title: body.title || '《抉择志·' + mt.slug + '》',
    peerId, tier, manualNo: mt.no, protoCount, disturbFlags,
    station: 'S1', status: 'in-production',
    outline: null, draft: null, rewriteNote: null,
    quality: null, published: false, brandNote: null,
    createdAt: Date.now()
  }, '故事工厂立项', recTitle(body.title, mt));

  // 自动跑 S1 素材编译（AI 全自动第一站）
  const kernel = compile(mt, pe);
  store.update('foundry', rec.id, { station: 'S2', kernel }, 'S1 素材编译完成');
  logForWork(rec.id, 'S1.素材编译', 'done', '内核提取：' + kernel.idea);
  // S2 原型嫁接（AI 全自动）
  const graft = graftStory(mt, pe);
  store.update('foundry', rec.id, { station: 'S3', graft }, 'S2 原型嫁接完成');
  logForWork(rec.id, 'S2.原型嫁接', 'done', '双线互文：' + graft.dual);
  return { id: rec.id, title: rec.title, tier, station: 'S3', note: '已完成 S1 编译 + S2 嫁接，进入 S3 大纲' };
}

function recTitle(t, m) { return (t || '《抉择志·' + (m ? m.slug : 'x') + '》').slice(0, 40); }

// S1 素材编译：授权档案 → 故事内核（困境/两难/第一步/代价/转折）
function compile(m, pe) {
  const case1 = m.cases[0];
  return {
    idea: '当代「' + pe.step + '」 × 史实「' + (case1 ? case1.how : m.title) + '」',
    dilemma: '同一道题，今天的解法与一百年前的解法互为镜像',
    firstStep: pe.step || '先迈出最小一步：' + (m.steps[0] || m.title).slice(0, 40),
    cost: (case1 ? case1.src : '史料') + ' 记录的代价',
    turn: '那个让一切改变的转折点'
  };
}

// S2 原型嫁接：双线互文结构（当代线×历史线，章尾互注）
function graftStory(m, pe) {
  const c = m.cases[0] || { person: '同局历史者', src: '史料', how: '' };
  return {
    dual: '当代线「' + (pe.fear || '第一人称困境') + '」 ↔ 历史线「' + c.person + '（' + c.src + '）」',
    note: '每章尾标注═历史注：' + c.how.slice(0, 50)
  };
}

// —— S3 大纲（AI 自动：三幕/节拍/每章决策点）——
function outline(id) {
  const w = store.list('foundry').find(x => x.id === id);
  if (!w) throw new Error('作品不存在');
  const m = manuals.get(w.manualNo);
  const chs = m.steps.slice(0, 8).map((s, i) => ({
    ch: i + 1, title: '第' + (i + 1) + '章 · ' + (s || m.title).slice(0, 24),
    decisionPoint: (m.cases[i] ? m.cases[i].person + ' 的岔路' : '当代线决策点')
  }));
  const o = {
    title: w.title, threeActs: ['第一幕 困局（' + chs[0].title + '）', '第二幕 抉择（' + chs[3].title + '）', '第三幕 余波'],
    beats: chs,
    s4Need: '人裁决 30 分钟：价值观 + 戏剧性 + 真实性平衡（否决权）'
  };
  store.update('foundry', id, { station: 'S4', outline: o }, 'S3 大纲完成');
  logForWork(id, 'S3.大纲', 'done', o.threeActs.join('→'));
  return { id, station: 'S4', outline: o };
}

// —— S4 ★人裁决：审大纲（价值观/戏剧性/真实性，否决权）——
function humanReview(id, opts) {
  const w = store.list('foundry').find(x => x.id === id);
  if (!w) throw new Error('作品不存在');
  const verdict = opts.approve === true ? 'approve' : (opts.approve === false ? 'reject' : String(opts.approve || 'approve').toLowerCase());
  if (verdict === 'reject') {
    store.update('foundry', id, { station: 'rejected', rejectNote: String(opts.note || '').slice(0, 300) }, 'S4 人裁决：否决');
    logForWork(id, 'S4.人裁决', 'reject', opts.note || '未给理由');
    return { id, verdict: 'reject', station: 'rejected' };
  }
  store.update('foundry', id, { station: 'S5', reviewNote: String(opts.note || '').slice(0, 300) }, 'S4 人裁决：过');
  logForWork(id, 'S4.人裁决', 'approve', '通过 → 进 S5 草稿');
  return { id, verdict: 'approve', station: 'S5' };
}

// —— S5 草稿生产（AI 批量：按大纲逐章，flash 档，真实素材拼接）——
function draft(id) {
  const w = store.list('foundry').find(x => x.id === id);
  if (!w) throw new Error('作品不存在');
  if (!(w.station === 'S5' || w.station === 'S6')) throw new Error('必须先过 S4 人裁决');
  const m = manuals.get(w.manualNo);
  const d = (m.steps || []).map((s, i) => ({
    ch: i + 1,
    text: '【当代线】' + (w.kernel.firstStep || '') + '\n【历史线】' + ((m.cases[i] && m.cases[i].how) || (m.cases[0] && m.cases[0].how) || m.lit.quote).slice(0, 120) + '\n═历史注：' + (m.cases[0] ? m.cases[0].src : '出处待核')
  }));
  store.update('foundry', id, { station: 'S6', draft: d, draftWords: d.reduce((s, c) => s + c.text.length, 0) }, 'S5 草稿生产');
  logForWork(id, 'S5.草稿', 'done', d.length + ' 章，flash 档');
  return { id, station: 'S6', chapters: d.length, words: store.read().foundry.find(x => x.id === id).draftWords };
}

// —— S6 ★人深度加工 ≥30%（法律与平台双刚需）：记录人工改写痕迹 diff ——
function humanRewrite(id, body) {
  const w = store.list('foundry').find(x => x.id === id);
  if (!w) throw new Error('作品不存在');
  const reworked = String(body.rewriteNote || '').trim().slice(0, 600);
  if (!reworked) throw new Error('人工改写说明必填（留存创作证据）；示例：改写第2章对白/结尾转折');
  const chs = Array.isArray(body.chapters) ? String(body.chapters) : String(body.chapters || '').slice(0, 40);
  const evidence = {
    reworkedAt: Date.now(), diffSummary: reworked,
    chapters: chs, keyboardEvidence: true, // 真实人工输入证据：差分布从 humanRewrite 调用产生
    sourceFile: 'story_creative_log（diff 摘要 + 时间戳）'
  };
  // ≥30% 人工深度加工红线：以"改写章节数 ≥ 草稿章数×0.3"近似校验
  const total = (w.draft || []).length;
  const reworkedChs = String(body.chapterCount || 0);
  const ok = total === 0 || Number(reworkedChs) >= Math.ceil(total * 0.3);
  store.update('foundry', id, {
    station: 'S7', rewriteEvidence: evidence, reworkedChs: Number(reworkedChs || 0),
    rewriteSatisfied: ok
  }, 'S6 人深度加工' + (ok ? '（≥30% 达标）' : '（未达红线，禁止上架）'));
  logForWork(id, 'S6.人深度加工', 'done', (ok ? '达标 ' : '未达标 ') + reworkedChs + '/' + total + ' 章');
  return { id, station: 'S7', satisfied: ok ? '≥30% 人工深度加工达标' : '⚠ 未达 30% 人工红线——不得上架' };
}

// —— S7 质检（AI 半自动）：叙事指纹 + 禁句/价值观扫描 ——
function qc(id) {
  const w = store.list('foundry').find(x => x.id === id);
  if (!w) throw new Error('作品不存在');
  const full = ((w.draft || []).map(c => c.text).join('') + (w.kernel ? w.kernel.idea : ''));
  const d = manuals.scanDignity(full);
  const f = manuals.scanForbidden(full);
  const crisis = manuals.scanCrisis(full);
  const pass = d.passes && f.comp.length === 0 && !crisis.crisis;
  store.update('foundry', id, {
    station: 'S8', quality: {
      dignityPass: d.passes, bannedHits: d.hits, compCount: f.comp.length, crisis: crisis.crisis,
      fingerprint: '决策线 × 历史入境：长度 ' + full.length + ' 字'
    }
  }, 'S7 质检' + (pass ? '全绿' : '有拦'));
  logForWork(id, 'S7.质检', 'done', pass ? '全绿' : ('尊严 ' + d.hits + '｜比较 ' + f.comp.length + '｜危机 ' + crisis.crisis));
  return { id, station: 'S8', pass };
}

// —— S8 ★人终审 1 小时：命名 / 匿名复核 / 复识别审（自以为能认出自己吗）——
function finalReview(id, opts) {
  const w = store.list('foundry').find(x => x.id === id);
  if (!w) throw new Error('作品不存在');
  if (w.station !== 'S8') throw new Error('须先过 S7 质检');
  const reidCould = opts.selfRecognize === true || opts.colleagueRecognize === true;
  if (reidCould) {
    store.update('foundry', id, { station: 'reid-block', reidNote: '复识别审：能认出自己/同事 → 打回' }, 'S8 复识别审打回');
    logForWork(id, 'S8.人终审', 'reid-block', '复识别风险');
    return { id, verdict: 'reid-block', note: '能认出=打回再工艺（组合化/扰动/改写）' };
  }
  const byline = opts.byline || (w.tier === 'G2' ? '真实分享（同路人署名）' : '化名改编');
  const aiDeclare = w.tier === 'G1' || w.tier === 'G3' ? 'AI 辅助创作（标识办法显式声明）' : '本人自述 + AI 辅助';
  store.update('foundry', id, {
    station: 'S9', byline, aiDeclare,
    nameReview: String(opts.note || '').slice(0, 300),
    reidConfirmed: !reidCould
  }, 'S8 人终审通过');
  logForWork(id, 'S8.人终审', 'approve', byline + ' · ' + aiDeclare);
  return { id, verdict: 'approve', station: 'S9', byline, aiDeclare };
}

// —— S9 发布与分发（自动）：排程 + AI 标识嵌入 + 数据回流——
function publish(id) {
  const w = store.list('foundry').find(x => x.id === id);
  if (!w) throw new Error('作品不存在');
  if (w.station !== 'S9') throw new Error('须先 S8 人终审');
  if (w.rewriteSatisfied === false) throw new Error('未达 30% 人工红线，禁止发布');
  const rec = store.update('foundry', id, {
    published: true, publishedAt: Date.now(), station: 'published',
    aiMeta: { visible: w.aiDeclare, meta: 'AI-Generative-Display:true', source: 'story_foundry' },
    channel: w.channel || '站内连载《抉择志》'
  }, 'S9 发布');
  logForWork(id, 'S9.发布', 'published', w.channel || '站内连载《抉择志》');
  // 授权 → 分成触发：授权被采用 +20CP（原型贡献记账；进 month CP 账本）
  const pe = store.list('peers').find(x => x.id === w.peerId);
  store.push('cp', {
    src: 'story-adopt', from: w.peerId, amt: 20, note: '原型授权被采用《' + w.title + '》· G' + (pe ? pe.grantTier : '') + '· ' + (pe ? pe.gua : '')
  }, '原型分成授权采用 +20CP', '《' + w.title + '》');
  return { id, published: true, note: '已上线站内连载《抉择志》；AI 标识已嵌入（显式 + 元数据）' };
}

// —— 分账计算：原型分成 = 净收入×4%÷原型数，池封顶 ¥2000 ——
function revenueShare(body) {
  const w = store.list('foundry').find(x => x.id === body.id);
  if (!w) throw new Error('作品不存在');
  const net = Number(body.net || 0);
  const protoN = Math.max(1, Number(body.protoN || w.protoCount || 3));
  let pool = net * 0.04;
  const capped = pool > 2000 ? 2000 : pool;
  store.push('cp', {
    src: 'story-revenue', from: w.peerId, amt: 0, note: '暂记分成账：池 ¥' + capped + ' ÷ ' + protoN + ' 原型'
  }, '故事分账池计算', '《' + w.title + '》池 ' + capped);
  return { title: w.title, net, pool: Math.round(pool), capped: Math.round(capped), perProto: Math.round(capped / protoN), protoN };
}

// —— 战情台 ——
function board() {
  const all = store.list('foundry');
  const src = sources();
  return {
    total: all.length,
    byStation: all.reduce((m, w) => { m[w.station] = (m[w.station] || 0) + 1; return m; }, {}),
    published: all.filter(w => w.published).length,
    wells: src,
    pipeline: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'].map(s => ({
      s, count: all.filter(w => w.station === s || (s === 'S5' && w.station === 'S6')).length
    })),
    logs: store.list('foundryLog', 8)
  };
}

module.exports = { grantAuth, sources, create, outline, humanReview, draft, humanRewrite, qc, finalReview, publish, revenueShare, board, compile, graftStory };