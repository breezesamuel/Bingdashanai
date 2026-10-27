// core/brain.js — 丙大山AI 大脑增强层
// 职责：记忆 / 学习 / 进化 / 命令路由 / 自适应参数 / 智能降级
// 记忆：跨会话持久（data/db.json 的 memory 区）。会话结束不强清，按相关性召回。
// 学习：记录每次调用成功/失败，学习默认 provider 与语言偏好（加权滑动平均）。
// 进化：趋势统计 + 每次关键里程碑写"进化日志"，前端可看"智能进化"面板。

const store = require('./store');

// ---- 记忆：读写/召回 ----
const MEM_MAX = 300; // 记忆上限，防自治循环把 db 撑爆
function remember(key, value, replace) {
  const db = store.read();
  if (!db.memory) db.memory = [];
  if (replace) db.memory = db.memory.filter(m => m.key !== key);
  db.memory.push({ key: key || 'note', value: String(value), at: Date.now() });
  if (db.memory.length > MEM_MAX) db.memory = db.memory.slice(-MEM_MAX);
  store.write(db);
  return { ok: true, count: db.memory.length };
}

function memories(limit) {
  const db = store.read();
  const m = db.memory || [];
  return limit ? m.slice(-limit).reverse() : m.slice().reverse();
}

// 只取条数：不复制数组。/v1/status 只需要 .length，
// 原来每次都做一次 slice().reverse()（evolution 有 500 条就是 500 次元素拷贝）。
function countMemories() {
  const db = store.read();
  return (db.memory || []).length;
}

