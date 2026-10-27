// core/subs.js — 全站收费墙 + 订阅 + 收款（微信/支付宝，统入支付宝）+ 邀请返利。
// 规则（用户钦定）：
//   全站收费墙：所有访客免费 10 次使用，用完后必须订阅（弹窗）。
//   订阅价（2026-09 全网竞品对标后重定，见 docs/定价对标与阶梯设计.md）：
//     中文 首月体验 ¥1 / 月度 ¥99 / 季度 ¥269（合 ¥89.7/月）/ 年度 ¥899（合 ¥74.9/月）
//     英文 首月体验 $1 / 月度 $12 / 季度 $29（合 $9.67/月）/ 年度 $119（合 $9.92/月）
//   收款：微信 OR 支付宝收，但入账一律进支付宝账号（settle=支付宝）。
//   邀请返利：1 个付费好友(≥1个月)→返 1 个月免费；3 个付费好友(满 3 个季付)→返 3 个月；10 个(10×年付)→返 1 年。
//     注意：首月 ¥1 体验单**不计入**邀请返利（否则白嫖返利可被刷）。

const store = require('./store');
const crypto = require('crypto');

const FREE_USES = 10;
const MONTH_MS = 30 * 86400000;
// 访客 pools 的键是「分区.日期」→ 每天每分区一条，长期不清理会把访客记录撑大。
// 只保留最近两天（够跨零点的连续使用），其余丢弃（不影响额度判定：判定只看当天键）。
const POOLS_KEEP_DAYS = 2;
function prunePools(pools) {
  if (!pools || typeof pools !== 'object') return {};   // 新访客没有 pools → 返回空对象（不能是 undefined）
  const keep = [];
  for (let i = 0; i < POOLS_KEEP_DAYS; i++) keep.push(new Date(Date.now() - i * 86400000).toDateString());
  const out = {};
  for (const k of Object.keys(pools)) {
    const d = String(k).split('.').slice(1).join('.');
    if (keep.indexOf(d) >= 0) out[k] = pools[k];
  }
  return out;
}

// 全站收费墙 · 分节配额：每个高价值功能区一周内独立的免费次数（用尽即墙，订阅后全放开）。
//
// 【口径唯一化】分区的**权威定义现在在 core/paywall.js 的 SECTIONS**，
// 那里还带了 label/desc/cost 以及「端点 → 分区」的完整映射（第 15 条：针对所有项目）。
// 这里不再自带一份配额表——两处各写一份必然漂移：改了 paywall.js 的配额，
// 这里不跟着改，用户就会遇到"明明加了分区却说配额不足"这种查不出的问题。
// 因此从 paywall.SECTIONS 读取，读不到再退回这份兜底值（供单测脱离 paywall 使用）。
let POOLS = (() => {
  try {
    const s = require('./paywall').SECTIONS || {};
    const out = {};
    Object.keys(s).forEach(k => { out[k] = s[k].quota; });
    if (Object.keys(out).length) return out;
  } catch (e) {}
  return {
    report: 10, decision: 10, skill: 10, agent: 6, leadgen: 6, chatdeep: 8,
    studio: 4, game: 4, music: 4, warboard: 20, org: 15, evolve: 10
  };
})();

// ============ 档位权益（tier entitlements，2026-10 竞品对标）============
// 重耗分区：单次调用成本显著（多次 LLM / TTS·ffmpeg / 代码生成），档位差异只体现在这些分区；
// 其余分区任何订阅档位一律不限次（基础承诺不回撤）。
const HEAVY_SECTIONS = ['agent', 'studio', 'game', 'music'];
// heavyDaily = 重耗分区日限倍数（× 该分区免费单日额度 POOLS[s]）；Infinity = 不限
// legacy = 档位上线前激活的老订阅：当时对用户的承诺是「订阅后全部不限次」，不回撤。
const TIERS = Object.freeze({
  legacy: { heavyDaily: Infinity },
  basic: { heavyDaily: 3 },
  pro: { heavyDaily: 8 },
  vip: { heavyDaily: Infinity },
  sup: { heavyDaily: Infinity }
});
function tierOf(planId) {
  const p = PLANS_CN.concat(PLANS_EN).find(x => x.id === planId);
  return (p && p.tier) || 'basic';
}
// 某分区在某档位下的日限（Infinity = 不限次）
function heavyQuota(section, tier) {
  const t = TIERS[tier] || TIERS.basic;
  if (t.heavyDaily === Infinity) return Infinity;
  return Math.max(1, Math.round((POOLS[section] || FREE_USES) * t.heavyDaily));
}

const PID = '[a-zA-Z0-9_]+';

// 【2026-10-23 激活/粘性埋点】每次真实放行都记一笔"这一天用过"，
// 用于算激活率、WAU/MAU、沉默客户、复购周期 —— 此前只有当日 pools，
// 跨天后被 prunePools 清掉，历史使用轨迹完全丢失，导致"付费后有没有用起来"
// 这个最关键的问题无法回答。
// 只保留最近 180 天，避免 visitors 行无界膨胀。
function usageStamp(v, section) {
  const now = Date.now();
  const d = new Date(now);
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const days = Object.assign({}, (v && v.usageDays) || {});
  days[day] = (Number(days[day]) || 0) + 1;
  const keys = Object.keys(days).sort();
  while (keys.length > 180) delete days[keys.shift()];
  return {
    usageDays: days,
    firstUseAt: Number(v && v.firstUseAt || 0) || now,
    lastUseAt: now,
    lastSection: String(section || ''),
  };
}


// 分节配额计费：gatePool(visitor, section)。已订阅 → 放行；未订阅 → 消耗该节当日额度。
function gatePool(key, section) {
  const v = visitorBy(key);
  // 【2026-10-22 修复】乐观授权通道（人工核账 24h 窗口内）：与 gate() / status() 同口径。
  // 此前 gatePool 未检查 liveProvisional，导致 manual-confirm 后前端墙被隐藏、
  // 但后端每次 gateSection 仍返回 402（免费额度耗尽即拦截），墙会重新弹出。
  const prov = liveProvisional(v.visitor);
  if (prov) return { allowed: true, wall: false, provisional: true, freeLeft: '∞', section };
  // 【2026-10-21】订阅查找改全量查找（原来只扫最近 999 条，订阅多了会失忆）；
  // 一个人可能有多条订阅记录 → 取**到期最晚的那条**（即当前有效的那条）
  const subsAll = store.findAllBy('sublist', 'visitor', v.visitor);
  const sub = subsAll.length ? subsAll.reduce((a, b) => (Number(b.expireAt || 0) > Number(a.expireAt || 0) ? b : a)) : null;
  const liveSub = (sub && sub.expireAt > Date.now()) ? sub : null;
  if (liveSub) {
    // 档位闸门（2026-10）：常规分区不限次；重耗分区按档位日限（legacy 老订阅不回撤，全∞）。
    const tier = liveSub.tier || 'legacy';
    if (HEAVY_SECTIONS.indexOf(section) < 0) return { allowed: true, wall: false, sub: true, section, freeLeft: '∞', tier };
    const cap = heavyQuota(section, tier);
    if (cap === Infinity) return { allowed: true, wall: false, sub: true, section, freeLeft: '∞', tier };
    const dayKeyH = section + '.' + new Date().toDateString();
    const usedH = Number(v.pools && v.pools[dayKeyH]) || 0;
    if (usedH < cap) {
      const poolsH = Object.assign(prunePools(v.pools), { [dayKeyH]: usedH + 1 });
      store.update('visitors', v.id, Object.assign({ pools: poolsH }, usageStamp(v, section)), '档位额度扣减 ' + section + ' ' + (usedH + 1) + '/' + cap);
      return { allowed: true, wall: false, sub: true, section, used: usedH + 1, quota: cap, tier };
    }
    return {
      allowed: false, wall: true, sub: true, section, used: usedH, quota: cap, tier,
      msg: '今日「' + section + '」本档位额度已用尽（' + cap + ' 次），升级更高档位可解除限制'
    };
  }
  // 【2026-10-22】与 gate() 对齐：freeLeft 耗尽时直接拦截，不等日配额用光
  if (v.freeLeft <= 0) {
    return { allowed: false, wall: true, section, freeLeft: 0, msg: '免费次数已用完，请订阅后继续' };
  }
  const quota = POOLS[section] || FREE_USES;
  const dayKey = section + '.' + new Date().toDateString();
  const used = Number(v.pools && v.pools[dayKey]) || 0;
  if (used < quota) {
    const pools = Object.assign(prunePools(v.pools), { [dayKey]: used + 1 });
    store.update('visitors', v.id, Object.assign({ pools }, usageStamp(v, section)), '节配额扣减 ' + section + ' ' + (used + 1) + '/' + quota);
    return { allowed: true, wall: false, sub: false, section, used: used + 1, quota };
  }
  return { allowed: false, wall: true, section, used, quota, msg: '今天「' + section + '」免费额度已用尽（' + quota + ' 次），订阅后不限次数' };
}

