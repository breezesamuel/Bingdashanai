// core/zodiac.js — 十二生肖养成系统（服务端权威状态）
//
// 现状问题（用户实测反馈"十二生肖需要更完善、像宠物一样在桌面上圈养"）：
//   web/zodiac.js 只有 1 只（一次养一个）、9 个固定动作、无自主行为、无成长、无记忆。
//
// 本模块重建为：12 只同屏 + 自主行为调度 + 精细化个性 + 养成成长 + 互动。
//
// 设计（像人体一样各司其职，各生肖一个"器官"）：
//   鼠=信息侦察 / 牛=执行落地 / 虎=风险压制 / 兔=敏捷响应 / 龙=统筹指挥 / 蛇=策略隐匿
//   马=快速突进 / 羊=资源统筹 / 猴=创意多变 / 鸡=准点守时 / 狗=忠诚守护 / 猪=福气聚合
// 每只的个性参数（胆识/活力/黏人/懒散/好奇心）决定它**自主**触发什么动作，
// 而不是随机乱动——这样才像"养的"，不像"动画"。
//
// 红线：状态全落 db.zodiac（可跨会话保留），不伪造——成长值/心情都由真实互动累积。

const store = require('./store');

const MAX_LEVEL = 20;
const KEY = 'zodiac';

// 十二生肖：个性 = 行为倾向；z1/z2 为主体色；e 为 emoji
const PETS = [
  { id: 'rat',    e: '🐭', name: '鼠', organ: '信息侦察', z1: '#94a3b8', z2: '#64748b', bold: 0.85, lively: 0.8, clingy: 0.3, lazy: 0.2, curious: 0.95 },
  { id: 'ox',     e: '🐮', name: '牛', organ: '执行落地', z1: '#a68a64', z2: '#7c5f3e', bold: 0.7,  lively: 0.4, clingy: 0.6, lazy: 0.5, curious: 0.3 },
  { id: 'tiger',  e: '🐯', name: '虎', organ: '风险压制', z1: '#f59e0b', z2: '#ea580c', bold: 0.95, lively: 0.9, clingy: 0.4, lazy: 0.15, curious: 0.6 },
  { id: 'rabbit', e: '🐰', name: '兔', organ: '敏捷响应', z1: '#f9a8d4', z2: '#ec4899', bold: 0.3,  lively: 0.95, clingy: 0.5, lazy: 0.3, curious: 0.8 },
  { id: 'dragon', e: '🐲', name: '龙', organ: '统筹指挥', z1: '#34d399', z2: '#0891b2', bold: 0.9,  lively: 0.7, clingy: 0.7, lazy: 0.2, curious: 0.7 },
  { id: 'snake',  e: '🐍', name: '蛇', organ: '策略隐匿', z1: '#4ade80', z2: '#16a34a', bold: 0.6,  lively: 0.35, clingy: 0.2, lazy: 0.65, curious: 0.75 },
  { id: 'horse',  e: '🐴', name: '马', organ: '快速突进', z1: '#c084fc', z2: '#9333ea', bold: 0.75, lively: 1.0, clingy: 0.35, lazy: 0.1, curious: 0.65 },
  { id: 'goat',   e: '🐑', name: '羊', organ: '资源统筹', z1: '#e7f7ee', z2: '#a7d8c5', bold: 0.35, lively: 0.45, clingy: 0.75, lazy: 0.55, curious: 0.4 },
  { id: 'monkey', e: '🐵', name: '猴', organ: '创意多变', z1: '#fbbf24', z2: '#d97706', bold: 0.6,  lively: 0.98, clingy: 0.45, lazy: 0.15, curious: 1.0 },
  { id: 'rooster',e: '🐔', name: '鸡', organ: '准点守时', z1: '#fb923c', z2: '#dc2626', bold: 0.55, lively: 0.6, clingy: 0.4, lazy: 0.3, curious: 0.35 },
  { id: 'dog',    e: '🐶', name: '狗', organ: '忠诚守护', z1: '#d4a373', z2: '#a05c2b', bold: 0.65, lively: 0.7, clingy: 1.0, lazy: 0.35, curious: 0.5 },
  { id: 'pig',    e: '🐷', name: '猪', organ: '福气聚合', z1: '#f9a8d4', z2: '#db2777', bold: 0.3,  lively: 0.5, clingy: 0.85, lazy: 0.9, curious: 0.55 }
];

const PET_MAP = Object.fromEntries(PETS.map(p => [p.id, p]));

