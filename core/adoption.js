// core/adoption.js — 复用选型 SOP（先检索复用，再造）
//
// 【为什么需要它】让 AI 找轮子时，绝大多数实现只看「好不好用」：
// 搜 GitHub → 按 star 排 → 抄进项目。跳过了三道本该由标准/合规把的关：
//   1. 协议能不能商用/闭源 —— Star 多、更新勤不等于能用
//   2. 仓库是不是真的存在 —— AI 会推荐不存在的仓库（幻觉）
//   3. 是不是已经停更/有已知漏洞 —— 高 Star 可能只是被投毒的信号
//
// 本模块把这些判据固化成**可执行、可复算、有明确结论**的检查单，
// 每个结论都附证据来源，拿不准就返回 unknown 而不是猜。
//
// 【诚实边界】以下情况一律返回 unknown 并说明原因，绝不臆断：
//   · LICENSE 文件缺失或读不到（不能因为仓库里有 LICENSE 字样就认定合规）
//   · 自定义/非标准协议（不是 SPDX 标准 id）
//   · 仓库不可达 / 不存在（这本身就是幻觉信号）
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DAY = 86400000;

// ============ 1. 协议判定：商用 / 闭源 / 传染性 ============
// SPDX 分类。每一类给出三个独立结论，不要混为一谈：
//   commercial  —— 能否用于商业用途
//   closedSrc   —— 能否在闭源产品中分发（不公开我方源码）
//   copyleft    —— 传染强度 none / weak(file-level) / strong(同协议) / network(SaaS 也触发)
//
// 【关键澄清】三类协议的传染范围完全不同，不能只回答"能不能用"：
//   · GPL-2.0/3.0       —— 同产品分发即整体开源；但**仅内部使用不分发不触发**
//   · AGPL-3.0          —— **即使只提供 SaaS 不分发二进制，远程使用即触发开源义务**
//                        （这条最常被误判成"我不分发就没事"，实际不是）
//   · LGPL-3.0          —— 动态链接一般可闭源；**静态链接/修改则需开源该库**
//   · MPL-2.0           —— 文件级弱传染：改了的文件要开源，其余可闭源
//   · Apache-2.0        —— 可闭源商用，但含**专利授权 + 专利诉讼终止**条款
//   · MIT/BSD           —— 可闭源商用，**明确放弃专利**
const LICENSE_RULES = {
  'MIT': { commercial: true, closedSrc: true, copyleft: 'none', patent: false, note: '最宽松：无传染、无专利条款' },
  'BSD-2-Clause': { commercial: true, closedSrc: true, copyleft: 'none', patent: false, note: '等同 MIT' },
  'BSD-3-Clause': { commercial: true, closedSrc: true, copyleft: 'none', patent: false, note: '多一条不得以作者名义背书' },
  'ISC': { commercial: true, closedSrc: true, copyleft: 'none', patent: false, note: '等同 MIT' },
  'Unlicense': { commercial: true, closedSrc: true, copyleft: 'none', patent: false, note: '等同公有领域' },
  'CC0-1.0': { commercial: true, closedSrc: true, copyleft: 'none', patent: false, note: '放弃权利，但**不含专利授权**' },

  'Apache-2.0': {
    commercial: true, closedSrc: true, copyleft: 'none', patent: true,
    note: '可闭源商用；含专利授权与专利诉讼终止条款（贡献者不可就专利起诉你）'
  },
  'MPL-2.0': {
    commercial: true, closedSrc: true, copyleft: 'weak(file)', patent: true,
    note: '文件级弱传染：**被修改过的文件**须以 MPL 开源，其余可闭源'
  },
  'LGPL-2.1': {
    commercial: true, closedSrc: 'conditional', copyleft: 'weak(lib)', patent: false,
    note: '动态链接通常可闭源；**静态链接或改动该库**则须开源该库本身'
  },
  'LGPL-3.0': {
    commercial: true, closedSrc: 'conditional', copyleft: 'weak(lib)', patent: true,
    note: '同 LGPL-2.1，另含专利条款'
  },
  'EPL-1.0': { commercial: true, closedSrc: 'conditional', copyleft: 'weak(file)', patent: false, note: 'EPL/EDL 双许可，可选其一' },
  'MPL-1.1': { commercial: true, closedSrc: 'conditional', copyleft: 'weak(file)', patent: false, note: '文件级弱传染' },

  'GPL-2.0': {
    commercial: true, closedSrc: false, copyleft: 'strong', patent: false,
    note: '**分发即整体开源**；仅内部使用不分发不触发。商用须买商业授权'
  },
  'GPL-3.0': {
    commercial: true, closedSrc: false, copyleft: 'strong', patent: true,
    note: '同 GPL-2.0，另含专利条款与更严的附加条款'
  },
  'AGPL-3.0': {
    commercial: true, closedSrc: false, copyleft: 'network', patent: true,
    note: '⚠ **最易误判**：即使只提供 SaaS、不分发二进制，**远程使用即触发源码开放义务**。闭源 SaaS 直接不兼容'
  },
  'SSPL-1.0': {
    commercial: false, closedSrc: false, copyleft: 'network', patent: false,
    note: '⚠ **不可商用**：即使提供服务也须开放服务端全部源码'
  },
  'BUSL-1.1': {
    commercial: 'conditional', closedSrc: 'conditional', copyleft: 'weak(file)', patent: false,
    note: '源可用，**非**开源：多数情况限内部/托管场景，商用须看具体附加条款与变更日期'
  },
  'CC-BY-NC-4.0': { commercial: false, closedSrc: false, copyleft: 'none', patent: false, note: '⚠ **禁止商用**（NC）' },
  'CC-BY-SA-4.0': { commercial: true, closedSrc: 'conditional', copyleft: 'weak(file)', patent: false, note: '内容性许可，通常不适用于代码' },
};