// 各节现状（供 /v1/subs/status 与前端画墙）
function poolStatus(key) {
  const v = visitorBy(key);
  const sub = store.findAllBy('sublist', 'visitor', v.visitor).find(x => x.expireAt > Date.now());
  const dayKey = s => s + '.' + new Date().toDateString();
  const tier = sub ? (sub.tier || 'legacy') : null;
  const out = {};
  Object.keys(POOLS).forEach(s => {
    if (!sub) {
      out[s] = { left: Math.max(0, POOLS[s] - (Number(v.pools && v.pools[dayKey(s)]) || 0)), quota: POOLS[s] };
      return;
    }
    // 订阅者：常规分区无限；重耗分区按档位日限如实显示余量（不谎报∞）
    const cap = HEAVY_SECTIONS.indexOf(s) >= 0 ? heavyQuota(s, tier) : Infinity;
    if (cap === Infinity) { out[s] = { left: '∞', quota: null, tier }; return; }
    const used = Number(v.pools && v.pools[dayKey(s)]) || 0;
    out[s] = { left: Math.max(0, cap - used), quota: cap, tier, tierLimited: true };
  });
  return out;
}

// —— 服务端签发访客身份（HMAC 签名，防客户端伪造/绕过）——
function secret() {
  let s = store.getSetting('visitorSecret');
  if (!s || s.length < 24) {
    s = crypto.randomBytes(24).toString('hex');
    store.setSetting('visitorSecret', s);
  }
  return s;
}
// 签发：key → { token, vid }。客户端只需保存 vid，回传时带 token 一起验证。
function issue(key) {
  const k = String(key || 'anon').slice(0, 64);
  const sig = crypto.createHmac('sha256', secret()).update(k).digest('hex').slice(0, 24);
  return { vid: k + '.' + sig };
}
// 验证：拆分 vid.sig，HMAC 重算比对（恒定时间）。
function verify(vid) {
  const s = String(vid || '');
  const dot = s.lastIndexOf('.');
  if (dot < 1) return null;
  const k = s.slice(0, dot), sig = s.slice(dot + 1);
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(k) || !/^[a-f0-9]{24}$/.test(sig)) return null;
  const expect = crypto.createHmac('sha256', secret()).update(k).digest('hex').slice(0, 24);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? k : null;
}

// 定价对标（2026-09 竞品实测）：
//   免费/开源 $0 · 入门付费 $10（Copilot Pro）· 中档锚点 $20（Cursor/Claude/Devin/Manus）
//   重度 $60–100（Cursor Pro+ / Claude Max 5x）· 顶级 $200 · 团队 $19–40/席
//   年付折扣普遍 15–17%（Claude 年付 $17/月、Manus 省 17%）
// 结论与本产品取舍：
//   1) 原 ¥60/月 ≈ $8.3，**低于主流入门线 $10**，价格信号偏低；抬到 ¥99（≈$13.7），
//      贴着国内 SaaS 心理价位，且仍低于 $20 锚点，留出涨价空间而非一步到顶。
//   2) 原阶梯有结构缺陷：季卡合 ¥50/月（比月卡低 17%）、年卡合 ¥41.7/月（低 31%），
//      等于主动把新客往年付推。但本产品当前 0 客户，最缺的是**低承诺首单**（月付=12 次挽留机会，
//      年付=一次定生死）。因此改为「月卡是锚、季卡只给 9% 引导、年卡给 24% 锁客」。
//   3) 0 客户阶段的真瓶颈是转化率不是价格：加 **¥1 首月体验**（每人一次）破冰，
//      把一次性试用变成一次真实付款动作，续订按 ¥99 走正常价。
// 【档位轴 2026-10 · 竞品对标】国内 AI 会员普遍 3-4 档：Kimi 入门49/效率99/专业199/尊享699，
// 豆包 标准68/加强200/专业500，智谱 VIP79/SVIP339，腾讯WorkBuddy 99-999 三档；海外主力 $20
// （ChatGPT Plus / Claude Pro），顶级 $100-200（ChatGPT Pro / Claude Max）。本站对应四档：
//   基础款（时长轴 t/m/q/y，¥99-899 / $12-119）→ 定制款 p（¥199/$25）→ VIP尊贵 v（¥399/$49）→ 至尊 s（¥699/$89）
// 档位差异只作用于「重耗分区」（agent/studio/game/music：多次 LLM / TTS·ffmpeg / 代码生成算力）：
// 常规分区任何档位一律不限次（基础承诺不回撤）；重耗分区按档位日限（见 TIERS / heavyQuota）。
// 新档只做月付：先验证升级转化，再考虑季/年（竞品顶级档也以月付为主锚）。
const PLANS_CN = [
  // 首 7 天体验（原为"首月"）：¥1 破冰，7 天到期即需要续费（续订走正常 ¥99/月）。
  // 用 days 而不是 months——1 个月太长，7 天足够跑完一次真实使用闭环又逼出复购决策。
  { id: 't', label: '首7天体验', amount: 1, currency: 'CNY', days: 7, months: 0, tier: 'basic', en: 'First 7 Days', tag: '每人限一次', trial: true },
  { id: 'm', label: '基础款月度', amount: 99, currency: 'CNY', months: 1, tier: 'basic', en: 'Monthly', tag: '随时停 · 重耗分区日限' },
  { id: 'q', label: '基础款季度', amount: 269, currency: 'CNY', months: 3, tier: 'basic', en: 'Quarterly', tag: '省 9%' },
  { id: 'y', label: '基础款年度', amount: 899, currency: 'CNY', months: 12, tier: 'basic', en: 'Yearly', tag: '省 24% · 相当于 ¥74.9/月' },
  { id: 'p', label: '定制款', amount: 199, currency: 'CNY', months: 1, tier: 'pro', en: 'Pro', tag: '重耗分区日限 8× · 优先队列' },
  { id: 'v', label: 'VIP尊贵款', amount: 399, currency: 'CNY', months: 1, tier: 'vip', en: 'VIP', tag: '重耗分区不限 · 音视频完整输出' },
  { id: 's', label: '至尊款', amount: 699, currency: 'CNY', months: 1, tier: 'sup', en: 'Supreme', tag: '全∞ · 成片交付 · 专家会诊' }
];
const PLANS_EN = [
  { id: 't', label: 'First 7 Days', amount: 1, currency: 'USD', days: 7, months: 0, tier: 'basic', tag: 'once per person', trial: true },
  { id: 'm', label: 'Basic Monthly', amount: 12, currency: 'USD', months: 1, tier: 'basic', tag: 'cancel anytime · heavy sections capped' },
  { id: 'q', label: 'Basic Quarterly', amount: 29, currency: 'USD', months: 3, tier: 'basic', tag: 'save 19%' },
  { id: 'y', label: 'Basic Yearly', amount: 119, currency: 'USD', months: 12, tier: 'basic', tag: 'save 17%' },
  { id: 'p', label: 'Pro', amount: 25, currency: 'USD', months: 1, tier: 'pro', tag: 'heavy sections 8x/day · priority' },
  { id: 'v', label: 'VIP', amount: 49, currency: 'USD', months: 1, tier: 'vip', tag: 'unlimited heavy · full A/V output' },
  { id: 's', label: 'Supreme', amount: 89, currency: 'USD', months: 1, tier: 'sup', tag: 'all unlimited · delivered films · expert council' }
];

// 不算「付费好友」的下单类型（体验单 / 0 元单），用于邀请返利与有效客户数统计
function isRealPaid(o) {
  return !!(o && o.paid && Number(o.amount) > 1);
}

const inviteReward = {
  1:  { need: 1, get: 1, desc: '1 个付费好友（≥月度）→ 返 1 个月' },
  3:  { need: 3, get: 3, desc: '3 个付费好友（满 3 个季付或等效）→ 返 3 个月' },
  10: { need: 10, get: 12, desc: '10 个付费好友（10×年度 ¥899）→ 返 1 年' }
};

// 访客对象：由客户端传 X-Visitor，否则用 IP fallback；服务端建独立访客记录，含免费次数/订阅/邀请码
//
// 邀请码修复（复购/裂变此前事实为零）：原来访客注册时 invite 初始化为 []（永为空），
// bindInvite 又拿"签名后的 vid"当邀请码去匹配 visitor 字段——签名串无法被人手动输入，
// 于是「邀请码」从来生成不出来、也从来绑不上，monthsCredit 更是只加不花。
// 现在：注册即生成一个**可手输**的短码（BD+随机），绑定按短码查表，返利月数可兑现。
function makeInviteCode() {
  // 4 位 base36 大写，避开易混字符；冲突重试
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 8; tries++) {
    let c = 'BD';
    for (let i = 0; i < 5; i++) c += alphabet[crypto.randomInt(alphabet.length)];
    const clash = store.findAllBy('visitors', 'inviteCode', c).length > 0;
    if (!clash) return c;
  }
  return 'BD' + Date.now().toString(36).toUpperCase().slice(-5);
}

