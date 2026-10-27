// core/leadgen-icp-extra.js — 增量 ICP 细分扩展（additive·幂等·不改 live leadgen.js）
//
// 背景：leadgen.ICP.fit 原只有 4 类（开发者/AI团队、增长团队、决策者/创业者、内容创作者），
//   导致 demand_probe 实测 3 类真实潜客被误路由或归零：
//     p-smb（小微/餐饮连锁）   → 误判 开发者/AI团队（因 topics 里"自动化"命中）
//     p-vertical（垂直行业 SaaS）→ 误判 增长团队
//     p-institution（机构/教育）→ ICP 分 = 0（n/a，完全没匹配）
//   本模块在**内存**里给 leadgen.ICP.fit 追加 3 类细分，让需求探针/漏斗路由更准。
//
// 双脑纪律（与 commerce-skus.js 同构）：
//   · 只改 live 进程内的对象属性，绝不改 leadgen.js 源文件；
//   · 幂等：重复 register 不产生重复类目（按 key 判重）；
//   · 不动已有 4 类的 kws/weight/conv；
//   · 新增类目 conv 是经验先验(A)，仅用于排序路由，不写进 landing、不当已验证成交。
//
// 用法：boot 一行 require('./core/leadgen-icp-extra').register(leadgen);
'use strict';

// 3 个新细分。kws 命中走 icpScore 的 hay.includes(k.toLowerCase())（industry+note+topics 拼接）。
// weight/conv 取值对齐 gtm.js 三个 ICP 的现实先验：SMB 客单低但量大可代运营；垂直 B2B 客单高；
// 机构/教育 贴牌入口 pre-validate。
const EXTRA_FIT = {
  'SMB/小微商家': {
    kws: ['餐饮', '连锁', '门店', '小微', '商家', '代运营', '获客', '客服', '单据', '报价', '外卖', '零售', '线下'],
    weight: 0.9,
    conv: 0.42,
    _source: 'icp-extra',
    _anchor: 'O1 代运营包月 ¥199/月（expand 杠杆）',
  },
  '垂直 B2B/行业': {
    kws: ['诊所', '医疗', '口腔', '行业', 'saas', '交付', '验收', '数据权属', '垂直', '黑盒', '患者', '档案'],
    weight: 0.85,
    conv: 0.4,
    _source: 'icp-extra',
    _anchor: 'O2 垂直交付一次性 ¥3999/单（客单 ×20）',
  },
  '机构/教育咨询': {
    kws: ['教育', '咨询', '机构', '贴牌', '白标', '决策', '推演', '培训', 'hr', '人生', '入口'],
    weight: 0.7,
    conv: 0.35,
    _source: 'icp-extra',
    _anchor: 'O3 决策IP白标引擎 ¥999/月（pre-validate）',
  },
};

// 幂等：已有 key 跳过；只新增缺失的。绝不覆盖已有 4 类的字段。
function register(leadgen) {
  if (!leadgen || !leadgen.ICP || typeof leadgen.ICP.fit !== 'object' || !leadgen.ICP.fit) {
    throw new Error('leadgen-icp-extra: leadgen.ICP.fit 不可用（需先 require leadgen）');
  }
  const fit = leadgen.ICP.fit;
  let added = 0;
  for (const cat of Object.keys(EXTRA_FIT)) {
    if (fit[cat]) continue; // 幂等：已存在（无论本模块还是后续人工加入）都跳过
    fit[cat] = Object.assign({}, EXTRA_FIT[cat]); // 复制，避免外部改坏内置
    added++;
  }
  return added;
}

module.exports = { EXTRA_FIT, register, CATEGORIES: Object.keys(EXTRA_FIT) };
