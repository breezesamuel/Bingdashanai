// core/skill-xuanxue.js — 易学玄学预测技能组（2026-10-25 装载）
//
// 【来源与许可】三个真实开源引擎 + 一部典籍文本：
//   · lunar-javascript（github.com/6tail/lunar-javascript，MIT）——干支/节气/八字四柱，npm 安装
//   · iztro（github.com/SylarLong/iztro，MIT）——紫微斗数排盘（古籍安星诀），npm 安装
//   · 梅花易数·时间起卦——邵雍标准公式，本模块实现（无外部依赖，可复算）
//   · 《滴天髓》精要（github.com/HeiGeAi/HeiGe-SuanMing references/13，jsDelivr 镜像落地
//     data/classics/ditian_sui.md）——按关键词检索原文段落
// 【诚实边界】术数输出是"传统数术视角的参考信息"，为决策提供另一只眼睛，
//   不构成事实判断；每次输出都带此声明。与 reuse-sop 的边界声明同源。
// 【装载方式】core/skills.js 在 RUNTIME 定义后 Object.assign 合并本模块 →
//   chat/会诊/技能军械库都能通过 skills.invoke('bazi'|'ziwei'|'iching'|'ditiansui') 调用。
'use strict';
const fs = require('fs');
const path = require('path');

const HONESTY = '\n—\n⚠️ 诚实边界：以上为传统术数视角的参考信息（引擎：开源排盘库 + 可复算公式），'
  + '为决策提供辅助视角，不构成事实判断或投资/医疗建议。';

// ---------- ① 八字（四柱） ----------
// 入参：{ date:'YYYY-MM-DD', hour:0-23 }；缺省取当前时刻。
function bazi(args) {
  const L = require('lunar-javascript');
  let y, mo, d, h;
  const m = String((args && args.date) || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; h = Number(args.hour); if (!Number.isFinite(h)) h = 12; }
  else { const n = new Date(); y = n.getFullYear(); mo = n.getMonth() + 1; d = n.getDate(); h = n.getHours(); }
  const solar = L.Solar.fromYmdHms(y, mo, d, h, 0, 0);
  const lunar = solar.getLunar();
  const ec = lunar.getEightChar();
  const pillars = [ec.getYear(), ec.getMonth(), ec.getDay(), ec.getTime()];
  const line = (tag, v) => v ? '\n' + tag + '：' + v : '';
  return '🎂 八字四柱（' + y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0')
    + ' ' + String(h).padStart(2, '0') + ' 时，公历）'
    + '\n┌ 年柱 ' + pillars[0] + '　月柱 ' + pillars[1] + '　日柱 ' + pillars[2] + '　时柱 ' + pillars[3]
    + line('日主', pillars[2][0] + '（以日干论命主）')
    + line('年柱纳音', ec.getYearNaYin())
    + line('日柱纳音', ec.getDayNaYin())
    + line('生肖', lunar.getYearShengXiao())
    + line('农历', lunar.toString())
    + '\n\n【滴天髓视角·取用提示】先辨衰旺、再求中和：日主强则克泄耗为用，日主弱则生扶为用；'
    + '寒暖燥湿失衡时，调候优先于格局。（检索原文：技能 ditiansui，如 q=「中和」「通关」）'
    + HONESTY;
}

