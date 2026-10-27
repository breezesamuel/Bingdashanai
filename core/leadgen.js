// core/leadgen.js — 获客成交闭环引擎：找客户 → 推荐客户 → 选择客户 → 优化客户 → 促进成交 → 完成成交
// 六段真实流水线，24h 轮巡推进。全程落 db.leads，成交后写 db.customers + money.credit 真实入账。
// 数据源：网络可用时走 intel.gitSearch（真实 GitHub 仓库探测高相关开发团队）；
//        网络不可达或限流时降级内置"公域线索池"，保证离线仍自运转。
// 零 LLM：评分/排序/方案全部确定性计算（ICP 匹配 + 信号加权 + 机会成本）。

const store = require('./store');
const intel = require('./intel');
const money = require('./money');

// 丙大山产品形态（决策手册 / 见证官 / AI 决策 / 故事工厂 / 奇门等）：据此定义 ICP。
// 行业权重矩阵：每个 ICP 细分带关键词命中加分、行业权重、基准转化率（conv，经验先验，非必中）。
const ICP = {
  fit: {
    '开发者/AI团队': { kws: ['mcp', 'ai', 'agent', 'llm', '开发工具', 'workflow', '自动化'], weight: 1.0, conv: 0.62 },
    '增长团队': { kws: ['growth', 'startup', 'saas', 'marketing', '运营', '增长'], weight: 0.8, conv: 0.45 },
    '决策者/创业者': { kws: ['founder', '创始人', '创业者', '创业'], weight: 0.75, conv: 0.4 },
    '内容创作者': { kws: ['writing', 'content', 'story', '内容', '创作'], weight: 0.85, conv: 0.5 }
  }
};

// 触达渠道轮换（多渠道触达：每次推进换一个触达面，避免单通道疲劳）
const CHANNELS = ['邮件', 'GitHub Issue', '企微通知', '短信', '路演/社媒'];

