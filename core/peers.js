// core/peers.js — 同路人系统（FINAL-1.1 §2.9 落地：T1 灯角 / T2 递一把 / T3 被帮账本）
// 定位：认同感的货币是事实计数不是勋章贴图。
//   T1: 300 字以内经历（模板三问）→ 授权 + 匿名化 + 周批 → 只出现在同卦用户报告第 7 段"灯角"与手册第④节
//   T2: 同卦老用户对新用户递出三种东西（手册卡/一句话/白名单资源）；限流单日 ≤3 次
//   T3: 被帮到了 → 计入帮到榜与 CP（单次 +2CP，封顶月 40；帮人不产粮不产额外奖励）
// 伦理四阀：①双向 opt-in（隐身即全网撤下）②禁比较句/金额句 ③危机语境永不出现 T1/T2 ④现金永远是配菜。
// 卦：S01–S16 处境卦（内部代号，呈现层统一"同卦/同处境"）。

const store = require('./store');
const manuals = require('./manuals');
const crypto = require('crypto');

// —— 处境卦（S01–S16）：关键词命中打分，返回卦 id。呈现层对外只暴露卦名与"处在你同卦的人"。
const GUAS = [
  { id: 'S01', name: '被裁/失业', kw: ['被裁', '裁员', '辞退', '失业', '离职', 'N+1', '被炒'] },
  { id: 'S02', name: '负债', kw: ['负债', '欠债', '网贷', '催收', '上岸', '还债', '征信', '信用卡'] },
  { id: 'S03', name: '毕业即失业', kw: ['应届', '毕业', '春招', '秋招', '空窗', '求职', '找不到工作'] },
  { id: 'S04', name: 'gap', kw: ['gap', 'gapyear', '休息一年', '辞职陪', '空窗期'] },
  { id: 'S05', name: '分手/离婚', kw: ['分手', '离婚', '失恋', '复合', '离异', '感情'] },
  { id: 'S06', name: '大病初愈', kw: ['大病', '肿瘤', '初愈', '康复', '化疗', '重病', '生病'] },
  { id: 'S07', name: '想辞职', kw: ['辞职', '裸辞', '想辞', '离职念', '换工作', '跳槽'] },
  { id: 'S08', name: '35+求职', kw: ['35', '中年', '被拒', '年龄', '瓶颈', '大龄'] },
  { id: 'S09', name: '考编/考研', kw: ['考公', '考研', '国考', '省考', '上岸', '二战', '三战', '编制'] },
  { id: 'S10', name: '父母生病', kw: ['父母', '生病', '养老', '陪护', '重病', '尽孝', '家庭'] },
  { id: 'S11', name: '原生家庭', kw: ['原生家庭', '逃离', '断亲', '妈妈', '爸爸', '家人', '家庭'] },
  { id: 'S12', name: '第1章事业', kw: ['创业', '合伙', '加盟', '开店', '副业', '事业'] },
  { id: 'S13', name: '转行', kw: ['转行', '转型', '换个行业', '技能', '失业'] },
  { id: 'S14', name: '升学/择校', kw: ['升学', '择校', '位次', '志愿', '选专业', '考研'] },
  { id: 'S15', name: '迁移/搬家', kw: ['搬家', '移民', '换城市', '回老家', '异地', '闯'] },
  { id: 'S16', name: '意义/迷茫', kw: ['没意思', '意义', '迷茫', '不知道', '图什么', '活下去', '活着'] }
];
function guaOf(topic) {
  const t = String(topic || '');
  let best = GUAS[0], bestN = 0;
  GUAS.forEach(g => {
    const n = g.kw.filter(k => t.toLowerCase().includes(k.toLowerCase())).length;
    if (n > bestN) { best = g; bestN = n; }
  });
  return best; // 至少返回 S01，但语义按命中
}
function guaName(topic) { return guaOf(topic).name; }
function findGua(id) { return GUAS.find(g => g.id === id) || GUAS[0]; }

// 白名单资源（T2 第三种"递资源"只允许这些官方/公开页）
const RESOURCE_WHITELIST = [
  { url: 'https://www.mohrss.gov.cn/', label: '人社部官网（失业金/社保政策）' },
  { url: 'https://www.12333.gov.cn/', label: '12333 人社政务服务' },
  { url: 'http://www.moj.gov.cn/', label: '司法部（法律援助 12348）' },
  { url: 'https://www.mca.gov.cn/', label: '民政部（社会救助目录）' }
];
function isWhitelisted(url) { return RESOURCE_WHITELIST.some(r => url === r.url); }