// 宽松但非"完全无风险"的家族判定（SPDX 常带 -only / -or-later 后缀）
const LICENSE_FAMILY = [
  [/^AGPL-3\.0/i, 'AGPL-3.0', '⚠ SaaS 亦触发开源义务'],
  [/^GPL-3\.0/i, 'GPL-3.0', '分发即整体开源'],
  [/^GPL-2\.0/i, 'GPL-2.0', '分发即整体开源'],
  [/^LGPL-3\.0/i, 'LGPL-3.0', '弱传染（库级）'],
  [/^LGPL-2\.1/i, 'LGPL-2.1', '弱传染（库级）'],
  [/^MPL-2\.0/i, 'MPL-2.0', '文件级弱传染'],
  [/^Apache-2\.0/i, 'Apache-2.0', '含专利条款'],
  [/^MIT/i, 'MIT', '最宽松'],
];

function classifyLicense(raw) {
  const s = String(raw || '').trim();
  if (!s || s === 'NOASSERTION' || /^other/i.test(s)) {
    return {
      verdict: 'unknown', reason: '未声明协议（SPDX 为空或 NOASSERTION）',
      commercial: 'unknown', closedSrc: 'unknown', copyleft: 'unknown', patent: 'unknown',
      // 没有协议 ≠ 可以随便用：默认版权保留，作者保留全部权利
      legalDefault: '保留全部权利，未经授权不得使用'
    };
  }
  const direct = LICENSE_RULES[s];
  if (direct) return Object.assign({ spdx: s, verdict: 'known' }, direct);

  const fam = LICENSE_FAMILY.find(f => f[0].test(s));
  if (fam) {
    const base = LICENSE_RULES[fam[1]];
    return Object.assign({ spdx: s, verdict: 'known', family: fam[1] }, base, { note: base.note + '（识别自 ' + s + '）' });
  }
  // 有协议名但不在我们已知表里 —— 这是最危险的一档：看起来合规，实则未审
  return {
    verdict: 'unknown', spdx: s, commercial: 'unknown', closedSrc: 'unknown', copyleft: 'unknown',
    patent: 'unknown',
    legalDefault: '自定义/非标准协议，必须人工逐条阅读条款',
    note: '协议「' + s + '」不在已知分类表中，不能假定其条款'
  };
}

