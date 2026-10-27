// core/capability.js — 能力路由 + 能力缺口（第 2 条需求的第一半）
//
// 【需求】"智能对话：要支持调用本软件中的所有程序和功能模块来解答问题"
//
// 【问题根因】改这一条之前，对话链路是：
//   smart.detect(text) → 只在 skilllib.SKILLS 里找匹配的技能
//   → 找不到就退回纯 LLM，让模型用自己的世界知识回答
// 于是出现两种糟糕结果：
//   1. 模型不知道我们系统里的真实数据 → 只能编（"你大概有 200 条线索"——实际 462 条）；
//   2. 模型觉得自己不该知道 → 直接说"我无法访问您的业务数据"。
// 关键在于：**这不是模型不肯答，是我们没把能力递给它**。
// 本软件有 50+ 个 core 模块（获客漏斗、收款、组织大脑、决策中心、任务、监控……），
// 每一个都能给出权威真实数据，但对话链路一个都调不到——只在 dataSnapshot 里硬编码了 3 个。
//
// 【解法】把"本软件能干什么"变成一张**可执行的能力表**：
//   每条能力 = { id, 名字, 触发词[], run() }，run() 直接返回真实数据。
//   提问时按触发词打分 → 取最高分的几条**真的执行** → 把结果作为权威上下文喂给 LLM。
// 这样 LLM 回答的是"我们系统里的事实"，而不是"它以为的事实"，推脱自然消失。

const store = require('./store');