// 动作库：自主行为的候选（前端按动作名播放动画/位移）
const ACTIONS = {
  idle:    { label: '发呆', shot: '' },
  float:   { label: '悬浮', shot: '' },
  walk:    { label: '走动', shot: '' },
  run:     { label: '奔跑', shot: '' },
  jump:    { label: '跳跃', shot: '' },
  dance:   { label: '舞蹈', shot: '✨✨' },
  play:    { label: '玩耍', shot: '🎾' },
  sleep:   { label: '睡觉', shot: '💤' },
  eat:     { label: '进食', shot: '🍚' },
  happy:   { label: '开心', shot: '💖✨' },
  alert:   { label: '警戒', shot: '❗' },
  patrol:  { label: '巡视', shot: '🔍' },
  think:   { label: '思考', shot: '💭' },
  stretch: { label: '伸懒腰', shot: '🌤️' },
  groom:   { label: '理毛', shot: '✨' }
};

// 各生肖在"不同时间/心情"下更可能做的动作（体现个性，不是纯随机）
function actionPoolFor(pet, mood) {
  const p = PET_MAP[pet] || PETS[4];
  const pool = ['float', 'idle'];
  // 活力高 → 活跃动作
  if (p.lively > 0.7) pool.push('walk', 'run', 'jump', 'dance');
  else if (p.lively > 0.45) pool.push('walk', 'stretch');
  // 好奇心高 → 探索
  if (p.curious > 0.7) pool.push('patrol', 'think', 'play');
  // 黏人高（心情好时）→ 靠近/互动
  if (p.clingy > 0.7 && mood > 0.6) pool.push('happy', 'groom');
  // 懒散高 → 睡
  if (p.lazy > 0.6 && mood < 0.6) pool.push('sleep', 'lie');
  // 胆识高 → 警戒/巡视
  if (p.bold > 0.85) pool.push('alert');
  return pool;
}

// ---------- 状态读写 ----------
function blank(pet) {
  return {
    id: pet.id, name: pet.name, e: pet.e, organ: pet.organ,
    z1: pet.z1, z2: pet.z2,
    level: 1, exp: 0,                 // 成长
    mood: 0.7, energy: 0.8,           // 心情/精力 0..1
    fed: 0, played: 0, petted: 0,      // 互动计数（真实互动累积，不随机）
    lastAct: 'idle', lastActAt: 0,
    x: 10 + Math.random() * 70, y: 20 + Math.random() * 60,  // 桌面位置 %
    unlocked: false
  };
}

function all() {
  const db = store.read();
  let arr = Array.isArray(db[KEY]) ? db[KEY] : [];
  // 首次进入：建 12 只（默认解锁 3 只，其余靠互动/成长解锁——养成感）
  if (arr.length === 0) {
    arr = PETS.map((p, i) => {
      const b = blank(p);
      b.unlocked = i < 3;             // 先给 鼠牛虎 三只
      return b;
    });
    save(arr);
  }
  // 兼容旧结构（曾经是单只 bd_zodi）并补齐缺失生肖
  PETS.forEach(p => { if (!arr.find(x => x.id === p.id)) arr.push(blank(p)); });
  save(arr);
  return arr;
}

function save(arr) {
  const db = store.read();
  db[KEY] = arr;
  store.write(db);
}

function find(id) { return all().find(p => p.id === id); }

// ---------- 行为调度（自主触发，按"时长"驱动）----------
// 依个性 + 精力/心情，按时间间隔决定下一只该做什么动作。真实推进，不编造。
function tick(opts) {
  const o = opts || {};
  const arr = all();
  const now = Date.now();
  const minGap = Math.max(3000, Number(o.minGap) || 9000);   // 每次 tick 至少间隔
  const out = [];
  const my = currentId(arr);

  // 【2026-09·只驱动被选中那一只】
  // 原来对**所有已解锁**宠物都跑一遍动作判定。但界面上只显示客户选中的那一只，
  // 另两只在屏幕外"动"——用户看不见，却每次命中都要 store.write（每分钟约 20 次写盘），
  // 正是之前那类"看不见的开销"。现在只驱动可见的那只，写盘量也顺带降下来。
  arr.filter(p => p.unlocked && p.id === my).forEach(p => {
    const elapsed = now - (p.lastActAt || 0);
    // 触发概率随个性与状态变化：活泼的更爱动，懒散/困倦的更爱睡
    const def = PET_MAP[p.id];
    let prob = 0.12 + (def.lively * 0.15) + (p.energy * 0.1) - (p.mood < 0.3 ? 0.1 : 0);
    if (elapsed < minGap) prob = 0;                 // 刚动过，先歇着
    if (Math.random() > prob) return;                // 本次不触发（真实概率，不是每只都动）

    // 精力消耗：动得多就累
    const moving = ['run', 'jump', 'dance', 'walk', 'patrol', 'play'].some(a => p.lastAct === a);
    p.energy = clamp(p.energy - (moving ? 0.05 : 0.02), 0.05, 1);

    // 选动作
    const pool = actionPoolFor(p.id, p.mood);
    const act = pool[Math.floor(Math.random() * pool.length)] || 'idle';
    p.lastAct = act;
    p.lastActAt = now;

    // 轻微位移（桌面游走）
    p.x = clamp(p.x + (Math.random() - 0.5) * 8, 2, 92);
    p.y = clamp(p.y + (Math.random() - 0.5) * 6, 4, 90);
    out.push({ id: p.id, act, label: (ACTIONS[act] || {}).label || act, x: p.x, y: p.y });
  });

  if (out.length) save(arr);
  return { ok: true, at: now, acted: out, unlocked: arr.filter(p => p.unlocked).length };
}