// ============ 2. 活跃度与投毒信号 ============
// 【为什么要单列】Star 和更新频率**本身可以被投毒**：仓库可在两周内刷到数千 Star
// 再归档/跑路。高 Star 可能是高价值信号，也可能是高风险信号，不能只当正面指标。
// 时间字段归一：GitHub API 返回 ISO 字符串，也可能有毫秒时间戳或空值。
// 【不归一会静默失效】若直接拿 ISO 串去和 Date.now() 相减会得到 NaN，
// 而 NaN 进入 days<=90 / days<=365 的比较全部为 false —— 活跃度会被误判成
// "几年没提交"，一个健康仓库被判停更。因此统一在这里转成毫秒。
function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function scoreActivity({ stars, forks, pushedAt, archived, openIssues, createdAt }) {
  const out = { score: 0, signals: [], risks: [] };
  if (archived) {
    out.risks.push('仓库已归档（archived）：只读、不再接受修复，依赖它的风险随时间累积');
    return out;
  }
  const now = Date.now();
  const pushed = toMs(pushedAt);
  const created = toMs(createdAt);
  if (pushed) {
    const days = Math.max(0, (now - pushed) / DAY);
    if (days <= 90) { out.score += 35; out.signals.push(Math.floor(days) + ' 天内有提交'); }
    else if (days <= 365) { out.score += 18; out.signals.push(Math.floor(days) + ' 天前有提交（偏慢）'); }
    else { out.risks.push('已 ' + Math.floor(days / 365) + ' 年无提交：实质停更'); }
  } else {
    out.risks.push('无法取得最近提交时间，活跃度未知');
  }
  const st = Number(stars) || 0;
  if (st >= 500) { out.score += 25; out.signals.push('Star ' + st); }
  else if (st >= 100) { out.score += 15; out.signals.push('Star ' + st); }
  else if (st > 0) { out.score += 6; out.signals.push('Star ' + st); }
  // 投毒特征：极新 + 极高 Star + 几乎无 fork（刷量通常不跟着 fork 走）
  const fr = Number(forks) || 0;
  const ageDays = created ? (now - created) / DAY : null;
  if (ageDays !== null && ageDays < 120 && st >= 1000 && fr < st * 0.08) {
    out.risks.push('⚠ 疑似刷量：仓库创建不足 120 天，Star ' + st + ' 但 fork 仅 ' + fr + '（fork/star 比例异常低）');
  }
  if (st > 0 && fr === 0 && ageDays !== null && ageDays < 365) {
    out.risks.push('⚠ 疑似刷量：有 Star 但零 fork，创建不足一年');
  }
  return out;
}

// ============ 3. 部署/接入难度 ============
// 【为什么要单列】「能不能用」和「要改多少才能用」是两件事。
// 一个 MIT 协议但需要改动 15 个文件才能接进现有架构的项目，
// 实际改造成本可能高于自己写一个。
function scoreIntegration({ lang, fileCount, hasPackageJson, hasDockerfile, hasTests, hasCI, runtime, depsCount, manifests }) {
  const out = { score: 100, signals: [], risks: [] };   // 100 = 接入最省力
  const L = String(lang || '').toLowerCase();
  // 与本项目主栈（Node.js）一致性：跨栈接入成本显著更高
  if (L === 'javascript' || L === 'typescript') out.score -= 0;
  else if (L === 'python') { out.score -= 10; out.signals.push('Python 栈：跨语言集成（需 HTTP/子进程边界）'); }
  else if (L) { out.score -= 18; out.signals.push('非主流栈（' + lang + '）：集成成本高'); }
  else out.risks.push('主语言未知');

  // 【按语言查对应清单文件】旧实现只认 package.json —— 这是 Node 中心假设。
  // 后果：Go 的 go.mod、Java 的 pom.xml、Python 的 requirements.txt 全被误报
  // 「无 package.json：非标准 npm 包」，hatchet/rill-flow 这类健康仓库白背一条
  // 风险、集成分被无谓拉低。正确做法是问「这个栈的标准清单文件在不在」。
  // manifestOk 由调用方通过 facts.manifests（根目录文件名数组）提供。
  const MANIFEST_NAMES = {
    javascript: ['package.json'], typescript: ['package.json'],
    python: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
    go: ['go.mod'],
    java: ['pom.xml', 'build.gradle'],
    rust: ['cargo.toml'], ruby: ['gemfile'], php: ['composer.json'],
    'c#': ['.csproj'], c: ['makefile', 'cmakelists.txt']
  };
  const manifestFiles = Array.isArray(manifests) ? manifests : [];
  const wanted = MANIFEST_NAMES[L] || null;
  let hasManifest = false;
  if (wanted && manifestFiles.length) {
    hasManifest = manifestFiles.some(f => wanted.indexOf(String(f).toLowerCase()) >= 0);
  } else if (hasPackageJson) {
    hasManifest = true; // 兼容旧调用点：没传 manifests 时退回 package.json 判断
  }
  if (hasManifest) out.score -= 5;
  else if (wanted) out.risks.push('无 ' + wanted[0] + '：非标准 ' + lang + ' 包结构，接入方式需自行判断');
  else out.risks.push('主语言未知，无法判断标准清单文件');
  if (hasDockerfile) out.score -= 3; else if (hasDockerfile === false) out.signals.push('无 Dockerfile');
  if (hasCI) out.score -= 4; else if (hasCI === false) out.signals.push('无 CI 配置');
  // 【拿不到数据时不许声称「没有」】旧实现把 undefined 与 false 同等对待：
  // gitTree 被 GitHub 限流时 names 为空 → hasTests 退化成 false →
  // 仓库白背一条"⚠ 无测试"的风险，集成分被无谓拉低 30。
  // 正确做法：false = 确认没有（扣分+告警）；undefined = 没看到（不加分也不污名）。
  if (hasTests) out.score -= 4;
  else if (hasTests === false) { out.score -= 30; out.risks.push('⚠ 无测试：改动后无从验证回归，无法判定「可直接用」'); }
  else out.signals.push('测试目录未探明（远端未返回清单，不作判定）');

  const n = Number(depsCount) || 0;
  if (n > 30) { out.score -= 14; out.risks.push('依赖树很重（' + n + ' 个直接依赖）：供应链攻击面大'); }
  else if (n > 10) out.score -= 4;
  const fc = Number(fileCount) || 0;
  if (fc > 1000) { out.score -= 12; out.risks.push('代码量大（' + fc + ' 文件）：全量二开的成本与回归面都很大'); }
  else if (fc > 300) out.score -= 6;
  if (runtime) out.signals.push('需运行时：' + runtime);
  out.score = Math.max(0, Math.min(100, out.score));
  return out;
}