function visitorBy(key) {
  const k = String(key || 'anon').slice(0, 64);
  // 【2026-10-21 修复规模化失忆】原来用 store.list('visitors', 999) 找 —— 那是**最近 999 个**的窗口：
  // 访客数超过窗口后，早先的访客会被当成新访客**重建记录** → 额度重置、身份分裂、
  // 订单与权益对不上人（生产实测访客已达 2805 > 999）。
  // 现在走全量等值查找（store.findBy），O(n) 扫描但零分配，且**不再丢身份**。
  let v = store.findBy('visitors', 'visitor', k);
  if (!v) {
    v = store.push('visitors', {
      visitor: k, freeLeft: FREE_USES, used: 0, paid: 0, monthsCredit: 0,
      invite: [], invitedBy: null, inviteCode: makeInviteCode(), trialUsed: false,
      freeTrialUsed: false
    }, '访客注册', k);
  } else if (!v.inviteCode) {
    // 老访客补发短码（此前注册的都缺）
    store.update('visitors', v.id, { inviteCode: makeInviteCode() }, '补发邀请码', null);
    v.inviteCode = store.findBy('visitors', 'id', v.id).inviteCode;
  }
  return v;
}

// 人工通道「24h 临时通行」开关：默认开；运营可置 settings.manualTempPass=false 关闭。
// 关闭后回传凭证只留痕、不临时放行，一切以运营确认/网关回调为准。
function tempPassOn() {
  const v = store.getSetting('manualTempPass');
  return !(v === false || v === 'false' || v === 'off' || v === 0 || v === '0');
}

// 人工通道核账窗口：上传凭证即开通，24h 内系统内部确认；到期未确认则权益失效并要求补交截图。
const MANUAL_REVIEW_MS = 24 * 3600 * 1000;

// 【临时开通但可回收】人工通道上传凭证后立即开通，但这条订阅带 provisional 标记：
// 24h 内被内部确认（confirmed）→ 永久有效；到期未确认 → 权益自动回收，订单标记 needProof。
// 之所以要回收：否则"点一下就白嫖"；之所以要立即开通：真实买家不该被流程卡住。
function isProvisionalExpired(sub) {
  return !!(sub && sub.provisional && Number(sub.reviewUntil || 0) > 0 && Number(sub.reviewUntil || 0) <= Date.now());
}

// 清理过期的人工临时权益：sublist 里 provisional 且已过 reviewUntil 的条目直接作废。
// 返回被回收的条数（供审计）。
// 回收过期的乐观授权：只动 provisional 集合，**绝不碰 sublist**。
// 客户已付费的订阅（sublist）不在回收范围内——这是本设计最关键的隔离。
function sweepProvisionalSubs() {
  const now = Date.now();
  const list = store.list('provisional', 999);
  let n = 0;
  for (const x of list) {
    if (x.status === 'confirmed') continue;
    if (Number(x.reviewUntil || 0) > now) continue;
    try {
      store.update('provisional', x.id, { status: 'expired', expiredAt: now },
        '人工核账超24h未确认，回收乐观授权');
      n++;
    } catch (e) {}
  }
  return n;
}

// 【回收时的订单联动】把仍未确认的人工订单标记为 needProof，
// 让客户端能提示"请重新提交支付截图"，运营端能按 needProof 筛选待处理。
// markNeedProofOrders：以「乐观授权记录」为准，订单自身 reviewUntil 过期也一并算
// 匿名访客定期清理（2026-10-21）
// ------------------------------------------------------------------
// 匿名身份（没有签名 vid、没有 Cookie）只用来做「按 IP 计的免费额度」，
// 不是客户资产：探针、爬虫、站点自己的内部调用都会留下这类记录。
// 不清理 → 访客表被噪声淹没（生产实测 2805 条里绝大多数是这类）、db 无界增长。
// 【红线】**只删匿名形态**的记录；签名访客（有 inviteCode/订阅/付费记录）一律不动。
// 清理它们的代价与「清 Cookie」等价：免费额度重置 —— 而 ¥1 试用本来就有 IP 闸门兜着。
const ANON_VISITOR_RE = /^ip:[^:]+:[a-z0-9]{4,}$/i;
const ANON_MAX_AGE_MS = 48 * 3600 * 1000;   // 匿名记录保留 48 小时
function sweepAnonVisitors(maxAgeMs) {
  const cutoff = Date.now() - (Number(maxAgeMs) || ANON_MAX_AGE_MS);
  const all = store.list('visitors');
  let n = 0;
  for (const v of all) {
    if (!v || !ANON_VISITOR_RE.test(String(v.visitor || ''))) continue;
    if (Number(v.createdAt || 0) > cutoff) continue;
    // 有实质资产的匿名记录**一律不删**。判定不能只看访客身上的标志位：
    // 真实客户付过款但访客记录的 paid 标志没置位（钱在订单里），只看标志会误删真人记录 →
    // 丢掉 trialUsed/额度状态 → 还能再领一次 ¥1 体验（钱相关漏洞）。
    const hasAsset = !!(v.paid || v.monthsCredit || (Array.isArray(v.invite) && v.invite.length));
    if (hasAsset) continue;
    const hasOrder = store.findAllBy('orders', 'visitor', v.visitor).length > 0;
    const hasSub = store.findAllBy('sublist', 'visitor', v.visitor).length > 0;
    if (hasOrder || hasSub) continue;
    try { store.remove('visitors', v.id); n++; } catch (e) {}
  }
  return n;
}

function markNeedProofOrders() {
  const now = Date.now();
  // 乐观授权已被回收的订单 → 一定需要补交截图
  const expiredIds = new Set(store.list('provisional', 999)
    .filter(x => x.status === 'expired' && x.orderId)
    .map(x => x.orderId));
  let n = 0;
  // 【2026-10-21 全量】24h 临时权益回收：只扫最近 999 单 → 老的人工单永不过期（白嫖漏洞）
  for (const o of store.list('orders')) {
    if (o.manualStatus !== 'provisionally_active') continue;
    // 两个来源任一过期即判定：订单自身窗口到期，或其乐观授权已被回收
    const orderExpired = Number(o.reviewUntil || 0) <= now;
    const provExpired = expiredIds.has(o.id);
    if (!orderExpired && !provExpired) continue;
    try {
      store.update('orders', o.id, {
        manualStatus: 'needProof',
        needProof: true,
        needProofAt: now
      }, '人工核账超24h未确认，转为需补交支付截图');
      n++;
    } catch (e) {}
  }
  return n;
}

// 人工通道：立即开通（可回收的临时权益）
// 语义：上传凭证 = 立即放行；系统内部 24h 内确认；超时未确认自动回收。
// 人工通道订单对应的时长（体验档按天，正式档按月）
// 访客当前有效的乐观授权（24h 核账窗口内）
// 访客当前有效的乐观授权（24h 核账窗口内）
// 【以订单为权威】provisional 集合只是索引/加速用；真正的权威是订单上的
// manualStatus='provisionally_active' + reviewUntil。
// 早前只查集合，一旦集合记录被误删（清理脚本/异常），客户就会"付了钱却打不开"，
// 而且既没有提示也没有恢复路径。现在集合缺失时回落到订单并自动重建索引 → 自愈。
function liveProvisional(visitorKey) {
  const now = Date.now();
  const list = store.list('provisional', 999);
  for (const x of list) {
    if (x.visitor !== visitorKey) continue;
    if (x.status === 'confirmed' || x.status === 'expired' || x.status === 'revoked') continue;
    if (Number(x.reviewUntil || 0) > now) return x;
  }
  // 索引缺失 → 用订单重建（自愈）
  const o = store.findAllBy('orders', 'visitor', visitorKey).find(v =>
    v.manualStatus === 'provisionally_active' && Number(v.reviewUntil || 0) > now);
  if (!o) return null;
  try {
    const { p, durMs } = provisionalDur(o.plan);
    const rec = store.push('provisional', {
      visitor: visitorKey, orderId: o.id, plan: o.plan, tier: tierOf(o.plan),
      durMs: durMs, reviewUntil: Number(o.reviewUntil || 0),
      expireAt: Date.now() + durMs, status: 'active', rebuilt: true
    }, '乐观授权索引重建(自愈)', visitorKey);
    return rec;
  } catch (e) { return null; }
}

// 把乐观授权折算成与 sublist 同形状的对象（前端统一读 sub 字段）
function provisionalAsSub(p) {
  if (!p) return null;
  return {
    plan: p.plan, tier: p.tier || 'legacy', expireAt: Number(p.expireAt || 0),
    daysLeft: Math.max(0, Math.ceil((Number(p.expireAt || 0) - Date.now()) / 86400000)),
    provisional: true, reviewUntil: Number(p.reviewUntil || 0)
  };
}

function provisionalDur(planId) {
  const plans = PLANS_CN.concat(PLANS_EN);
  const fallback = plans.find(x => x.id === 'm');
  const p = plans.find(x => x.id === planId) || fallback;
  const durMs = (Number(p.days) || 0) * 86400000 || (Number(p.months) || 0) * MONTH_MS;
  const durLabel = (Number(p.days) ? p.days + '天' : p.months + '个月');
  return { p, durMs, durLabel };
}

