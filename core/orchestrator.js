// core/orchestrator.js — 对话编排 + 反推脱契约（第 2 条需求的核心）
//
// 【需求原文】
//   "智能对话：要支持调用本软件中的所有程序和功能模块来解答问题，如果发现技能存在限制，
//    可以选择打开进化学习成长，搜寻相应的技能skill来装载，然后回答和解决提出的问题，
//    而不是回答我不会，我解决不了等推脱不负责任的拒绝"
//
// 【拆成三件可验证的事】
//   1. 能调本软件的模块   → core/capability.js（本文件负责调度）
//   2. 技能不够就装载     → discover()：识别缺口 → GitHub 搜技能 → 可一键装载
//   3. 不许推脱           → CONTRACT（写进系统提示）+ verify()（事后扫描并打回重答）
//
// 【为什么第 3 条要"事后扫描"，光靠提示词不够】
// 只在系统提示里写"不要拒绝"，模型仍然会拒绝——因为它训练时就倾向于在不确定时谦逊。
// 所以这里加了一道**输出后校验**：reply 里出现"我无法/我做不到/作为AI"这类推脱话术时，
// 直接判定不合格，把 CONTRACT 升级为"强制"并重问一次。
// 这是把"期望"变成"约束"——和第 1 条语言切换不靠提示词而靠 applyI18n 是同一个思路。
//
// 【设计红线】本文件**不允许**伪造能力。凡是系统真的做不到的事（缺凭证、缺客户授权），
// 正确做法是"说清缺什么 + 给出确切的补齐动作"，而不是假装能做，也不是一句"我不行"。
// 前者是负责任的推脱，后者才是不负责任的推脱。

const capability = require('./capability');
const smart = require('./smart');
const skills = require('./skills');

// —— 反推脱契约 ——
const CONTRACT = [
  '【硬性要求 · 不得违背】',
  '1. 你运行在一个真实业务系统内部，本轮已为你接入下方【本系统实时数据】。凡涉及本系统的事实（营收、线索、任务、员工、项目、告警、目标等），只能引用这些数据作答，禁止凭印象编造数字。',
  '2. 禁止使用任何推脱话术，包括但不限于："我无法"、"我不能"、"我做不到"、"我解决不了"、"作为AI"、"我无法访问您的数据"、"建议您咨询专业人士"、"抱歉，我不能协助"。',
  '3. 遇到确实缺失的能力时，按以下三段式回答，不许只说做不到：',
  '   (a) 先给出你现在**能**做到的部分，并立刻做出来（用已有数据、已有模块给出可直接执行的结果或方案）；',
  '   (b) 精确指出缺的是什么（具体到缺凭证 / 缺授权 / 缺某个技能，而不是笼统说"能力不足"）；',
  '   (c) 给出确切的补齐动作（本系统可一键装载的技能名称、需要客户提供的凭证类型、或需要人工确认的步骤）。',
  '4. 语气是同事之间的专业协作，不是客服话术。不要过度道歉，不要重复免责声明。'
].join('\n');

// 推脱话术检测。命中即判定不合格。
// 注意：这里刻意**不放**"建议"二字——"建议你先做A再做B"是完全正常的可执行建议，
// 放进去会把好答案也误杀。判据是"把责任推回给用户 + 自己不出手"这一组合。
const REFUSAL = [
  { re: /我(无法|不能|没办法|做不到|解决不了|不支持|不具备)/, w: '自称能力不足' },
  { re: /(作为|作为一个)(一个)?(AI|人工智能|语言模型|助手)/, w: '以 AI 身份推卸' },
  { re: /无法(访问|获取|查看|读取)(您|你)?(的)?(数据|信息|系统|后台)/, w: '声称拿不到系统数据' },
  { re: /建议(您|你)(咨询|联系|询问)(专业人士|专家|客服|律师|会计师)/, w: '把问题推给外部' },
  { re: /(抱歉|对不起)[，,]?\s*(我|但我)/, w: '道歉式回避' }
];