function recall(keyword) {
  const db = store.read();
  const m = db.memory || [];
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return m.slice(-20).reverse();
  const now = Date.now();
  const DAY = 864e5;
  return m.map(x => {
    const keyHit = x.key.toLowerCase().includes(kw);
    const val = String(x.value).toLowerCase();
    const valHit = val.includes(kw);
    // 关键词命中加权 + 近因衰减（Ebbinghaus 曲线，1~0 随时间衰减）
    const recency = Math.exp(-(now - (x.at || now)) / (7 * DAY));
    let score = 0;
    if (keyHit) score += 3;
    if (valHit) score += Number(val.includes(kw)) * 2;
    // 词频相似度：查询词在记忆中的出现次数（二次命中加分）
    if (keyHit || valHit) score += val.split(kw).length - 1;
    score *= recency;
    return { x, score };
  }).filter(v => v.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(v => v.x);
}

function evolve(note) {
  const db = store.read();
  if (!db.evolution) db.evolution = [];
  db.evolution.push({ note: String(note), at: Date.now() });
  // 归档上限：仅保留最近 500 条，防长期运行无限膨胀
  if (db.evolution.length > 500) db.evolution = db.evolution.slice(-500);
  store.write(db);
  return { ok: true, total: db.evolution.length };
}

function evolution() {
  const db = store.read();
  return (db.evolution || []).slice().reverse();
}

// 只取条数：不复制数组（配合 /v1/status 的 evolutionTotal）
function countEvolution() {
  const db = store.read();
  return (db.evolution || []).length;
}

// provider 是否可用：有密钥 + 近期学习曲线不烂（连续失败>=2 且零成功、或样本充足仍低成功率 → 视为劣化）
function providerUsable(id, providers, cache) {
  const p = (providers || []).find(x => x.id === id);
  if (!p || !p.hasKey) return false;
  // 【2026-09】支持传入预取的 learn 表：recommendedProviders 会对每个 provider 调一次，
  // 原来每次都 store.read()（即使命中缓存也有 mtime stat + 映射开销，实测 8 个 provider
  // ≈ 4.5ms）。现在由调用方读一次、传进来。
  const stats = cache ? (cache[id] || null) : dbOf(id);
  if (stats && ((stats.ok === 0 && stats.n >= 2) || (stats.n >= 3 && stats.rate < 40))) return false;
  return true;
}
function dbOf(provider) {
  const db = store.read();
  const L = db.learn || {};
  const s = L[provider];
  if (!s) return null;
  return { ok: s.ok, fail: s.fail, n: s.n, rate: s.n ? Math.round((s.ok / s.n) * 100) : 0, avgMs: s.n ? Math.round(s.totalMs / s.n) : 0 };
}

// ---- 学习：成功/失败计数 ----
function learnResult(provider, ok, ms) {
  const db = store.read();
  if (!db.learn) db.learn = {};
  if (!db.learn[provider]) db.learn[provider] = { ok: 0, fail: 0, totalMs: 0, n: 0 };
  const L = db.learn[provider];
  if (ok) L.ok++; else L.fail++;
  L.totalMs += ms; L.n++;
  // 同 provider 两次失败 -> 进化日志（自主降级策略）
  if (!ok && L.fail >= 2) evolve('检测到 ' + provider + ' 连续失败 ' + L.fail + ' 次，将自动切换备用通道');
  store.write(db);
  return L;
}

function learnStats() {
  const db = store.read();
  const L = db.learn || {};
  return Object.keys(L).map(k => {
    const v = L[k];
    const rate = v.n ? Math.round((v.ok / v.n) * 100) : 0;
    return { provider: k, ok: v.ok, fail: v.fail, n: v.n, rate, avgMs: v.n ? Math.round(v.totalMs / v.n) : 0 };
  }).sort((a, b) => b.rate - a.rate);
}

// ---- 自适应：推荐默认 provider ----
// 策略：优先成功率最高且最近响应最快的已配置服务商；无密钥则不推；近期劣化的通道直接排除。
// 返回按适配度降序的可用通道列表（供串行降级尝试）。
function recommendedProviders(providers) {
  // 【2026-09】一次 store.read() 取 learn 表，供 stats 与 providerUsable 共用，
  // 避免按 provider 数量重复读库（/v1/status 高频轮询，实测该函数 9.31ms → 目标 <1ms）。
  const L = (store.read().learn) || {};
  const rateOf = id => {
    const v = L[id];
    if (!v) return null;
    return { ok: v.ok, fail: v.fail, n: v.n, rate: v.n ? Math.round((v.ok / v.n) * 100) : 0, avgMs: v.n ? Math.round(v.totalMs / v.n) : 0 };
  };
  const stats = Object.keys(L).map(k => {
    const v = rateOf(k);
    return Object.assign({ provider: k }, v, { rate: v.rate, avgMs: v.avgMs });
  }).sort((a, b) => b.rate - a.rate);
  const usable = (providers || []).filter(p => p.hasKey && providerUsable(p.id, providers, L));
  const conf = n => Math.min(1, n / 12) * 0.6 + 0.2;
  const scored = usable.map(p => {
    const s = stats.find(x => x.provider === p.id);
    const n = s ? s.n : 0;
    const rate = s ? s.rate : 50;
    const latency = s ? s.avgMs : 1500;
    const score = (rate / 100) * conf(n) - (latency / 3000) * 0.3 + 0.02 * Math.min(n, 10);
    return { id: p.id, score };
  }).sort((a, b) => b.score - a.score);
  return scored.map(x => x.id);
}
function recommendedProvider(providers) {
  const list = recommendedProviders(providers);
  return list.length ? list[0] : null;
}

// ---- 命令路由 ----
// 输入若以 "/" 开头，尝试解析为命令；否则返回 null 交给对话。
// 命令集：/help /clearmem /stats /evolve /remember x /recall x
//         /model <id> /theme <name> /lang <code>
// 服务器级命令（返回 null，由 server.js 执行）：/agents /task /knowledge /summary
const SERVER_CMDS = ['/agents', '/task', '/project', '/knowledge', '/summary', '/find'];
function routeCommand(text, ctx) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return null;
  const [cmd, ...rest] = t.split(/\s+/);
  const arg = rest.join(' ');
  const act = cmd.toLowerCase();

  if (SERVER_CMDS.includes(act)) return null;

  if (act === '/help') {
    return { kind: 'text', text: '可用命令：\n/agents <专家> <问题> 专家会诊 · /task <内容> 新建任务 · /knowledge <Q/A> 存入知识库 · /summary 系统摘要 · /find <关键词> 全局检索\n/stats 学习统计 · /evolve 进化日志 · /remember <内容> 记住一条 · /recall <关键词> 召回记忆\n/model <id> 切换默认模型 · /theme <名称> 切换主题 · /lang <中|en> 切换语言 · /clearmem 清除记忆' };
  }
  if (act === '/stats') {
    const s = learnStats();
    return { kind: 'text', text: '【学习统计】\n' + (s.length ? s.map(x => x.provider + ' ✓' + x.ok + ' ✗' + x.fail + ' 成功率' + x.rate + '% 均延' + x.avgMs + 'ms').join('\n') : '尚无调用记录') };
  }
  if (act === '/evolve') {
    const e = evolution();
    return { kind: 'text', text: '【进化日志】' + (e.length ? ('\n' + e.slice(0, 10).map(x => new Date(x.at).toLocaleString() + ' · ' + x.note).join('\n')) : '\n（尚无明显进化节点）') };
  }
  if (act === '/remember') {
    if (!arg) return { kind: 'text', text: '用法：/remember <要记住的内容>' };
    remember('note', arg);
    return { kind: 'text', text: '已记住：' + arg };
  }
  if (act === '/recall') {
    const r = recall(arg);
    return { kind: 'text', text: '【记忆召回】' + (r.length ? r.map(x => new Date(x.at).toLocaleString() + ' [' + x.key + '] ' + x.value).join('\n') : '（无匹配记忆）') };
  }
  if (act === '/clearmem') {
    const n = (store.read().memory || []).length;
    store.push('audit', { action: '清除记忆', detail: '/clearmem 清空 ' + n + ' 条记忆', at: Date.now() }, null, null);
    store.write(Object.assign(store.read(), { memory: [] }));
    return { kind: 'text', text: '记忆已清空（共 ' + n + ' 条）' };
  }
  if (act === '/model' || act === '/theme' || act === '/lang') {
    // /model 映射到 provider（系统读取 settings.provider 选择通道）
    const key = act === '/model' ? 'provider' : act.slice(1);
    return { kind: 'setting', key, value: arg };
  }
  return { kind: 'text', text: '未知命令：' + cmd + '（输入 /help 查看全部）' };
}