// 人工通道乐观开通：写入独立的 provisional 集合（绝不写 sublist）
//
// 【为什么要独立集合】早前实现把 provisional 标记直接写在 sublist 行上，于是：
//   客户已有永久订阅 → 再买一单 → activateProvisional 把那条【永久订阅行】标成 provisional
//   → 24h 超时回收时 expireAt 被置 0 → 客户已付费的订阅被直接摧毁（数据丢失）。
// 独立集合后：sublist 只存「已确认的订阅」，provisional 只存「待核账的临时授权」，
// 回收临时授权永远碰不到已付费订阅。
function activateProvisional(visitorKey, planId, orderId, reviewUntil) {
  const { p, durMs, durLabel } = provisionalDur(planId);
  const v = visitorBy(visitorKey);
  const until = Number(reviewUntil || 0);
  const list = store.list('provisional', 999);
  const prev = orderId ? list.find(x => x.orderId === orderId && x.visitor === v.visitor) : null;
  if (prev) {
    // 同一订单：补交截图后重开 24h 窗口（幂等，不叠加时长）
    store.update('provisional', prev.id, {
      plan: p.id, tier: prev.tier || tierOf(p.id), durMs: durMs,
      reviewUntil: until, status: 'active', expiredAt: null, revokedAt: null
    }, '乐观开通续期(人工·补交凭证)');
    return store.list('provisional', 999).find(x => x.id === prev.id);
  }
  return store.push('provisional', {
    visitor: v.visitor, orderId: orderId || null, plan: p.id, tier: tierOf(p.id),
    durMs: durMs, reviewUntil: until, expireAt: Date.now() + durMs, status: 'active'
  }, '乐观开通(人工·待核账)', v.visitor + ' +' + durLabel + ' (' + tierOf(p.id) + ')');
}

// 内部确认（运营令牌 / 网关回调）：把临时权益转正，永不过期。
// 内部确认到账：把乐观授权标记为 confirmed。
// 真正的时长发放由 settleEffects → activate() 完成（幂等键 grantedOrders）。
function confirmProvisional(orderId) {
  const o = store.findBy('orders', 'id', orderId);
  if (!o) return { ok: false, error: '订单不存在' };
  const hit = store.list('provisional', 999).filter(x => x.orderId === orderId);
  for (const x of hit) {
    try {
      store.update('provisional', x.id, { status: 'confirmed', confirmedAt: Date.now() },
        '人工通道内部确认到账');
    } catch (e) {}
  }
  return { ok: true, confirmed: hit.length };
}

function status(key) {
  const v = visitorBy(key);
  // 【2026-10-21 全量查找】原来 list('sublist', 999).find(...) 只看最近 999 条 →
  // 订阅多了会失忆（权益消失）。改为全量等值查找 + 取到期最晚的那条。
  const _subs = store.findAllBy('sublist', 'visitor', v.visitor);
  const sub = _subs.find(x => x.expireAt > Date.now())
    || (_subs.length ? _subs.reduce((a, b) => (Number(b.expireAt || 0) > Number(a.expireAt || 0) ? b : a)) : null);
  // 人工通道乐观开通（24h 核账窗口内）：独立于 sublist 的临时授权，
  // 给通行权但不算「已购买」；窗口到期自动失效，且不会动到已付费订阅。
  const prov = liveProvisional(v.visitor);
  // 旧口径（reviewing）：仅保留兼容，已被乐观开通取代。
  const _orders = store.findAllBy('orders', 'visitor', v.visitor);
  const reviewing = !sub && !prov && tempPassOn() && _orders.find(o => !o.paid &&
    (o.manualStatus === 'reviewing' || o.manualStatus === 'provisionally_active') && Number(o.reviewUntil || 0) > Date.now());
  const paidEver = _orders.filter(o => o.paid);
  // 【2026-09 契约修正】订阅用户的 freeLeft 原本是 JS 的 Infinity，但 Infinity 不能 JSON 序列化
  // ——server.js 用裸 JSON.stringify，实际 JSON.stringify({freeLeft:Infinity})
  // === '{"freeLeft":null}'，前端于是收到 null 并显示「免费次数 null·0」。
  // 现在显式给 unlimited 布尔位，freeLeft 保持 JSON 安全的 null。
  // 前端判断「无限」应看 d.unlimited / d.sub，不要依赖 Infinity。
  const unlimited = !!sub || !!prov || !!reviewing;
  // 人工通道：24h 内无内部确认 → 订单转 needProof，前端提示客户补交支付截图。
  // 只在该访客名下、仍未确认、且已过期未确认的单里找。
  const needProofOrder = _orders.find(o =>
    o.manualStatus === 'needProof' && o.needProof !== false);
  return {
    ok: true, visitor: v.visitor,
    freeLeft: unlimited ? null : v.freeLeft,
    unlimited,
    needProof: !!needProofOrder,
    needProofOrderId: needProofOrder ? needProofOrder.id : null,
    // provisional=true 表示「已开通但待内部核账」，前端据此显示「待核账」而不是「已订阅」
    provisional: !!prov && !sub,
    tempPass: (!!prov || !!reviewing) && !sub,
    tempUntil: prov ? Number(prov.reviewUntil || 0) : (reviewing ? reviewing.reviewUntil : null),
    used: v.used, paidEver: paidEver.length,
    trialUsed: !!v.trialUsed,                      // ¥1 首月体验是否已用过（前端据此隐藏该档）
    // 免费试用 2 天的领取资格（前端据此显隐墙上的「免费试 2 天」按钮）
    freeTrialAvailable: !v.freeTrialUsed && !unlimited,
    sub: sub ? { plan: sub.plan, tier: sub.tier || 'legacy', expireAt: sub.expireAt, daysLeft: Math.ceil((sub.expireAt - Date.now()) / 86400000) }
      : provisionalAsSub(prov),
    wall: !unlimited && v.freeLeft <= 0,
    inviteCode: v.inviteCode ? [v.inviteCode] : [],   // 可手输短码（此前恒为空数组 → UI 永远显示「待生成」）
    monthsCredit: v.monthsCredit || 0,              // 待兑现的返利月数（此前只加不花、也不展示）
    pools: poolStatus(key),
    plans: { CN: PLANS_CN, EN: PLANS_EN }
  };
}

// 使用计费：每次"高价值操作"调用 gate(key)。返回 { allowed, wall, freeLeft }
function gate(key) {
  const v = visitorBy(key);
  const sub = store.findAllBy('sublist', 'visitor', v.visitor).find(x => x.expireAt > Date.now());
  // 人工通道乐观开通：与 status() 同口径（24h 窗口内放行）
  const prov = liveProvisional(v.visitor);
  const reviewing = !sub && !prov && tempPassOn() && store.findAllBy('orders', 'visitor', v.visitor).find(o => !o.paid &&
    (o.manualStatus === 'reviewing' || o.manualStatus === 'provisionally_active') && Number(o.reviewUntil || 0) > Date.now());
  // freeLeft 与 status() 一致：不返回 Infinity（JSON 序列化会变成 null），改用 unlimited 标志
  if (sub) return { allowed: true, wall: false, sub: true, freeLeft: null, unlimited: true };
  if (prov) return { allowed: true, wall: false, sub: false, provisional: true, freeLeft: null, unlimited: true };
  if (reviewing) return { allowed: true, wall: false, sub: false, tempPass: true, freeLeft: null, unlimited: true };
  if (v.freeLeft > 0) {
    store.update('visitors', v.id, { freeLeft: v.freeLeft - 1, used: v.used + 1 }, '免费额度扣减');
    return { allowed: true, wall: false, sub: false, freeLeft: v.freeLeft - 1 };
  }
  return { allowed: false, wall: true, freeLeft: 0, msg: '免费次数已用完，请订阅后继续' };
}

// 收款指引：按当前配置实时生成（占位检测防脏数据当真账户展示），不入库。
// 下单与「复用未付体验单」共用——用户关掉弹窗再回来，拿到的永远是最新可用指引。
// 占位检测：历史脏数据（示例/待设置文本）按未配置处理。
// 【为什么不能一刀切 /\.com/】真收款账号大量落在 .com 域（Payoneer/企业主域/自建站），
// 一旦命中就 account 被清空、hint 变成"渠道正在配置中"，买家明明看到二维码却付不了，
// 白丢客户。收窄为"明确的示例域"（example.com / example.org 这类保留测试域）
// + 明确的占位中文/英文措辞，其余一律当已配置。
function payGuide(v, o) {
  const ph = x => /待设置|待配置|占位|placeholder|@example\.|\bexample\.(com|org|net)\b|xxx|请输入|敬请期待|(你的|您的).*账号|未配置|收款账号，待|^\s*$/.test(String(x || ''));
  const a = store.getSetting('receiveQrAlipay') || '';
  const w = store.getSetting('receiveQrWechat') || '';
  // 买家侧「可付款」只认收款码：银行账号已不向买家展示，若只配了账号而没配收款码，
  // 就不能再声称"可付款"（否则买家看到指引却无处可扫）——如实走"联系客服"。
  const ready = (!ph(a) && !!a) || (!ph(w) && !!w);
  return {
    wechat: true, alipay: true, settle: '支付宝',
    receive: {
      alipay: ph(a) ? '' : a,
      wechat: ph(w) ? '' : w,
      // 【合规/隐私】银行账号不面向买家展示：买家只看到支付宝/微信收款码（海外走 PayPal）。
      // 收款账号仅保留在运营侧接口 /v1/subs/pay-config（已脱敏 account），前端不再回传明文。
      account: '',
      methods: { domestic: ['支付宝', '微信'], intl: ['PayPal'] },
      hint: ready
        ? '请用支付宝 / 微信扫码付款（海外买家使用 PayPal），务必在备注中填写订单号：' + o.id
        : '收款渠道正在配置中，请先联系客服完成下单'
    },
    confirmBy: '运营确认到账后自动激活'
  };
}

