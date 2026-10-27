// core/deck.js — 材料与演示文稿生成（PDE 助手化的真实落点）
//
// 【为什么必须真做，而不是写个说明】
// 用户 PDE 第一条明确要求：AI 做个人数字助手，要「写材料、做 PPT、查资料」。
// 实测本系统三者里只有「查资料」有出口（intel/firecrawl/webfetch），
// 写材料与做 PPT **完全没有模块** —— 于是对话被问到时只能答"我做不到"，
// 那正是用户最反感的推脱。
//
// 【产出是真的，不是占位】
//   · build() 从**真实数据**取数：营收、线索、团队、任务、目标进度、知识产出
//   · 生成的 HTML 自带翻页、键盘导航、打印样式，可直接全屏演示或导 PDF
//   · 每页都标注数据来源模块，便于核对，杜绝"编一个看起来像样的数字"
//   · 不调 LLM：文案模板 + 真实数字拼接，输出确定、可复现、离线可用
const store = require('./store');

const FORMATS = ['html', 'markdown', 'outline'];

// —— 数据采集：每项都 try/catch，读不到就明说读不到，不填假数 ——
function collect() {
  const d = { ok: [], fail: [] };
  const T = (label, fn) => {
    try {
      const v = fn();
      if (v === undefined || v === null) d.fail.push(label + '：无返回');
      else d.ok.push(label);
      return v;
    } catch (e) {
      d.fail.push(label + '：' + String(e.message || e).slice(0, 60));
      return null;
    }
  };

  const goals = T('核心目标', () => require('./goals').alignment());
  const kpi = T('营收台账', () => require('./money').kpi());
  const leads = T('线索漏斗', () => require('./leadgen').board());
  const team = T('团队', () => require('./team').board());
  const tasks = T('任务', () => {
    const ts = store.read().tasks || [];
    return {
      total: ts.length,
      running: ts.filter(t => !t.done && t.status === 'running').length,
      blocked: ts.filter(t => !t.done && t.status === 'blocked').length,
      done: ts.filter(t => t.done).length,
      list: ts.filter(t => !t.done).slice(0, 5).map(t => ({ title: t.title, owner: t.ownerName || '未认领' }))
    };
  });
  const graph = T('知识图谱', () => {
    const b = require('./graphify').build();
    return { nodes: b.totals.nodes, edges: b.totals.edges, isolated: b.totals.isolated, top: require('./graphify').centrality(3).map(n => n.label + '(' + n.degree + ')') };
  });
  const learn = T('学习产出', () => require('./memory-hub').dashboard());
  const pde = T('PDE 四级', () => require('./pde').assess());

  return { goals, kpi, leads, team, tasks, graph, learn, pde, missing: d.fail };
}