// 输出后校验：返回 { ok, hits }
function verify(reply) {
  const s = String(reply || '');
  const hits = REFUSAL.filter(r => r.re.test(s)).map(r => r.w);
  return { ok: hits.length === 0, hits };
}

// —— 能力缺口识别 ——
// 判定"这个问题我们答不了"的标准：既没命中任何系统能力，也没命中任何已装载技能。
// 注意这是**结构化判定**，不是让模型自己说"我不会"——模型的自述不可信，数据可信。
async function detectGap(text, capResult, int) {
  if (capResult.matched > 0) return null;
  if (int && (int.type === 'skill' || int.type === 'data' || int.type === 'decision' || int.type === 'websearch')) return null;
  return { reason: 'no-capability', text: String(text || '').slice(0, 120) };
}

// —— 技能搜索（进化装载的"搜寻"环节）——
// 只做**搜索与提案**，不自动装。理由：装技能 = 引入外部代码，
// 必须让人确认一次，这是安全边界，不因为"不许推脱"就该被绕过。
// 不许推脱 ≠ 静默执行不可逆操作。
//
// 【踩过的坑】最初直接把中文原句丢给 GitHub 搜索，搜"帮我把这个视频自动发到抖音"
// 返回 0 条——GitHub 索引的是英文仓库名/描述，中文自然语言几乎搜不到东西。
// 现在做两步：先剥掉中文口水词留下技术实体，再叠加一张常见意图→英文检索词的映射。
// 映射表刻意保持小而准：宁可少译几个，也不要把"视频"硬译成 video 之后搜出一堆无关仓库。
const EN_HINT = [
  [/(抖音|快手|小红书|视频号|微博|B站|YouTube|youtube)/i, 'uploader'],
  [/(视频|影视|剪辑|成片|片子)/i, 'video'],
  [/(音乐|作曲|编曲|歌曲|配乐|唱歌|写歌|一首歌|歌词|BGM)/i, 'music'],
  [/(游戏|小游戏|Unity|unity)/i, 'game'],
  [/(图片|海报|出图|绘画|配图)/i, 'image'],
  [/(文案|写作|脚本|推文|文章)/i, 'copywriting'],
  [/(爬|抓取|采集|爬虫)/i, 'scraper'],
  [/(翻译|多语言|i18n)/i, 'i18n'],
  [/(报表|数据|分析|看板|图表)/i, 'analytics'],
  [/(客服|工单|售后)/i, 'helpdesk'],
  [/(合同|发票|记账|财务)/i, 'invoice'],
  [/(自动|自动发布|批量)/i, 'automation']
];
function searchTerms(text) {
  const raw = String(text || '');
  const out = [];
  // 1) 中文口水词剥除后剩下的实体。**仅当残留里还有 ASCII 才用**：
  //    GitHub 索引的是英文仓库名/描述，"做一首歌"这种纯中文残留搜出来必然是 0 条，
  //    拿去搜不仅浪费一次网络往返，还会让人误以为"网上真的没有这个技能"。
  const cleaned = raw.replace(/(帮我|请|麻烦|我想|要|把|这个|那个|一下|自动|现在|怎么|如何|什么|能不能|可以|给我|帮忙|的话|好吗|吧|呢|？|\?)/g, ' ')
    .replace(/[，。、！,.!；;：:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length >= 2 && /[a-z0-9]/i.test(cleaned)) out.push(cleaned);
  // 2) 英文技术词（GitHub 真正索引的东西）
  const hints = EN_HINT.filter(([re]) => re.test(raw)).map(([, w]) => w);
  hints.forEach(h => out.push(h));
  // 3) 兜底：至少给一个 agent skill，保证不是空查询
  if (!out.length) out.push('agent skill');
  return [...new Set(out)].slice(0, 3);
}

async function discover(text) {
  try {
    const terms = searchTerms(text);
    const seen = new Map();
    for (const q of terms) {
      if (!q) continue;
      const r = await skills.discoverGit(q).catch(() => null);
      const items = (r && (r.items || r.results)) || (Array.isArray(r) ? r : []);
      for (const x of (Array.isArray(items) ? items : [])) {
        const repo = x.repo || x.full_name || x.src;
        if (repo && !seen.has(repo)) {
          seen.set(repo, { repo, name: x.name || String(repo).split('/').pop(), stars: x.stars || 0, desc: String(x.desc || x.description || '').slice(0, 100) });
        }
      }
    }
    const candidates = [...seen.values()].sort((a, b) => b.stars - a.stars).slice(0, 5);
    return { ok: true, terms, candidates };
  } catch (e) {
    // 联网失败不等于"我们不会"。这属于环境问题，要在回答里说清是网络而不是能力。
    return { ok: false, error: String(e.message || e).slice(0, 80), candidates: [] };
  }
}

// —— 主流程 ——
// 返回给 server.js 的 /v1/chat 用
async function prepare(text, opt) {
  const o = opt || {};
  const out = { context: [], tools: [], intent: 'chat', gap: null, discovery: null, refusalHits: [] };

  // 0) 决策焦点优先于一切（第 3 条）。用户正在做某个方向的决策时，
  //    回答必须服务于那个决策，否则"决策中心"就只是个分析工具，推不动事。
  //    放在最前面是因为它的优先级高于能力匹配——先定方向，再补数据。
  //
  // 【双向互通的缺失环节】原来这里只做「决策中心 → 聊天」单向：
  //   有焦点就注入 chatDirective()；没焦点就什么都不做。
  // 于是用户在聊天里说「我该不该把年费从899提到1299」——
  //   intent 能识别成 decision，但**从不登记焦点**，
  //   决策中心压根不知道这次对话在决策什么，两边彻底不互通。
  // 现在先过 decision-bridge.syncFromChat()：
  //   · 已有焦点 → 保留不覆盖，只判断本轮是否同向；
  //   · 无焦点 + 是决策句 + 能归入 12 个业务域 → 自动登记并派发指向性任务；
  //   · 置信度低或无法归类 → 明确说不自动登记，并给出建议域（不硬塞）。
  let bridge = null;
  try {
    const Bridge = require('./decision-bridge');
    bridge = await Bridge.syncFromChat(text, { force: !!o.forceFocus });
    out.bridge = bridge;
    if (bridge.directive) { out.context.push(bridge.directive); out.focus = true; }
    if (bridge.action === 'registered') {
      // 如实告知用户"我替你登记了"，不静默改变系统状态
      out.context.push('【已自动登记决策焦点】' + bridge.reason
        + '。以下是本次焦点可推进的动作，若归错了方向请直接说「换到XX方向」。');
    } else if (bridge.action === 'kept' && bridge.related === false) {
      out.context.push('【焦点提示】当前决策焦点是「' + bridge.current.domain + '」，本轮话题偏向「'
        + (bridge.inferred.domain || '未归类') + '」。已保留原焦点未做覆盖。');
    }
  } catch (e) {
    out.bridgeError = String(e.message || e).slice(0, 100);
  }

  try {
    const dir = require('./decision-focus').chatDirective();
    if (dir && !out.context.includes(dir)) { out.context.push(dir); out.focus = true; }
  } catch (e) {}

  // 1) 系统能力优先：本软件的真实模块数据
  const cap = await capability.route(text, o);
  out.context.push(...cap.context);
  out.tools.push(...cap.tools);

  // 1.5) 决策焦点的看板数据：既然定了方向，就把该方向的真实数字递进来，
  //      让聊天报的是这个决策的真实底数（而不是别的领域的数字）。
  try {
    const DF = require('./decision-focus');
    const f = DF.current();
    if (f) {
      const need = DF.DOMAINS[f.domain];
      if (need && need.board) {
        const hit = capability.CAPS.find(c => c.id === need.board);
        if (hit) {
          const v = hit.run();
          if (v) out.context.push('【' + f.domain + '方向看板 · 本系统实时数据】\n' + String(v).slice(0, 900));
        }
      }
      // 【补】光有方向和看板还不够：用户问「那你说怎么定价」时，
      // 模型需要知道**现在能推哪一项**。没有这段，它只能泛泛给方法论。
      try {
        const moves = require('./decision-bridge').nextMoves();
        if (moves.active) {
          out.nextMoves = moves.moves;
          const list = moves.moves.map(m => '- ' + m.title + '（' + m.owner + '·' + m.status + '）').join('\n');
          out.context.push('【当前焦点可推进的动作 · ' + moves.domain + '】\n' + (list || '（暂无待推进项）')
            + '\n要求：回答要落到上述某一项的具体做法上，不要复述方法论框架。');
        }
      } catch (e2) {}
    }
  } catch (e) {}

  // 2) 技能与情报增强
  const int = smart.detect(text);
  out.intent = int.type;
  const enh = await smart.enrich(text).catch(() => ({ tools: [], context: [] }));
  // 去重：能力路由已经把营收/线索/经验这些真实数据递进来了，
  // smart.enrich 里的 dataSnapshot 讲的是同一批东西。两份都塞进去会让提示词
  // 凭空膨胀近一倍，还会让模型看到两个口径（虽然一致）的数字而分神。
  // 规则：只要能力路由命中过数据类能力，就丢弃 data_snapshot 那块。
  const capHasData = cap.tools.some(t => t.id && t.id.indexOf('cap.') === 0);
  const kept = capHasData
    ? (enh.context || []).filter(c => c.indexOf('data_snapshot') < 0 && c.indexOf('项目真实数据') < 0)
    : (enh.context || []);
  out.context.push(...kept);
  out.tools.push(...(enh.tools || []));

  // 3) 缺口 → 搜技能（此时才判定缺口，避免无谓联网）
  const gap = await detectGap(text, cap, int);
  if (gap) {
    out.gap = gap;
    out.discovery = await discover(text);
    const d = out.discovery;
    if (d && d.ok && d.candidates && d.candidates.length) {
      out.context.push(
        '【能力缺口 · 已为你检索可装载技能】你当前不具备直接完成该请求的模块或技能。'
        + '已从 GitHub 检索到以下候选，可由用户在"技能军械库"一键装载：\n'
        + d.candidates.map((c, i) => (i + 1) + '. ' + c.repo + ' ★' + c.stars + ' — ' + c.desc).join('\n')
        + '\n处理要求：不要因此回答"我做不到"。先用你现有能力给出可执行的替代方案与推进步骤，'
        + '再把上述候选作为补齐路径提给用户。'
      );
    } else if (d && !d.ok && d.error) {
      out.context.push(
        '【能力缺口 · 技能检索未完成】原因：' + d.error + '（这是网络/环境问题，不是能力问题）。'
        + '处理要求：仍不要推脱。请先用现有模块给出你现在能做的部分，并说明要补齐该能力需要什么。'
      );
    } else {
      out.context.push(
        '【能力缺口 · 未检索到现成技能】处理要求：禁止回答"我解决不了"。'
        + '请拆解目标：先完成当前系统能完成的部分，给出剩余部分的具体所需条件与步骤，'
        + '并说明可以通过"记忆·学习·进化"沉淀新技能来补齐。'
      );
    }
  }

  out.context.push(CONTRACT);
  return out;
}

// 升级版契约：verify() 判定推脱后用它重问（把语气要求写死，不给模型讨价还价空间）
function strictContract() {
  return CONTRACT + '\n\n【二次强制】你上一版回答被判为推脱，已作废。请重新作答：'
    + '直接给出你现在能执行的动作与结果；若确有缺失，只允许用一句话点明缺什么并给出补齐方式。'
    + '本轮再次出现推脱话术将被判为失败。';
}

module.exports = { prepare, discover, detectGap, verify, strictContract, CONTRACT, REFUSAL };
