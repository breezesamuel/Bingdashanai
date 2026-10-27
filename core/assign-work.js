// core/assign-work.js — 统一「下达工作」服务（第 5 条 + 第 4 条的接缝）
//
// 【需求原文】
//   第 5 条："项目管理中，添加项目管理时可以直接通过智能聊天进行下达任务，
//            也可以在项目管理中下达任务"
//   第 4 条："为了完成任务而选择不同的员工"
//
// 【问题】下达任务的入口本来散在三个地方：/task 命令、POST /v1/projects、POST /v1/tasks。
// 三处各写一遍，且**只有 /task 那条会记 ref**、只有 projects 那条会带 desc，
// 更关键的是——**三处都不会给人派工**。任务建完躺在待办里没人认领，
// 这正是第 3 条和第 4 条之间那道断缝。
//
// 【解法】收口成一个 create()，三个入口都走它，统一保证：
//   1. 建完立刻组队派工（第 4 条），不等下一次定时 assign
//   2. 可挂到项目下（项目 = 任务的容器）
//   3. 自动带 ref 与验收标准，任务台能看出这活是哪来的
//
// 设计上刻意**不**在 create 里自动调 LLM：下达任务是确定性的结构化动作，
// 解析自然语言是 orchestrator 的事。这里只做"建得干净、派得出去"。

const store = require('./store');
const team = require('./team');

// 任务逾期判定（供任务台报表 / 提醒共用）。
// 【为什么单独写】任务台要敢说"有几条在跑、几条逾期"。而任务 due 是自由文本
// （"周四 18:00"/"本周"/"2026-10-04"…），直接 new Date(due) 全是 Invalid Date。
// 这里只做**可靠**的解析：答不出绝不猜，返回 null = "无法判定是否逾期"。
// 判定口径：绝对日期到今天结束 / 本周=本周日、下周=下周日、今天/明天/后天按字面。
function dueDate(task) {
  const due = String((task && task.due) || '').trim();
  if (!due) return null;
  const now = new Date();
  const day = 86400000;
  const endOf = d => new Date(new Date(d).setHours(23, 59, 59, 999));
  const endOfWeek = (base, offsetWeeks) => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const dayNum = (d.getDay() + 6) % 7;              // 周一=0 … 周日=6
    const sunday = new Date(+d + (6 - dayNum) * day + offsetWeeks * 7 * day);
    return endOf(sunday);
  };
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(due)) return endOf(new Date(due));
  if (/今天|今日/.test(due)) return endOf(now);
  if (/明天|明日/.test(due)) return endOf(new Date(+now + day));
  if (/后天/.test(due)) return endOf(new Date(+now + 2 * day));
  if (/本周|这周|周内/.test(due)) return endOfWeek(now, 0);
  if (/下周/.test(due)) return endOfWeek(now, 1);
  const m = due.match(/(\d{1,2})[月\/\-](\d{1,2})[日号]?/);
  if (m) {
    const y = now.getFullYear();
    const cut = new Date(y + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0'));
    return endOf(cut);
  }
  const t = new Date(due);
  return isNaN(t) ? null : endOf(t);
}

function isOverdue(task, nowMs) {
  const d = dueDate(task);
  if (!d) return false;
  return !task.done && d.getTime() < (nowMs === undefined ? Date.now() : nowMs);
}

// 认领所有"没主"的未完成任务（第 6 条的任务台"在跑数"的唯一可靠入口）。
// 【要它做什么】原来 team.assign 只在 createTask / self-heal 里被顺带调用，
// goalpilot、decision-focus 直接 store.push 建的任务永远不会被认领，
// 于是任务台永远显示"在跑 0"——不是没活，是没人把活接上人。
// 任何任务源建完都应调它，让"下达 → 认领 → 在跑"一条链走完。
function claimPending(opt) {
  const o = opt || {};
  const before = (store.read().tasks || []).filter(t => !t.done && !t.owner).length;
  let r;
  try { r = team.assign({ autoHire: o.autoHire !== false, cap: o.cap }); }
  catch (e) { return { ok: false, error: e.message, pending: before }; }
  const after = (store.read().tasks || []).filter(t => !t.done && !t.owner).length;
  return {
    ok: true,
    assigned: (r.assigned || []),
    hired: (r.hired || []),
    capped: !!r.capped,
    reason: r.reason || (r.assigned && r.assigned.length ? '' : '没有待认领任务'),
    pendingBefore: before,
    pending: after,        // 认领后仍未认领的（无匹配人选 → 如实保留，不硬塞）
    unclaimed: after
  };
}