// ---------- ② 紫微斗数排盘 ----------
// 入参：{ date:'YYYY-MM-DD', hour:0-23, gender:'男'|'女' }。
function ziwei(args) {
  const { astro } = require('iztro');
  const date = String((args && args.date) || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) throw new Error('date 需为 YYYY-MM-DD');
  const hour = Number.isFinite(Number(args && args.hour)) ? Number(args.hour) : 12;
  const gender = (args && args.gender) === '男' ? '男' : '女';
  const ast = astro.bySolar(date, hour, gender, true, 'zh-CN');
  const ming = ast.palaces.find(p => p.name === '命宫') || ast.palaces[0];
  const stars = p => ((p.majorStars || []).map(s => s.name).concat((p.minorStars || []).map(s => s.name)).join('、')) || '空宫（借对宫）';
  // iztro 宫名除「命宫」外不带宫字（官禄/财帛/夫妻…），匹配用裸名、展示补宫字
  const keyPals = [['命宫', '命宫'], ['财帛', '财帛宫'], ['官禄', '官禄宫'], ['夫妻', '夫妻宫'], ['迁移', '迁移宫'], ['福德', '福德宫']];
  const rows = keyPals.map(([n, show]) => {
    const p = ast.palaces.find(x => x.name === n);
    return p ? '\n· ' + show + '（' + (p.earthlyBranch || '') + '）：' + stars(p) : '';
  }).join('');
  return '🔮 紫微斗数十二宫盘（' + date + ' ' + hour + ' 时 · ' + gender + '）'
    + '\n命宫：' + stars(ming) + '（' + (ming.earthlyBranch || '') + '）'
    + '\n身宫：' + (ast.palaces.find(p => p.isBodyPalace === true) || {}).name
    + '\n五行局：' + (ast.fiveElementsClass || (ming.fiveElementsClass) || '—')
    + '\n生肖：' + (ast.zodiac || '—')
    + '\n—— 关键六宫 ——' + rows
    + '\n\n【决策视角】命宫看禀赋底色、财帛看求财方式、官禄看事业形态、迁移看外缘动向；'
    + '四化与大限流年需结合具体问题再细断。'
    + HONESTY;
}

// ---------- ③ 梅花易数·时间起卦 ----------
// 公式（邵雍）：年支数+农历月+日，除 8 余数为上卦；加时辰数除 8 为下卦；总和除 6 余数为动爻。
const TRI_NAMES = { 1: '乾', 2: '兑', 3: '离', 4: '震', 5: '巽', 6: '坎', 7: '艮', 8: '坤' };
// 64 卦名表：HEX[上卦数][下卦数]（先天卦数坐标，文王卦名）
const HEX = {
  1: { 1: '乾为天', 2: '天泽履', 3: '天火同人', 4: '天雷无妄', 5: '天风姤', 6: '天水讼', 7: '天山遁', 8: '天地否' },
  2: { 1: '泽天夬', 2: '兑为泽', 3: '泽火革', 4: '泽雷随', 5: '泽风大过', 6: '泽水困', 7: '泽山咸', 8: '泽地萃' },
  3: { 1: '火天大有', 2: '火泽睽', 3: '离为火', 4: '火雷噬嗑', 5: '火风鼎', 6: '火水未济', 7: '火山旅', 8: '火地晋' },
  4: { 1: '雷天大壮', 2: '雷泽归妹', 3: '雷火丰', 4: '震为雷', 5: '雷风恒', 6: '雷水解', 7: '雷山小过', 8: '雷地豫' },
  5: { 1: '风天小畜', 2: '风泽中孚', 3: '风火家人', 4: '风雷益', 5: '巽为风', 6: '风水涣', 7: '风山渐', 8: '风地观' },
  6: { 1: '水天需', 2: '水泽节', 3: '水火既济', 4: '水雷屯', 5: '水风井', 6: '坎为水', 7: '水山蹇', 8: '水地比' },
  7: { 1: '山天大畜', 2: '山泽损', 3: '山火贲', 4: '山雷颐', 5: '山风蛊', 6: '山水蒙', 7: '艮为山', 8: '山地剥' },
  8: { 1: '地天泰', 2: '地泽临', 3: '地火明夷', 4: '地雷复', 5: '地风升', 6: '地水师', 7: '地山谦', 8: '坤为地' },
};
// 先天卦数 → 三爻（自下而上 1=阳），用于动爻变卦
const TRI_BITS = { 1: [1, 1, 1], 2: [1, 1, 0], 3: [1, 0, 1], 4: [1, 0, 0], 5: [0, 1, 1], 6: [0, 1, 0], 7: [0, 0, 1], 8: [0, 0, 0] };
const BITS_TRI = {}; for (const n in TRI_BITS) BITS_TRI[TRI_BITS[n].join('')] = +n;
const zhiNames = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