// —— 能力表 ——
// 约定：
//   kw  触发词（命中即加权；用户口语化说法要尽量列全）
//   run 必须 try/catch 自保且**不许调 LLM**（这是同步数据读取，LLM 调用放慢 10 倍）
//   返回值是给 LLM 看的**权威事实文本**，不是给人看的 UI 文案
const CAPS = [
  // ---------- 获客与营收 ----------
  {
    id: 'cap.leads', name: '获客线索漏斗', kw: ['线索', '客户线索', '漏斗', '获客', '商机', '跟进', '成交客户', '转化', '转化率', '有多少线索', '线索质量', '成交了', '签了几单'],
    run() {
      const b = require('./leadgen').board();
      return '线索 ' + b.total + ' 条 · 成交客户 ' + b.customers + ' 人 · 成交额 ¥' + b.deals
        + ' · 真实触达 ' + (b.realTouches || 0) + ' · 待人工确认 ' + (b.waitingHuman || 0)
        + '\n各阶段分布：' + JSON.stringify(b.byStage)
        // closeGate / blocked 是**对象**（如 {"minTouch":2,"minSignal":66}），
        // 直接字符串拼接会得到 "[object Object]"，模型读到这种垃圾等于没读到。
        + '\n成交闸门：' + (b.closeGate ? JSON.stringify(b.closeGate) : '无')
        + '\n受阻项：' + (b.blocked && Object.keys(b.blocked).length ? JSON.stringify(b.blocked) : '无');
    }
  },
  {
    id: 'cap.revenue', name: '营收与收款台账', kw: ['营收', '收入', '收款', '到账', '成交额', '收了多少钱', '进账', '结算', '发票', '余额', '还有多少钱', '收了钱没', '到账了吗', '营收多少', '钱呢', '赚了多少', '收入多少', '流水'],
    run() {
      const m = require('./money');
      const k = m.kpi(), b = m.budget();
      const all = m.revenueAll ? m.revenueAll() : [];
      const settled = all.filter(r => m.isSettled(r));
      const pending = all.filter(r => !m.isSettled(r));
      return '已结算实收 ¥' + Math.round(k.revenue) + '（目标 ¥' + (k.target / 10000) + '万，完成 ' + k.pct + '%）'
        + '\n日均实收 ¥' + Number(k.regDaily || 0).toFixed(0) + ' · 达标需日均 ¥' + Number(k.needDaily || 0).toFixed(0)
        + '\n已结算 ' + settled.length + ' 笔（含自测 ' + (k.testCount || 0) + ' 笔 ¥' + (k.testRevenue || 0) + '，不计入营收）· 待到账 ' + pending.length + ' 笔'
        + (pending.length ? '\n待到账明细：' + pending.slice(0, 5).map(r => '¥' + (r.amt || r.amount) + (r.note ? '（' + r.note + '）' : '')).join('；') : '')
        + '\n推广池：已拨 ¥' + b.allotted + ' · 已支出 ¥' + b.spent + ' · 可用 ¥' + b.avail;
    }
  },
  {
    id: 'cap.partner', name: '合伙人与分润', kw: ['合伙人', '分润', '返利', '佣金', '抽成', '平台费', '分成'],
    run() {
      const p = require('./partner');
      const b = p.board();
      const fee = p.feePolicy ? p.feePolicy() : {};
      return '合伙人 ' + (b.total || 0) + ' 人 · 状态 ' + JSON.stringify(b.byStatus || {})
        + '\n当前阶梯平台费 ' + (fee.pct !== undefined ? fee.pct + '%' : '未配置')
        + '（按近 365 天已结算实收判定）· 合伙人分成 ' + (fee.partnerPct !== undefined ? fee.partnerPct + '%' : '—');
    }
  },
  {
    id: 'cap.price', name: '订阅与定价', kw: ['定价', '价格', '订阅', '收费', '付费', '套餐', '多少钱', '收费墙', '试用'],
    run() {
      const s = require('./subs');
      const st = s.status ? s.status() : {};
      return '当前订阅：' + JSON.stringify(st.plan || 'free')
        + '\n阶梯：首7天体验 ¥1 · 月度 ¥99 · 季度 ¥269 · 年度 ¥899（英文站 $1/$12/$29/$119）'
        + '\n真实付费判定：' + (s.isRealPaid ? (s.isRealPaid({}) ? '是' : '否') : '—');
    }
  },

  // ---------- 组织与执行 ----------
  {
    id: 'cap.org', name: '组织大脑与员工', kw: ['员工', '组织', '团队', '人数', '在岗', '招人', '部门', '花名册', 'hr', '谁最忙', '工作量', '忙不忙', '人员情况', '团队情况', '有几个'],
    run() {
      const o = store.orgStats();
      const organs = require('./organs');
      return '员工 ' + o.headcount + ' 人（在岗 ' + o.active + '）· 项目 ' + o.projects + ' 个'
        + '\n部门/岗位分布：' + JSON.stringify(o.byRole || o.byDept || {})
        + '\n组织健康：' + JSON.stringify(organs.health ? organs.health() : {});
    }
  },
  {
    id: 'cap.focus', name: '当前决策焦点与指向性任务', kw: ['决策焦点', '当前决策', '要做哪个决策', '指向性任务', '决策进度', '现在聚焦什么', '当前重点'],
    run() {
      const p = require('./decision-focus').progress();
      if (!p.active) return '当前没有进行中的决策焦点。可选领域：' + require('./decision-focus').allDomains().map(d => d.name).join(' / ');
      return '当前决策方向：' + p.domain + '（' + p.topic + '）'
        + '\n指向性任务 ' + p.total + ' 项 · 已完成 ' + p.done + ' · 进行中 ' + p.running + ' · ' + p.pct + '%'
        + '\n决策状态：' + (p.answered ? '所有决策问题均已回答' : '尚有 ' + (p.total - p.done) + ' 个问题未回答');
    }
  },
  {
    id: 'cap.cmd', name: '作战指挥塔（全局态势与指挥建议）', kw: ['指挥', '态势', '全局', '整体情况', '指挥部', '我该先做什么', '优先级', '建议', '该干什么', '现在该干什么', '下一步做什么', '指挥建议', '我该聚焦什么'],
    run() {
      const W = require('./warboard');
      const M = W.modules();
      const A = W.advisories();
      return '【全局态势】\n' + M.map(m => '· [' + m.status.toUpperCase() + '] ' + m.label + '：' + m.value + (m.note ? '（' + m.note + '）' : '')).join('\n')
        + '\n\n【指挥建议（按优先级）】' + (A.length ? '\n' + A.map((a, i) => (i + 1) + '. [' + a.sev + '] ' + a.title + '\n   依据：' + a.why + '\n   动作：' + a.action).join('\n') : '当前无异常，按既定节奏推进');
    }
  },
  {
    id: 'cap.learn', name: '全模块记忆·学习·进化', kw: ['学到什么', '记忆', '进化', '学习', '经验', '沉淀', '成长了', '变强', '退化', '训练'],
    run() {
      const s = require('./memory-hub').summary();
      const d = require('./memory-hub').dashboard();
      return s + (d.alerts.length ? '\n退化告警明细：' + d.alerts.map(a => a.msg).join('；') : '');
    }
  },
  {
    id: 'cap.team', name: '组织大脑·组队与成长', kw: ['员工', '组队', '认领', '谁来做', '派人', '花名册', '招人', '增员', '等级', '成长', '人头', '多少人', '谁最忙', '负载', '分工情况', '招了谁'],
    run() {
      const b = require('./team').board();
      return '员工 ' + b.headcount + ' 人（在岗 ' + b.active + '，其中系统按任务自动增员 ' + b.autoHired + '）'
        + '\n平均等级 ' + b.avgLevel + ' · 已认领在办任务 ' + b.owned + ' 项'
        + '\n角色分布：' + JSON.stringify(b.byRole)
        + '\n当前负载：' + JSON.stringify(b.load)
        + '\n说明：人数不固定，系统按未认领任务的技能缺口自动增员；任务完成会驱动员工升级与技能解锁。';
    }
  },
  {
    id: 'cap.tasks', name: '任务台', kw: ['任务', '在跑', '待办', '进度', '做到哪', '完成度', '在途', '跑了几个', '今天该做什么', '今天干什么', '任务列表', '有几个任务', '任务进度', '在跑几个', '任务情况', '有什么任务'],
    run() {
      const db = store.read();
      const t = db.tasks || [];
      const open = t.filter(x => !x.done);
      // 需求 #6 关心"确认有多少任务是在跑的"——这里按显式 running 状态与未完成分别计数
      const running = t.filter(x => x.running || x.status === 'running');
      return '任务共 ' + t.length + ' 项 · 未完成 ' + open.length + ' · 标记在跑 ' + running.length
        + '\n未完成清单（前 10）：' + (open.slice(0, 10).map(x => '- ' + (x.title || '(无标题)') + (x.due ? '（' + x.due + '）' : '')).join('\n') || '无');
    }
  },
  {
    id: 'cap.projects', name: '项目管理', kw: ['项目', '交付', '里程碑', '排期', '立项', '项目进度', '项目情况', '有几个项目', '并行项目'],
    run() {
      const db = store.read();
      const p = db.projects || [];
      return '项目 ' + p.length + ' 个'
        + (p.length ? '\n' + p.slice(0, 8).map(x => '- ' + (x.name || x.title || '(未命名)') + '：' + (x.status || '进行中') + (x.progress ? ' ' + x.progress + '%' : '')).join('\n') : '');
    }
  },
  {
    id: 'cap.decision', name: '决策中心', kw: ['决策', '该不该', '选哪个', '框架', '抉择', '方案对比', '决定什么', '拍板', '该不该做'],
    run() {
      const d = require('./decision');
      const s = d.stats();
      // stats() 实际只有 total / byCat，**没有 today 字段**。
      // 原来写 s.today → 永远 undefined，模型看到"今日 undefined"。
      // 想给"今日"就得真去数，别引用不存在的字段。
      const all = d.list ? d.list() : [];
      const todayKey = new Date().toISOString().slice(0, 10);
      const todayCount = all.filter(x => String(x.at || x.createdAt || '').slice(0, 10) === todayKey).length;
      return '决策累计 ' + s.total + ' 条（今日新增 ' + todayCount + '）'
        + '\n分类分布：' + JSON.stringify(s.byCat || {})
        + '\n可推荐框架：' + (d.suggestV2 ? JSON.stringify((d.suggestV2('通用') || {}).picks || []).slice(0, 300) : '—');
    }
  },

  // ---------- 运行与健康 ----------
  {
    id: 'cap.autopilot', name: '24h 自主运营', kw: ['自主运营', '自动运营', 'autopilot', '自动跑', '无人值守', '在跑什么'],
    run() {
      const s = require('./autopilot').status();
      return JSON.stringify(s).slice(0, 700);
    }
  },
  {
    id: 'cap.watchdog', name: '监控告警与自愈', kw: ['告警', '监控', '自愈', '报错', '异常', '健康', '故障', '为什么坏了', '有没有报错', '坏了吗', '健康吗'],
    run() {
      const w = require('./watchdog');
      const st = w.status();
      return '状态 ' + JSON.stringify(st).slice(0, 300)
        + '\n近期告警 ' + JSON.stringify((w.recentAlerts ? w.recentAlerts() : []).slice(0, 5))
        + '\n近期自愈 ' + JSON.stringify((w.recentHeals ? w.recentHeals() : []).slice(0, 5));
    }
  },
  {
    id: 'cap.perf', name: '性能与卡顿诊断', kw: ['卡', '卡顿', '慢', '性能', '延迟', '响应', '流畅', '不流畅', '内存', '卡不卡', '很慢', '为什么慢'],
    run() {
      const tw = require('./tasktime').report();
      return '后台任务耗时（越低越好）：\n' + tw.totals.slice(0, 6).map(t => '- ' + t.name + ' 调用 ' + t.calls + ' 次，最长 ' + t.maxMs + 'ms').join('\n')
        + '\n慢写盘 ' + store.slowWrites().length + ' 次';
    }
  },
  {
    id: 'cap.audit', name: '审计日志', kw: ['审计', '日志', '记录', '谁做的', '改了什么', '操作记录'],
    run() {
      const a = store.read().audit || [];
      return '审计 ' + a.length + ' 条，最新：\n' + a.slice(0, 8).map(x => '- ' + (x.action || '') + ' ' + (x.detail || '').slice(0, 60)).join('\n');
    }
  },
  {
    id: 'cap.goals', name: '目标任务', kw: ['目标', 'kpi', '指标', '使命', '核心目标', '半年', '目标是什么', '任务目标', '指导目标'],
    run() {
      const g = require('./goals');
      const al = g.alignment();
      return '核心目标：' + al.title + '（目标 ' + al.target + ' ' + al.unit + '，进度 ' + al.pct + '%）'
        + '\n已结算营收 ¥' + Math.round(al.revenue) + ' · 还差 ¥' + Math.round(al.remain) + ' · 剩余 ' + al.daysLeft + ' 天'
        + '\n全部目标：' + g.all().map(x => x.title + (x.primary ? '(核心)' : '')).join(' | ');
    }
  },

  // ---------- 知识与学习 ----------
  {
    id: 'cap.knowledge', name: '知识库与经验', kw: ['知识', '经验', '沉淀', '教训', '记住', '查过'],
    run() {
      const k = require('./knowledge').stats();
      const l = require('./lessons').stats();
      return '知识 ' + k.total + ' 条 · 经验库 ' + l.total + ' 条（仅已验证的会注入回答）';
    }
  },
  {
    id: 'cap.zodiac', name: '生肖伙伴', kw: ['生肖', '宠物', '伙伴', '养'],
    run() {
      const b = require('./zodiac').board();
      // myZodiac 是**字符串**（如 "rat"），原来写 b.myZodiac.name 必然是 undefined。
      const names = { rat: '鼠', ox: '牛', tiger: '虎', rabbit: '兔', dragon: '龙', snake: '蛇', horse: '马', goat: '羊', monkey: '猴', rooster: '鸡', dog: '狗', pig: '猪' };
      const cur = b.myZodiac ? (names[b.myZodiac] || b.myZodiac) : null;
      return '当前伙伴：' + (cur || '未选择')
        + ' · 已解锁 ' + b.unlocked + ' 只 · 悬浮层只显示选中的一只';
    }
  },
  {
    id: 'cap.agents', name: 'Agent 团队', kw: ['agent', '智能体', '专家', '会诊', '多agent'],
    run() {
      const a = require('./agents');
      return '可用专家 ' + a.list().map(x => x.name).join(' · ');
    }
  },
  {
    id: 'cap.skills', name: '技能军械库', kw: ['技能', 'skill', '会什么', '能做什么', '工具', '能力', '技能库', '军械库', '技能边界', '我会什么', '有哪些技能', '技能能用吗'],
    run() {
      const s = require('./skillspace').summary();
      const u = require('./skillspace').clusters();
      return s + '\n\n用途速查：' + u.map(c => c.key + '(' + c.count + ')').join(' · ');
    }
  },
  // ---------- 创作工坊（第 14 条：音乐 / 游戏 / 视频）----------
  {
    id: 'cap.music', name: '音乐制作工坊', kw: ['音乐', '歌曲', '作曲', '编曲', '音色', '旋律', '调式', '和声', '音频', 'wav', 'bpm', '曲', '谱', '音乐做完', '歌做完了吗', '曲子'],
    run() {
      const m = require('./music');
      // 【踩过的坑】原来写 `m.elements ? m.elements() : null`，
      // 但 music.js 导出的是**常量数组** ELEMENTS，不是函数 → 调用 undefined 直接抛错，
      // 整条能力被 try/catch 吞掉，模型只能拿到兜底快照，于是回答"请问需要什么帮助"。
      // 导出形状要照实际模块写，不能凭印象。
      const els = Array.isArray(m.ELEMENTS) ? m.ELEMENTS
        : (typeof m.elements === 'function' ? m.elements() : null);
      const list = (m.jobs && m.jobs()) || [];
      return '音乐制作要素 ' + (els ? els.length : '—') + ' 项（全部真实算法）'
        // 这三个是**普通对象**（键为调式/音色名），不是数组 —— 取 .length 得 undefined。
        // 计数要 Object.keys().length，数组才用 .length。
        + '\n音阶 ' + Object.keys(m.SCALES || {}).length + ' 种 · 音色 ' + Object.keys(m.VOICES || {}).length
        + ' 种 · 和声进行 ' + Object.keys(m.PROGRESSIONS || {}).length + ' 组'
        + '\n历史作业 ' + list.length + ' 个'
        + (list.length ? '\n最近：' + list.slice(0, 3).map(j => (j.title || j.name || '未命名') + '（' + (j.status || '—') + '）').join('；') : '\n尚未生成过作品');
    }
  },
  {
    id: 'cap.game', name: '游戏制作工坊', kw: ['游戏', '关卡', '地图', 'game', 'gamedev', 'unity', 'godot', '玩法', '数值', '角色'],
    run() {
      const g = require('./gamestudio');
      const b = (g.board ? g.board() : (g.summary ? g.summary() : {})) || {};
      return '游戏制作工坊：' + JSON.stringify(b).slice(0, 700);
    }
  },
  {
    id: 'cap.video', name: '视频影视制作', kw: ['视频', '影视', '剪辑', '分镜', '字幕', '配音', '转场', '特效', '调色', '短视频', '成片'],
    run() {
      // 【踩过的坑】原来 require('./convert') —— 但 convert.js 在 web/ 下、是前端文件，
      // core/ 里根本没有。require 直接抛 MODULE_NOT_FOUND，整条能力被 try/catch 吞掉，
      // 模型拿不到任何视频数据。写能力入口前必须确认模块真实存在。
      // 视频能力实际落在：publisher（发布）+ studio（作品）+ gamestudio（引擎）。
      const out = {};
      try { const st = require('./studio'); out.studio = (st.board ? st.board() : {}); } catch (e) { out.studioErr = 1; }
      try { const pb = require('./publisher'); out.publisher = (pb.board ? pb.board() : {}); } catch (e) { out.pubErr = 1; }
      return '视频/影视制作：' + JSON.stringify(out).slice(0, 800);
    }
  },

  // ---------- 全媒体运营（第 11 条）----------
  {
    id: 'cap.paperclip', name: 'Paperclip 多 Agent 公司协同',
    kw: ['paperclip', '多agent', '公司', '协同', '任务', '审批', '预算', '智能体', '组织', '交接单'],
    run() {
      const p = require('./paperclip');
      const s = p.status ? p.status() : {};
      return 'Paperclip 状态：' + JSON.stringify(s).slice(0, 800);
    }
  },
  {
    id: 'cap.guard', name: '同在守护：心理·策略·智慧库',
    kw: ['守护','心理','策略','智慧','认知偏差','团队动力','博弈论','谈判','压力管理','韧性','心理安全感','决策质量'],
    run() {
      const g = require('./guard');
      const s = g.status ? g.status() : {};
      return '同在守护：' + JSON.stringify(s).slice(0, 800);
    }
  },
  {
    id: 'cap.publisher', name: '全媒体运营与发布', kw: ['媒体', '发布', '平台', '投放', '渠道', '自媒体', '小红书', '抖音', '视频号', '公众号', 'b站', '知乎', '推特', 'youtube', '出海', '矩阵', '账号', '发出去了吗', '发布了吗', '发了多少', '平台数据', '流量'],
    run() {
      const p = require('./publisher');
      const b = (p.board ? p.board() : (p.status ? p.status() : {})) || {};
      return '全媒体发布：' + JSON.stringify(b).slice(0, 900);
    }
  },
  {
    id: 'cap.crawl', name: '全网抓取与情报', kw: ['抓取', '爬', '全网', '情报', '舆情', '竞品', '搜索', '找资料', '搜集', '关键词', '调研'],
    run() {
      const i = require('./intel');
      const f = require('./firecrawl');
      const a = { intel: null, firecrawl: null };
      try { a.intel = i.summary ? i.summary() : null; } catch (e) {}
      try { a.firecrawl = f.status ? f.status() : null; } catch (e) {}
      return '情报/抓取：' + JSON.stringify(a).slice(0, 800);
    }
  },
  {
    id: 'cap.autopub', name: '自动发布流水线', kw: ['自动发布', '发布流水线', '排期', '定时发布', '发布列车', '待发布'],
    run() {
      const a = require('./autopub');
      return '自动发布：' + JSON.stringify(a.status ? a.status() : a).slice(0, 700);
    }
  },

  // ---------- Agent 协作（第 10 条）----------
  {
    id: 'cap.agentmesh', name: 'Agent 协作网与多模型会商', kw: ['agentmesh', '协作网', '多agent', '会商', '多模型', '并行', 'codex', 'openai', '千问', 'qwen', 'deepseek', 'opencode', 'claude', '共识', '分歧'],
    run() {
      const a = require('./agentmesh');
      return 'Agent 协作网：' + JSON.stringify(a.backends ? a.backends() : a.list ? a.list() : {}).slice(0, 900);
    }
  },
  {
    id: 'cap.agentcenter', name: 'Agent 管理中心', kw: ['管理中心', 'agent 管理', '多agent 管理', '互联互通', 'agent 编排'],
    run() {
      const a = require('./agentcenter');
      return 'Agent 管理中心：' + JSON.stringify(a.board ? a.board() : a.summary ? a.summary() : {}).slice(0, 800);
    }
  },
  {
    id: 'cap.deliberation', name: '专家会诊与深思', kw: ['会诊', '专家', '深思', '研讨', '头脑风暴', '多角度', '反方'],
    run() {
      const d = require('./deliberation');
      return '会诊：' + JSON.stringify(d.board ? d.board() : d.list ? d.list() : {}).slice(0, 800);
    }
  },
  {
    id: 'cap.peers', name: '同业与同行对标', kw: ['同业', '同行', '对标', 'benchmark', '竞品对比'],
    run() {
      const p = require('./peers');
      return '同业对标：' + JSON.stringify(p.board ? p.board() : {}).slice(0, 600);
    }
  },

  // ---------- 架构与编排（第 1 轮深挖成果）----------
  {
    id: 'cap.graph', name: '语义知识图谱', kw: ['图谱', '知识图谱', '关系图', '节点', '边', '枢纽', '孤立', '最短路径', '连通', '结构关系', '我缺什么', '哪些没连上'],
    run() {
      const g = require('./graphify');
      const b = g.build();
      return '图谱 ' + b.totals.nodes + ' 节点 / ' + b.totals.edges + ' 边 · 平均度 ' + b.totals.avgDegree
        + ' · 孤立 ' + b.totals.isolated + '\n边类型：' + JSON.stringify(b.byType)
        + '\n枢纽 Top5：' + g.centrality(5).map(n => n.label + '(' + n.degree + ')').join('、');
    }
  },
  {
    id: 'cap.layers', name: '七层架构健康', kw: ['七层', '架构', '分层', '感知层', '认知层', '记忆层', '治理层', '闭环', '健康度', '组件'],
    run() {
      const l = require('./layers');
      const a = l.audit ? l.audit() : (l.report ? l.report() : {});
      const lp = require('./orkernel').loopHealth ? require('./orkernel').loopHealth() : null;
      return '七层架构：' + JSON.stringify(a).slice(0, 800) + (lp ? '\n闭环：' + JSON.stringify(lp).slice(0, 300) : '');
    }
  },
  {
    id: 'cap.orch', name: '七种编排与统一执行', kw: ['编排', '架构选择', 'react', 'plan', 'blackboard', '路由', '执行链', '链路', '对比', '竞速', 'trace', '学习闭环'],
    run() {
      const o = require('./orchestrators');
      const k = require('./orkernel');
      const names = o.list ? o.list().map(x => x.name || x.id) : [];
      return '可用编排：' + names.join(' · ')
        + '\n统一执行统计：' + JSON.stringify(k.stats ? k.stats() : {}).slice(0, 500);
    }
  },
  {
    id: 'cap.orca', name: 'Orca 执行队列', kw: ['orca', '队列', '并发槽', '执行体', '排队', '后台作业', '工作流'],
    run() {
      const o = require('./orca');
      const b = o.board ? o.board() : o.status ? o.status() : {};
      return 'Orca 队列：' + JSON.stringify(b).slice(0, 800);
    }
  },
  {
    id: 'cap.sop', name: 'MetaGPT SOP 流水线', kw: ['sop', '流水线', '产品经理', '架构师', '工程师', 'qa', '人工裁决', '阶段'],
    run() {
      const s = require('./sop');
      return 'SOP 流水线：' + JSON.stringify(s.status ? s.status() : s.board ? s.board() : {}).slice(0, 800);
    }
  },
  {
    id: 'cap.registry', name: '模块注册表与能力发现', kw: ['注册表', '能力发现', '模块清单', '有多少模块', '新能力', '自动发现', '自检能力'],
    run() {
      const r = require('./registry');
      const s = r.summary ? r.summary() : r.report ? r.report() : {};
      return '模块注册表：' + JSON.stringify(s).slice(0, 800);
    }
  },
  {
    id: 'cap.conductor', name: '统一指挥调度', kw: ['指挥', '调度', '统筹', '总控', '协调', 'conductor'],
    run() {
      const c = require('./conductor');
      return '指挥调度：' + JSON.stringify(c.board ? c.board() : c.status ? c.status() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.coordinator', name: '跨模块协同', kw: ['协同', '协调器', '联动', '互相调用', 'coordinator'],
    run() {
      const c = require('./coordinator');
      return '跨模块协同：' + JSON.stringify(c.board ? c.board() : {}).slice(0, 700);
    }
  },

  // ---------- 商业与资金 ----------
  {
    id: 'cap.payout', name: '结算与打款', kw: ['结算', '打款', '提现', '出金', '结算单', '分账', '到账周期'],
    run() {
      const p = require('./payout');
      const m = require('./money');
      return '结算台账：' + JSON.stringify(p.board ? p.board() : {}).slice(0, 500)
        + '\n营收台账：' + JSON.stringify(m.kpi ? m.kpi() : {}).slice(0, 400);
    }
  },
  {
    id: 'cap.pay', name: '支付与订阅收入', kw: ['支付', '付费用户', '订阅收入', '续费', '套餐', '订单量'],
    run() {
      const p = require('./pay');
      return '支付：' + JSON.stringify(p.board ? p.board() : p.summary ? p.summary() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.gtm', name: 'GTM 今日作战单', kw: ['gtm', '今日作战', '今天做什么', '今日待办', 'go to market', '今日安排', '今天干什么'],
    run() {
      const g = require('./gtm');
      return 'GTM 今日作战单：' + JSON.stringify(g.todayTasks ? g.todayTasks() : g.board ? g.board() : {}).slice(0, 900);
    }
  },
  {
    id: 'cap.goalpilot', name: '目标驾驶舱', kw: ['目标驾驶', '目标进度', 'kpi 进度', '目标差距', '离目标', '达成率'],
    run() {
      const gp = require('./goalpilot');
      return '目标驾驶舱：' + JSON.stringify(gp.board ? gp.board() : gp.status ? gp.status() : {}).slice(0, 800);
    }
  },
  {
    id: 'cap.annual', name: '年度规划', kw: ['年度', '一年', '全年', 'annual', '年度目标'],
    run() {
      const a = require('./annual');
      return '年度规划：' + JSON.stringify(a.board ? a.board() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.assignwork', name: '派工与认领', kw: ['派工', '认领', '谁负责', '分工', '指派', '接单'],
    run() {
      const a = require('./assign-work');
      return '派工：' + JSON.stringify(a.board ? a.board() : {}).slice(0, 700);
    }
  },

  // ---------- 证据 / 手册 / 预案 ----------
  {
    id: 'cap.evidence', name: '证据链与验收', kw: ['证据', '验收', '举证', '可追溯', '数据来源', '依据'],
    run() {
      const e = require('./evidence');
      return '证据链：' + JSON.stringify(e.stats ? e.stats() : e.board ? e.board() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.manuals', name: '手册与预案库', kw: ['手册', '预案', 'sop 文档', '操作手册', '怎么操作', '指南'],
    run() {
      const m = require('./manuals');
      return '手册库：' + JSON.stringify(m.board ? m.board() : m.list ? m.list() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.playbook', name: '作战 playbook', kw: ['playbook', '打法', '套路', '作战手册', '剧本'],
    run() {
      const p = require('./playbook');
      return 'Playbook：' + JSON.stringify(p.board ? p.board() : {}).slice(0, 700);
    }
  },

  // ---------- 人格 / 心理 / 守护 ----------
  {
    id: 'cap.persona', name: '决策人格画像', kw: ['人格', '性格', '决策风格', '我的画像', '测试题', '抉择'],
    run() {
      const p = require('./persona');
      return '人格画像：' + JSON.stringify(p.current ? p.current() : p.board ? p.board() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.metaphys', name: '同在守护 · 心理策略库', kw: ['守护', '心理', '焦虑', '情绪', '压力', '心态', '内耗', '陪伴', ' metaphysics'],
    run() {
      const m = require('./metaphys');
      return '守护策略库：' + JSON.stringify(m.board ? m.board() : m.summary ? m.summary() : {}).slice(0, 800);
    }
  },

  // ---------- 工程 / 记忆 / 其它 ----------
  {
    id: 'cap.brain', name: '大脑记忆与召回', kw: ['记忆', '回忆', 'brain', '记住了什么', '召回', '历史对话'],
    run() {
      const b = require('./brain');
      const st = b.stats ? b.stats() : {};
      return '大脑记忆：' + JSON.stringify(st).slice(0, 600);
    }
  },
  {
    id: 'cap.memoryext', name: '外部记忆扩展', kw: ['外部记忆', '长期记忆', '扩展记忆', '记忆分层'],
    run() {
      const m = require('./memoryext');
      return '外部记忆：' + JSON.stringify(m.board ? m.board() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.mcp', name: 'MCP 工具接入', kw: ['mcp', '工具接入', '外部工具', 'tool'],
    run() {
      const m = require('./mcp');
      return 'MCP：' + JSON.stringify(m.list ? m.list() : m.board ? m.board() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.foundry', name: '技能工坊', kw: ['工坊', '造技能', '做技能', '技能工厂', 'foundry'],
    run() {
      const f = require('./foundry');
      return '技能工坊：' + JSON.stringify(f.board ? f.board() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.devcap', name: '研发能力评估', kw: ['研发能力', '开发能力', '能不能做出来', '技术可行性', '实现难度'],
    run() {
      const d = require('./devcap');
      return '研发能力：' + JSON.stringify(d.board ? d.board() : d.assess ? d.assess() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.harness', name: '评测台', kw: ['评测', '测试一下', '跑分', 'harness', '质量评估', '打分'],
    run() {
      const h = require('./harness');
      return '评测台：' + JSON.stringify(h.report ? h.report() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.opmods', name: '运营模块清单', kw: ['有哪些模块', '功能清单', '模块列表', '系统有什么功能'],
    run() {
      const o = require('./opmods');
      const list = o.list ? o.list() : (o.modules ? o.modules() : []);
      return '系统功能模块 ' + (Array.isArray(list) ? list.length : '—') + ' 个'
        + (Array.isArray(list) ? '：' + list.slice(0, 30).map(m => m.name || m.id).join('、') : '');
    }
  },
  {
    id: 'cap.geo', name: '地域与市场', kw: ['地域', '地区', '哪个城市', '市场在哪', '区域', '海外'],
    run() {
      const g = require('./geo');
      return '地域：' + JSON.stringify(g.board ? g.board() : {}).slice(0, 500);
    }
  },
  {
    id: 'cap.mail', name: '邮件与外联', kw: ['邮件', '邮箱', '外联', '发信', 'smtp', '邮件触达'],
    run() {
      const m = require('./mailer');
      return '邮件：' + JSON.stringify(m.status ? m.status() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.providers', name: '模型通道状态', kw: ['通道', '模型通道', '哪个模型', 'api key', '密钥状态', '余额够不够'],
    run() {
      const p = require('./providers');
      const l = p.list ? p.list() : [];
      return '模型通道：' + l.map(x => x.id + (x.hasKey ? '✓' : '✗')).join(' · ');
    }
  },
  {
    id: 'cap.paywall', name: '订阅收费墙', kw: ['收费墙', '订阅墙', '付费墙', '免费次数', '收费策略'],
    run() {
      const w = require('./paywall');
      return '收费墙：' + JSON.stringify(w.status ? w.status() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.opmods2', name: '作战数据底座', kw: ['数据底座', '作战数据', '全局数据', '系统总览', '整体情况', '汇总'],
    run() {
      const w = require('./warboard');
      return '作战底座：' + JSON.stringify(w.base ? w.base() : w.board ? w.board() : {}).slice(0, 800);
    }
  },
  // ---------- 补齐剩余模块 ----------
  {
    id: 'cap.decengine', name: '决策引擎', kw: ['决策引擎', '怎么选', '该不该', '值不值', '利弊', '权衡', '选项对比'],
    run() {
      const d = require('./decision_engine');
      return '决策引擎：' + JSON.stringify(d.board ? d.board() : d.stats ? d.stats() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.talents', name: '行业人才库', kw: ['人才库', '招聘', '招人建议', '行业人才', '找人', '团队搭建'],
    run() {
      const t = require('./talents');
      const l = t.list ? t.list() : [];
      return '行业人才库 ' + (Array.isArray(l) ? l.length : '—') + ' 条'
        + (Array.isArray(l) ? '：' + l.slice(0, 8).map(x => (x.role || x.name || '—')).join('、') : '');
    }
  },
  {
    id: 'cap.studio', name: '创作工坊总览', kw: ['创作工坊', '工坊', '作品', '产出', '做了哪些东西', '创作'],
    run() {
      const s = require('./studio');
      return '创作工坊：' + JSON.stringify(s.board ? s.board() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.skillsinvoke', name: '技能调用与技能库', kw: ['调用技能', '执行技能', '技能怎么用', 'skill 调用', '技能列表'],
    run() {
      const s = require('./skills');
      const l = s.list ? s.list() : (s.all ? s.all() : []);
      return '可执行技能 ' + (Array.isArray(l) ? l.length : '—') + ' 项';
    }
  },
  {
    id: 'cap.skilllib', name: '技能库装载状态', kw: ['装载了哪些技能', '技能库状态', '外载技能', '已装载技能'],
    run() {
      const s = require('./skilllib');
      return '技能库：' + JSON.stringify(s.board ? s.board() : s.status ? s.status() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.smart', name: '智能增强与候选技能', kw: ['智能增强', '候选技能', '智能补齐', '自动补'],
    run() {
      const s = require('./smart');
      return '智能增强：' + JSON.stringify(s.board ? s.board() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.rank', name: '排行榜与绩效', kw: ['排行榜', '绩效', '谁的贡献大', '排名', '谁的活多', '贡献榜'],
    run() {
      const r = require('./rank');
      return '排行榜：' + JSON.stringify(r.board ? r.board() : r.list ? r.list() : {}).slice(0, 700);
    }
  },
  {
    id: 'cap.report', name: '报告生成', kw: ['报告', '写个报告', '汇报材料', '总结报告', '周报', '日报', '月报'],
    run() {
      const r = require('./report');
      return '报告：' + JSON.stringify(r.list ? r.list() : r.board ? r.board() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.repurpose', name: '内容复用器', kw: ['复用', '一稿多发', '改编', '重新分发', '换平台'],
    run() {
      const r = require('./repurpose');
      return '内容复用：' + JSON.stringify(r.board ? r.board() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.tickets', name: '客服工单', kw: ['工单', '客服', '客户问题', '投诉', '售后', '工单队列'],
    run() {
      const t = require('./tickets');
      return '工单：' + JSON.stringify(t.board ? t.board() : t.list ? t.list() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.train', name: '训练与调优', kw: ['训练', '调优', '微调', 'train', '模型训练'],
    run() {
      const t = require('./train');
      return '训练：' + JSON.stringify(t.board ? t.board() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.email', name: '邮件发送', kw: ['邮件发送', '发邮件', 'smtp', '邮件模板'],
    run() {
      const e = require('./email');
      return '邮件：' + JSON.stringify(e.status ? e.status() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.webfetch', name: '网页抓取工具', kw: ['抓网页', '网页内容', 'fetch', '读取网址', 'url'],
    run() {
      const w = require('./webfetch');
      return '网页抓取：' + JSON.stringify(w.status ? w.status() : {}).slice(0, 500);
    }
  },
  {
    id: 'cap.tenancy', name: '租户与席位', kw: ['租户', '席位', '团队账号', '子账号', '权限'],
    run() {
      const t = require('./tenancy');
      return '租户：' + JSON.stringify(t.board ? t.board() : {}).slice(0, 600);
    }
  },
  {
    id: 'cap.qr', name: '二维码生成与裁剪', kw: ['二维码', 'qr', '扫码'],
    run() {
      const a = require('./qr-generate');
      const b = require('./qr-crop');
      return '二维码：生成 ' + JSON.stringify(a.list ? a.list() : {}).slice(0, 200)
        + ' · 裁剪 ' + JSON.stringify(b.list ? b.list() : {}).slice(0, 200);
    }
  },
  // ---------- 系统设置中枢（第 7 条）----------
  {
    id: 'cap.setting', name: '系统设置中枢与体检', kw: ['设置', '配置', '系统设置', '管理盲区', '缺什么配置', '密钥状态', '收件邮箱', '收款账号', '平台费率', '监控间隔', '并发槽位', '设置体检'],
    run() {
      const SR = require('./settings-registry');
      const cov = SR.coverage();
      const h = SR.health();
      const items = SR.list({}).items;
      const lines = items.filter(x => x.group !== 'lang').map(x => {
        // 【踩过的坑】原来直接 String(x.value)。但 platformFee 是阶梯**对象**，
        // 拼接后变成 "平台费率阶梯（JSON）：[object Object]" —— 模型读到这种垃圾
        // 等于没读到。对象/数组必须 JSON 序列化。
        let v;
        if (x.type === 'secret') v = x.configured ? '已配置' : '未配置';
        else if (x.value === null || x.value === undefined) v = '—';
        else if (typeof x.value === 'object') v = JSON.stringify(x.value).slice(0, 160);
        else v = String(x.value);
        return '  ' + x.label + '：' + v;
      });
      return '设置中枢：共 ' + SR.ITEMS.length + ' 项可配置，覆盖率 ' + cov.rate + '%（' + cov.verdict + '）'
        + '\n当前配置：\n' + lines.join('\n')
        + '\n\n体检：' + h.verdict
        + (h.problems.length ? '\n' + h.problems.map(p => '  [' + p.level + '] ' + p.text).join('\n') : '');
    }
  },
  // ---------- 24h 监控自修复（第 15 条）----------
  {
    id: 'cap.heal', name: '24h 监控自修复闭环', kw: ['自愈', '自修复', '自我修复', '监控修复', '告警修复', '闭环率', '心跳停滞', '有没有坏', '自动修'],
    run() {
      const H = require('./self-heal');
      const cov = H.coverage();
      const lines = Object.keys(H.CATALOG).map(k => {
        const r = H.CATALOG[k];
        let d = null;
        try { d = r.diagnose(); } catch (e) {}
        return '  ' + k + ' [' + r.risk + '] ' + (d && d.cause ? d.cause : '—');
      });
      return '自修复策略覆盖 ' + cov.covered + '/' + cov.alertKeys + '（' + cov.rate + '%）· ' + cov.verdict
        + '\n风险分级：auto=可自动修 / assist=需人工确认 / manual=不可自动修\n'
        + lines.join('\n')
        + '\n说明：涉现金、对外发声、会篡改真实数据的异常一律拒绝自动修，并给出人工指引。';
    }
  },
  // ---------- 决策互通（第 3 条）----------
  {
    id: 'cap.bridge', name: '决策焦点与聊天互通', kw: ['决策焦点', '互通', '当前决策', '归类', '业务域', '该往哪个方向', '帮我决策', '做个决定'],
    run() {
      const B = require('./decision-bridge');
      const nm = B.nextMoves();
      if (!nm.active) return '当前没有决策焦点。' + nm.hint;
      const list = nm.moves.map(m => '- ' + String(m.title).slice(0, 44) + '（' + m.owner + '·' + m.status + '）').join('\n');
      return '当前决策焦点：' + nm.domain + '\n议题：' + nm.topic
        + '\n可推进动作 ' + nm.moves.length + ' 项：\n' + (list || '（暂无待推进项）')
        + '\n说明：' + nm.hint;
    }
  },
  // ---------- PDE 产出大项（助手化 / 流程化 / 系统化 / 原生化）----------
  {
    id: 'cap.pde', name: 'PDE 四级演进体检', kw: ['pde', '助手化', '流程化', '系统化', '原生化', '数字助手', '组织能力', '增长曲线', '四级', '演进'],
    run() {
      const a = require('./pde').assess();
      const lines = a.stages.map(s =>
        s.idx + '. ' + s.name + ' ' + s.on + '/' + s.total + '（' + s.grade.label + '）'
        + '\n' + s.items.filter(i => !i.on).map(i => '   缺：' + i.name + ' —— ' + i.detail).join('\n')
      );
      return 'PDE 总体 ' + Math.round(a.rate * 100) + '%（' + a.grade.label + '）\n' + lines.join('\n')
        + '\n结论：' + a.verdict;
    }
  },
  {
    id: 'cap.deck', name: '材料与演示文稿生成', kw: ['ppt', 'ppt生成', '幻灯片', '演示文稿', '汇报材料', '写材料', '做个报告', '做份材料', 'deck', '出材料'],
    run() {
      const d = require('./deck');
      return '材料/PPT 生成能力：格式 ' + d.FORMATS.join('/')
        + '\n数据源：核心目标、营收台账、线索漏斗、团队与任务、知识图谱、学习产出、PDE 体检'
        + '\n每一页都标注来源模块，取不到的数据会单列一页如实说明'
        + '\n说「做份汇报PPT」或「生成材料」即可产出（不调大模型，离线可跑）';
    }
  },
  {
    id: 'cap.material', name: '成文材料产出', kw: ['材料', '文档', '写文档', '手册', '说明文档', '成文', '写一份'],
    run() {
      let n = 0, which = [];
      [['./manuals', '手册'], ['./report', '报告'], ['./playbook', '打法'], ['./deck', '材料/PPT']].forEach(([m, tag]) => {
        try { require(m); n++; which.push(tag); } catch (e) {}
      });
      return '成文材料产出入口 ' + n + ' 个：' + which.join('、')
        + '\n说明：deck 模块把真实业务数据排成可演示的文档/PPT，含翻页与打印样式';
    }
  },
  {
    id: 'cap.selfcap', name: '系统自身能力与自检', kw: ['你能调用什么', '系统有哪些模块', '你的能力', '模块总数', '自检', '健康自检', '你能做什么'],
    run() {
      const c = require('./capability');
      const list = c.allCaps().map(x => x.id.replace('cap.', '') + '(' + x.name + ')');
      const dyn = (store.read().adoptedCaps || []).length;
      return '本系统可被对话调用的能力共 ' + list.length + ' 项（内置 ' + c.CAPS.length + ' + 动态装载 ' + (list.length - c.CAPS.length) + '）：\n' + list.join(' · ');
    }
  }
];

// —— 动态能力：把注册表里「已验证并采纳」的模块函数接进对话路由 ——
//
// 【这一段是被用户投诉逼出来的】
// 用户原话：「相应技能装载后能够调用实现，而不是一直告诉你需要哪些技能而不会自检回馈」。
// 实测确认了问题：registry.adopt() 确实把验证通过的能力写进了 db.adoptedCaps，
// 但 **capability.route() 从来不读它** —— 于是：
//   · 系统能"发现能力"→ 能告诉你缺什么；
//   · 但发现完之后，那个能力**依然调不到**；
//   · 表现就是"永远在报需要哪些技能，永远不自己动手"。
//
// 现在把采纳的能力真正变成可调用的工具：命中关键词就现场 require 该模块并调用。
// 边界（不能因为"能自检"就放开手脚）：
//   · 只跑**已验证**（verified）且**不含危险动词**的函数；
//   · 每次调用都 try/catch，失败如实返回，不伪造成功；
//   · 危险函数（付款/发布/删除/清空等）绝不自动调用，只告知需人工确认。
const DANGEROUS_FN = /send|pay|credit|spend|settle|purchase|order|publish|delete|remove|reset|clear|run|execute|flush|kill|stop/i;

let dynCache = { at: 0, sig: '', caps: [] };
function dynamicCaps() {
  const db = store.read();
  const adopted = db.adoptedCaps || [];
  if (!adopted.length) return [];
  let regs = [];
  try { regs = require('./registry').registry() || []; } catch (e) { return []; }
  const byKey = {};
  regs.forEach(r => { byKey[r.key] = r; });

  const out = [];
  adopted.forEach(key => {
    const r = byKey[key];
    if (!r || r.confidence !== 'verified') return;      // 没验证过的不给用
    if (!r.mod || !r.fn) return;
    if (DANGEROUS_FN.test(String(r.fn))) return;        // 危险函数不自动调
    const name = (r.domain || r.mod) + '·' + r.fn;
    out.push({
      id: 'dyn.' + r.key,
      name: '已装载能力·' + name,
      kw: [r.fn, r.domain, r.mod, name].filter(Boolean).map(String),
      adopted: true,
      run() {
        const mod = require('./' + r.mod);
        const fn = mod[r.fn];
        if (typeof fn !== 'function') return '（该函数已不在模块导出中，需要重新装载）';
        const v = fn();
        return r.mod + '.' + r.fn + '() → ' +
          (v && typeof v.then === 'function' ? '返回异步结果' : JSON.stringify(v === undefined ? 'undefined' : v).slice(0, 500));
      }
    });
  });
  return out;
}

// 所有可路由能力 = 静态表 + 动态采纳
// 【缓存踩过的坑】原来只看 20 秒时间戳，于是：
//   1) 测试里 adopt() 之后立刻 route()，拿到的是**采纳前的旧缓存**，
//      断言"对话能路由到动态能力"直接失败——看起来像功能没实现，其实是缓存脏了；
//   2) 生产上更糟：用户刚装载完技能，回头问一句，系统说"没这个能力"。
// 现在缓存签名带上 adoptedCaps 的内容与长度，**一有变化立刻失效**，
// 时间戳只作为兜底。这样"装载完马上能用"是确定行为，而不是碰运气。
function allCaps() {
  const db = store.read();
  const adopted = db.adoptedCaps || [];
  const sig = adopted.length + ':' + adopted.join(',');
  if (Date.now() - dynCache.at < 20000 && dynCache.sig === sig) return dynCache.caps;
  let dyn = [];
  try { dyn = dynamicCaps(); } catch (e) { dyn = []; }
  dynCache = { at: Date.now(), sig, caps: CAPS.concat(dyn) };
  return dynCache.caps;
}

// —— 自检：已装载能力是否真的可调 ——
// 用户要的是"自检回馈"，所以必须能给出一个**可验证的结论**，
// 而不是又一句"我做不到"。逐个实跑，报告通过/失败/需人工确认。
function selfCheck() {
  const db = store.read();
  const adopted = db.adoptedCaps || [];
  let regs = [];
  try { regs = require('./registry').registry() || []; } catch (e) {}
  const byKey = {};
  regs.forEach(r => { byKey[r.key] = r; });
  const items = adopted.map(key => {
    const r = byKey[key];
    if (!r) return { key, state: 'missing', note: '注册表里已无此条目（可能重新扫描后消失）' };
    if (r.confidence !== 'verified') return { key, state: 'unverified', note: '未通过验证，未接入对话' };
    if (!r.mod || !r.fn) return { key, state: 'incomplete', note: '条目缺少模块或函数名' };
    if (DANGEROUS_FN.test(String(r.fn))) {
      return { key, mod: r.mod, fn: r.fn, state: 'manual', note: '危险函数：涉及不可逆操作，需人工确认后才执行' };
    }
    try {
      const mod = require('./' + r.mod);
      const fn = mod[r.fn];
      if (typeof fn !== 'function') return { key, state: 'missing', note: '模块导出里已无该函数' };
      const v = fn();
      return { key, mod: r.mod, fn: r.fn, state: 'ok', note: '可调用' };
    } catch (e) {
      return { key, mod: r.mod, fn: r.fn, state: 'error', note: String(e.message || e).slice(0, 100) };
    }
  });
  const ok = items.filter(x => x.state === 'ok').length;
  const manual = items.filter(x => x.state === 'manual').length;
  const bad = items.filter(x => ['missing', 'unverified', 'incomplete', 'error'].indexOf(x.state) >= 0);
  return {
    adopted: adopted.length, ok, manual, badCount: bad.length, items,
    verdict: !adopted.length ? '尚未装载任何动态能力（系统仍在用内置 ' + CAPS.length + ' 项能力回答）'
      : bad.length ? (ok + ' 项可用，' + bad.length + ' 项需修复')
        : (manual ? ok + ' 项可用，' + manual + ' 项需人工确认' : ok + ' 项全部可用')
  };
}

// —— 路由：按触发词打分 ——
// 【纯关键词的漏召回问题】
// 原实现只有 `low.includes(kw)`。实测「今天该做什么」「余额还有多少」这类
// 最普通的问题**一个能力都匹配不上** —— 因为用户不会用模块名来提问。
// 结果是模型拿不到任何事实，只能猜或答「我看不到」，正是用户最反感的推脱。
//
// 现在加三层召回，从严到宽：
//   1) 关键词直接命中（最可信，分最高）
//   2) **意图句式**：问「做什么/怎么样/多少/有哪些」时，把所有能力里
//      与问题动词相关的一并召回（低分兜底）
//   3) **字符重合**：与最高分能力的触发词有 ≥2 个公共汉字时算弱命中（更低分）
// 宁可多给模型一点真实数据，也不要让它空手去编。
const QUESTION_VERBS = ['做什么', '干什么', '怎么样', '如何', '多少', '有哪些', '是什么', '进展', '情况', '状态', '建议', '如何做', '怎么'];
const CN_RE = /[\u4e00-\u9fa5]/g;
function charOverlap(a, b) {
  const A = new Set(String(a).match(CN_RE) || []);
  const B = new Set(String(b).match(CN_RE) || []);
  let n = 0;
  A.forEach(ch => { if (B.has(ch)) n++; });
  return n;
}

function score(text) {
  const low = String(text || '').toLowerCase();
  const out = [];
  const isQuestion = QUESTION_VERBS.some(v => low.includes(v));

  // 用 allCaps()（静态表 + 动态采纳），否则装载进来的能力永远匹配不上
  for (const c of allCaps()) {
    let sc = 0;
    const hit = [];
    for (const k of c.kw) {
      if (low.includes(String(k).toLowerCase())) { sc += k.length >= 3 ? 2 : 1; hit.push(k); }
    }
    if (sc > 0) { out.push({ cap: c, score: sc, hit }); continue; }

    // 第 2 层：宽泛问句 + 该能力的关键词含问题动词相关词 → 低分召回
    if (isQuestion && c.kw.some(k => QUESTION_VERBS.some(v => String(k).includes(v)))) {
      out.push({ cap: c, score: 0.4, hit: ['宽泛问句'], weak: true });
      continue;
    }
    // 第 3 层：字符重合（弱命中，权重极低，只在完全没有命中时才起兜底作用）
    const ov = Math.max.apply(null, [0].concat(c.kw.map(k => charOverlap(low, k))));
    if (ov >= 2) out.push({ cap: c, score: Math.min(0.3, ov * 0.1), hit: ['字符重合'], weak: true });
  }
  return out.sort((a, b) => b.score - a.score);
}

// —— 兜底总览：无论问什么，都给模型一份系统真实快照 ——
//
// 【为什么必须有】用户问「今天该做什么」时，就算一条能力都没命中，
// 模型也应该知道真实的营收、任务数、员工数、告警数，而不是凭空回答。
// 这不是"万能回答"，而是**底线事实**：有了它，模型至少不会说出
// 「您目前有 0 个任务」这种编造的数字（实测确实发生过）。
//
// 代价：每次对话多拼约 600 字上下文。这个开销换掉"编数据"是值得的。
function overview() {
  const db = store.read();
  const tasks = db.tasks || [];
  const staff = db.staff || [];
  const leads = db.leads || [];
  const running = tasks.filter(t => !t.done && t.status === 'running').length;
  const blocked = tasks.filter(t => !t.done && t.status === 'blocked').length;
  const m = require('./money');
  const k = m.kpi ? m.kpi() : {};
  return '员工 ' + staff.length + ' 人（在岗 ' + staff.filter(s => s.status !== 'off').length + '）'
    + '\n任务 ' + tasks.length + ' 个（在跑 ' + running + ' · 受阻 ' + blocked + ' · 已完成 ' + tasks.filter(t => t.done).length + '）'
    + '\n线索 ' + leads.length + ' 条'
    + '\n营收：已结算 ¥' + Math.round(k.revenue || 0) + '（目标 ' + Math.round(k.target || 0) + '，完成 ' + (k.pct || 0) + '%）'
    + '\n项目 ' + (db.projects || []).length + ' 个 · 知识 ' + (db.knowledge || []).length + ' 条'
    + '\n本系统共 ' + allCaps().length + ' 项可调用能力，用户问什么就去调对应模块拿真实数据，'
    + '拿不到就说明读不到，不要编数字。';
}

// 执行 topN 条能力，返回 { context, tools, matched }
// 每条都 try/catch 自保：某个模块报错绝不能连带整轮对话失败
async function route(text, opt) {
  const o = opt || {};
  const maxN = o.max || 3;
  // 弱命中也允许进（阈值 0.3），因为"给模型真实但相关性一般的数据"
// 远好过"什么都不给，让模型自由发挥"
  const minScore = o.minScore !== undefined ? o.minScore : 0.3;
  const cands = score(text).filter(x => x.score >= minScore).slice(0, maxN);
  const context = [], tools = [];
  for (const c of cands) {
    const t0 = Date.now();
    try {
      const v = c.cap.run();
      if (v) {
        context.push('【' + c.cap.name + ' · 本系统实时数据，务必据此回答】\n' + String(v).slice(0, 1200));
        tools.push({ id: c.cap.id, name: c.cap.name, score: c.score, hit: c.hit, weak: !!c.weak, elapsedMs: Date.now() - t0 });
      }
    } catch (e) {
      // 模块自身报错：记录但不让整轮失败。**不推给用户**，避免变成"我做不到"
      tools.push({ id: c.cap.id, name: c.cap.name, error: String(e.message || e).slice(0, 80) });
    }
  }
  // 一条都没命中也要给底线事实（除非调用方显式关掉）
  if (!context.length && o.overview !== false) {
    try {
      const ov = overview();
      context.push('【系统实时快照 · 底线事实，不得编造未列出的数字】\n' + ov);
      tools.push({ id: 'cap.overview', name: '系统实时快照', score: 0, hit: ['兜底'], fallback: true, elapsedMs: 0 });
    } catch (e) { /* 快照也失败就算了，不影响对话 */ }
  }
  return { context, tools, matched: cands.length };
}

module.exports = { CAPS, score, route, overview, allCaps, dynamicCaps, selfCheck, DANGEROUS_FN };