// ============ 4. 幻觉与真实性核验 ============
// 【AI 检索的固有失败模式】会推荐**根本不存在**的仓库，或名字极其相似的仓库。
// 唯一可靠的判据是「远端是否存在」这一事实核验，不能靠描述听起来合理。
function verifyReality({ reachable, exists, rateLimited, probeStatus }) {
  if (rateLimited && probeStatus) {
    if (probeStatus === 200) return { verdict: 'exists', evidence: 'codeload 直达探测 200' };
    if (probeStatus === 404) return { verdict: 'hallucination', evidence: 'codeload 探测 404：仓库不存在' };
    return { verdict: 'unknown', evidence: '限流且探测未得出结论' };
  }
  if (reachable === false) return { verdict: 'unknown', evidence: '网络不可达，未能核验（不等于不存在）' };
  if (exists === false) return { verdict: 'hallucination', evidence: '仓库不存在或已删除' };
  if (exists === true) return { verdict: 'exists', evidence: '远端核验通过' };
  return { verdict: 'unknown', evidence: '未核验' };
}

// ============ 5. 汇总：直接用 / 二开 / 别用 ============
function recommend({ license: lic, activity, integration, reality }) {
  const L = lic || classifyLicense('');
  const A = activity || { score: 0, risks: [] };
  const I = integration || { score: 50, risks: [] };
  const R = reality || { verdict: 'unknown', evidence: '未核验' };

  if (R.verdict === 'hallucination') {
    return { decision: 'reject', label: '别用（仓库不存在）', reasons: ['AI 给出的仓库在远端不存在：' + R.evidence] };
  }
  if (R.verdict === 'unknown') {
    return { decision: 'hold', label: '先核实再用', reasons: ['真实性未能核验：' + R.evidence + '。AI 推荐仓库必须先确认它真实存在'] };
  }
  // 协议是硬门槛：闭源分发不兼容的协议，不能靠"改造"绕过
  if (L.closedSrc === false) {
    const r = ['协议 ' + (L.spdx || '未知') + ' 不允许闭源分发：' + (L.note || '')];
    if (L.copyleft === 'network') r.push('若是 AGPL/SSPL 类协议，**做成 SaaS 对外提供服务同样触发**该义务，不存在"不分发就没事"的豁免');
    return { decision: 'reject', label: '别用（协议不允许闭源）', reasons: r };
  }
  if (L.verdict === 'unknown') {
    return {
      decision: 'hold', label: '需人工审协议',
      reasons: [L.reason || '协议未识别', '默认权利状态：' + (L.legalDefault || '保留全部权利'), '在读完 LICENSE 原文前不要合入']
    };
  }
  // 协议可用，接下来比「省力程度」。
  // 【「可直接用」的门槛必须够高】不是分数够高就算——存在**否决项**时一律不给 use：
  // 无测试（改完无法验证回归）、依赖树过重（供应链面失控），
  // 这两种情况下的"省力"是假的，接进去之后每一步改动都在裸奔。
  const blocking = (I.risks || []).filter(x => /^⚠/.test(x));
  if (blocking.length) {
    return {
      decision: 'adapt', label: '需要二开（有否决项）',
      reasons: ['协议允许（' + (L.spdx || '') + '：' + (L.note || '') + '）']
        .concat(blocking.map(x => '否决项：' + x))
        .concat(['「可直接用」的前提是能验证改动没有引入回归；上述否决项不满足时不得直接上线'])
    };
  }
  if (I.score >= 65 && (A.risks || []).length === 0) {
    return {
      decision: 'use', label: '可直接用',
      reasons: ['协议允许闭源商用（' + (L.spdx || '') + '）', '活跃度健康', '接入成本低（省力分 ' + I.score + '）'].concat(L.patent ? ['注意：' + L.note] : [])
    };
  }
  if (I.score >= 35) {
    return {
      decision: 'adapt', label: '需要二开',
      reasons: ['协议允许（' + (L.spdx || '') + '：' + (L.note || '') + '）', '接入需改造（省力分 ' + I.score + '）']
        .concat((A.risks || []).map(x => '风险：' + x))
    };
  }
  return {
    decision: 'adapt', label: '二开成本高于自研',
    reasons: ['协议允许（' + (L.spdx || '') + '）', '但接入省力分仅 ' + I.score + '，改造成本可能高于自己写']
      .concat((A.risks || []).map(x => '风险：' + x))
      .concat(['建议：做一次「自研 vs 二开」的工时对比再定，不要默认复用'])
  };
}

