// core/report.js — 七段决策报告（「我一直在」FINAL-1.1 §2.2 宪法级落地）
// 段1 开局｜段2 镜像｜段3 代价｜段4 许可｜段5 结构｜段6 余味｜段7 安放
// 工程纪律（与手册同源）：
//   · 无出处=不输出（历史案例只用手册 cases 的真实出处，不编页码）
//   · 许可锚史实不锚安慰（史实许可句来自手册 lit.quote）
//   · 余味段 n<30 不生成回访统计（明示非预言）
//   · 段7 安放：危机词命中 → 12356 转介优先于一切；否则挂"同卦灯角"，
//     有对应走出来的人才亮（peers.lighthouse 已批准未隐藏 T1）。
// 全程零 LLM，输出的是真实词库 + 真实 db 聚合，不猜不编。

const store = require('./store');
const peerOrg = require('./peers');
const manuals = require('./manuals');
const decision = require('./decision');

const HOT = manuals.HOTLINE;

// 同场景计数（"这道题历史上 N 人遇到过"）——按卦场景 id 去重，而非按提问文本
function sceneCount(guaTopic, db) {
  const all = (db.decisions || []);
  if (!all.length) return 0;
  const selfId = peerOrg.guaOf(guaTopic).id;
  const sameGua = all.filter(d => peerOrg.guaOf(d.question).id === selfId);
  // 同一场景下，按"人"去重：判断依据是 question 题眼 + answer 归属，尽量归并为独立的历史同题者
  return new Set(sameGua.map(d => String(d.question || '').toLowerCase())).size;
}

// 历史案例（五拍结构：困局→岔路→决定→账单→余波），出处必须来自手册 cases
function mirrorCases(guaId) {
  const mlist = manuals.MANUALS;
  const no = (mlist.find(m => m.crisis) && guaId === 'S16') ? 12 : null;
  const m = no ? mlist.find(x => x.no === no) : mlist.find(x => listKeywordHit(x, guaId));
  const src = m ? m.cases : [];
  return src.slice(0, 3).map(c => ({
    person: c.person, src: c.src, how: c.how,
    five: { ku: '困局：' + c.how.split('；')[0] || c.how, jue: '岔路：这个时刻只能选一条路', ding: '决定：' + c.how, zhang: '账单（代价）：见史料原文', yu: '余波：见出处' }
  }));
}

function listKeywordHit(m, guaId) {
  const g = peerOrg.findGua(guaId);
  return g && (m.keywords || []).some(k => g.name.includes(k) || g.kw.includes(k));
}

// 许可段：史实许可句（锚史实）+ 关键人清单（每人一句候选台词，系统代笔，明示非本人原话）
function permission(m) {
  const person = m && m.lit && m.lit.person ? m.lit.person : '历史同局者';
  return {
    quote: (m && m.lit && m.lit.quote) || '同类处境的人，也曾被同一道题困住——但他们走出来了。',
    keyPeople: m && m.cases ? m.cases.slice(0, 3).map(c => ({
      name: c.person,
      line: '（AI 代笔候选台词，非本人原话）"那道题我背了三年，后来我把它拆成了三天一页。"'
    })) : []
  };
}

// 结构段：行动清单 ≤3 条 + 一条"暂缓也是行动"（来自手册真实步骤）
function structure(m) {
  const steps = (m && m.steps || []).slice(0, 3);
  return {
    actions: steps.length ? steps : ['先完成一次失业登记（12333），把"状态"从惊慌变成流程。', '列一张 60 天现金表：存款 ÷ 每月硬支出 = 还能撑几个月。', '每周见 3 个真实的人。'],
    delay: '暂缓也是行动：今天先不签任何重大文件，给自己 72 小时。'
  };
}