// ---- 长会话记忆：thread 分线程 + 滚动压缩摘要 ----
// 每个 thread 保存最近 N 条；超限时把中间段压缩为一条"note"（吸取关键词/结论句），
// 让 AI 能"记得住很久以前说过的话"，又不撑爆上下文。
const THREAD_ROLL = 14;  // 超过条数即压缩
function threadGet(thread) {
  const db = store.read();
  if (!db.threads) db.threads = [];
  let t = db.threads.find(x => x.id === thread);
  if (!t) {
    t = { id: thread || ('t' + Date.now()), hist: [], note: '', createdAt: Date.now(), updatedAt: Date.now() };
    db.threads.push(t);
    store.write(db);
  }
  return t;
}
// 追加消息；若 hist 超上限 → 把最早的一半压进 note（保留结论密度），hist 只留最近。
function threadPush(thread, role, content) {
  const db = store.read();
  if (!db.threads) db.threads = [];
  let t = db.threads.find(x => x.id === thread);
  if (!t) { t = { id: thread || ('t' + Date.now()), hist: [], note: '', createdAt: Date.now(), updatedAt: Date.now() }; db.threads.push(t); }
  t.hist.push({ role, content: String(content).slice(0, 2000), at: Date.now() });
  t.updatedAt = Date.now();
  // 滚动压缩：超过 THREAD_ROLL 条 → 把最老一半提炼成 note（关键词句摘要）
  if (t.hist.length > THREAD_ROLL) {
    const old = t.hist.splice(0, Math.floor(t.hist.length / 2));
    const digest = old.filter(m => m.role === 'user')
      .map(m => String(m.content).replace(/\s+/g, ' ').slice(0, 60)).slice(-6);
    const bullets = digest.filter(Boolean).map(x => '- ' + x);
    if (bullets.length) t.note = '【更早对话摘要】\n' + bullets.join('\n') + (t.note ? '\n' + t.note : '');
    t.note = t.note.slice(-1200);
  }
  store.write(db);
  return t;
}
// 组 thread 的模型上下文：note（长记忆）+ 最近 ≤8 条
function threadContext(thread, lastN) {
  const t = threadGet(thread);
  const hist = (t.hist || []).slice(-(lastN || 8)).map(m => ({ role: m.role, content: m.content }));
  return { note: t.note || '', hist };
}

// ---- 自动记忆进化：每轮对话沉淀"主题结论"到 memory（7 天同主题去重）----
function rememberAuto(topic, conclusion) {
  const db = store.read();
  const key = 'chat:' + String(topic || '').slice(0, 20);
  const dup = (db.memory || []).some(m => m.key === key && Date.now() - (m.at || 0) < 7 * 864e5);
  if (dup) return { dedup: true };
  return remember(key, String(conclusion || '').slice(0, 200));
}

// ---- 人性化：根据意图给一句自然追问 ----
// 让 AI 不只给答案，还会像人一样把话题继续往前带（决策/信息/闲聊各有收口）。
function followUp(intent, topic) {
  const t = String(topic || '').trim();
  if (!t) return '';
  if (intent === 'decision') return '要不要我接着用推荐框架（如 PDCA）把这一步拆成可执行清单？';
  if (intent === 'websearch') return '要不要我把搜到的开源项目下载进来做能力验证？';
  if (intent === 'skill') return '这个结果可以直接用。需要我把它沉淀成团队知识吗？';
  return '如果这段对你有帮助，可以补充更多背景，我会记得继续往下聊。';
}

module.exports = { remember, memories, countMemories, recall, evolve, evolution, countEvolution, learnResult, learnStats, recommendedProviders, recommendedProvider, providerUsable, routeCommand, threadGet, threadPush, threadContext, rememberAuto, followUp };