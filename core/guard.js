// core/guard.js —— 同在守护：心理学·策略·智慧库（第 13 条）
//
// 【定位】不是简单的资料库，而是：
//   1. 心理学模型库：人格画像、认知偏差、决策心理、压力应对、团队动力学
//   2. 策略知识库：孙子兵法、博弈论、商业战略、竞品分析框架、谈判战术
//   3. 智慧沉淀：实战案例、失败复盘、最佳实践、模式识别
//   4. 实时护盾：基于心理/策略模型的实时预警与建议
//
// 【数据源】内置模型 + GitHub 技能包 (psychology/strategy 类) + 实战沉淀
// 【对外能力】guard.analyze(context) → { risks, suggestions, models, confidence }

const fs = require('fs');
const path = require('path');
const store = require('./store');
const agentmesh = require('./agentmesh');

const PSYCHOLOGY_MODELS = {
  // 人格与认知
  big5: { name: 'Big Five 人格特质', dims: ['开放性','尽责性','外向性','宜人性','神经质'], apply: '团队配置/岗位匹配' },
  mbti: { name: 'MBTI 类型', dims: ['E/I','S/N','T/F','J/P'], apply: '沟通风格/协作模式' },
  disc: { name: 'DISC 行为模型', dims: ['支配型','影响型','稳健型','顺从型'], apply: '冲突化解/激励策略' },
  // 认知偏差
  biases: {
    confirmation: { name: '确认偏误', desc: '倾向寻找支持既有观点的信息', counter: '主动寻找反面证据' },
    anchoring: { name: '锚定效应', desc: '过度依赖首个获得的信息', counter: '多源信息交叉验证' },
    sunk_cost: { name: '沉没成本谬误', desc: '因已投入而继续错误决策', counter: '仅看边际收益' },
    overconfidence: { name: '过度自信', desc: '高估自身判断准确性', counter: '预演失败场景/红队' },
    availability: { name: '可得性启发', desc: '易回忆的事件被高估概率', counter: '数据驱动而非直觉' },
    loss_aversion: { name: '损失厌恶', desc: '损失痛感是同等收益的 2 倍', counter: '重构为机会成本' }
  },
  // 压力与韧性
  stress: {
    fight_flight: { name: '战斗或逃跑', trigger: '感知威胁', manage: '呼吸/认知重构/微行动' },
    window_of_tolerance: { name: '耐受窗口', desc: '最佳唤醒区间，超出则过度/不足唤醒', manage: '识别信号/调节回窗口' },
    resilience: { name: '心理韧性', factors: ['意义感','自主感','连接感','能力感'], build: '小胜利累积/社会支持' }
  },
  // 团队动力学
  team: {
    psychological_safety: { name: '心理安全感', key: '可冒险/认错/提问不被惩罚', measure: 'Google 亚里士多德项目 5 维度' },
    tuckman: { name: '塔克曼阶段', stages: ['形成期','震荡期','规范期','执行期','终结期'], guide: '阶段匹配领导风格' },
    lencioni: { name: '莱恩西奥尼五大障碍', obs: ['缺乏信任','恐惧冲突','缺乏承诺','逃避责任','不重结果'], fix: '自上而下解决' }
  }
};

const STRATEGY_FRAMEWORKS = {
  // 经典军事/商战
  sun_tzu: { name: '孙子兵法 13 篇', principles: ['知己知彼','以逸待劳','攻其不备','兵贵神速'], biz_map: '市场切入/竞品绕行/资源集中' },
  lanchester: { name: '兰切斯特方程', law: '线性律(单打独斗) vs 平方律(集中优势兵力)', apply: '强者集中/弱者游击' },
  ooda: { name: 'OODA 循环', steps: ['观察','判断','决策','行动'], speed: '比对手快完成循环即胜' },
  // 现代商业战略
  porter: { name: '波特五力', forces: ['供应商','购买者','新进入者','替代品','现有竞争'], use: '行业结构分析/护城河' },
  blue_ocean: { name: '蓝海战略', tools: ['战略画布','四步行动框架','消除-减少-提升-创造'], goal: '开辟无竞争市场' },
  okr: { name: 'OKR 目标管理', cycle: '季度 O + 关键结果 KR', align: '自上而下对齐 + 自下而上承诺' },
  // 竞品与谈判
  competitor: { name: '竞品分析矩阵', dims: ['产品','价格','渠道','推广','用户','技术','品牌'], output: '差异化定位/防御/进攻' },
  negotiation: {
    batna: { name: 'BATNA 最佳替代方案', rule: '无 BATNA 不谈判' },
    zopa: { name: 'ZOPA 共同利益区', rule: '报价必须在区间内' },
    anchoring_talk: { name: '锚定谈判', tactic: '极端首报价拉宽 ZOPA' },
    concession: { name: '让步策略', rule: '小步让步/附带条件/互惠' }
  }
};