// 从一句话里抽出项目名/截止/负责人
// 不做真正的 NLU——那会引入不确定性。这里只做可靠的小解析：
// 「在「XX项目」下 加个任务 周五前 完成A」这类句式够用，复杂表述交给 LLM 转成结构再调本函数。
function parse(text) {
  const s = String(text || '');
  const out = { project: '', due: '', need: [] };
  // 项目：引号内内容，或「在XX项目下」句式
  let m = s.match(/[「『"'"]([^」』"'"]{1,30})[」』"'"](?:项目|计划|里面|下)?/);
  if (m) out.project = m[1];
  else {
    m = s.match(/(?:在|给|往)\s*([^\s，,。]{2,20}?项目)(?:下|里|中|内)/);
    if (m) out.project = m[1];
  }
  // 截止：相对日期词 → 绝对日期（写死时间会立刻过期，所以解析成真实日期）
  const day = 86400000;
  const now = new Date();
  const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  if (/今天|今日/.test(s)) out.due = fmt(now);
  else if (/明天|明日/.test(s)) out.due = fmt(new Date(+now + day));
  else if (/后天/.test(s)) out.due = fmt(new Date(+now + 2 * day));
  else if (/本周|这周|周内/.test(s)) out.due = fmt(new Date(+now + ((7 - now.getDay()) || 7) * day - 3 * day));
  else if (/下周/.test(s)) out.due = fmt(new Date(+now + (14 - now.getDay()) * day - 3 * day));
  else if (/月底|本月/.test(s)) out.due = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  else {
    m = s.match(/(\d{1,2})[月\/\-](\d{1,2})[日号]?/);
    if (m) out.due = now.getFullYear() + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
  }
  // 负责人：「让XX负责」「@XX」
  m = s.match(/(?:让|由|派给|指派给)\s*([^\s，,。负责]{2,10})\s*(?:负责|来做|跟进)/);
  if (m) out.owner = m[1];
  out.need = team.requiredSkills({ title: s });
  return out;
}

// 建项目。带第一个任务时一起建（第 5 条："添加项目管理时可以直接通过智能聊天下达任务"）
function createProject(input) {
  const name = String(input.name || '').trim();
  if (!name) return { ok: false, error: '项目名不能为空' };
  const rec = store.push('projects', {
    name,
    desc: String(input.desc || '').slice(0, 500),
    status: input.status || 'running',
    progress: Number(input.progress || 0),
    createdBy: input.createdBy || 'manual'
  }, '新增项目', name.slice(0, 60));
  if (input.firstTask) {
    const t = createTask({ title: input.firstTask, ref: 'project:' + rec.id, projectId: rec.id });
    return { ok: true, project: rec, task: t.task || null, team: t.team || null };
  }
  return { ok: true, project: rec };
}