// 下单：生成待付款订单（微信或支付宝渠道，最终入支付宝）
// pay.receive：运营配置的收款码（settings.receiveQrAlipay / receiveQrWechat，可为图片URL或base64 dataURI）
// confirm 由运营在收到转账后调用（带 admin token），真收款人工把关=最早可跑通的合规路径。
// ============ 买家邮箱（收据 / 续费提醒的唯一送达方式）============
// 【为什么需要】站点订单按 visitor 令牌追踪，**从不存邮箱** → 商业闭环的「通知」段
//   永远只能记 skipped/no_email，客户拿不到付款凭证与续费提醒。
//   采集邮箱是让闭环真正送达的必要条件。
// 【安全边界】邮箱只用于「发凭证/提醒」，**不作为任何身份凭证**（不用它登录、不用它授权）。
//   因此只做格式与长度校验，不做验证；填错的后果仅限于收不到邮件。
//   严格拒绝：含 CR/LF（可注入邮件头）、超长、含分隔符/空格的畸形地址。
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
function normEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  if (s.length > 128) return '';
  if (/[\r\n\t\0]/.test(s)) return '';
  if (!EMAIL_RE.test(s)) return '';
  return s;
}

/**
 * 给已有订单补邮箱（客户在付款弹窗里填的）。
 * 只有**订单自己的访客**能改（否则任何人都能给别人的订单挂邮箱 → 凭证被劫走）。
 */
function attachEmail(orderId, visitorKey, email) {
  const oid = String(orderId || '');
  if (!oid) return { ok: false, error: '缺少订单号' };
  const mail = normEmail(email);
  if (!mail) return { ok: false, error: '邮箱格式不正确' };
  const order = store.findBy('orders', 'id', oid);
  if (!order) return { ok: false, error: '订单不存在' };
  const v = visitorBy(visitorKey);
  if (!v || v.visitor !== order.visitor) return { ok: false, error: '无权修改该订单' };
  if (order.email === mail) {
    // 订单邮箱已一致（常见：下单时就填了邮箱）→ **仍要确保身份上有这个邮箱**，
    // 否则"用邮箱找回订阅"找不到人（下面的挂载逻辑不能被提前 return 跳过）。
    try { bindVisitorEmail(v, mail); } catch (e) { /* 挂载失败不影响订单邮箱 */ }
    return { ok: true, order: order, reused: true };
  }
  store.update('orders', oid, { email: mail }, '补充买家邮箱');
  // 【2026-10-21 跨设备恢复断点】邮箱只写进**订单**时，"用邮箱找回订阅"找不到人
  // （auth.loginContact 是按**访客**的邮箱找身份的）→ 落地页承诺的"换电脑订阅自动恢复"
  // 在真实付费流程里其实不成立：手机付钱、换电脑 → 找不到原身份 → 看到墙 → 退款/重复付款。
  // 这里把邮箱同时挂到**当前访客身份**上（未验证）：真正的所有权证明交给恢复流程的
  // 邮箱验证码（auth.verifyCode）——不在这里凭"用户输入过"就当已验证。
  try { bindVisitorEmail(v, mail); } catch (e) { /* 挂载失败不影响订单邮箱本身 */ }
  return { ok: true, order: store.findBy('orders', 'id', oid) };
}

// 把邮箱挂到访客身份（未验证；验证由邮箱验证码流程完成）。已有邮箱不覆盖（避免被别人改走）。
function bindVisitorEmail(v, mail) {
  if (!v || !v.id || !mail) return false;
  const vv = store.findBy('visitors', 'id', v.id);
  if (!vv) return false;
  if (vv.email) return false;
  store.update('visitors', v.id, { email: mail }, '下单邮箱挂到访客身份（待验证码验证）', null);
  return true;
}

function order(key, planId, lang, ip, email) {
  // 币种由语言决定：中文 → CNY(¥)，海外(en/ar) → USD($)。
  // 【真实事故】此前只判 'en'：阿拉伯语买家在落地页看到 $12，服务端却按 ¥99(CNY) 下单——
  // 标价与实收不符、且支付渠道错（USD 走 PayPal，CNY 走支付宝）。海外语言一律走 USD 价目表。
  const intl = ['en', 'ar'].indexOf(String(lang || '').toLowerCase()) >= 0;
  const plans = intl ? PLANS_EN : PLANS_CN;
  const p = plans.find(x => x.id === planId) || plans.find(x => x.id === 'm');
  const v = visitorBy(key);
  // ¥1/$1 首月体验每人仅一次：服务端强校验（前端隐藏只是提示，接口才是闸门）
  if (p.trial) {
    if (v.trialUsed) return { ok: false, error: '首7天体验每人仅限一次，请选择月度方案' };
    const prior = store.findAllBy('orders', 'visitor', v.visitor).find(o => o.plan === p.id);
    if (prior && prior.paid) {
      // 遗留半程单核销：paid 但 trialUsed 漏置位的老数据，此处补闸堵住重复体验
      if (v.id) store.update('visitors', v.id, { trialUsed: true }, '首7天体验核销(遗留补记)', null);
      return { ok: false, error: '首7天体验每人仅限一次，请选择月度方案' };
    }
    if (prior) {
      // 未付款的体验单复用同一订单号返回，而不是一拒到底：
      // pending 单永不过期，旧逻辑下用户关掉弹窗/刷新后就永远拿不回收款指引，
      // ¥1 体验漏斗死锁（每次重试都撞同一句报错，前端 toast 后再无下一步）。
      // 同单复用同时天然防了重复下单。
      return { ok: true, order: prior, reused: true, pay: payGuide(v, prior) };
    }
    // 【IP 维度二次闸门】到这里说明「本人没体验过 + 没有可复用的旧体验单」= 即将新建体验单。
    // 仅靠 visitor 身份挡不住「清 Cookie 换新身份」无限刷 ¥1 体验（见 trialIpGuard 注释）。
    const guard = trialIpGuard(ip, v);
    if (guard.blocked) return { ok: false, error: guard.error };
  }
  // 非体验单同样复用未付款单：同一访客对同一方案（同币种）重复下单时返回原单号。
  // 此前每次点击都 push 一单，连点/重试会刷出一堆 pending 垃圾单（db 膨胀 + 待对账噪音）。
  // 复用同时天然防了重复下单。已付单不在此列——那是续订，走新单。
  if (!p.trial) {
    const pend = store.findAllBy('orders', 'visitor', v.visitor).find(o =>
      o.plan === p.id && o.currency === p.currency && !o.paid);
    if (pend) return { ok: true, order: pend, reused: true, pay: payGuide(v, pend) };
  }
  const o = store.push('orders', {
    visitor: v.visitor, plan: p.id, amount: p.amount, currency: p.currency,
    months: p.months, status: 'pending', paid: false, at: Date.now(), invitedBy: v.invitedBy || null,
    trial: !!p.trial,
    // 买家邮箱（可选）：只用于发凭证/提醒，不是身份凭证
    email: normEmail(email) || null
  }, '订阅下单', v.visitor + ' ' + p.amount + p.currency);
  // 体验单落地即记 IP 台账（不是等到付款）：否则攻击者可无限建 pending 体验单绕过闸门。
  if (p.trial) trialIpRecord(ip, v, o.id);
  return { ok: true, order: o, pay: payGuide(v, o) };
}

