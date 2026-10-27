// core/decision-bridge.js — 决策中心 ↔ 智能聊天 互通层
//
// 【这一层为什么必须单独存在】
// 实测两个方向都断：
//   决策中心 → 聊天：decision-focus.chatDirective() 能注入指令，**但要求先有焦点**；
//                    而 normDomain() 只认精确域名（"定价"→定价），
//                    用户在聊天里说「我该不该把年费从899提到1299」→ 返回 null。
//   聊天 → 决策中心：orchestrator 识别出 intent='decision'，
//                    但**从不调用 set()**，所以决策中心压根不知道这次对话在决策什么。
// 表现就是用户说的「不互通不智能」：两边各自有数据，就是不联动。
//
// 【三条设计原则】
//   1. 推断要有**依据**：关键词命中 + 与该域既有决策问题的语义重叠，
//      并返回命中了哪些词，便于核对与纠正。不是黑箱猜一个域。
//   2. 不擅自改已有焦点：用户已设了焦点时，新问题**不覆盖**，
//      只标注"与当前焦点相关/不同"，把选择权留给人。
//   3. 登记要**可撤销**：任何自动登记都必须能被 close()，且审计留痕。
const DF = require('./decision-focus');

// —— 业务域关键词表 ——
// 刻意保守：只收真能唯一指向一个域的词。像"用户""产品"这种跨域词不放，
// 放进来会让"用户增长"既命中增长又命中市场，反而更不准。
const DOMAIN_KW = {
  '定价': ['定价', '价格', '涨价', '提价', '降价', '折扣', '套餐', '收费', '定价策略', '定价模型',
    '年费', '月费', '客单价', '收费墙', '续费涨价', '溢价', '价格带', '盈亏平衡点', '报价'],
  '增长': ['增长', '获客', '拉新', '转化', '复购', '留存', '裂变', '漏斗', '线索', '商机',
    '渠道', '投放', 'roi', 'gmv', '增长曲线', '用户增长', '拓客', '客源', '成交率',
    // 【补】平台名本身就是获客渠道问题，用户说「小红书值得做吗」时
    // 一个域特征词都没有 → 返回 null → 决策无法登记，只能干瞪眼。
    '小红书', '抖音', '视频号', 'b站', '哔哩', '知乎', '公众号', '微博', '快手',
    '私域', '公域', '直播', '带货', 'kol', '达人', '种草'],
  '财务': ['财务', '现金流', '账上', '资金', '成本', '支出', '预算', '收入确认', '对账',
    '报销', '付款', '打款', '结算周期', '垫资', '利润率', '毛利', '亏钱', '融资', '估值',
    // 【补】"还能撑多久"是典型的财务决策问法，原来不含任何关键词
    '撑多久', '周转', '够不够', '扛得住', '亏本', '回本', '多久回本'],
  '战略': ['战略', '方向', '定位', '护城河', '竞争格局', '差异化', '长期', '三年', '愿景',
    '使命', '核心优势', '劣势', '壁垒', '转型', '是否该all in', '押注'],
  '市场': ['市场', '客户画像', '目标客户', '用户画像', '客群', '细分', '行业', '赛道',
    '需求验证', '受众', '地域', '出海', '海外市场', '市场规模', 'tam', '值得做吗', '值不值得做'],
  '运营': ['运营', '流程', '效率', '瓶颈', '交付', '排期', '产能', '自动化', '标准化',
    'sop', '内控', '执行', '落地', '跑通', '卡在哪一环'],
  '风险': ['风险', '合规', '法务', '合同', '监管', '投诉', '退款', '纠纷', '安全', '隐私',
    '封号', '违规', '告警', '故障', '坏了', '止损', '隐患'],
  '人力': ['人力', '招人', '招聘', '团队规模', '人员', '离职', '绩效', '薪酬', '工资',
    '岗位', '职责', '谁来做', '加人', '减人', '外包', '兼职', '老板', '员工'],
  '管理': ['管理', '目标', 'kpi', 'okr', '进度', '考核', '优先级', '协同', '会议',
    '汇报', '周报', '季度', '规划', '里程碑', '是否达标'],
  '数据': ['数据', '指标', '口径', '埋点', '看板', '统计', '报表', '归因', '度量',
    '数据质量', '字段', '数据库', '取数', '清洗'],
  '技术': ['技术', '代码', '架构', '性能', '并发', '延迟', '接口', 'api', '部署',
    '重构', '技术选型', '瓶颈在代码', '系统卡', '稳定性', 'bug', '故障率', '模型选型',
    // 【补】用户描述症状的说法，不是技术术语：这么卡/很慢/跑不起来/报错
    '这么卡', '很卡', '卡顿', '很慢', '好慢', '跑不起来', '起不来', '报错', '打不开', '崩'],
  '玄数': ['玄数', '直觉', '不确定', '盲区', '相反证据', '反例', '假设', '验证',
    '凭什么', '有没有可能错', '本质', '第一性原理', '换个角度']
};

