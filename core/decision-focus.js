// core/decision-focus.js — 决策焦点与指向性任务目标（第 3 条需求）
//
// 【需求原文】"决策中心，当使用者选择了哪方面的决策，就是客户有目的的想要做出这方面的决策，
//             智能聊天机器人就应该有指向的完成任务目标"
//
// 【为什么这不是"决策中心加个按钮"就完了】
// 原决策中心做完框架分析就结束了：产出是一段 Markdown 文本，躺在 decisions 表里。
// 用户看到"建议优先用 4P 营销"，然后呢？没有下一步、没有任务、没有进度。
// 于是"做决策"和"推进决策"之间是断的——这正是需求要补的那一环。
//
// 【解法：把"我正在做哪方面的决策"变成系统的一等状态】
//   set(domain, topic)  用户选定领域 → 立刻展开成**指向性任务目标**（有主体、有步骤、有验收标准）
//   current()           当前焦点；对话时注入上下文，让聊天**朝着这个目标**回答，而不是泛泛而谈
//   progress()          推进到哪一步（这一步直接喂给第 6 条"任务台确认在跑几个"）
//
// 关键约束：任务必须**指向决策本身**，不是泛泛的"加强增长"。
// 每个领域配一组"这个决策真正需要回答的问题"，任务就是这些问题，
// 这样任务做完 = 决策有答案，而不是"忙了一阵但决策还是悬着"。

const store = require('./store');

// 领域 → 该领域决策真正要回答的问题 + 该动用的系统能力
// 这些是"决策的验收标准"，不是通用建议。写死在这里比让 LLM 临场生成可靠：
// 临场生成会漂移到"多渠道推广"这类谁都能说、但没回答任何具体决策的空话。
const DOMAINS = {
  '增长': {
    key: 'growth',
    questions: [
      '当前增长卡在哪一环：获客不足 / 转化不足 / 复购不足',
      '本季度要把哪个渠道的量做到什么数？上限由什么限制',
      '获客成本上限是多少，超过多少就不该继续投',
      '哪一批线索最值得先做，理由是数据还是猜测'
    ],
    caps: ['cap.leads', 'cap.revenue'],
    board: 'cap.leads'
  },
  '定价': {
    key: 'pricing',
    questions: [
      '当前真实成交价是多少，与标价差多少，差额去哪了',
      '盈亏平衡点是多少，当前销量离它还有多远',
      '提价/降价对收入和成交率的净影响是什么',
      '竞争对手价格带落在哪里，我们在哪个位置'
    ],
    caps: ['cap.price', 'cap.revenue'],
    board: 'cap.price'
  },
  '财务': {
    key: 'finance',
    questions: [
      '已结算实收多少，支出多少，可用资金还能撑几个月',
      '推广池该继续按当前额度投，还是先收回',
      '哪笔投入的 ROI 最低，应该停掉'
    ],
    caps: ['cap.revenue', 'cap.partner'],
    board: 'cap.revenue'
  },
  '战略': {
    key: 'strategy',
    questions: [
      '我们的优势和劣势分别是什么，有数据支撑还是印象判断',
      '外部环境里哪个变量最可能改变现有打法',
      '如果只能做一件事，做哪件，依据是什么'
    ],
    caps: ['cap.leads', 'cap.perf'],
    board: 'cap.leads'
  },
  '市场': {
    key: 'market',
    questions: [
      '目标客户的真实画像是什么，数据从哪来',
      '我们的获客渠道里哪个转化最好',
      '客户为什么买/不买，证据是什么'
    ],
    caps: ['cap.leads', 'cap.skills'],
    board: 'cap.leads'
  },
  '运营': {
    key: 'ops',
    questions: [
      '当前流程里最慢的一环在哪',
      '哪些任务在跑、哪些卡住、哪些超期',
      '哪个环节的产出不达标，瓶颈是什么'
    ],
    caps: ['cap.tasks', 'cap.projects'],
    board: 'cap.tasks'
  },
  '风险': {
    key: 'risk',
    questions: [
      '有哪些未到账款项可能在坏账',
      '系统有哪些反复出现的告警，说明什么结构性问题',
      '最坏情况发生时，我们能撑多久'
    ],
    caps: ['cap.watchdog', 'cap.revenue'],
    board: 'cap.watchdog'
  },
  '人力': {
    key: 'hr',
    questions: [
      '当前任务量与人力是否匹配，谁是瓶颈',
      '谁在做与目标无关的事，该停掉',
      '要完成目标，缺哪类角色'
    ],
    caps: ['cap.org', 'cap.tasks'],
    board: 'cap.org'
  },
  '管理': {
    key: 'mgmt',
    questions: [
      '核心目标的进度是多少，离达标还差多少',
      '本周该完成的三个动作是什么，各自负责人是谁',
      '哪个目标已经连续两周没进展，该重新审视'
    ],
    caps: ['cap.goals', 'cap.tasks'],
    board: 'cap.goals'
  },
  '数据': {
    key: 'data',
    questions: [
      '哪些指标是决策必需的，现在缺哪个',
      '数据口径有没有冲突，哪份是权威台账',
      '系统运行是否健康，有没有阻塞'
    ],
    caps: ['cap.perf', 'cap.audit'],
    board: 'cap.perf'
  },
  '技术': {
    key: 'tech',
    questions: [
      '系统哪些环节在慢，瓶颈在代码还是数据量',
      '哪些技能缺失会影响业务，装载成本多大',
      '哪些故障是反复发生的，根因是什么'
    ],
    caps: ['cap.perf', 'cap.skills'],
    board: 'cap.perf'
  },
  '玄数': {
    key: 'meta',
    questions: [
      '当前决策的最大不确定性是什么，能否用数据消解',
      '有没有被忽略的相反证据',
      '这个决定如果错了，代价是什么'
    ],
    caps: ['cap.audit'],
    board: 'cap.audit'
  }
};