function iching(args) {
  const L = require('lunar-javascript');
  let solar;
  const m = String((args && args.date) || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m && Number.isFinite(Number(args.hour))) solar = L.Solar.fromYmdHms(+m[1], +m[2], +m[3], Number(args.hour), 0, 0);
  else { const n = new Date(); solar = L.Solar.fromYmdHms(n.getFullYear(), n.getMonth() + 1, n.getDate(), n.getHours(), 0, 0); }
  const lunar = solar.getLunar();
  const zhiIdx = zhiNames.indexOf(String(lunar.getYearInGanZhi())[1]);   // 0-11
  const mo = lunar.getMonth();                                           // 农历月（闰月按本月）
  const day = lunar.getDay();
  const hourIdx = Math.floor((solar.getHour() + 1) / 2) || 1;            // 时辰 1-12
  const mod8 = n => (n % 8) || 8;
  const up = mod8(zhiIdx + 1 + mo + day);
  const down = mod8(zhiIdx + 1 + mo + day + hourIdx);
  const moving = ((zhiIdx + 1 + mo + day + hourIdx) % 6) || 6;
  const name = HEX[up][down];
  // 变卦：翻转动爻（动爻 1-3 在下卦、4-6 在上卦，均自下而上数）
  const low = TRI_BITS[down].slice(), high = TRI_BITS[up].slice();
  if (moving <= 3) low[moving - 1] ^= 1; else high[moving - 4] ^= 1;
  const changed = HEX[BITS_TRI[high.join('')]][BITS_TRI[low.join('')]];
  return '☰ 梅花易数·时间起卦（' + solar.toYmdHms().slice(0, 14) + '，可复算）'
    + '\n农历 ' + lunar.getMonthInChinese() + '月' + lunar.getDayInChinese() + ' · ' + zhiNames[zhiIdx] + '年 · ' + hourIdx + '时辰'
    + '\n本卦：' + TRI_NAMES[up] + '上 ' + TRI_NAMES[down] + '下 —— ' + name
    + '\n动爻：第 ' + moving + ' 爻'
    + '\n变卦：' + changed
    + '\n\n【断卦视角】本卦为事之现状、变卦为事之走向；体用分法——动爻所在卦为用、另一卦为体，'
    + '体克用吉、用克体凶、体用生和则顺。决策时把问题映射到"体（我方根基）vs 用（事态变量）"再看生克。'
    + HONESTY;
}

// ---------- ④ 滴天髓检索 ----------
// 入参：{ q:'关键词' }（如 中和/通关/官杀/伤官/寒暖/衰旺）；无 q 返回章节目录。
function ditiansui(args) {
  const file = path.join(__dirname, '..', 'data', 'classics', 'ditian_sui.md');
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) {
    return '《滴天髓》文本未装载：data/classics/ditian_sui.md 缺失'
      + '（来源 github.com/HeiGeAi/HeiGe-SuanMing references/13_ditian_sui.md，jsDelivr 可镜像重取）。';
  }
  const q = String((args && args.q) || '').trim();
  if (!q) {
    const heads = [...txt.matchAll(/^## (.+)$/gm)].map(x => x[1]);
    return '《滴天髓》精要目录（刘伯温旧序本 · 任铁樵注）\n' + heads.map((h, i) => (i + 1) + '. ' + h).join('\n')
      + '\n\n用法：传 q=关键词 检索相关段落（如 中和 / 通关 / 衰旺 / 官杀）。' + HONESTY;
  }
  // 按二级标题分段，返回命中段（标题或正文含关键词）
  const secs = txt.split(/^## /m).slice(1).map(s => {
    const i = s.indexOf('\n');
    return { title: s.slice(0, i).trim(), body: s.slice(i + 1).trim() };
  });
  const hits = secs.filter(s => (s.title + s.body).includes(q));
  if (!hits.length) return '《滴天髓》中未命中「' + q + '」。试试：中和 / 衰旺 / 通关 / 寒暖 / 官杀 / 伤官 / 清浊。' + HONESTY;
  return '📖《滴天髓》· 命中 ' + hits.length + ' 节\n'
    + hits.slice(0, 3).map(s => '—— ' + s.title + ' ——\n' + s.body.slice(0, 600) + (s.body.length > 600 ? '…' : '')).join('\n\n')
    + HONESTY;
}

module.exports = { bazi, ziwei, iching, ditiansui };