// 智慧库：实战沉淀
function loadWisdom() {
  const db = store.read();
  return {
    cases: db.guard_cases || [],
    patterns: db.guard_patterns || [],
    lessons: (db.lessons || []).filter(l => l.tags?.some(t => ['心理','策略','守护'].includes(t))) || []
  };
}

function saveWisdom(w) {
  const db = store.read();
  if (w.cases) db.guard_cases = w.cases.slice(-200);
  if (w.patterns) db.guard_patterns = w.patterns.slice(-100);
  store.write(db);
}

// 核心分析：输入上下文 → 输出风险/建议/模型/置信度
async function analyze(context) {
  const ctx = context || {};
  const { situation, actors, goals, history, metrics } = ctx;
  const wisdom = loadWisdom();
  const risks = [], suggestions = [], models = [];

  // 1. 心理风险扫描
  if (actors?.length) {
    actors.forEach(a => {
      if (a.stressLevel > 7) {
        risks.push({ type: 'psychology', level: 'high', model: 'window_of_tolerance', desc: `${a.name} 压力超载，面临过度唤醒风险`, action: '立即降压：暂停高压任务/引入微休息/1对1倾听' });
        models.push('window_of_tolerance');
      }
      if (a.trustScore < 3) {
        risks.push({ type: 'team', level: 'high', model: 'psychological_safety', desc: `${a.name} 信任度极低，团队心理安全感受损`, action: '建立安全对话机制/公开承认错误/明确共同目标' });
        models.push('psychological_safety');
      }
    });
  }

  // 2. 认知偏差检测（基于决策历史）
  if (history?.length) {
    const recent = history.slice(-10);
    const confirmBias = recent.filter(h => h.type === 'decision' && h.evidence?.confirmOnly).length;
    if (confirmBias > 3) {
      risks.push({ type: 'cognitive', level: 'medium', model: 'confirmation', desc: '近期决策多存在确认偏误', action: '引入红队复盘/强制列出 3 条反面证据' });
      models.push('confirmation');
    }
  }

  // 3. 策略建议生成
  if (goals?.length) {
    const primary = goals.find(g => g.primary) || goals[0];
    if (primary) {
      // 根据目标类型匹配策略框架
      if (primary.unit === '客户' || primary.unit === '家') {
        suggestions.push({ area: 'market', framework: 'blue_ocean', desc: '客户增长目标：用四步行动框架寻找未被满足的细分需求', confidence: 0.8 });
        suggestions.push({ area: 'competition', framework: 'lanchester', desc: '弱势资源下避免正面硬刚，采用游击/差异化集中突破', confidence: 0.75 });
      }
      if (primary.unit === 'CNY' || primary.unit === '¥') {
        suggestions.push({ area: 'revenue', framework: 'porter', desc: '营收目标：分析五力寻找定价权来源，构建转换成本护城河', confidence: 0.8 });
      }
      // OODA 通用建议
      suggestions.push({ area: 'execution', framework: 'ooda', desc: '建立周级 OODA 循环：周一观察数据/周二判断偏差/周三决策调整/周四行动/周五复盘', confidence: 0.9 });
    }
  }

  // 4. 指标异常映射到心理/策略
  if (metrics) {
    if (metrics.conversionRate < 0.02) {
      suggestions.push({ area: 'conversion', framework: 'negotiation', desc: '转化率极低：检查 BATNA 是否清晰、报价是否在 ZOPA、是否建立了足够信任', confidence: 0.7 });
    }
    if (metrics.churnRate > 0.05) {
      risks.push({ type: 'retention', level: 'high', model: 'loss_aversion', desc: '流失率高：客户损失厌恶未被缓解', action: '设计损失框架沟通/提供无损试用/建立转换成本' });
    }
  }

  // 5. 从智慧库匹配历史模式
  wisdom.patterns.forEach(p => {
    if (matchPattern(ctx, p.condition)) {
      suggestions.push({ area: 'pattern', source: 'wisdom', desc: `历史模式：${p.desc}`, action: p.action, confidence: p.confidence || 0.6 });
    }
  });

  // 去重
  const uniqModels = [...new Set(models)];
  return {
    ok: true,
    timestamp: Date.now(),
    risks: risks.slice(0, 10),
    suggestions: suggestions.slice(0, 10),
    modelsUsed: uniqModels,
    confidence: risks.length ? 0.6 : 0.85,
    wisdomStats: { cases: wisdom.cases.length, patterns: wisdom.patterns.length, lessons: wisdom.lessons.length }
  };
}