// ============ ¥1 体验的「每人一次」防线：IP 维度二次闸门 ============
// 【为什么必须有】visitor 身份 = 服务端签名 + HttpOnly cookie：清掉 Cookie / 开无痕窗口
// 就会拿到一个全新 visitor（anon = ip:<ip>:<ts>），于是 visitors.trialUsed 归零，
// 上面那条「每人仅一次」被直接绕过 —— 用户可以用 ¥1/7天 无限续，永远不买 ¥99/月
// （相当于把月费打到 ≈¥4.3，且无上限）。这是实打实的营收漏斗漏洞。
// 做法：给「体验单」单独记一本 IP 台账，同一 IP 在窗口期内只放行一次；本人重试同单（reuse）
// 不受影响；正式方案（月/季/年）完全不受影响（只卡 ¥1 体验）。
// 【权衡】同 IP 多人（办公室 / 运营商 CGNAT）中第二个人会被挡 —— 体验档是促销，被挡者可买
// 正式档；窗口由设置 trialIpWindowDays 调节（0 = 关闭该闸门），全程写审计，可人工放行。
function trialIpWindowMs() {
  const d = Number(store.getSetting('trialIpWindowDays'));
  const days = Number.isFinite(d) ? d : 30;
  return Math.max(0, days) * 86400000;
}
function trialIpGuard(ip, v) {
  const win = trialIpWindowMs();
  if (!win) return { blocked: false };              // 设置 0 天 = 明确关闭该闸门
  const norm = String(ip || '').trim();
  if (!norm) return { blocked: false };             // 拿不到真实 IP：fail-open（促销闸门不误伤正常买家）
  const now = Date.now();
  const hits = store.list('trialLedger', 2000)
    .filter(r => r && r.ip === norm && (now - Number(r.at || 0)) < win);
  if (!hits.length) return { blocked: false };
  if (hits.some(r => r.visitor === v.visitor)) return { blocked: false };   // 本人（重试）放行
  return {
    blocked: true,
    error: '该网络近期已使用过 ¥1 首7天体验（每人限一次）。如需继续使用，请选择月度/季度/年度方案；若确有特殊情况请联系客服。'
  };
}
function trialIpRecord(ip, v, orderId) {
  if (!trialIpWindowMs()) return;                   // 闸门关闭则不记账
  const norm = String(ip || '').trim();
  if (!norm) return;
  store.push('trialLedger', { ip: norm, visitor: v.visitor, orderId: orderId || '', at: Date.now() },
    '体验单·IP 台账', norm + ' → ' + (orderId || ''));
}

// ============ 免费试用 2 天（获客件，2026-10-25）============
// 【定位】¥1 体验解决"愿意付钱但怕不值"的破冰；免费 2 天解决"连 ¥1 都不想掏"的
// 零客户冷启动——先用 2 天真实价值换信任，到期自动回墙，转化走 ¥1/月卡漏斗。
// 【纪律】与 ¥1 体验同一套防线，且更严（0 成本 = 刷量面更大）：
//   1) visitors.freeTrialUsed 每人一次（服务端强校验）；
//   2) 独立 IP 台账 freeTrialLedger（默认窗口 7 天，设置 freeTrialIpWindowDays=0 关闭）：
//      清 Cookie 换新身份刷不出第二次；与 trialLedger 分账——用过 ¥1 体验的 IP
//      不该被免费试用的报错文案误伤（反之亦然）；
//   3) 已有有效订阅者不发放（防订阅用户点着玩、也防重复叠加）。
// 【绝不走 activate()】它的 planId 兜底是月卡 m——免费试用若误入会把"2 天"写成
// "送一个月"。这里独立授予，时长写死 2 天，tier='trial'（重耗分区按体验档日限）。
const FREE_TRIAL_DAYS = 2;
function freeTrialIpWindowMs() {
  const d = Number(store.getSetting('freeTrialIpWindowDays'));
  const days = Number.isFinite(d) ? d : 7;
  return Math.max(0, days) * 86400000;
}
function freeTrialIpGuard(ip, v) {
  const win = freeTrialIpWindowMs();
  if (!win) return { blocked: false };
  const norm = String(ip || '').trim();
  if (!norm) return { blocked: false };             // 拿不到真实 IP：fail-open（获客闸门不误伤）
  const now = Date.now();
  const hits = store.list('freeTrialLedger', 2000)
    .filter(r => r && r.ip === norm && (now - Number(r.at || 0)) < win);
  if (!hits.length) return { blocked: false };
  if (hits.some(r => r.visitor === v.visitor)) return { blocked: false };   // 本人重试放行
  return {
    blocked: true,
    error: '该网络近期已领取过免费试用（每人限一次）。如需继续使用，请订阅；确有特殊情况请联系客服。'
  };
}
function grantFreeTrialDays(visitorKey, days) {
  const v = visitorBy(visitorKey);
  const all = store.findAllBy('sublist', 'visitor', v.visitor);
  const cur = all.find(x => x.expireAt > Date.now());
  const durMs = days * 86400000;
  if (cur && cur.id) {
    // 有效订阅上叠加 2 天（例如用户先买了月卡又中了运营活动）：顺延而非覆盖
    store.update('sublist', cur.id, { expireAt: cur.expireAt + durMs }, '免费试用顺延');
    return store.findBy('sublist', cur.id) || cur;
  }
  return store.push('sublist', {
    visitor: v.visitor, plan: 'f2', tier: 'trial',
    expireAt: Date.now() + durMs, grantedOrders: ['free-trial']
  }, '免费试用激活', v.visitor + ' +' + days + '天 (trial)');
}
function claimFreeTrial(key, ip) {
  const v = visitorBy(key);
  if (v.freeTrialUsed) return { ok: false, error: '免费试用每人仅限一次', usedUp: true };
  // 已是订阅者：不发放也不烧掉资格（到期后仍可试用，属善意设计）
  const hasSub = store.findAllBy('sublist', 'visitor', v.visitor).some(x => x.expireAt > Date.now());
  if (hasSub) return { ok: false, error: '你已有有效订阅，无需免费试用' };
  const guard = freeTrialIpGuard(ip, v);
  if (guard.blocked) return { ok: false, error: guard.error };
  // 先核销再发放（与 ¥1 体验同序）：即使发放中途异常，也不会留下"可反复领"的口子
  store.update('visitors', v.id, { freeTrialUsed: true }, '免费试用核销', null);
  if (freeTrialIpWindowMs()) {
    const norm = String(ip || '').trim();
    if (norm) store.push('freeTrialLedger', { ip: norm, visitor: v.visitor, at: Date.now() },
      '免费试用·IP 台账', norm);
  }
  const sub = grantFreeTrialDays(v.visitor, FREE_TRIAL_DAYS);
  return { ok: true, days: FREE_TRIAL_DAYS, expireAt: sub.expireAt, sub: { plan: 'f2', tier: 'trial', expireAt: sub.expireAt } };
}

// 收款结算副作用（入账 / 激活 / 体验核销 / 返利）——运营确认与网关到账共用一套口径。
// 每个副作用自带幂等键，重复执行只补缺口、绝不重复记账（已 paid 的订单被再次确认 /
// 网关重推时会重入这里）：
//   入账    revenue.id = 'rev-<订单号>'（money.credit 内查重）
//   激活    sublist.grantedOrders 含订单号（activate 内查重）
//   体验核销 visitors.trialUsed 置位前查
//   返利    settleInvite 按「应得月数 target − 已发」取增量，天然幂等
// 返回 { inviteBonus, changed }：changed=这次重入是否补上了任何缺口（决定审计是否记一笔）。
function settleEffects(o, methodLabel) {
  const money = require('./money');
  let changed = false;
  const revId = 'rev-' + o.id;
  const hadRev = !!store.findBy('revenue', 'id', revId);
  const c = money.credit(o.amount, '订阅-' + o.plan, methodLabel, { id: revId, currency: o.currency, noPromo: !!o.trial });
  if (c.ok && !hadRev) changed = true;
  const hadGrant = store.findAllBy('sublist', 'visitor', o.visitor).some(x =>
    Array.isArray(x.grantedOrders) && x.grantedOrders.includes(o.id));
  activate(o.visitor, o.plan, o.id, o.paidAt);
  if (!hadGrant) changed = true;
  if (o.trial) {
    const vv = store.findBy('visitors', 'visitor', o.visitor);
    if (vv && vv.id && !vv.trialUsed) { store.update('visitors', vv.id, { trialUsed: true }, '首7天体验核销', null); changed = true; }
  }
  let inviteBonus = null;
  if (o.invitedBy) inviteBonus = settleInvite(o.invitedBy, o);

  // 【自动收录 FIRST_CUSTOMER 证据】首个真实付费客户（非自测单）完成确认时
  const db = store.read();
  const isFirstReal = !db.customers || db.customers.length === 0;
  const isReal = !money.isSelfTest({ id: revId, amt: o.amount, source: '订阅-' + o.plan, settled: true }, new Map((db.orders || []).map(x => [String(x.id), x])));
  if (isFirstReal && isReal) {
    try {
      const ep = require('./evidence-pipeline');
      const r = ep.captureManual({
        sourceType: 'order',
        channel: methodLabel || 'manual',
        quote: '首位真实付费客户完成订阅订单 ' + o.id + '（' + o.amount + ' ' + o.currency + '），非自测单',
        name: 'system',
        note: 'settleEffects 自动收录：first real paying customer'
      });
      if (r.ok) ep.confirm(r.evidence.id);
    } catch (e) {}
  }

  // 【物理通知】真实付费客户确认（非自测）→ 可选 WLED 灯闪。
  // 旁观者原则：设备不可达时静默失败，绝不影响确认结果；自测单不会走到这里（isReal=false）。
  if (isReal) {
    try { require('./wled').celebrateRealDeal({ amount: o.amount, currency: o.currency, kind: 'deal', selfTest: false }).catch(() => {}); } catch (e) {}
  }

  return { inviteBonus, changed };
}