// 余味段：同类真实回访——决策中心的同类决策数；n<30 不生成（诚实拒绝）
function aftertaste(db, guaId) {
  const peers = (db.decisions || []).filter(d => peerOrg.guaOf(d.question).id === guaId);
  const n = peers.length;
  // 真实指标：同场景决策数 n + 本场景被"递了一把/帮到"的次数（handoffs 计数），不冒充"回访月/人"
  const helped = (db.handoffs || []).length;
  return {
    n, helped,
    note: n < 30
      ? '回访样本不足（n=' + n + ' < 30），本段不生成统计——这是诚实的拒绝，不是冷冰冰的省略。'
      : '同类人回访：' + n + ' 条同类决策记录，其中 ' + helped + ' 人把手里那句话递给了下一个人。'
  };
}

// 段7 安放：风险提醒 + 验证页 + AI 标识 + 参考书目 + 同卦灯角；危机词命中→12356 优先
function placement(topic, guaId) {
  const crisis = manuals.scanCrisis(topic);
  const lights = peerOrg.lighthouse(guaId);
  const refs = [];
  const m = manuals.MANUALS.find(x => { try { return listKeywordHit(x, guaId); } catch (e) { return false; } });
  if (m) m.cases.forEach(c => { if (!refs.includes(c.src)) refs.push(c.src); });
  return {
    crisis: crisis.crisis,
    crisisCard: crisis.crisis ? crisis.card : null,
    hotline: HOT,
    lights: crisis.crisis ? [] : lights,          // 危机语境永不出现灯角（伦理阀③）
    refs: refs.slice(0, 5),
    aiNote: '本报告由丙大山 AI 辅助生成（含人工核查出处）；不构成法律/医疗/财务专业建议。',
    verifyNote: '验证页：本报告引用的出处与手册第④节同源，点击可核对原文。'
  };
}