function matchPattern(ctx, condition) {
  if (!condition) return false;
  // 简易条件匹配：{ metric: 'conversionRate', op: '<', value: 0.02 }
  if (condition.metric && ctx.metrics) {
    const v = ctx.metrics[condition.metric];
    if (v === undefined) return false;
    switch (condition.op) {
      case '<': return v < condition.value;
      case '>': return v > condition.value;
      case '<=': return v <= condition.value;
      case '>=': return v >= condition.value;
      case '==': return v === condition.value;
    }
  }
  return false;
}

// 记录实战案例/模式
function recordCase(input) {
  const w = loadWisdom();
  const c = { id: store.uid(), ...input, at: Date.now() };
  w.cases.push(c);
  saveWisdom(w);
  return c;
}

function recordPattern(input) {
  const w = loadWisdom();
  const p = { id: store.uid(), ...input, at: Date.now(), confidence: input.confidence || 0.6 };
  w.patterns.push(p);
  saveWisdom(w);
  return p;
}

// GitHub 技能包同步：psychology/strategy 类
async function syncPsychologySkills() {
  const res = await agentmesh.discoverPacks({ only: ['psychology', 'strategy', 'negotiation', 'team-dynamics', 'cognitive-bias', 'decision-making', 'behavioral-economics', 'organizational-psychology', 'leadership', 'conflict-resolution', 'stress-management', 'resilience', 'motivation', 'culture', 'change-management', 'coaching', 'facilitation', 'mediation', 'emotional-intelligence', 'mindfulness', 'mental-models'], per: 1 });
  return res;
}

async function loadPsychologyPacks() {
  const packs = await agentmesh.discoverPacks({ only: ['psychology', 'strategy', 'negotiation', 'team-dynamics', 'cognitive-bias', 'decision-making', 'behavioral-economics', 'organizational-psychology', 'leadership', 'conflict-resolution', 'stress-management', 'resilience', 'motivation', 'culture', 'change-management', 'coaching', 'facilitation', 'mediation', 'emotional-intelligence', 'mindfulness', 'mental-models'], per: 3 });
  const results = [];
  for (const p of packs.packs || []) {
    try {
      const loaded = await agentmesh.loadPack(p.key);
      results.push({ key: p.key, ok: loaded.ok, modules: loaded.modules?.length || 0 });
    } catch (e) {
      results.push({ key: p.key, ok: false, error: String(e) });
    }
  }
  return results;
}

// 面板数据
function board() {
  const wisdom = loadWisdom();
  return {
    psychologyModels: Object.keys(PSYCHOLOGY_MODELS).length + Object.keys(PSYCHOLOGY_MODELS.biases).length + Object.keys(PSYCHOLOGY_MODELS.stress).length + Object.keys(PSYCHOLOGY_MODELS.team).length,
    strategyFrameworks: Object.keys(STRATEGY_FRAMEWORKS).length,
    wisdom: { cases: wisdom.cases.length, patterns: wisdom.patterns.length, lessons: wisdom.lessons.length },
    models: { psychology: PSYCHOLOGY_MODELS, strategy: STRATEGY_FRAMEWORKS }
  };
}

// 状态接口
function status() {
  return { ok: true, module: 'guard', ...board() };
}

module.exports = { PSYCHOLOGY_MODELS, STRATEGY_FRAMEWORKS, analyze, recordCase, recordPattern, syncPsychologySkills, loadPsychologyPacks, board, status, loadWisdom, saveWisdom };