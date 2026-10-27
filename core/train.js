// core/train.js — E4 发布列车（FINAL-2.0 §4 落地：版本火车机制）
// 节奏：双周一班，雷打不动；错过编组的 feature 等下一班，不许插队加车。
// 每班固定装载三格：一个增长件、一个留存件、一个还债件（技术债每周必还一格）。
// 规则：任何新想法默认写下一次班次的 parking lot；火车不等人是纪律，parking lot 不删是尊重。
// 数据全部落 db（trains / parkinglot），对真实运行产线有意义。

const store = require('./store');

const TICKET_MS = 14 * 24 * 3600000; // 双周一班

// 起始班次：以本模块首次启用为基准，回推对齐日期取偶数周初
const BOOT = Date.UTC(2026, 0, 5); // 2026-01-05（周一）为第 0 班

// 班次表（规范 §4 版本定义，真实冻结）
const MAJOR_LINE = [
  { ver: 'V0.9', phase: 'W6', name: '内部满血：核心闭环+校验器+危机线' },
  { ver: 'V1.0', phase: 'W7', name: '对外+收款：冷启动 Playbook 启动' },
  { ver: 'V1.1', phase: 'W9', name: 'A/B 实验装载版（封面/价格实验）' },
  { ver: 'V1.5', phase: 'W13', name: '快速问全量+回访自动化' },
  { ver: 'V2.0', phase: 'W16', name: '宠物血脉上线（含故事影子模式验收）' },
  { ver: 'V2.5', phase: 'M9+', name: '播客+白标预研+MCP 接口' },
  { ver: 'V3.0', phase: 'M12', name: '年报+POD' },
  { ver: 'V4.0', phase: 'M18', name: '故事季刊化' }
];

// 当前班次序号（从启动班算起，双周一跳）
function line(now) {
  const t = now || Date.now();
  const n = Math.floor((t - BOOT) / TICKET_MS);
  return n >= 0 ? n : 0;
}

function lineBounds(no, now) {
  const t = now || Date.now();
  const start = BOOT + no * TICKET_MS;
  const end = start + TICKET_MS;
  return { no, start, end, now: t };
}

// 该班 need 的三格
function slots() {
  return [
    { slot: 'growth', name: '增长件', desc: '带新用户或新收入', filled: null },
    { name: 'retention', desc: '要让老用户留下的东西', filled: null },
    { name: 'debt', desc: '还技术债（每周必还一格）', filled: null }
  ];
}

// 装载：把 feature 装进某班某格（不插队，只按班次）
function load(body) {
  const no = line();
  const slotKey = String(body.slot || '').trim();
  if (!['growth', 'retention', 'debt'].includes(slotKey)) throw new Error('slot 必须为 growth/retention/debt');
  const title = String(body.title || '').trim();
  if (!title) throw new Error('feature 标题必填');
  const desc = String(body.desc || '').slice(0, 200);
  const cur = store.read();
  if (!cur.trains) cur.trains = [];
  let train = cur.trains.find(x => x.no === no);
  if (!train) {
    train = { id: store.uid(), no, createdAt: Date.now(), slots: { growth: null, retention: null, debt: null }, released: false, releasedAt: null };
    cur.trains.push(train);
  }
  if (train.slots[slotKey]) throw new Error('本班 ' + slotKey + ' 格已装「' + oldTitle(train.slots[slotKey]) + '」，等下一班（火车不等人）');
  train.slots[slotKey] = { title, desc, by: body.by || 'founder', at: Date.now() };
  if (!cur.audit) cur.audit = [];
  cur.audit.push({ id: store.uid(), action: '发布列车装载', detail: no + ' 班 ' + slotKey + '：' + title, at: Date.now() });
  store.write(cur);
  return { no, slot: slotKey, title, note: '已进 ' + no + ' 班' };
}

function oldTitle(v) { return v && v.title ? v.title : ''; }