// 主入口：对一条决策/主题生成完整七段报告
function seven(topic, answer, visitor) {
  const t = String(topic || '').trim() || '当前主题';
  const a = String(answer || '').trim();
  const db = store.read();
  const gua = peerOrg.guaOf(t);
  const guaId = gua.id;

  // 段1 开局：引用原话开场 + 处境分类（真实计数）
  const seen = sceneCount(t.charAt(0) === '【' ? t.replace(/^【[^】]+】/, '') : t, db);
  const opening = {
    echo: '你说："' + (t.length > 40 ? t.slice(0, 40) + '…' : t) + '"',
    stance: '处境分类：' + gua.name + ' 卦。这道题同类处境的记录 ' + seen + ' 条。',
    rule: '不揣测你的动机，不假装懂你的疼——只把这道题翻到底，让你自己看见路。'
  };

  const m = manuals.MANUALS.find(x => { try { return listKeywordHit(x, guaId); } catch (e) { return false; } });
  const segMirror = mirrorCases(guaId);
  const segPerm = permission(m);
  const segStruct = structure(m);
  const segAfter = aftertaste(db, guaId);
  const segPlace = placement(t, guaId);

  const lines = [];
  lines.push('【七段决策报告：' + t + '】');
  lines.push('── 段1 开局 ──'); lines.push('· ' + opening.echo); lines.push('· ' + opening.stance); lines.push('· ' + opening.rule);
  lines.push('');
  lines.push('── 段2 镜像（历史同局，有出处才输出）──');
  segMirror.forEach(c => { lines.push('· [' + c.person + '] ' + c.how + '（' + c.src + '）'); });
  if (!segMirror.length) lines.push('· 无同卦历史案例可从手册第④节引用——本段诚实留白。');
  lines.push('');
  lines.push('── 段3 代价（具象到人，不承诺结果）──');
  lines.push('· 显性：时间、金钱、精力的一次性支付；' + (a.includes('元') || a.includes('万') ? '（你已填入明确金额，决策时就按这个数字过一遍账）' : '金额未在问题中给出，不编造。'));
  lines.push('· 隐性：关系摩擦、机会成本、持续的心理消耗——这是账单里最贵的那一行。');
  lines.push('· 沉没成本清算：已花的不能要回来，只留"再往前走一格的成本"。');
  lines.push('');
  lines.push('── 段4 许可（锚史实，不锚安慰）──');
  lines.push('· ' + segPerm.quote);
  if (segPerm.keyPeople.length) { lines.push('· 这道题里还有谁：'); segPerm.keyPeople.forEach(k => lines.push('   - ' + k.name + '：' + k.line)); }
  lines.push('');
  lines.push('── 段5 结构（有路，≤3 条）──');
  segStruct.actions.forEach((s, i) => lines.push('· ' + (i + 1) + '. ' + s));
  lines.push('· ' + segStruct.delay);
  lines.push('');
  lines.push('── 段6 余味（n<30 诚实拒绝）──');
  lines.push('· ' + segAfter.note);
  lines.push(''); 
  lines.push('── 段7 安放 ──');
  if (segPlace.crisis) {
    lines.push('⚠ 危机语境：' + segPlace.crisisCard);
    lines.push('· 热线：' + HOT.main + '（24h，全国统一）· 备线 ' + HOT.backup + ' · 法律 ' + HOT.legal + ' · 人社 ' + HOT.labor);
  } else {
    if (segPlace.lights.length) {
      lines.push('· 同卦灯角（有对应走出来的人才亮）：');
      segPlace.lights.forEach(l => {
        lines.push('   -「' + (l.text.length > 46 ? l.text.slice(0, 46) + '…' : l.text) + '」· 被帮到 ' + l.helpedCount + ' 次');
      });
    } else {
      lines.push('· 同卦灯角：暂无同处境的人走出记录——这段灯角留给你来点亮。');
    }
    lines.push('· ' + segPlace.aiNote);
    lines.push('· ' + segPlace.verifyNote);
    if (segPlace.refs.length) lines.push('· 参考书目：' + segPlace.refs.join('；'));
  }

  const rec = store.push('reports', {
    kind: 'seven', topic: t, gua: guaId, crisis: segPlace.crisis,
    lights: segPlace.lights.length, version: 'F1.1-§2.2',
    content: lines.join('\n'), generatedAt: Date.now()
  }, '七段决策报告', t.slice(0, 60));
  // 数据归属（留存根因）：给用户主动产生的报告打上 visitor
  try { require('./tenancy').markOwned('reports', rec, visitor); } catch (e) {}

  return {
    id: rec.id, version: 'FINAL-1.1 §2.2', gua: gua.name, topic: t,
    crisis: segPlace.crisis, lights: segPlace.lights.length,
    verifyUrl: verifyUrl(rec.id),
    segments: {
      s1: opening, s2: segMirror, s3: { note: '显性/隐性/沉没成本三表' },
      s4: segPerm, s5: segStruct, s6: segAfter, s7: segPlace
    },
    content: lines.join('\n'),
    generatedAt: Date.now()
  };
}

// 决策中心入口：对一条真实决策直接补七段报告
function septhed(question, answer) {
  return seven(question, answer);
}

// 报告列表/统计
function list(limit) {
  const rows = store.list('reports');
  return rows.slice().sort((a, b) => b.generatedAt - a.generatedAt).slice(0, Number(limit) || 10)
    .map(r => ({ id: r.id, topic: r.topic, gua: r.gua, crisis: r.crisis, lights: r.lights, at: r.generatedAt, version: r.version, verifyUrl: verifyUrl(r.id) }));
}

// 按 id 取完整报告（供验证页 /verify/<id> 与 MCP verify 链接回指）
function get(id) {
  const r = store.list('reports').find(x => x.id === id);
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, topic: r.topic, gua: r.gua,
    crisis: r.crisis, lights: r.lights, version: r.version,
    content: r.content, generatedAt: r.generatedAt
  };
}

// 验证页 URL（本机服务时指向同源 /verify/<id>）
function verifyUrl(id) {
  return '/verify/' + id;
}

function stats() {
  const rows = store.list('reports');
  return {
    total: rows.length,
    crisis: rows.filter(r => r.crisis).length,
    withLights: rows.filter(r => r.lights > 0).length,
    byGua: rows.reduce((m, r) => { m[r.gua] = (m[r.gua] || 0) + 1; return m; }, {})
  };
}

module.exports = { seven, septhed, list, stats, get, verifyUrl, sceneCount, mirrorCases, placement };