// 收款确认（运营在收到微信/支付宝转账后标记已到账 → 入支付宝账本 + 激活订阅 + 结算邀请返利）
function confirm(orderId) {
  const o = store.findBy('orders', 'id', orderId);
  if (!o) return { ok: false, error: '订单不存在' };
  const first = !o.paid;
  if (first) store.update('orders', o.id, { status: 'paid', paid: true, paidAt: Date.now() }, '收款确认');
  // 已 paid 也重跑副作用：写序是「先置 paid 再做副作用」，置位后、副作用前崩溃会留下
  // 半程单——旧代码见 already 就 return，把「钱没入账 / 订阅没开通」永久跳过且无人自知。
  // 副作用全部幂等（见 settleEffects），重入只补缺口、绝不重复记账。
  const fx = settleEffects(o, o.currency === 'USD' ? '微信/支付宝(USD)' : '微信/支付宝');
  if (first || fx.changed) {
    const sym = o.currency === 'USD' ? '$' : '¥';
    store.push('audit', {
      action: first ? '订单到账' : '订单到账(补账)',
      detail: sym + o.amount + ' ' + o.currency + ' → 入账支付宝' + (fx.inviteBonus ? '；返利' + JSON.stringify(fx.inviteBonus).slice(0, 60) : '')
    }, null, null);
  }
  return { ok: true, order: store.findBy('orders', 'id', o.id), inviteBonus: fx.inviteBonus, already: !first };
}

// 激活订阅：按访客 + 计划加计有效月数（已有订阅顺延）。网关到账 / 运营确认共用。
// orderId 可选：传入则该订单只允许加一次时长（grantedOrders 记账）——自愈重入
// （重复确认 / 网关重推补齐副作用）必须幂等，否则一次补账会多送一个月。
function activate(visitorKey, planId, orderId, baseAt) {
  const plans = PLANS_CN.concat(PLANS_EN);
  // 兜底必须是正式月卡，不能是 plans[0]——加入 ¥1 体验档后 plans[0] 就是体验档，
  // 非法 planId 会白送一个月。体验档本身也只允许走 order() 的核销路径。
  const fallback = plans.find(x => x.id === 'm');
  const p = plans.find(x => x.id === planId) || fallback;
  const v = visitorBy(visitorKey);
  const all = store.findAllBy('sublist', 'visitor', v.visitor);
  if (orderId && all.some(x =>
    Array.isArray(x.grantedOrders) && x.grantedOrders.includes(orderId))) {
    // 本单已加过时长：返回当前有效订阅（过期则 null），绝不重复加
    return all.find(x => x.expireAt > Date.now()) || null;
  }
  const cur = all.find(x => x.visitor === v.visitor && x.expireAt > Date.now());
  const grant = orderId ? [orderId] : [];
  // 时长口径：体验档按「天」（首 7 天），正式档按「月」。原来只认 months，
  // 体验档改成 7 天后必须走 days，否则按 0 月激活 = 立即过期。
  const durMs = (Number(p.days) || 0) * 86400000 || (Number(p.months) || 0) * MONTH_MS;
  const durLabel = (Number(p.days) ? p.days + '天' : p.months + '月');
  // 时长起算点：默认取付款时刻（不是核账确认时刻），核账晚也不该吞掉客户已用掉的时间
  const base = Number(baseAt || Date.now());
  if (cur && cur.id) {
    store.update('sublist', cur.id, {
      expireAt: cur.expireAt + durMs,
      grantedOrders: (cur.grantedOrders || []).concat(grant),
      tier: cur.tier || tierOf(p.id) // 顺延时补档位（老记录无 tier → 保持 legacy 不回撤）
    }, '订阅顺延');
    // 【2026-10-24】返回库里的最新行：store.update 不回写传入对象，
    // 返回旧 cur 会把「顺延前的 expireAt」交给调用方——续费到账却报旧到期日。
    return store.findBy('sublist', cur.id) || cur;
  }
  return store.push('sublist', { visitor: v.visitor, plan: p.id, tier: tierOf(p.id), expireAt: base + durMs, grantedOrders: grant }, '订阅激活', v.visitor + ' +' + durLabel + ' (' + tierOf(p.id) + ')');
}

// 访客键里的 IP 段（'ip:<ip>:<rand>' → '<ip>'）：用于识别"同一个人换身份"
// （自邀请、试用刷单）。非 IP 形态的访客键（无 IP 信息）返回空串 → 相关判定 fail-open。
function ipPart(visitorKey) {
  const s = String(visitorKey || '');
  if (s.indexOf('ip:') !== 0) return '';
  const rest = s.slice(3);
  const i = rest.lastIndexOf(':');
  return i > 0 ? rest.slice(0, i) : '';
}

// 结算邀请返利：按被邀请人累计付费月数/金额判定档位，兑换加赠月数
function settleInvite(inviterKey, order) {
  // 【2026-10-21 全量查找】邀请返利是**钱**：原来只扫最近 999 个访客/订单 →
  // 超出窗口的老邀请人找不到、被邀请人的付费单也统计不到 → 返利该发不发（少发钱）。
  const inviter = store.findBy('visitors', 'visitor', inviterKey);
  if (!inviter) return null;
  // 只认真实付费单：排除 ¥1 首月体验与 0 元单（否则推荐人可自己刷 10 个 ¥1 单白嫖 12 个月）
  const paidByInvited = store.findAllBy('orders', 'invitedBy', inviterKey).filter(o => isRealPaid(o));
  // 【2026-10-21 自邀请识别】同一个人可以造多个访客身份（清 Cookie / 换浏览器），
  // 把自己"邀请"成 10 个粉丝 → 满 10 人返 1 年 = 白嫖一年。
  // 访客键里带 IP 段（'ip:<ip>:<rand>'）→ **同 IP 的被邀请人视为同一个人**，不计粉丝数。
  const inviterIp = ipPart(inviterKey);
  const realFans = paidByInvited.filter((o) => {
    if (!inviterIp) return true;                 // 拿不到 IP：fail-open（不误伤正常推荐）
    const ip = ipPart(o.visitor);
    return !(ip && ip === inviterIp);
  });
  // 按**去重后的付费人数**计档，不是订单数：规则写的是「10 个付费好友」，
  // 原来直接数订单数，于是推荐人自己连买 10 次月卡就能拿满「10 人 → 返 1 年」。
  const fans = new Set(realFans.map(o => o.visitor));
  const count = fans.size;
  const bigFans = new Set(realFans.filter(o => o.plan === 'q' || o.plan === 'y').map(o => o.visitor)).size;
  let target = count >= 1 ? 1 : 0;                  // 累计应得月数（目标值，不是本次增量）
  if (count >= 3 && bigFans >= 3) target = 3;        // 3 档要求满 3 个季付/年付
  if (count >= 10) target = 12;                     // 满 10 人直接返 1 年
  const already = Number(inviter.inviteGrantedMonths) || 0;
  const added = Math.max(0, target - already);       // 幂等：重复付款不会重复累加
  const tier = target >= 12 ? '10' : target >= 3 ? '3' : target >= 1 ? '1' : null;
  if (added > 0 && inviter.id) {
    const cur = inviter.monthsCredit || 0;
    store.update('visitors', inviter.id, {
      monthsCredit: cur + added,
      inviteGrantedMonths: already + added          // 记账已发总额，保证 settleInvite 可重复调用不重复发
    }, '邀请返利 +' + added + '月');
    // 立即扩张 inviter 的当前订阅（如有）
    const isub = store.findAllBy('sublist', 'visitor', inviterKey).find(x => x.expireAt > Date.now());
    if (isub) store.update('sublist', isub.id, { expireAt: isub.expireAt + added * MONTH_MS }, '返利顺延');
  }
  // addedMonths = 本次增量；grantedMonths = 累计已发总额（档位语义以累计为准：
  // 3 个季付好友累计返 3 个月，而不是第 3 单一次发 3 个月叠加前面 2 单的 2 个月）
  return { tier, addedMonths: added, grantedMonths: already + added, totalPaidFans: count, bigFans };
}