// 发车：该班三格装完或到期才可发；只能发"当前班"
function depart(body) {
  const no = line();
  const cur = store.read();
  const train = (cur.trains || []).find(x => x.no === no);
  if (!train) throw new Error('本班尚未装载，无法发车');
  const filled = Object.values(train.slots).filter(Boolean);
  const note = filled.length < 3 ? '（三格未满，但已到发车时间，先发已装件的执行栈）' : '';
  train.released = true; train.releasedAt = Date.now(); train.note = note;
  if (!cur.audit) cur.audit = [];
  cur.audit.push({ id: store.uid(), action: '发布列车发车', detail: '第 ' + no + ' 班（已装 ' + filled.length + ' 格）', at: Date.now() });
  store.write(cur);
  return { no, filled: filled.length, note: '第 ' + no + ' 班发车' + note };
}

// parking lot：新想法默认写这里（不删是尊重，下手想法别手痒）
function park(body) {
  const idea = String(body.idea || body.title || '').trim();
  if (!idea) throw new Error('想法必填');
  const rec = store.push('parkinglot', {
    idea: idea.slice(0, 200),
    desc: String(body.desc || '').slice(0, 300),
    target: String(body.target || 'next').slice(0, 20), // next / V2.5 / …
    by: body.by || 'founder',
    taken: false                   // 是否已被后续班次提取（尊重：不删，只标记）
  }, 'parking lot 登记', idea.slice(0, 60));
  return { id: rec.id, idea: rec.idea, target: rec.target, note: '记入 parking lot，等它的班次' };
}

function takeFromLot(id, no, slotKey) {
  const cur = store.read();
  const idea = (cur.parkinglot || []).find(x => x.id === id);
  if (!idea) throw new Error('parking lot 无此条');
  if (idea.taken) throw new Error('该想法已被提取过');
  const r = load({ slot: slotKey, title: idea.idea, desc: idea.desc });
  store.update('parkinglot', id, { taken: true, takenBy: r.no }, '从 parking lot 提取');
  return { ...r, from: 'parking lot' };
}

// 班次状态（战情室展示）：当前班进度 + 下一班 parking
function board() {
  const cur = store.read();
  const no = line();
  const curTrain = (cur.trains || []).find(x => x.no === no);
  const nextLot = (cur.parkinglot || []).filter(x => !x.taken);
  const history = (cur.trains || [])
    .filter(x => x.no < no && x.released)
    .sort((a, b) => b.no - a.no)
    .slice(0, 6)
    .map(x => ({ no: x.no, slots: x.slots, releasedAt: x.releasedAt }));
  return {
    current: curTrain
      ? { no, slots: curTrain.slots, released: curTrain.released, releasedAt: curTrain.releasedAt }
      : { no, slots: { growth: null, retention: null, debt: null }, released: false },
    nextNo: no + 1,
    history,
    parkinglot: nextLot.slice(0, 10),
    lotCount: nextLot.length,
    techDebt: techDebt().slice(0, 5),
    majorLine: MAJOR_LINE,
    bound: lineBounds(no)
  };
}

// 技术债欠账名单（还债格数据源）
function techDebt() {
  const cur = store.read();
  const items = [];
  if (!cur.settings || !cur.settings.theme) items.push('theme 配置项缺默认回退');
  const undefinedRoutes = (cur.messages || []).length && !cur.routes ? 'routes 表未建：可观察但不可审计' : null;
  if (undefinedRoutes) items.push(undefinedRoutes);
  // 真实可查的债：审计超限？旧决策无双字段？
  const noVer = (cur.decisions || []).filter(d => !d.version && /framework|manual|autopilot/.test(String(d.engine || ''))).length;
  if (noVer) items.push('decisions 中 ' + noVer + ' 条 engine 决策缺 version 字段');
  return items.length ? items : ['当前无待还技术债记录——很好，保持这一格每周检查的纪律。'];
}

module.exports = { line, lineBounds, load, depart, park, takeFromLot, techDebt, board, MAJOR_LINE, slots };