// —— 推断：文本 → 业务域 ——
function inferDomain(text, opt) {
  const o = opt || {};
  const s = String(text || '');
  if (!s.trim()) return { domain: null, key: null, score: 0, reason: '空输入' };

  // 只看**能唯一指向域**的部分：去掉客套与元话语
  const cleaned = s
    .replace(/^(帮我|请问|我想|我要|你觉得|你建议|分析一下|看看|到底|到底该|应不应该|要不要|该不该|值不值)/g, '')
    .replace(/(好不好|行不行|可以吗|呢|吗|？|\?)/g, '');

  const scored = [];
  for (const dom of Object.keys(DOMAIN_KW)) {
    const kws = DOMAIN_KW[dom];
    let score = 0;
    const hit = [];
    for (const k of kws) {
      if (cleaned.indexOf(k) >= 0) {
        // 长词更可信（"定价策略" 比 "定价" 更能说明意图）
        score += k.length >= 4 ? 3 : k.length >= 3 ? 2 : 1;
        hit.push(k);
      }
    }
    if (score > 0) scored.push({ domain: dom, key: (DF.DOMAINS[dom] || {}).key, score, hit });
  }

  scored.sort((a, b) => b.score - a.score);

  // 语义兜底：与该域既有决策问题的词面重叠
  // （用户说"接单太多忙不过来"，没有命中关键词，但和「人力/运营」的
  //  既有决策问题用词相近）
  if (!scored.length || (scored[0] && scored[0].score < 2)) {
    for (const dom of Object.keys(DF.DOMAINS)) {
      const qs = (DF.DOMAINS[dom].questions || []).join(' ');
      const cn = new Set((qs.match(/[\u4e00-\u9fa5]{2,4}/g) || []));
      let ov = 0;
      const words = cleaned.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      words.forEach(w => { if (cn.has(w)) ov++; });
      if (ov >= 2) scored.push({ domain: dom, key: DF.DOMAINS[dom].key, score: ov * 0.5, hit: ['与该域决策问题用词相近'], weak: true });
    }
    scored.sort((a, b) => b.score - a.score);
  }

  const top = scored[0];
  if (!top || top.score < 1) {
    return { domain: null, key: null, score: top ? top.score : 0, reason: '无任何域特征词，无法归类', candidates: [] };
  }
  const gap = scored[1] ? (top.score - scored[1].score) : top.score;
  return {
    domain: top.domain,
    key: top.key,
    score: top.score,
    hit: top.hit,
    weak: !!top.weak,
    // 置信度低时要明说，别假装很确定
    confidence: gap >= 2 ? 'high' : (gap >= 1 ? 'medium' : 'low'),
    candidates: scored.slice(0, 3).map(x => x.domain + '(' + x.score.toFixed(1) + ')'),
    reason: '命中 ' + top.hit.join('、')
      + (top.weak ? '（弱推断，建议确认）' : '')
      + (gap === 0 && scored[1] ? '；与「' + scored[1].domain + '」难以区分' : '')
  };
}

// —— 判定一句话是不是在"做决策"——
const DECISION_PAT = [
  /该不该/, /要不要/, /值不值/, /是否该/, /该不该要/,
  /做不做/, /选哪个/, /怎么选/, /哪一个更/, /还是.{0,6}好/,
  /^该/, /到底该/, /帮我决定/, /拿主意/, /拍板/,
  // 【补】这些也是决策句，但不含"该不该"：
  //   "值得做吗" 是投入判断；"还能撑多久" 是期限判断；
  //   "为什么这么卡" 背后是"要不要优化/重构"的决策。
  /值得/, /还.{0,3}多久/, /够不够/, /扛得住/, /扛不住/,
  /回本/, /赚不赚/, /亏不亏/, /为什么这么/, /要不要改/, /改不改/,
  /.{0,8}好吗[?？]?$/, /还是.{0,8}划算/, /哪条路/, /怎么走/
];
function looksLikeDecision(text) {
  const s = String(text || '');
  if (DECISION_PAT.some(re => re.test(s))) return true;
  // 有明确商业动词 + 疑问结构，也算决策
  if (/[?？]/.test(s) && /(涨|降|招|投|做|上|停|砍|加|换|开|关|买|卖|租|招人|上线|下线)/.test(s)) return true;
  return false;
}