// 建任务。核心：建完立刻派工（第 4 条）
function createTask(input) {
  const title = String(input.title || '').trim();
  if (!title) return { ok: false, error: '任务标题不能为空' };
  const p = parse([title, input.desc || '', input.projectName || ''].join(' '));
  const need = (input.need && input.need.length) ? input.need : (p.need.length ? p.need : ['运营']);

  // 指定负责人时优先尊重
  let ownerId = null;
  if (input.owner || p.owner) {
    const want = String(input.owner || p.owner).trim();
    const hit = (store.read().staff || []).find(x => x.name === want || x.id === want || String(x.role || '').indexOf(want) >= 0);
    if (hit) ownerId = hit.id;
  }

  const rec = store.push('tasks', {
    title,
    due: input.due || p.due || '',
    ref: input.ref || 'chat',
    accept: String(input.accept || '').slice(0, 300),
    need,
    owner: ownerId,
    // 指定了负责人就直接进入 running；否则留给 team.assign 去选最合适的人
    status: ownerId ? 'running' : 'open',
    projectId: input.projectId || ''
  }, '新增任务', title.slice(0, 60));

  // 补上负责人名/角色（store.push 不做关联展开）
  if (ownerId) {
    const db = store.read();
    const s = (db.staff || []).find(x => x.id === ownerId);
    if (s) {
      const t = db.tasks.find(x => x.id === rec.id);
      if (t) { t.ownerName = s.name; t.role = s.role; store.write(db); }
    }
  }

  // 第 4 条：立刻组队，让这活马上有人认领，而不是躺在待办里
  // 统一走 claimPending：它内部会 team.assign（ref 以 decision: 优先），
  // 并把"认领后仍未认领的"如实带回来，不硬塞错配的人。
  let teamRes = null;
  if (!ownerId) {
    try { teamRes = claimPending({ autoHire: true }); } catch (e) { teamRes = { error: e.message }; }
  }
  const final = (store.read().tasks || []).find(x => x.id === rec.id) || rec;
  return { ok: true, task: final, team: teamRes, parsed: p };
}

// —— 项目看板（第 5 条收尾）——
// 把"项目 + 其子任务"压成看板需要的派生结构。所有数字都从任务表实打实算：
//   · taskTotal/taskDone/taskPct        —— 子任务推到哪
//   · taskOverdue/taskUnclaimed         —— 逾期 / 没人认领（如实单列）
//   · noTasks                           —— 0 个具体事项 = 未拆解（事实，不是"完成 0%"）
//   · lastActivityDays / ageDays        —— 多久没动 / 建了多久（注意力信号，不猜原因）
// progress 字段（手工/经营口径）原样保留，绝不与 task* 混成一个数。
function projectBoard() {
  const db = store.read();
  const now = Date.now(), DAY = 86400000;
  const projs = (db.projects || []).map(x => {
    const tks = (db.tasks || []).filter(t => t.projectId === x.id);
    const open = tks.filter(t => !t.done);
    const ref = Number(x.updatedAt) || Number(x.createdAt) || 0;
    return Object.assign({}, x, {
      taskDone: tks.filter(t => t.done).length,
      taskTotal: tks.length,
      taskPct: tks.length ? Math.round(tks.filter(t => t.done).length / tks.length * 100) : 0,
      taskOverdue: open.filter(t => isOverdue(t)).length,
      taskUnclaimed: open.filter(t => !t.owner).length,
      noTasks: tks.length === 0,
      lastActivityDays: ref ? Math.max(0, Math.floor((now - ref) / DAY)) : null,
      ageDays: Number(x.createdAt) ? Math.max(0, Math.floor((now - Number(x.createdAt)) / DAY)) : null
    });
  });
  const allOpen = (db.tasks || []).filter(t => !t.done);
  return {
    ok: true,
    projects: projs,
    summary: {
      total: projs.length,
      running: projs.filter(x => x.status === 'running').length,
      paused: projs.filter(x => x.status === 'paused').length,
      done: projs.filter(x => x.status === 'done').length,
      noTasks: projs.filter(x => x.noTasks).length,
      openTasks: allOpen.length,
      // 注意：必须包箭头函数——filter 会把下标当第二个参数传进来，
      // 而 isOverdue(task, nowMs) 的第二个参数就是 nowMs。直接 filter(isOverdue)
      // 会让“历史逾期”碰上下标比较而恒判 false（真踩过这个坑，两个口径因此不一致）。
      overdueTasks: allOpen.filter(t => isOverdue(t)).length,
      unclaimedTasks: allOpen.filter(t => !t.owner).length
    }
  };
}

module.exports = { createTask, createProject, parse, claimPending, dueDate, isOverdue, projectBoard };