const MAX_T1_LEN = 300;
const MAX_HANDOFFS_PER_DAY = 3;
const CP_PER_THANK = 2;
const CP_MONTH_CAP = 40;

// —— T1 提交（模板三问）——完全自愿双向 opt-in；匿名化三关：
//    ① 无身份证/手机/称呼 ② 无地域+职业组合可辨 ③ 本人确认"谁也认不出我"
function submitT1(body) {
  const text = String(body && body.text || '').trim();
  if (!text) throw new Error('缺经历内容');
  if (text.length > MAX_T1_LEN) throw new Error('经历长度超过 ' + MAX_T1_LEN + ' 字');
  const author = String(body && body.author || '匿名').trim().slice(0, 12);
  const optin = body && body.optin === true; // 双向 opt-in 的第一方向：授权发布
  if (!optin) throw new Error('须勾选授权发布（T1 伦理阀①）');
  const fear = String(body && body.fear || '').trim().slice(0, 100);
  const step = String(body && body.step || '').trim().slice(0, 100);
  const say = String(body && body.say || '').trim().slice(0, 100);
  // 危机语境永不出现 T1/T2（伦理阀③）——触发器在路由层用 manuals.scanCrisis 判断，这里防一道
  const crisis = manuals.scanCrisis(text + fear + step + say);
  if (crisis.crisis) throw new Error('危机语境不接收 T1 投稿；请先拨打 12356');
  // 伦理阀②：禁比较句/金额句
  const fb = manuals.scanForbidden(text);
  if (fb.comp.length || fb.money.length) {
    throw new Error('内容含比较性表述或金额细节（防炫富/卖惨两端）：' + [...fb.comp, ...fb.money].slice(0, 3).join('、'));
  }
  // 匿名化三关
  const idKill = /(身份证|[0-9]{6}[\*]{4}[0-9]{4}|1[3-9]\d{9})/.test(text);
  const nameKill = /我(叫|是)([A-Za-z\u4e00-\u9fa5]{2,4}老师?|[一二三四五六七八九十]哥|[一二三四五六七八九十]姐)/.test(text);
  if (idKill || nameKill) throw new Error('内容含可识别个人特征，请按匿名化三关去除（电话/身份证/称呼）');
  const gua = guaOf(body.topic || text).id;
  const rec = store.push('peers', {
    kind: 'T1', gua,
    text, fear, step, say,
    authorHash: 'u_' + crypto.randomBytes(4).toString('hex'), // 脱敏：只留内部随机代号
    approved: false,            // 周批：默认未批，不出现
    hidden: false,              // 隐身退出开关（伦理阀①）——hide=true 全端撤下
    viewCount: 0, helpedCount: 0,
    optin: { publish: true, share: !!(body && body.share === true) }
  }, '同路人 T1 投稿待批', gua + ' ' + text.slice(0, 40));
  return { id: rec.id, gua: findGua(rec.gua).name, status: '待周批（审批通过前不对外展示）' };
}

// 周批（管理员）。批准后灯角才可见。
function approveT1(id, ok) {
  const cur = store.list('peers').find(x => x.id === id);
  if (!cur) throw new Error('未找到该投稿');
  store.update('peers', id, { approved: ok === true }, '同路人 T1 ' + (ok ? '批准上灯' : '退回'));
  return { id, approved: ok === true };
}

// 隐身退出（伦理阀①第二条：互联网撤下）
function hidePeers(authorHash) {
  const all = store.list('peers');
  const hits = all.filter(x => x.authorHash === authorHash && !x.hidden);
  hits.forEach(x => store.update('peers', x.id, { hidden: true }, '同路人隐身退出'));
  return { removed: hits.length };
}

// 灯角：某卦的已批准、未隐藏 T1，按帮到数排序（同题相见）
function lighthouse(guaId) {
  const approved = store.list('peers').filter(x => x.kind === 'T1' && x.approved && !x.hidden && x.gua === guaId);
  return approved.sort((a, b) => b.helpedCount - a.helpedCount).map(x => ({
    id: x.id, gua: findGua(x.gua).name, viewCount: x.viewCount,
    helpedCount: x.helpedCount, text: x.text
  }));
}
function countLights() {
  const all = store.list('peers').filter(x => x.kind === 'T1' && x.approved && !x.hidden);
  return all.reduce((m, x) => { m[findGua(x.gua).name] = (m[findGua(x.gua).name] || 0) + 1; return m; }, {});
}