function allDomains() {
  return Object.keys(DOMAINS).map(k => ({ name: k, key: DOMAINS[k].key, questions: DOMAINS[k].questions.length }));
}

// 归一化领域名：允许"增长策略"/"市场增长"这类写法落到标准领域
function normDomain(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  if (DOMAINS[s]) return s;
  // 去掉修饰词再找："增长策略" → 含"增长"
  for (const k of Object.keys(DOMAINS)) if (s.indexOf(k) >= 0) return k;
  return null;
}

// 设焦点：写入状态 + 展开指向性任务（幂等——同一领域重复选定不产生重复任务）
function set(domainRaw, topic, opt) {
  const o = opt || {};
  const domain = normDomain(domainRaw);
  if (!domain) return { ok: false, error: '未识别的决策领域。可选：' + Object.keys(DOMAINS).join(' / ') };
  const D = DOMAINS[domain];
  const t = String(topic || '').trim() || domain + '决策';
  const db = store.read();
  const prev = (db.decisionFocus || []).find(x => x.domain === domain && !x.closed);
  const focusId = prev ? prev.id : store.uid();

  const focus = {
    id: focusId, domain, topic: t,
    questions: D.questions.slice(),
    setAt: prev ? prev.setAt : Date.now(),
    updatedAt: Date.now(),
    closed: false,
    // 任务 id：记录已派生的任务，便于回填进度与关闭
    taskIds: prev ? prev.taskIds.slice() : []
  };

  // 派生任务：每个问题一条，带验收标准（"问题被回答"就是完成条件）
  const created = [];
  D.questions.forEach((q, i) => {
    const title = '【' + domain + '·决策】' + q;
    if (prev && prev.taskIds[i]) { created.push(prev.taskIds[i]); return; }   // 已存在则复用
    const tk = store.push('tasks', {
      title,
      due: '',
      done: false,
      ref: 'decision:' + focusId,
      // 验收标准写进任务体，任务台里能直接看到"做到什么算完成"
      accept: '产出可核查的结论并回填到决策看板：' + q,
      seq: i + 1
    }, '决策任务·派发', title.slice(0, 50));
    created.push(tk.id);
  });
  focus.taskIds = created;

  // 落盘焦点。放在派发任务之后，这样审计里记录的"派发 N 项"是真实发生过的。
  const d2 = store.read();
  if (!Array.isArray(d2.decisionFocus)) d2.decisionFocus = [];
  const i = d2.decisionFocus.findIndex(x => x.id === focusId);
  if (i >= 0) d2.decisionFocus[i] = focus; else d2.decisionFocus.push(focus);
  store.write(d2);

  // 第 6 条：决策派发的指向性任务也要进"在跑"。
  // 原来这里 store.push('tasks') 就直接完事——不认领、不带人，
  // 于是决策中心明明下了 4 项工作，任务台却显示"在跑 0"。
  // team.assign 内部对 ref 以 decision: 开头的任务**优先真派**，正好接住。
  let claimed = null;
  try {
    const AW = require('./assign-work');
    const cr = AW.claimPending({ autoHire: true });
    claimed = { n: (cr.assigned || []).length, pending: cr.pending, unclaimed: cr.unclaimed };
  } catch (e) { claimed = { error: String(e.message || e) }; }

  store.push('audit', {
    action: '决策焦点·设定',
    detail: domain + ' · ' + t + '（派发 ' + created.length + ' 项指向性任务'
      + (claimed && claimed.error ? '，认领失败：' + claimed.error : '，认领 ' + (claimed ? claimed.n : 0) + ' / 未认领 ' + (claimed && claimed.unclaimed != null ? claimed.unclaimed : 0)) + '）',
    at: Date.now()
  });
  return { ok: true, focus, tasks: created.length, claimed };
}