// 绑定邀请码（被推荐人注册时填写推荐人的短码，如 BD7K2M）
// 兼容：也接受直接传推荐人的 visitor 串（历史 API 行为 + 自动化流程用）。
function bindInvite(newKey, codeRaw) {
  const code = String(codeRaw || '').trim().slice(0, 64);
  if (!code) return { ok: false, error: '邀请码必填' };
  // 【2026-10-21 全量】邀请码绑定是客户可见功能：只扫最近 999 个访客会让老邀请人的短码失效
  const all = store.list('visitors');
  // 优先按短码匹配（推荐人可分享给人手输的形态）
  let host = all.find(x => x.inviteCode === code.toUpperCase());
  // 兼容旧路径：直接用 visitor 串绑定
  if (!host) host = all.find(x => x.visitor === code);
  if (!host) return { ok: false, error: '邀请码不存在' };
  const me = visitorBy(newKey);
  if (me.visitor === host.visitor) return { ok: false, error: '不能邀请自己' };
  if (me.invitedBy) return { ok: true, host: me.invitedBy, already: true, note: '已绑定过邀请人' };
  store.update('visitors', me.id, { invitedBy: host.visitor }, '绑定邀请码');
  const inv = (host.invite || []).concat([me.visitor]).slice(-200);
  store.update('visitors', host.id, { invite: inv }, '新增被邀请人', null);
  return { ok: true, host: host.visitor, hostCode: host.inviteCode };
}

// 返利月数兑现：把 monthsCredit 换算成实际订阅时长。
// 修复：此前 settleInvite 只在邀请人「当前有活跃订阅」时才顺延，导致
// 尚无订阅的邀请人攒了一堆返利月数却永远用不掉（只加不花）。现在可主动兑现。
function redeemMonthsCredit(key) {
  const me = visitorBy(key);
  const credit = Math.max(0, Math.round(Number(me.monthsCredit) || 0));
  if (!credit) return { ok: false, error: '暂无待兑现的返利月数' };
  const isub = store.findAllBy('sublist', 'visitor', me.visitor).find(x => x.expireAt > Date.now());
  const now = Date.now();
  if (isub) {
    // 有活跃订阅 → 顺延
    store.update('sublist', isub.id, { expireAt: isub.expireAt + credit * MONTH_MS }, '返利月数兑现·顺延');
    store.update('visitors', me.id, { monthsCredit: 0 }, '返利月数清零', null);
    return { ok: true, addedMonths: credit, mode: '顺延到期时间' };
  }
  // 无活跃订阅 → 换等额免费额度（按 99 元/月档折算：直接给天数）
  const freeDays = credit * 30;
  const until = now + freeDays * 86400000;
  store.push('sublist', {
    visitor: me.visitor, plan: 'rebate', months: credit,
    // 【2026-10-21 漏洞修复】必须写明档位：tier 缺失会被 gatePool 当成 'legacy'
    // （老订阅的"全不限次"承诺）→ 重耗分区（agent/studio/game/music）的日限被绕过
    // → 返利 1 个月 = 白嫖 30 天重耗算力。现在按基础档（3×）计。
    tier: 'basic', tierNote: '返利兑换·按基础档日限',
    expireAt: until, fromRebate: true, at: now
  }, '返利月数兑现·生成等效订阅');
  store.update('visitors', me.id, { monthsCredit: 0 }, '返利月数清零', null);
  return { ok: true, addedMonths: credit, mode: '兑换为 ' + freeDays + ' 天等效订阅', expireAt: until };
}

// 到期预警：订阅剩余天数落在阈值内（或已过期）即需提醒。
// 修复：status() 早就算好了 daysLeft，却没有任何地方消费它——用户到期瞬间静默回到墙，
// 根本不知道自己付费的东西昨天到期了。这是复购杠杆最高、成本最低的一环。
const RENEW_WINDOW_DAYS = 7;
function renewalState(key) {
  const v = visitorBy(key);
  const now = Date.now();
  const active = store.findAllBy('sublist', 'visitor', v.visitor).find(x => x.expireAt > now);
  if (active) {
    const daysLeft = Math.ceil((active.expireAt - now) / 86400000);
    if (daysLeft > RENEW_WINDOW_DAYS) return { state: 'ok', daysLeft, plan: active.plan };
    return {
      state: 'expiring', daysLeft, plan: active.plan, expireAt: active.expireAt,
      msg: daysLeft <= 0 ? '订阅已到期' : ('订阅将在 ' + daysLeft + ' 天后到期（' + active.plan + '）——续费可保持全部功能'),
      urgent: daysLeft <= 3
    };
  }
  // 已过期（保留历史记录，不删）
  const past = store.findAllBy('sublist', 'visitor', v.visitor).filter(x => x.expireAt <= now);
  if (past.length) {
    const last = past.sort((a, b) => b.expireAt - a.expireAt)[0];
    const daysAgo = Math.floor((now - last.expireAt) / 86400000);
    return { state: 'expired', daysAgo, plan: last.plan, msg: '订阅已于 ' + daysAgo + ' 天前到期，续费可恢复全部功能' };
  }
  return { state: 'none', daysLeft: 0, msg: '' };
}

// 运营侧：临期订阅清单（用于主动 outreach——这是"召回客户"的唯一抓手）
function dueList(withinDays) {
  const w = Number(withinDays) || RENEW_WINDOW_DAYS;
  const now = Date.now();
  const horizon = now + w * 86400000;
  const rows = {};
  // 【2026-10-21 全量】续费扫描：只看最近 999 条订阅会让老订阅漏扫
  store.list('sublist').forEach(s => {
    if (s.expireAt > now && s.expireAt <= horizon) {
      const r = rows[s.visitor] = rows[s.visitor] || { visitor: s.visitor, plan: s.plan, expireAt: s.expireAt, daysLeft: 0 };
      r.daysLeft = Math.min(r.daysLeft || 999, Math.ceil((s.expireAt - now) / 86400000));
    }
  });
  const out = Object.values(rows).sort((a, b) => a.daysLeft - b.daysLeft);
  return { ok: true, withinDays: w, count: out.length, rows: out };
}

function orders(limit) { return store.list('orders', limit || 30); }

/**
 * 某个访客自己的订单（**只给本人**）。
 * 【为什么要单独一个函数】原来 `orders(limit)` 直接返回全库订单，
 * 而 GET /v1/subs/orders 是公开端点 → 任何访客都能拉到**所有人的订单**
 * （订单号/金额/方案/时间）。这不是小问题：金额与订单号是收款对账的关键信息。
 * 现在：普通访客只拿自己的；运营（管理令牌）或本机回环才拿全量（核账台要用）。
 */
function ordersOf(visitorKey, limit) {
  const key = String(visitorKey || '');
  if (!key) return [];
  const n = Math.min(Number(limit) || 30, 50);
  // 【2026-10-21 全量】我的订单：只扫最近 999 单会让老客户看不到自己的订单（订单超过 999 单后）
  const all = store.list('orders');
  return all.filter(o => o.visitor === key).slice(0, n);
}

// 运营重置收费墙：清空访客免费额度/绑定并发新签名密钥。
// 旧 vid 全部失效（签名密钥轮换），未签到账的订单保留；历史访客记录也一并清理，避免旧 key 残留混淆。
function resetVisitors() {
  const rnd = crypto.randomBytes(24).toString('hex');
  store.setSetting('visitorSecret', rnd);
  // 【2026-09·防卡死】原来三个 forEach 逐条 store.remove = 2 + visitors + sublist + 未付订单
  // 次同步写盘，随访客数线性增长（当时 21 访客 ≈ 23 次 ≈ 2.3s 阻塞）。
  // 改为一次 batch：读一次、改完、只落盘一次。
  const removed = store.batch(db => {
    const nv = (db.visitors || []).length;
    const ns = (db.sublist || []).length;
    const no = (db.orders || []).filter(o => !o.paid).length;
    db.visitors = [];
    db.sublist = [];
    if (Array.isArray(db.orders)) db.orders = db.orders.filter(o => o.paid);
    if (!db.audit) db.audit = [];
    db.audit.push({
      id: store.uid(), action: '收费墙重置',
      detail: '访客 ' + nv + ' 条、订阅 ' + ns + ' 条、未付订单 ' + no + ' 条已清理；签名密钥轮换',
      at: Date.now()
    });
    return { visitors: nv, subs: ns, orders: no };
  });
  return { ok: true, visitors: 0, removed, visitorSecretRotated: true };
}
// 轮换管理令牌（确认到账鉴权用），只返回新值不返回旧值
function rotateAdminToken() {
  const t = crypto.randomBytes(18).toString('base64url');
  store.setSetting('adminToken', t);
  store.push('audit', { action: '管理令牌轮换', detail: 'X-Admin-Token 已更新', at: Date.now() }, null, null);
  return { ok: true, token: t };
}

module.exports = { FREE_USES, MONTH_MS, MANUAL_REVIEW_MS, PLANS_CN, PLANS_EN, POOLS, TIERS, HEAVY_SECTIONS, tierOf, heavyQuota, isRealPaid, inviteReward, visitorBy, status, gate, gatePool, poolStatus, order, confirm, settleEffects, activate, activateProvisional, confirmProvisional, sweepProvisionalSubs, sweepAnonVisitors, liveProvisional, provisionalAsSub, markNeedProofOrders, isProvisionalExpired, bindInvite, settleInvite, redeemMonthsCredit, renewalState, dueList, RENEW_WINDOW_DAYS, orders, ordersOf, issue, verify, resetVisitors, rotateAdminToken, normEmail, attachEmail, claimFreeTrial, FREE_TRIAL_DAYS };