// —— 聊天 → 决策中心：自动登记 ——
// 【不擅自覆盖已有焦点】用户已经定了方向时，新问题是"补充"而不是"换题"。
async function syncFromChat(text, opt) {
  const o = opt || {};
  const out = { action: 'none', reason: '' };

  const cur = DF.current();
  const inf = inferDomain(text);

  // 情况 1：已有焦点 → 不覆盖，只判断相关性
  if (cur) {
    out.action = 'kept';
    out.current = cur;
    out.inferred = inf;
    const same = inf.domain === cur.domain;
    out.related = same;
    out.reason = same
      ? ('与当前焦点「' + cur.domain + '」同向，回答已对齐该决策')
      : ('当前焦点是「' + cur.domain + '」，本轮推断偏「' + (inf.domain || '未归类')
        + '」；已保留原焦点不做覆盖，可手动 close 后切换');

    // 【重要修正】闲聊时**不注入**决策指令。
    // 原来只要有焦点就注入，于是用户问「今天天气怎么样」也会被硬掰成
    // "回答要服务于定价决策" —— 过度施加约束，回答变得莫名其妙。
    // 焦点应该在**讨论相关话题**时起作用，不该劫持无关对话。
    const chitchat = !looksLikeDecision(text) && inf.score < 1;
    if (chitchat) {
      out.aligned = false;
      out.reason += '；本轮为无关对话，不施加决策约束';
    } else {
      out.aligned = true;
      out.directive = DF.chatDirective();
    }
    return out;
  }

  // 情况 2：无焦点 + 不是决策句 → 不登记
  if (!o.force && !looksLikeDecision(text)) {
    out.action = 'none';
    out.inferred = inf;
    out.reason = '本轮不是决策类提问，且当前没有决策焦点，未自动登记';
    return out;
  }

  // 情况 3：无焦点 + 是决策句 → 登记
  if (!inf.domain) {
    out.action = 'skipped';
    out.inferred = inf;
    out.reason = '判定为决策类提问，但无法归入 12 个业务域（' + inf.reason + '），不硬塞一个域';
    return out;
  }

  // 置信度太低时不自动登记 —— 登记错域比不登记更有害
  if (inf.confidence === 'low' && !o.force) {
    out.action = 'skipped';
    out.inferred = inf;
    out.reason = '推断域置信度低（' + inf.candidates.join('、') + '），需你确认后再登记';
    out.suggest = inf.domain;
    return out;
  }

  try {
    const r = await DF.set(inf.domain, String(text).slice(0, 120));
    out.action = 'registered';
    out.registered = r && r.focus;
    out.inferred = inf;
    out.directive = DF.chatDirective();
    // 【踩过的坑】原来写 r.tasks.length —— DF.set() 返回的是 { ok, focus }，
    // 没有 tasks 字段，于是提示语变成"派发 undefined 项指向性任务"。
    // 任务数要从 progress() 读，别引用不存在的字段。
    const pg = DF.progress();
    out.tasks = pg && pg.total !== undefined ? pg.total : 0;
    out.reason = '已自动登记决策焦点「' + inf.domain + '」并派发 '
      + out.tasks + ' 项指向性任务（依据：' + inf.reason + '）';
    return out;
  } catch (e) {
    out.action = 'error';
    out.error = String(e.message || e);
    out.reason = '登记失败：' + out.error;
    return out;
  }
}

// —— 决策中心 → 聊天：本轮可推进的动作 ——
// 聊天不只是"知道有个焦点"，还要知道**现在能推哪一项**。
function nextMoves() {
  const p = DF.progress();
  if (!p.active) return { active: false, moves: [], hint: '当前没有决策焦点，可在决策中心选定，或在聊天里直接问一个决策问题（如「该不该提价」）' };
  const db = require('./store').read();
  const focus = DF.current();
  const tasks = (db.tasks || []).filter(t => String(t.ref || '').indexOf('decision:' + focus.id) === 0
    || String(t.ref || '').indexOf('decision:') === 0 && String(t.title || '').indexOf(focus.domain) >= 0);
  const open = tasks.filter(t => !t.done);
  return {
    active: true,
    domain: focus.domain,
    topic: focus.topic,
    moves: open.slice(0, 5).map(t => ({ id: t.id, title: t.title, owner: t.ownerName || '未认领', status: t.status || 'todo' })),
    hint: open.length
      ? ('当前焦点「' + focus.domain + '」有 ' + open.length + ' 项待推进，可直接问其中某项要怎么做')
      : '当前焦点的指向性任务已全部完成，可 close 焦点或换新方向'
  };
}

module.exports = { inferDomain, looksLikeDecision, syncFromChat, nextMoves, DOMAIN_KW };