const esc = s => String(s === undefined || s === null ? '—' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = n => '¥' + Math.round(Number(n) || 0).toLocaleString('en-US');

// —— 幻灯片构造 ——
function slides(d) {
  const S = [];

  // 1) 封面
  S.push({
    title: '丙大山 AI Agent',
    sub: d.goals && d.goals.title ? d.goals.title : '经营现状汇报',
    kind: 'cover',
    notes: '数据采集于生成时刻，全部取自本系统真实模块。'
  });

  // 2) 目标
  if (d.goals) {
    S.push({
      title: '核心目标与进度',
      kind: 'kpi',
      rows: [
        ['目标', d.goals.title],
        ['目标值', money(d.goals.target)],
        ['当前完成', (d.goals.pct || 0) + '%'],
        ['还差', money(d.goals.remain)],
        ['剩余天数', (d.goals.daysLeft || 0) + ' 天']
      ],
      notes: '来源：core/goals.alignment()'
    });
  }

  // 3) 营收
  if (d.kpi) {
    const b = (() => { try { return require('./money').budget(); } catch (e) { return null; } })();
    S.push({
      title: '营收与收款',
      kind: 'kpi',
      rows: [
        ['已结算实收', money(d.kpi.revenue)],
        ['目标完成率', (d.kpi.pct || 0) + '%'],
        ['日均实收', money(d.kpi.regDaily)],
        ['达标需日均', money(d.kpi.needDaily)],
        ...(b ? [['推广池可用', money(b.avavail !== undefined ? b.avavail : b.avail)]] : [])
      ],
      notes: '来源：core/money.kpi() / budget()。实收只统计已结算，挂账不计入。'
    });
  }

  // 4) 线索
  if (d.leads) {
    const by = d.leads.byStage || {};
    S.push({
      title: '线索漏斗',
      kind: 'table',
      head: ['阶段', '条数'],
      rows: Object.keys(by).map(k => [k, String(by[k])]),
      sum: '合计 ' + (d.leads.total || 0) + ' 条 · 成交客户 ' + (d.leads.customers || 0)
        + ' 人 · 真实触达 ' + (d.leads.realTouches || 0) + ' · 待人工确认 ' + (d.leads.waitingHuman || 0),
      notes: '来源：core/leadgen.board()。真实触达须人工确认后写入，不自动累加。'
    });
  }

  // 5) 团队与任务
  if (d.team || d.tasks) {
    S.push({
      title: '组织与执行',
      kind: 'table',
      head: ['项', '值'],
      rows: [
        ['员工', (d.team && d.team.headcount !== undefined ? d.team.headcount : '—') + ' 人（在岗 ' + (d.team && d.team.active !== undefined ? d.team.active : '—') + '）'],
        ['任务总数', String(d.tasks ? d.tasks.total : '—')],
        ['在跑', String(d.tasks ? d.tasks.running : '—')],
        ['受阻', String(d.tasks ? d.tasks.blocked : '—')],
        ['已完成', String(d.tasks ? d.tasks.done : '—')]
      ],
      notes: '来源：core/team.board() + store.tasks。'
    });
  }

  // 6) 未完成任务明细
  if (d.tasks && d.tasks.list && d.tasks.list.length) {
    S.push({
      title: '在办事项（未完成）',
      kind: 'table',
      head: ['任务', '负责'],
      rows: d.tasks.list.map(t => [String(t.title).slice(0, 34), t.owner]),
      notes: '来源：store.tasks（未完成前 5 条）。'
    });
  }

  // 7) 知识图谱
  if (d.graph) {
    S.push({
      title: '系统结构（知识图谱）',
      kind: 'kpi',
      rows: [
        ['节点', String(d.graph.nodes)],
        ['边', String(d.graph.edges)],
        ['孤立节点', String(d.graph.isolated)],
        ['主要枢纽', (d.graph.top || []).join('、')]
      ],
      notes: '来源：core/graphify.build()。孤立节点高说明模块之间还没连上。'
    });
  }

  // 8) 学习进化
  if (d.learn) {
    const t = d.learn.totals || {};
    S.push({
      title: '学习与进化',
      kind: 'kpi',
      rows: [
        ['覆盖模块', String((d.learn.modules || []).length)],
        ['累计学习产出', String(t.entries !== undefined ? t.entries : '—')],
        ['退化告警', String((d.learn.alerts || []).length)]
      ],
      notes: '来源：core/memory-hub.dashboard()。'
    });
  }

  // 9) PDE 四级
  if (d.pde) {
    S.push({
      title: 'PDE 四级演进',
      kind: 'table',
      head: ['级别', '达成'],
      rows: d.pde.stages.map(s => [s.idx + '. ' + s.name + '（' + s.on + '/' + s.total + '）', s.grade.label]),
      sum: d.pde.verdict,
      notes: '来源：core/pde.assess()，每一项都有真实探测。'
    });
  }

  // 10) 数据缺口（诚实页）
  S.push({
    title: '本次未取到的数据',
    kind: 'table',
    head: ['缺失项'],
    rows: (d.missing && d.missing.length ? d.missing : ['无，全部数据源均取到']).map(m => [m]),
    notes: '如实列出取不到的数据，避免读者误以为该项为零。'
  });

  return S;
}

// —— HTML 输出：自带翻页/键盘/打印样式，可直接演示 ——
const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0b1020;color:#e8ecf8;font:16px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}
.deck{position:relative;min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:48px 64px}
.slide{display:none}
.slide.on{display:block;animation:in .28s ease}
@keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1}}
h1{font-size:44px;margin:0 0 8px;background:linear-gradient(90deg,#6ea8ff,#a78bfa);-webkit-background-clip:text;color:transparent}
h2{font-size:32px;margin:0 0 28px;color:#8ab4ff}
.sub{font-size:20px;color:#9aa7c7;margin-top:14px}
table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{padding:11px 14px;border-bottom:1px solid #22304d;text-align:left;font-size:17px}
th{color:#8ab4ff;font-weight:600;background:rgba(110,168,255,.07)}
td:first-child{color:#9aa7c7;width:38%}
.sum{margin-top:18px;color:#cbd5f5;font-size:15px}
.notes{margin-top:26px;color:#63739a;font-size:13px;border-left:3px solid #2b3b63;padding-left:12px}
.bar{height:9px;background:#1b2742;border-radius:5px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#6ea8ff,#a78bfa)}
.bar{width:180px}
.nav{position:fixed;bottom:22px;right:26px;display:flex;gap:10px;align-items:center;color:#63739a;font-size:14px}
.nav button{background:#1b2742;color:#cbd5f5;border:0;border-radius:8px;padding:8px 15px;cursor:pointer;font-size:15px}
.nav button:hover{background:#27375c}
.pill{position:fixed;top:20px;right:26px;color:#63739a;font-size:13px}
@media print{
  body{background:#fff;color:#111}
  .slide{display:block!important;page-break-after:always;min-height:96vh;padding:24px}
  .nav,.pill{display:none}
  h1,h2{color:#111;-webkit-text-fill-color:#111}
  th{color:#225;background:#eef}
  th,td{border-bottom:1px solid #bbb;color:#222}
  .notes,.sum{color:#555}
  .bar{background:#eee}.bar i{background:#225}
}`;

function toHtml(sl, meta) {
  const body = sl.map((s, i) => {
    let inner = '';
    if (s.kind === 'cover') {
      inner = `<h1>${esc(s.title)}</h1><div class="sub">${esc(s.sub)}</div>`;
    } else {
      inner = `<h2>${esc(s.title)}</h2>`;
      if (s.kind === 'kpi') {
        inner += '<table>' + s.rows.map(r => {
          const isPct = /率|进度/.test(String(r[0]));
          const v = isPct ? String(r[1]) : esc(r[1]);
          const bar = isPct ? (() => {
            const n = parseFloat(r[1]) || 0;
            return `<div class="bar"><i style="width:${Math.max(0, Math.min(100, n))}%"></i></div>`;
          })() : '';
          return `<tr><td>${esc(r[0])}</td><td>${v}${bar}</td></tr>`;
        }).join('') + '</table>';
      } else if (s.kind === 'table') {
        inner += '<table><thead><tr>' + s.head.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>'
          + s.rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('')
          + '</tbody></table>';
      }
      if (s.sum) inner += `<div class="sum">${esc(s.sum)}</div>`;
      if (s.notes) inner += `<div class="notes">${esc(s.notes)}</div>`;
    }
    return `<section class="slide${i === 0 ? ' on' : ''}">${inner}</section>`;
  }).join('\n');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title><style>${CSS}</style></head><body>
<div class="pill">${sl.length} 页 · 空格/→ 翻页 · F 全屏 · Ctrl+P 导出 PDF</div>
${body}
<div class="nav"><button onclick="go(-1)">←</button><span id="i">1/${sl.length}</span><button onclick="go(1)">→</button></div>
<script>
var S=document.querySelectorAll('.slide'),i=0;
function show(n){i=Math.max(0,Math.min(S.length-1,n));S.forEach(function(e,k){e.classList.toggle('on',k===i)});
document.getElementById('i').textContent=(i+1)+'/'+S.length;}
function go(d){show(i+d);}
document.addEventListener('keydown',function(e){
if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown')go(1);
else if(e.key==='ArrowLeft'||e.key==='PageUp')go(-1);
else if(e.key==='Home')show(0);
else if(e.key==='End')show(S.length-1);
else if(e.key==='f'||e.key==='F'){document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();}});
show(0);
</script></body></html>`;
}

function toMarkdown(sl, meta) {
  return sl.map((s, i) => {
    let out = '## ' + (i + 1) + '. ' + s.title + '\n\n';
    if (s.kind === 'cover') out += '**' + s.sub + '**\n\n';
    else {
      if (s.rows) {
        out += '| 项 | 值 |\n|---|---|\n' + s.rows.map(r => '| ' + r[0] + ' | ' + r[1] + ' |').join('\n') + '\n\n';
      }
      if (s.sum) out += '> ' + s.sum + '\n\n';
      if (s.notes) out += '_' + s.notes + '_\n\n';
    }
    return out;
  }).join('---\n\n');
}

function toOutline(sl) {
  return sl.map((s, i) => (i + 1) + '. ' + s.title + (s.sub ? '（' + s.sub + '）' : '') + '\n'
    + (s.rows ? s.rows.map(r => '   - ' + r[0] + '：' + r[1]).join('\n') + '\n' : '')).join('\n');
}

// —— 对外接口 ——
function build(opt) {
  const o = opt || {};
  const d = collect();
  const sl = slides(d);
  const fmt = FORMATS.indexOf(o.format) >= 0 ? o.format : 'html';
  const title = o.title || (d.goals && d.goals.title ? d.goals.title + ' · 汇报' : '丙大山经营汇报');
  const content = fmt === 'html' ? toHtml(sl, { title })
    : fmt === 'markdown' ? toMarkdown(sl, { title }) : toOutline(sl);

  // 无论是否落盘都回传 content：调用方（API / 对话）常常要直接取内容渲染，
  // 原来只在 save:false 时才有 content，导致「生成了但拿不到」的错觉。
  const base = { ok: true, format: fmt, slides: sl.length, title, content, chars: content.length, missing: d.missing };

  if (o.save !== false) {
    const dir = store.dataPath ? store.dataPath() : require('path').join(__dirname, '..', 'data');
    const fs = require('fs');
    const path = require('path');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = fmt === 'html' ? 'html' : fmt === 'markdown' ? 'md' : 'txt';
    const file = path.join(dir, 'decks', 'deck-' + stamp + '.' + ext);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return Object.assign(base, { file });
    } catch (e) {
      return Object.assign(base, { ok: false, error: String(e.message || e) });
    }
  }
  return base;
}

module.exports = { build, collect, FORMATS, slides };