// 线索清洗：URL 归一化（去协议/去尾斜杠/去查询串），用于天然去重
function normUrl(u) {
  return String(u || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/[?#].*$/, '');
}

// 活跃度衰减：线索越久未更新，信号越弱（60 天线性衰减到 0.3 倍）
function activeWeight(l) {
  const ageDays = (now() - (l.updatedAt || now())) / 86400000;
  return Math.max(0.3, 1 - ageDays / 60);
}

// ICP 打分：按行业权重矩阵计算命中分 + 返回最佳匹配细分
function icpScore(l) {
  const hay = ((l.industry || '') + ' ' + (l.note || '') + ' ' + (l.topics || []).join(' ')).toLowerCase();
  let best = { cat: '', icp: 0 };
  Object.keys(ICP.fit).forEach(cat => {
    const m = ICP.fit[cat];
    let hit = 0;
    m.kws.forEach(k => { if (hay.includes(k.toLowerCase())) hit++; });
    const v = hit * 8 * m.weight;
    if (v > best.icp) best = { cat, icp: v };
  });
  return best;
}

// 成交概率模型（0-100）：信号 + 触达次数驱动，非承诺，仅排序用
function convProb(l) {
  const s = Number(l.signal || 50) / 100;
  const t = Math.min(2, Number(l.touch || 0));
  return Math.round(Math.min(0.95, 0.1 + s * 0.5 + t * 0.15) * 100);
}

// 网络不可达时的降级策略：绝不编造线索。真实原则——线索必须是可回查的公开仓库/实体。
// 因此离线时如实返回"暂无可验证线索"，等网络恢复再探测，杜绝假线索进漏斗。
const OFFLINE_POOL = [];

// 六段流水线
// 六段流水线 + 两个出口。'商机候选'/'长期跟进' 是终态旁路，不是自动流转的中间段：
// 商机候选等人工确认金额，长期跟进等人工判断，两者都不该被机器反复重试。
const STAGES = ['触达', '推荐', '选择', '优化', '促单', '成交'];

// 「商机候选」的准入门槛。CLOSE_MIN_TOUCH 数的是**人工确认的真实触达**（markTouched 写入），
// 机器排定的触达计划不计入——否则排两次计划就能把线索推成商机候选，等于自己给自己发工资。
const CLOSE_MIN_TOUCH = 2;
const CLOSE_MIN_SIGNAL = 66;
const SIDELINES = ['商机候选', '长期跟进'];

function now() { return Date.now(); }

// 线索展示名兜底：老数据(无 name/company/hook)也能可读
function leadName(l) { return (l && (l.name || l.company || l.hook)) || ('线索#' + String((l && l.id) || '').slice(-4) || '未知'); }

// 漏斗挑线索：按轮次轮转 + 信号分排序，避免「同一条被每轮刷新 updatedAt 而霸占」。
// 原实现三处都用 sort(updatedAt desc)[0]，被处理过的那条永远是最新，
// 于是只有一条线索在漏斗里打转，其余全部饿死（实测 55 次只轮过 1 条）。
function pickLead(leads, stage, roundNo, exclude) {
  const skip = exclude || new Set();
  // 注意：这里**不能**在"本段全被本轮排除"时回退去取被排除的线索——那等于把刚推进的
  // 线索在同一轮里再推一段，防级联的 ctx.advanced 就形同虚设（曾实测一轮就把线索推到优化）。
  const pool = (leads || []).filter(l => l.stage === stage && !skip.has(l.id));
  if (!pool.length) return null;
  // 长期跟进（underFollow）的线索不再参与主动轮转。
  // 它已经被 close() 判定为「屡次未达标、等人工判断」，留在原地每轮被重试
  // 只会让 tries 无限增长、白白吃掉本该给新线索的轮次（实测一条被刷 33 次）。
  // 只有在没有其他候选时才回头碰它。
  const live = pool.filter(l => !l.underFollow);
  const usable = live.length ? live : pool;
  // 排序按段位语义区分，不能一套规则打天下：
  //
  // 「促单」段：按**真实触达次数降序**——离成交最近的那条必须先被评估。
  //   【2026-09 修复·饿死】原来这里无差别地"优先没被处理过的（无 touch/tries）"，
  //   于是只要同段还存在未被真实触达的线索，**已被人工触达过的线索就永远排在池外**，
  //   close() 永远看不到它 → 就算真人完成 2 次触达，线索也升不到商机候选。
  //   即"越接近成交的线索，越不会被自动流程处理"。
  //
  // 其他段：沿用"优先没被处理过的"，保证新线索有机会被推进。
  let rank;
  if (stage === '促单') {
    rank = usable.slice().sort((a, b) =>
      ((Number(b.touch) || 0) - (Number(a.touch) || 0)) ||
      ((Number(b.signal) || 0) - (Number(a.signal) || 0)) ||
      ((a.updatedAt || 0) - (b.updatedAt || 0)));
  } else {
    const fresh = usable.filter(l => !l.touch && !l.tries);
    rank = (fresh.length ? fresh : usable).slice()
      .sort((a, b) => (Number(b.signal || 0) - Number(a.signal || 0)) || ((a.updatedAt || 0) - (b.updatedAt || 0)));
  }
  return rank[Math.abs(Number(roundNo || 0)) % rank.length] || null;
}

// ---------- 第 1 段：找客户 ----------
// 真实数据源：intel.gitSearch 以 ICP 关键词搜开发者/团队的 GitHub 仓库，
// 命中者登记为('探测')线索。一次拉 per=6 避免打满限流。
async function find(roundNo) {
  const o = [];
  const queries = [
    'mcp server agent',
    'ai agent workflow',
    'claude skills',
    'writing automation'
  ];
  const q = queries[(roundNo || 0) % queries.length];
  const r = await intel.gitSearch(q, { per: 5, sort: 'updated' });
  if (!r.ok) {
    // 网络不可达/限流 → 如实报"无可验证线索"，不编造。等网络恢复再探测。
    o.push('GitHub 探测暂不可达，本轮未登记任何线索（宁可空、不造假）');
    return o;
  }
  // 网络可用：登记真实仓库主人为潜在客户（按 URL 归一化去重）
  const db = store.read();
  const exist = new Set(((db.leads || [])).map(l => l.name));
  const urls = new Set(((db.leads || [])).map(l => normUrl(l.url)).filter(Boolean));
  let added = 0;
  // 【2026-09·防卡死】这批 push 包进一个 batch：原来逐条 push = 3 次同步写盘。
  // 网络请求（await intel.gitSearch）已在 batch 之外，这里是纯同步循环，符合前提。
  store.batch(() => {
    r.items.forEach((it, i) => {
      if (added >= 3) return;
      const name = it.repo || it.name;
      if (exist.has(name)) return;
      const nu = normUrl(it.url);
      if (nu && urls.has(nu)) return; // URL 归一化去重（同仓库不同名）
      urls.add(nu);
      store.push('leads', {
        name, company: name, repo: it.repo, industry: it.lang || '未知',
        signal: Math.min(95, 45 + it.stars % 30),
        source: 'GitHub 探测·' + q, stage: '探测', status: 'new', path: 'leadgen',
        topics: (it.topics || []).slice(0, 5), url: it.url, note: (it.desc || '').slice(0, 60)
      }, 'leadgen·发现线索', name);
      added++;
      o.push('GitHub 发现『' + name + '』(' + (it.lang || '未知') + ')·信号 ' + Math.min(95, 45 + it.stars % 30));
    });
  });
  if (!added) o.push('GitHub 返回 ' + r.items.length + ' 条，均已登记去重跳过');
  return o;
}

// 线索 ROI 统计（借鉴 Polsia 广告自动调优：按渠道累计成本/成交额，淘汰差渠道、放大好渠道）
// 渠道 ROI 看板（借鉴 Polsia 广告调优：高 ROI 渠道加投、低 ROI 降权）。
//
// 红线与诚实约束（前一版是死代码）：原实现读 lead.cost，但全仓没有任何地方写它，
// 于是 roi 永远 null、排序永远空操作——"有看板无数据"。
// 现在成本只来自**真实支出**：money.spend 记入 db.promo 且带 channel 标签的真金白银投放。
// 成交额来自人工确认的 lead.deal（leadgen.convert 是唯一写 deal 的入口）。
// 无真实支出/成交的渠道，roi 如实为 null，绝不用编造成本把表格填满。
function roiBoard() {
  const db = store.read();
  const rows = {};

  const row = ch => rows[ch] = rows[ch] || { channel: ch, cost: 0, leads: 0, deals: 0, revenue: 0, spendN: 0 };

  // 成本：真实投放支出（db.promo 里 kind=支出 且带 channel 的记录）
  (db.promo || []).forEach(p => {
    if (!p || p.kind !== '支出') return;
    if (!p.channel) return; // 未标渠道的支出不摊派——摊派就是编造
    const r = row(p.channel);
    r.cost += Number(p.amt) || 0;
    r.spendN++;
  });

  // 线索量与成交（人工确认的真实 deal）
  (db.leads || []).forEach(l => {
    const ch = l.channel || l.source || '未知';
    const r = row(ch);
    r.leads++;
    if (l.deal) {
      r.deals++;
      r.revenue += Number(l.deal) || 0;
    }
  });

  const out = Object.values(rows).map(r => ({
    channel: r.channel,
    cost: Math.round(r.cost),
    spendN: r.spendN,
    leads: r.leads,
    deals: r.deals,
    revenue: Math.round(r.revenue),
    roi: r.cost > 0 ? Math.round((r.revenue - r.cost) / r.cost * 100) : null,
    cac: r.cost > 0 && r.deals > 0 ? Math.round(r.cost / r.deals) : null
  })).sort((a, b) => (b.roi === null ? -1 : a.roi === null ? 1 : b.roi - a.roi));

  const totalCost = out.reduce((s, x) => s + x.cost, 0);
  const totalRevenue = out.reduce((s, x) => s + x.revenue, 0);
  return {
    ok: true, channels: out,
    totalCost, totalRevenue,
    // 整体 ROI 只在有真实支出时才有意义
    roi: totalCost > 0 ? Math.round((totalRevenue - totalCost) / totalCost * 100) : null,
    note: totalCost > 0 ? '成本来自真实推广支出（money.spend 标注渠道），成交额来自人工确认' :
      '尚无带渠道标记的真实推广支出，ROI 暂不可算——不编造成本填充'
  };
}

// ---------- 第 2 段：推荐客户 ----------
// 对存量'探测'段线索打 ICP 分 + 信号分，产出推荐榜（top2 进入'推荐'段）。
function recommend(ctx) {
  const o = [];
  const db = store.read();
  const skip = (ctx && ctx.advanced) || new Set();
  const probes = (db.leads || []).filter(l => (l.stage === '探测' || l.stage === '触达') && !skip.has(l.id));
  if (!probes.length) { o.push('暂无待推荐线索（先跑「找客户」段）'); return o; }
  // ICP 打分：行业权重矩阵命中 + 信号（活跃度衰减）+ 成交概率
  const scored = probes.map(l => {
    const name = l.name || l.hook || l.company || ('线索#' + String(l.id || '').slice(-4));
    const m = icpScore(l);
    // 大小平衡：ICP 70% + 信号(衰减后) 30%
    const score = Math.round(m.icp * 0.7 + Number(l.signal || 50) * activeWeight(l) * 0.3);
    return Object.assign({}, l, { name, score, icpCat: m.cat, conv: convProb(Object.assign({}, l, { signal: l.signal })) });
  });
  scored.sort((a, b) => b.score - a.score);
  // 一次推 3 条（原 top2）。串行流水线里 top2 会让 backlog 消化太慢：
  // 探测段越积越多，而一条不达标的线索要 tries>=3 才退出，整轮就只轮到 1-2 条。
  scored.slice(0, 3).forEach(l => {
    store.update('leads', l.id, { stage: '推荐', score: l.score, icpCat: l.icpCat, conv: l.conv }, 'leadgen·推荐客户');
    if (ctx && ctx.advanced) ctx.advanced.add(l.id);
    o.push('推荐『' + l.name + '』·综合分 ' + l.score + '（' + (l.icpCat || '未匹配') + '·预成交率 ' + l.conv + '%）');
  });
  return o;
}

// ---------- 第 3 段：选择客户 ----------
// 从'推荐'段择一条进入'选择'。
// 原来取 recs[0]（按 score 降序第一条）—— 但 score 会被后续 update 刷新，
// 同一条会永远排第一，其余推荐线索轮不到（实测 alpha 被连续选中 4 轮）。
// 改走 pickLead：排除长期跟进 + 轮转下标，保证推荐段被逐条消化。
function selectOne(roundNo, ctx) {
  const o = [];
  const db = store.read();
  const recs = (db.leads || []).filter(l => l.stage === '推荐');
  if (!recs.length) { o.push('无推荐线可挑（先跑「推荐客户」段）'); return o; }
  const pick = pickLead(db.leads, '推荐', roundNo, ctx && ctx.advanced);
  if (!pick) { o.push('无推荐线可挑（先跑「推荐客户」段）'); return o; }
  const pc = convProb(pick);
  store.update('leads', pick.id, { stage: '选择', chosen: true, conv: pc }, 'leadgen·选择客户');
  if (ctx && ctx.advanced) ctx.advanced.add(pick.id);
  o.push('选定主攻『' + leadName(pick) + '』·分 ' + (pick.score || 0) + '·预成交率 ' + pc + '%（其余留仓待后续轮）');
  return o;
}

// ---------- 第 4 段：优化客户 ----------
// 为选定客户生成个性化作战方案：钩子议题 + 三条关键诉求 + 报价参考。确定性构造。
function optimizeOne(roundNo, ctx) {
  const o = [];
  const db = store.read();
  const lead = pickLead(db.leads, '选择', roundNo, ctx && ctx.advanced);
  if (!lead) { o.push('无待优化客户（先「选择客户」）'); return o; }
  const hooks = [
    '《决策手册》：把创业最难的三步拆开',
    '见证官计划：先陪你跑一个 30 天冷启动',
    'AI 决策沙盒：结构化框架替直觉下判断'
  ];
  const plan = [
    '第一步：P0 精准钩子「' + hooks[(db.leads || []).length % hooks.length] + '」',
    '第二步：提供 3 分钟案例价值（案例库真实场景）',
    '第三步：报价参考 ¥' + (199 + (lead.signal || 60) * 3) + ' 档位（按信号溢价）'
  ];
  store.update('leads', lead.id, { stage: '优化', plan }, 'leadgen·优化方案');
  if (ctx && ctx.advanced) ctx.advanced.add(lead.id);
  o.push('为『' + leadName(lead) + '』定制方案：' + plan[0] + ' / ' + plan[2]);
  return o;
}

// ---------- 第 5 段：催收计划（不冒充已发送） ----------
// 排定一次触达计划：绝不造假"已发送"。系统不代发邮件/企微——只把触达时机、渠道、
// 拟交给人工执行，落 audit 措辞如实写"排定待人工触达"，绝不写"已触达/已发送"。
//
// 【2026-09 修复·伪造进展】原来这里写 `touch: touches + 1`——把**排定的计划**记成了
// **已发生的触达**，而 close() 的成熟门槛恰恰是 `touch >= 2`。于是机器只要排两次计划
// （一次也没真发出去），线索就自动升级为「商机候选」。这与本文件"绝不冒充已发送"的
// 承诺直接矛盾，也让 230 条线索 / 0 客户的漏斗失去意义。
// 现在严格区分两个计数器：
//   planned —— 机器排了几次计划（可无限排，不构成任何进展证据）
//   touch   —— 人工**确认**已真实触达的次数（只能由 markTouched() 增加）
// close() 的门槛只看 touch，因此"商机候选"必然对应真实的人际接触。
function promote(roundNo, ctx) {
  const o = [];
  const db = store.read();
  const lead = pickLead(db.leads, '优化', roundNo, ctx && ctx.advanced);
  if (!lead) { o.push('无待触达客户（先「优化客户」）'); return o; }
  const planned = Number(lead.planned || 0);
  // 多渠道轮换：按历史渠道总数轮换（回炉也不重复同渠道）
  const ch = CHANNELS[(Array.isArray(lead.plannedChannels) ? lead.plannedChannels.length : planned) % CHANNELS.length];
  // 【关键】计划渠道写 plannedChannels，**绝不写 channels**。
  // channels 是 roiBoard() 归因真实触达渠道的唯一依据；把"打算发"混进去，
  // ROI 看板就会把没发出去的投放算成已触达 —— 同一类"把计划冒充进展"的造假。
  const plannedChannels = (Array.isArray(lead.plannedChannels) ? lead.plannedChannels.slice() : []).concat([ch]);
  store.update('leads', lead.id, {
    planned: planned + 1, stage: '促单', plannedChannels,
    lastPlanAt: now(), touchPlanned: true
  }, 'leadgen·排定触达计划（待人工执行）');
  if (ctx && ctx.advanced) ctx.advanced.add(lead.id);
  o.push('为『' + leadName(lead) + '』排定第 ' + (planned + 1) + ' 次触达计划（渠道 ' + ch + '，待人工执行，系统不代发）→ 进「促单」段，等人工真实触达后回报');
  return o;
}

// ---- 人工确认一次真实触达：唯一能增加 touch 的入口 ----
// 这是漏斗里唯一的"人造进展"闸门。必须给渠道；evidence 可选但强烈建议（回执/截图说明）。
// 没有它，close() 的 touch>=2 永远达不到，线索会老老实实停在「促单」等人工——
// 这正是我们要的：机器不生产进展，只生产可执行计划。
function markTouched(id, channel, evidence) {
  const db = store.read();
  const lead = (db.leads || []).find(l => l.id === id);
  if (!lead) return { ok: false, error: '线索不存在' };
  const ch = String(channel || '').trim().slice(0, 40);
  if (!ch) return { ok: false, error: '必须填写本次真实触达的渠道（邮件/微信/通话…），系统不接受无渠道的触达确认' };
  const ev = String(evidence || '').trim().slice(0, 200);
  const touches = (Number(lead.touch) || 0) + 1;
  const channels = (Array.isArray(lead.channels) ? lead.channels.slice() : []).concat([ch]);
  store.update('leads', lead.id, {
    touch: touches, channels, lastTouch: now(),
    lastTouchChannel: ch, lastTouchEvidence: ev || undefined
  }, 'leadgen·人工确认真实触达');
  store.push('audit', {
    action: '真实触达确认',
    detail: leadName(lead) + ' 第 ' + touches + ' 次触达（' + ch + '）' + (ev ? ' 凭证 ' + ev.slice(0, 60) : ' 未附凭证'),
    at: Date.now()
  }, null, null);
  return { ok: true, touch: touches, channels, stillNeeds: Math.max(0, CLOSE_MIN_TOUCH - touches) };
}

// ---------- 第 6 段：线索达标 → 上报人工（自动化绝不编造成交额/成交状态） ----------
// 自动化只负责把成熟线索加权上报为「商机候选」，金额=null 供人工线下洽谈后填。
// 诚实记账：自动化永不写 revenue/customers，也永不写「待成交」；「待成交/成交」是
// 人工端点 /v1/leads/:id/convert 的专属领地（人类确认真实收款金额后才落账）。
function close(roundNo, ctx) {
  const o = [];
  const db = store.read();
  const lead = pickLead(db.leads, '促单', roundNo, ctx && ctx.advanced);
  if (!lead) { o.push('无促单中的客户'); return o; }
  if (ctx && ctx.advanced) ctx.advanced.add(lead.id);
  const tries = Number(lead.tries || 1);
  const touch = Number(lead.touch || 0);          // 只数人工确认的真实触达
  const planned = Number(lead.planned || 0);      // 机器排了多少次计划（**不构成进展**）
  const prob = convProb(lead);

  // 判定按**阻塞原因**分，而不是一律回炉：
  //   touch === 0  → 阻塞方是"人没动"，回炉到优化毫无意义（机器该做的都做了），
  //                  让线索稳稳停在「促单」等人工，别在 优化↔促单 之间来回振荡。
  //   touch >= 1   → 说明真人已经接触过了，此时不达标才是线索质量问题，回炉有意义。

  // A) 成熟 → 商机候选（待人工洽谈）
  if (touch >= CLOSE_MIN_TOUCH && Number(lead.signal || 0) >= CLOSE_MIN_SIGNAL) {
    store.update('leads', lead.id, {
      stage: '商机候选', deal: null, signalAt: Date.now(), needHuman: true,
      touchesAtGate: touch
    }, 'leadgen·上报商机候选（真实触达已达标·待人工洽谈）');
    o.push('『' + leadName(lead) + '》真实触达 ' + touch + '/' + CLOSE_MIN_TOUCH + ' 次、信号 ' + Number(lead.signal || 0) + '/' + CLOSE_MIN_SIGNAL + '、预测成交率 ' + prob + '% 达标 → 上报为商机候选，等待人工线下洽谈后经 /v1/leads/:id/convert 确认入账');
    return o;
  }

  // B) 真人零触达：机器排满两次计划仍没人动 → 明确交回人工，移出自动轮转
  if (touch === 0 && planned >= 2) {
    store.update('leads', lead.id, {
      stage: '长期跟进', tries: tries + 1, underFollow: true,
      blockedOn: 'human-touch', planned
    }, 'leadgen·转长期跟进（真人零触达）');
    o.push('『' + leadName(lead) + '』机器已排定 ' + planned + ' 次触达计划，但人工真实触达 0 次 —— 线索停在「促单」不会自己成交，需人工执行一次触达后回报（POST /v1/leads/:id/touch）');
    return o;
  }

  // C) 真人零触达但机器还在排计划中：原地等待，不推进也不打回（保持状态稳定）
  if (touch === 0) {
    o.push('『' + leadName(lead) + '》等待人工第 1 次真实触达（已排定 ' + planned + ' 次计划，真实触达 0/' + CLOSE_MIN_TOUCH + '）→ 留在「促单」等人工，不自动推进');
    return o;
  }

  // D) 已真实接触但仍未达标 → 线索质量问题，回炉重谈（真实触达次数与计划数都不清零）
  if (tries >= 3) {
    store.update('leads', lead.id, {
      stage: '长期跟进', underFollow: true, blockedOn: 'below-threshold'
    }, 'leadgen·转长期跟进（移出自动轮转）');
    o.push('『' + leadName(lead) + '》真实触达 ' + touch + '/' + CLOSE_MIN_TOUCH + ' 次、信号 ' + Number(lead.signal || 0) + '/' + CLOSE_MIN_SIGNAL + '、预测成交率 ' + prob + '%，第 ' + tries + ' 次未达标 → 转「长期跟进」，机器不再自动重试，等人工判断');
    return o;
  }
  store.update('leads', lead.id, { stage: '优化', tries: tries + 1 }, 'leadgen·回炉重谈');
  o.push('『' + leadName(lead) + '》真实触达 ' + touch + '/' + CLOSE_MIN_TOUCH + ' 次、信号 ' + Number(lead.signal || 0) + '/' + CLOSE_MIN_SIGNAL + '、预测成交率 ' + prob + '%，未达线·第 ' + tries + ' 次回炉重谈（真实触达次数保留，不清零）');
  return o;
}

// 人工确认成交：唯一把「商机候选」转「待成交」的合法入口。amount 须人工填真实金额。
function convert(id, amount) {
  const db = store.read();
  const lead = (db.leads || []).find(l => l.id === id);
  if (!lead) return { ok: false, error: '线索不存在' };
  const amt = Number(amount);
  if (!(amt > 0)) return { ok: false, error: '必须提供 > 0 的真实成交金额' };
  store.update('leads', id, { stage: '待成交', deal: amt, closedAt: now(), roi: lead.cost > 0 ? Math.round((amt - lead.cost) / lead.cost * 100) : null }, 'leadgen·待成交（人工确认入账）');
  store.push('audit', { action: 'leadgen·人工确认成交', detail: leadName(lead) + ' ¥' + amt + ' → 待成交，经 /v1/money/credit 入账', at: Date.now() }, null, null);
  // 器官协作：手臂（获客）广播「成交」信号 → 钱袋/记忆皮层/免疫记忆 统一接收处理。
  // 不在这里各自沉淀——由 organs 的反射弧统一做，避免"各跑各的"。
  try {
    require('./organs').publish('deal@done', {
      leadId: id, name: leadName(lead), amt,
      channel: lead.channel || lead.source || '未知',
      industry: lead.industry || '未知'
    });
  } catch (e) {}
  // 履约自动建单：已确认成交的线索必须有订单跟踪（绝对不"裸成交跳过履约"）
  try {
    require('./fulfillment').createFromDeal(id);
  } catch (e) {
    store.push('audit', { action: '履约·建单失败', detail: leadName(lead) + ' ' + String(e && (e.message || e)).slice(0, 80), at: Date.now() }, null, null);
  }
  return { ok: true, lead: { ...lead, stage: '待成交', deal: amt, closedAt: now() } };
}

// 删除原有的自动 settle（已无调用方，避免回归陷阱）
function settle() { return []; }

// 客户生命周期：按成交次数与活跃距今天数归类 新客/复购/沉睡/流失
function lifecycle() {
  const db = store.read();
  return (db.customers || []).map(c => {
    const ageD = (now() - (c.lastAt || c.at || now())) / 86400000;
    let state = '新客';
    if ((c.deals || 1) >= 2) state = '复购';
    else if (ageD > 90) state = '流失';
    else if (ageD > 45) state = '沉睡';
    return { name: c.company || c.name, deals: c.deals || 1, amount: c.amount || 0, state, lastAt: Math.round(ageD) + '天前' };
  });
}

// ---------- 主入口：每次轮巡推进整条漏斗 ----------
// 原实现每轮只推进一段，且从最靠近成交的段往前挑。结果：促单段有一条
// 永远不满足条件的线索，于是每轮都只跑 close()，13 条「探测」线索
// 永远推不出去，漏斗实际只有一个客户在打转。
//
// 改为：按漏斗顺序把每个「有货」的段都推进一次，段与段之间互相喂数据。
// 单段失败不阻断后续段（失败隔离）。
// opts.intensity：1 = 常规（每轮补一批）；>1 = 冲刺（KPI 落后时一轮多补几批）。
// 目标「半年千万」是后台 24h 全方位运行的硬指标，落后时必须加大获客投放量，
// 否则漏斗只消化存量、目标永远推不动。
async function funnelStep(roundNo, opts) {
  const o = opts || {};
  const intensity = Math.max(1, Math.min(4, Number(o.intensity) || 1));
  const out = [];
  let db = store.read();
  if (!(db.leads || []).length) {
    out.push('获客：' + (await find(roundNo)).join(' · '));
    return out;
  }
  const has = stage => (store.read().leads || []).some(l => l.stage === stage);
  const count = stage => (store.read().leads || []).filter(l => l.stage === stage).length;
  // 每段一轮最多推进 3 条：用递增 roundNo 错开 pickLead 的轮转下标，
  // 否则同一段每轮只动 1 条，5 条线索要走 5 轮才过完全程（backlog 消化太慢）。
  const PASS = 3;
  // 【2026-09 修复·单轮级联】原实现在同一轮里依次跑完 5 段，
  // 于是刚探测到的线索一轮之内就被推到「优化」——5 个阶段之间没有任何真实动作，
  // 漏斗退化成一条传送带。现用 advanced 集合保证：**一条线索一轮最多推进一段**。
  const ctx = { advanced: new Set() };

  // 【2026-09·防卡死】把 5 段推进包进一个 store.batch()。
  // 原来每段各自 store.update（实测单轮 3~18 次同步写盘 ≈ 1.6s 阻塞），
  // 而这一整段是**同一个同步调用栈**内跑完的，符合 batch 的前提，N 次写压成 1 次。
  // 注意：第 6 步"补充获客"含 await find()（要联网），必须留在 batch 之外——
  // batch 期间一旦 await 让出事件循环，"同一 tick"前提就不成立。
  store.batch(() => {
    // 1) 探测/触达 -> 推荐
    out.push('推荐：' + recommend(ctx).join(' · '));
    // 2) 推荐 -> 选择
    for (let i = 0; i < PASS && count('推荐') > 0; i++) out.push('选择：' + selectOne(roundNo + i, ctx).join(' · '));
    // 3) 选择 -> 优化
    for (let i = 0; i < PASS && count('选择') > 0; i++) out.push('优化：' + optimizeOne(roundNo + i, ctx).join(' · '));
    // 4) 优化 -> 促单
    for (let i = 0; i < PASS && count('优化') > 0; i++) out.push('促单：' + promote(roundNo + i, ctx).join(' · '));
    // 5) 促单 -> 商机候选（门槛是**人工确认的真实触达**，机器到这一步就该停了）
    for (let i = 0; i < PASS && count('促单') > 0; i++) out.push('成交：' + close(roundNo + i, ctx).join(' · '));
  });
  db = store.read();
  // 6) 补充获客：没有在途线索时必须获客；即使有在途，若"长期跟进"堆积过多
  //    （close 判定屡次未达标、已停止自动轮转）也继续获客，否则漏斗会整条僵死。
  //    实测曾出现 85/87 条全落在 underFollow、funnelStep 无事可做、KPI 目标永远推不动。
  const liveStages = ['触达', '探测', '推荐', '选择', '优化', '促单'];
  const busy = liveStages.some(st => (db.leads || []).some(l => l.stage === st));
  const parked = (db.leads || []).filter(l => (l.stage === '长期跟进' || l.stage === '商机候选')).length;
  const idle = !busy || parked >= 5;
  if (idle) {
    for (let i = 0; i < intensity; i++) {
      out.push('获客：' + (await find(roundNo + i * 7)).join(' · '));
    }
  }

  if (!out.length) out.push('获客闭环当前无推进（等待轮巡触发）。');

  // 7) 如实汇报"机器已经做完了、现在卡在人工"的数量。
  // 这是当前 0 客户局面最该盯的数字：它不会被任何自动轮次稀释，
  // 也不允许被"排定计划"冒充成进展。
  const waitingHuman = (db.leads || []).filter(l =>
    l.stage === '促单' && (Number(l.touch) || 0) < CLOSE_MIN_TOUCH);
  if (waitingHuman.length) {
    out.push('⏸ 待人工真实触达 ' + waitingHuman.length + ' 条（机器已排定计划，但 "商机候选" 需要 ≥' +
      CLOSE_MIN_TOUCH + ' 次人工确认触达：POST /v1/leads/:id/touch）');
  }
  return out;
}

// 漏斗看板：各段计数 + 成交总额 + 生命周期
function board() {
  const db = store.read();
  const leads = db.leads || [];
  const byStage = {};
  const channels = {};
  leads.forEach(l => {
    byStage[l.stage] = (byStage[l.stage] || 0) + 1;
    (l.channels || []).forEach(c => { channels[c] = (channels[c] || 0) + 1; });
  });
  const waitingHuman = leads.filter(l => l.stage === '促单' && (Number(l.touch) || 0) < CLOSE_MIN_TOUCH);
  const realTouches = leads.reduce((s, l) => s + (Number(l.touch) || 0), 0);
  const plannedOnly = leads.reduce((s, l) => s + (Number(l.planned) || 0), 0);
  return {
    total: leads.length, byStage, channels,
    customers: (db.customers || []).length,
    deals: (db.customers || []).reduce((s, c) => s + (c.amount || 0), 0),
    lifecycle: lifecycle(),
    stages: STAGES, channels_def: CHANNELS,
    // 进展的诚实口径：机器排了多少计划 vs 人真做了多少次接触
    realTouches, plannedOnly, waitingHuman: waitingHuman.length,
    closeGate: { minTouch: CLOSE_MIN_TOUCH, minSignal: CLOSE_MIN_SIGNAL },
    // 阻塞归因：长期跟进里的线索到底缺什么
    blocked: leads.filter(l => l.stage === '长期跟进').reduce((m, l) => {
      const k = l.blockedOn || 'unknown';
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {})
  };
}

module.exports = {
  find, recommend, selectOne, optimizeOne, promote, close, convert, funnelStep, board,
  lifecycle, convProb, icpScore, roiBoard, markTouched,
  STAGES, SIDELINES, ICP, CLOSE_MIN_TOUCH, CLOSE_MIN_SIGNAL
};