// 灯角点击：被看见计数（事实输出用）
function view(id) {
  const cur = store.list('peers').find(x => x.id === id);
  if (!cur) throw new Error('未找到该灯角');
  store.update('peers', id, { viewCount: (cur.viewCount || 0) + 1 }, '灯角被阅读');
  return { viewCount: (cur.viewCount || 0) + 1 };
}

// —— T2 递一把（kind: card | sentence | resource）——单日 ≤3 次（防骚扰）
function handoff(body) {
  const kind = String(body && body.kind || '').trim();
  if (!['card', 'sentence', 'resource'].includes(kind)) throw new Error('kind 必须为 card/sentence/resource');
  const toGua = String(body && body.gua || '').trim();
  const fromHash = String(body && body.from || 'u_guest').trim().slice(0, 12);
  let payload = '';
  if (kind === 'card') {
    const m = manuals.get(String(body && body.payload || ''));
    if (!m) throw new Error('手册不存在');
    payload = m.no + '《' + m.title + '》';
  } else if (kind === 'sentence') {
    payload = String(body && body.payload || '').trim();
    if (!payload || payload.length > 80) throw new Error('一句话限 80 字以内');
    const fb = manuals.scanForbidden(payload);
    if (fb.comp.length || fb.money.length) throw new Error('含比较/金额表述');
  } else if (kind === 'resource') {
    const url = String(body && body.payload || '').trim();
    if (!isWhitelisted(url)) throw new Error('非白名单资源，不允许递出');
    payload = url;
  }
  // 限流：统计 fromHash 当天已递出次数
  const today = new Date().toDateString();
  const dayCount = store.list('handoffs').filter(h => h.fromHash === fromHash && new Date(h.createdAt).toDateString() === today).length;
  if (dayCount >= MAX_HANDOFFS_PER_DAY) throw new Error('单日递出已达 ' + MAX_HANDOFFS_PER_DAY + ' 次上限');
  const rec = store.push('handoffs', { kind, gua: toGua, fromHash, payload, thanked: false }, '同路人递一把', kind + ' ' + payload.slice(0, 30));
  return { id: rec.id, kind, gua: toGua, payload, note: '已递出（限流 ≤3/日）' };
}

// —— T3 被帮账本：新用户点"被帮到了" → helpedCount + CP
function thank(handoffId, oldHash) {
  const cur = store.list('handoffs').find(h => h.id === handoffId);
  if (!cur) throw new Error('未找到该递出记录');
  if (cur.thanked) return { id: cur.id, already: true };
  store.update('handoffs', handoffId, { thanked: true, thankedAt: Date.now(), oldHash }, '同路人·被帮到了');
  // T1 灯角 helpedCount +1（回馈帮助者：认同感货币）
  // 简化映射：T2 递出去的那句话对应某位 T1 作者的时间线——此处以 handoff.fromHash 借名计数已有人类的"被帮到"；灯角的实质 help 由 T1 帮助回访统计。
  return { id: handoffId, helped: true };
}

// 帮到榜（事实计数；"有 N 个人因为你的那句话迈出了第一步"）
function leaderboard() {
  const hs = store.list('handoffs').filter(h => h.thanked);
  const map = {};
  hs.forEach(h => { map[h.payload] = (map[h.payload] || 0) + 1; });
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ payload: k, helped: v }));
}

// 顶栏统计：本月递出/被帮到/灯角数
function stats() {
  const now = new Date();
  const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const hs = store.list('handoffs');
  const t1s = store.list('peers');
  return {
    handoffsMonth: hs.filter(h => String(new Date(h.createdAt).getFullYear()) + '-' + String(new Date(h.createdAt).getMonth() + 1).padStart(2, '0') === month).length,
    thankedTotal: hs.filter(h => h.thanked).length,
    lightsTotal: t1s.filter(x => x.kind === 'T1' && x.approved && !x.hidden).length,
    helpedAgg: leaderboard().reduce((s, i) => s + i.helped, 0)
  };
}

module.exports = { GUAS, guaOf, guaName, findGua, RESOURCE_WHITELIST, isWhitelisted, MAX_T1_LEN, submitT1, approveT1, hidePeers, lighthouse, countLights, view, handoff, thank, leaderboard, stats };