// ============ 主入口：一张完整检查单 ============
function assess(repo, facts) {
  const f = facts || {};
  const license = classifyLicense(f.license);
  const activity = scoreActivity(f);
  const integration = scoreIntegration(f);  const reality = verifyReality(f);
  const rec = recommend({ license, activity, integration, reality });
  return {
    repo: repo,
    checklist: {
      reality: reality,
      license: license,
      activity: activity,
      integration: integration
    },
    decision: rec.decision,
    label: rec.label,
    reasons: rec.reasons,
    // 抄进项目前必须人工确认的动作项
    mustDoBeforeUse: buildMustDo(license, activity, integration, reality, rec)
  };
}

function buildMustDo(L, A, I, R, rec) {
  const out = [];
  if (R.verdict !== 'exists') out.push('先在浏览器打开仓库地址确认真实存在——AI 推荐的仓库必须亲自核验');
  if (L.closedSrc === false) out.push('法务/合规复核传染义务；GPL 系须评估是否购买商业授权');
  if (L.copyleft === 'network') out.push('⚠ 若要做成 SaaS：本协议对网络提供服务同样生效，不能按「不分发即不触发」处理');
  if (L.copyleft === 'weak(file)') out.push('保留改动过的文件清单（' + (L.spdx || '') + ' 需以原协议开源这些文件）');
  if (L.patent) out.push('保留 LICENSE/NOTICE 全文与版权声明，随产品分发');
  if (L.verdict === 'unknown') out.push('读完 LICENSE 原文再决定，勿凭仓库名假定协议');
  if (A.risks && A.risks.length) out.push('评估这些活跃度/投毒信号：' + A.risks.join('；'));
  if (I.risks && I.risks.length) out.push('评估接入风险：' + I.risks.join('；'));
  if (rec.decision === 'adapt') out.push('先估工时：二开成本 vs 自研成本，二者都写下来再决策');
  return out;
}

// ============ 规则表自检 ============
// 【为什么要有】家族表 LICENSE_FAMILY 里每一项都指向 LICENSE_RULES 的某个 key。
// 若有人新增家族条目却写错名字，classifyLicense 会在运行时才炸，
// 而且是「某个后缀协议突然判成 unknown」这种极隐蔽的失败 ——
// 健康仓库被当成无协议，进而被 hold 掉。放进自检里，改表即时报错。
function selfCheck() {
  const problems = [];
  const REQUIRED = ['commercial', 'closedSrc', 'copyleft', 'patent', 'note'];
  Object.keys(LICENSE_RULES).forEach(k => {
    REQUIRED.forEach(f => {
      if (LICENSE_RULES[k][f] === undefined) problems.push('规则 ' + k + ' 缺字段 ' + f);
    });
  });
  LICENSE_FAMILY.forEach(([re, name]) => {
    if (!LICENSE_RULES[name]) problems.push('家族 ' + re + ' 指向不存在的规则 ' + name);
  });
  // 闭源禁止类协议必须被标记为不可闭源（防止手滑把 AGPL 写成可闭源）
  ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'SSPL-1.0'].forEach(k => {
    if (LICENSE_RULES[k] && LICENSE_RULES[k].closedSrc !== false) {
      problems.push('规则 ' + k + ' 是强传染协议，closedSrc 必须是 false');
    }
  });
  return { ok: problems.length === 0, problems, ruleCount: Object.keys(LICENSE_RULES).length };
}

module.exports = { classifyLicense, scoreActivity, scoreIntegration, verifyReality, recommend, assess, selfCheck, LICENSE_RULES, LICENSE_FAMILY };