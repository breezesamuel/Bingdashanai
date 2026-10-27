// regress_xuanxue.js — 易学玄学技能组回归（2026-10-25）
//
// 钉四件事：
//   ① 引擎真实可用（lunar-javascript 四柱 / iztro 十二宫排盘），不是装饰性词条；
//   ② 起卦公式可复算（同一时刻两次调用结果一致；卦名落在标准 64 卦集合内）；
//   ③ 滴天髓文本在位且可检索；
//   ④ skills.invoke 全链路（技能军械库/会诊/chat 走的就是这条路径）。
// 已知锚点：2026-10-25 为丙午年（火马）——若年柱不是丙午，说明干支引擎装错/换实现。
'use strict';
require('./_isolate.js');
const skills = require('../core/skills');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('  [PASS] ' + name);
  else { failed++; console.log('  [FAIL] ' + name + (detail ? ' — ' + String(detail).slice(0, 200) : '')); }
}

console.log('=== 易学玄学技能组回归 ===');

(async () => {
  // ---- ① 八字 ----
  const bz = await skills.invoke('bazi', { date: '2026-10-25', hour: 12 });
  check('bazi invoke 成功（RUNTIME 链路通）', bz && bz.ok && /八字四柱/.test(bz.output), bz && bz.output && bz.output.slice(0, 80));
  check('年柱=丙午（2026 火马年锚点）', bz.output.includes('丙午'), bz.output.slice(0, 120));
  check('四柱齐全（年月日时各两字×4）', /年柱 ..　月柱 ..　日柱 ..　时柱 ../.test(bz.output));
  check('带诚实边界声明', /诚实边界/.test(bz.output));

  // ---- ② 紫微 ----
  const zw = await skills.invoke('ziwei', { date: '2026-10-25', hour: 12, gender: '女' });
  check('ziwei invoke 成功（iztro 十二宫）', zw && zw.ok && /十二宫盘/.test(zw.output));
  check('命宫主星可读（该盘为廉贞天府）', /命宫[：:].*(廉贞|天府|空宫)/.test(zw.output), zw.output && zw.output.slice(0, 120));
  check('关键六宫渲染（财帛/官禄在列）', /财帛宫/.test(zw.output) && /官禄宫/.test(zw.output));
  const zwBad = await skills.invoke('ziwei', { date: '不是日期' }).catch(e => ({ threw: true }));
  check('非法日期被拒（不静默给假盘）', zwBad.threw === true || (zwBad.ok !== true));

  // ---- ③ 梅花起卦 ----
  const ic1 = await skills.invoke('iching', { date: '2026-10-25', hour: 12 });
  const ic2 = await skills.invoke('iching', { date: '2026-10-25', hour: 12 });
  check('iching invoke 成功', ic1 && ic1.ok && /本卦/.test(ic1.output));
  check('确定性：同参两次结果一致（可复算）', ic1.output === ic2.output);
  const ALL64 = ['乾为天','天泽履','天火同人','天雷无妄','天风姤','天水讼','天山遁','天地否','泽天夬','兑为泽','泽火革','泽雷随','泽风大过','泽水困','泽山咸','泽地萃','火天大有','火泽睽','离为火','火雷噬嗑','火风鼎','火水未济','火山旅','火地晋','雷天大壮','雷泽归妹','雷火丰','震为雷','雷风恒','雷水解','雷山小过','雷地豫','风天小畜','风泽中孚','风火家人','风雷益','巽为风','风水涣','风山渐','风地观','水天需','水泽节','水火既济','水雷屯','水风井','坎为水','水山蹇','水地比','山天大畜','山泽损','山火贲','山雷颐','山风蛊','山水蒙','艮为山','山地剥','地天泰','地泽临','地火明夷','地雷复','地风升','地水师','地山谦','坤为地'];
  const bengua = (ic1.output.match(/本卦：.\u4e0a .\u4e0b —— (.+)/) || [])[1];
  const biangua = (ic1.output.match(/变卦：(.+)/) || [])[1];
  check('本卦名在标准 64 卦集合内：' + bengua, ALL64.includes(bengua));
  check('变卦名在标准 64 卦集合内：' + biangua, ALL64.includes(biangua));
  check('动爻 1-6 合法', /动爻：第 [1-6] 爻/.test(ic1.output));
  // 变卦必须与本卦不同（动爻至少翻转一爻）
  check('变卦 ≠ 本卦', bengua !== biangua);

  // ---- ④ 滴天髓 ----
  const dts1 = await skills.invoke('ditiansui', {});
  check('ditiansui 目录返回', dts1.ok && /目录/.test(dts1.output));
  const dts2 = await skills.invoke('ditiansui', { q: '中和' });
  check('关键词检索命中（中和）', dts2.ok && /命中 1 节|命中 [1-9] 节/.test(dts2.output) && /中和为贵/.test(dts2.output));
  const dts3 = await skills.invoke('ditiansui', { q: '不存在的词xyz' });
  check('未命中给建议而非空串', dts3.ok && /未命中/.test(dts3.output));

  // ---- ⑤ 溯源登记机制（skills_ext：军械库显示 GitHub 来源；隔离库内验机制而非真实库数据）----
  const a1 = skills.addExternal({ src: 'github.com/SylarLong/iztro', name: 'iztro·紫微斗数排盘', cat: 'xuanxue', note: 'RUNTIME 已装载' });
  const a2 = skills.addExternal({ src: 'github.com/SylarLong/iztro', name: '重复登记' });
  check('addExternal 登记（iztro）', a1.added === true);
  check('重复登记被去重（added=false 复用原条目）', a2.added === false && a2.id === a1.id);
  const ext = skills.allExtRaw();
  check('军械库可见（含 xuanxue 分类）', ext.some(x => x.cat === 'xuanxue' && /iztro/.test(String(x.src))));

  // ---- ⑥ registry() 内置清单含四技能（/v1/skills → 前端军械库可见性）----
  const reg = skills.registry('');
  const ids = reg.builtin.map(x => x[0]);
  check('registry 含 bazi/ziwei/iching/ditiansui（UI 可发现）',
    ['bazi', 'ziwei', 'iching', 'ditiansui'].every(id => ids.includes(id)),
    '实际内置: ' + ids.slice(0, 20).join(','));

  console.log(failed ? 'FAILED（' + failed + '）' : 'ALL PASS（紫微/八字/梅花/滴天髓四技能全链路）');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('RUN ERROR', e); console.log('FAILED'); process.exit(1); });