function current() {
  const list = (store.read().decisionFocus || []).filter(x => !x.closed);
  if (!list.length) return null;
  // 最近设定的优先
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
}

function close(id) {
  const d = store.read();
  const f = (d.decisionFocus || []).find(x => x.id === (id || (current() || {}).id));
  if (!f) return { ok: false, error: '没有进行中的决策焦点' };
  f.closed = true; f.closedAt = Date.now();
  store.write(d);
  store.push('audit', { action: '决策焦点·关闭', detail: f.domain + ' · ' + f.topic, at: Date.now() });
  return { ok: true, focus: f };
}

// 推进度：这一条直接服务于第 6 条"确认有多少任务在跑"
function progress(id) {
  const f = id ? (store.read().decisionFocus || []).find(x => x.id === id) : current();
  if (!f) return { active: false };
  const tasks = (store.read().tasks || []).filter(t => f.taskIds.indexOf(t.id) >= 0);
  const done = tasks.filter(t => t.done).length;
  return {
    active: !f.closed,
    id: f.id, domain: f.domain, topic: f.topic,
    total: tasks.length, done, running: tasks.filter(t => !t.done).length,
    pct: tasks.length ? Math.round(done / tasks.length * 100) : 0,
    // 决策是否已有答案：全部问题都被回答 = 决策可以落地了
    answered: tasks.length > 0 && done === tasks.length,
    tasks: tasks.map(t => ({ id: t.id, title: t.title, done: !!t.done, accept: t.accept || '' }))
  };
}

// 给对话用：把当前焦点拼成一段"你现在应当朝这个方向回答"的指令
function chatDirective() {
  const p = progress();
  if (!p.active) return '';
  return '【当前决策焦点 · 回答必须对齐】用户正在做「' + p.domain + '」方向的决策：' + p.topic + '\n'
    + '已派发 ' + p.total + ' 项指向性任务，已完成 ' + p.done + '，进行中 ' + p.running + '。\n'
    + '处理要求：回答要服务于这个决策——给出能推进其中某项任务的具体信息或动作，'
    + '而不是泛泛谈「' + p.domain + '」这个大话题。若用户问的正是这些任务里的某项，'
    + '直接给结论和下一步，不要复述框架。';
}

module.exports = { DOMAINS, allDomains, normDomain, set, current, close, progress, chatDirective };