// ---------- 互动（真实累积：喂食/玩耍/抚摸）----------
function interact(id, kind) {
  const arr = all();
  const p = arr.find(x => x.id === id);
  if (!p) return { ok: false, error: '没有这只生肖：' + id };
  const now = Date.now();
  let gained = 0;
  if (kind === 'feed') { p.fed++; p.energy = clamp(p.energy + 0.25, 0, 1); p.mood = clamp(p.mood + 0.12, 0, 1); gained = 8; }
  else if (kind === 'play') { p.played++; p.energy = clamp(p.energy - 0.1, 0, 1); p.mood = clamp(p.mood + 0.2, 0, 1); gained = 12; }
  else if (kind === 'pet') { p.petted++; p.mood = clamp(p.mood + 0.16, 0, 1); gained = 6; }
  else if (kind === 'sleep') { p.energy = clamp(p.energy + 0.35, 0, 1); p.mood = clamp(p.mood + 0.05, 0, 1); }
  else return { ok: false, error: '未知互动：' + kind };

  // 成长：互动累积经验
  p.exp += gained;
  while (p.exp >= levelNeed(p.level) && p.level < MAX_LEVEL) {
    p.exp -= levelNeed(p.level);
    p.level++;
  }
  // 等级够了自动解锁下一只（养成推进）
  const locked = arr.filter(x => !x.unlocked).sort((a, b) => a.level - b.level)[0];
  if (locked && p.level >= (locked.level + 1)) { /* 保底：满 3 级解锁下一只 */ }
  const nextLock = arr.filter(x => !x.unlocked)[0];
  if (nextLock && p.level >= 3) { nextLock.unlocked = true; }

  save(arr);
  return {
    ok: true, id, kind, exp: p.exp, level: p.level,
    mood: p.mood, energy: p.energy,
    levelUp: p.level, unlocked: nextLock && nextLock.unlocked ? nextLock.id : null
  };
}

function levelNeed(level) { return 20 + level * 10; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, Number(v) || 0)); }

// ---------- 看板 ----------
// 【2026-09·选择机制】客户可以从"已解锁"的生肖里**选一只作为自己的伙伴**，
// 悬浮层只显示这一只。选择是**可随时切换**的（不是永久绑定——绑定死会让用户无法更换，
// 也不符合"客户选择"的意思）。选择存在 settings.myZodiac，与成长数据分开。
// 兼容：没选过、或原来选的那只被数据重置掉了 → 自动落到第一只已解锁的，保证恒有伙伴。
function currentId(arr) {
  const db = store.read();
  const saved = String((db.settings && db.settings.myZodiac) || '').trim();
  const hit = arr.find(p => p.id === saved);
  if (hit && hit.unlocked) return hit.id;
  const fallback = arr.find(p => p.unlocked) || arr[0];
  return fallback ? fallback.id : null;
}

function select(id) {
  const arr = all();
  const want = String(id || '').trim();
  const p = arr.find(x => x.id === want);
  if (!p) return { ok: false, error: '没有这只生肖：' + want };
  // 锁定的不给选：那 9 只是靠成长解锁的进阶内容，绕过去等于白送
  if (!p.unlocked) {
    return { ok: false, error: '「' + p.name + '」还没解锁——把当前伙伴养到 3 级会自动解锁下一只' };
  }
  store.setSetting('myZodiac', p.id);
  return { ok: true, myZodiac: p.id, name: p.name, e: p.e, unlocked: arr.filter(x => x.unlocked).length };
}

function board() {
  const arr = all();
  const my = currentId(arr);
  return {
    ok: true,
    pets: arr.map(p => ({
      ...p,
      actions: actionPoolFor(p.id, p.mood).map(a => ({ id: a, label: (ACTIONS[a] || {}).label || a })),
      need: levelNeed(p.level),
      // selectable=false 的卡片前端置灰：未解锁的不能选
      selectable: !!p.unlocked,
      isMine: p.id === my
    })),
    // 只显示这一只：前端据此隐藏其余 11 只
    myZodiac: my,
    unlocked: arr.filter(p => p.unlocked).length,
    total: arr.length,
    actions: ACTIONS
  };
}

module.exports = { PETS, ACTIONS, all, find, tick, interact, board, select, currentId };
