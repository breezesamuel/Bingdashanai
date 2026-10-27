// core/repurpose.js — 内容复用器 E1（FINAL-2.0 §1：一料五吃生产线）
// 原则：任何素材只手工生产一次，机器负责变形。
// 原料：R1 案例卡 / R2 同路人素材(T1) / R3 决策数据切片
// 变形（本模块输出 5 种）：①报告镜像段 ②快速问片段卡 ③识字课案例位 ④播客脚本素材块 ⑤SEO长尾页
// 每份产物带 lineage（原料类型+来源+授权边界+变形时间）；AI 变形稿须过尊严/危机扫描后才能标"可发布"。

const store = require('./store');
const manuals = require('./manuals');

const uid = () => store.uid();

function nowTs() { return Date.now(); }

// —— 原料入库（人工只喂这里）——
function feedMaterial(body) {
  const kind = String(body && body.raw || '').trim();
  const allowed = ['R1', 'R2', 'R3'];
  if (!allowed.includes(kind)) throw new Error('raw 必须是 R1(案例卡)/R2(同路人素材)/R3(数据切片)');
  const source = String(body && body.source || '').trim();
  const text = String(body && body.text || '').trim();
  if (!text) throw new Error('缺素材正文');
  if (text.length > 2000) throw new Error('素材过长（限 2000 字）');
  const rec = store.push('repurposes', {
    kind, source, text,
    granted: [],   // 授权载体枚举：镜像段/快速问/识字课/播客/SEO 逐步勾选
    lineage: [kind + ':' + source],
    variants: []
  }, '内容复用·原料入库', kind + ' ' + source + ' ' + text.slice(0, 40));
  return { id: rec.id, kind, source };
}

// —— 一料五吃：把一条素材变形成 5 种输出 ——
function repurpose(id, grants) {
  const all = store.list('repurposes');
  const mat = all.find(x => x.id === id);
  if (!mat) throw new Error('原料不存在');
  const scope = (grants || []);
  const payouts = [
    { key: 'mirror', name: '报告镜像段', need: scope.includes('mirror') || scope.length === 0,
      build: () => '【报告·镜像段】\n素材出处：' + mat.source + '\n当时的选项→判断→结果→代价原文摘录：\n「' + mat.text.slice(0, 120) + (mat.text.length > 120 ? '…' : '') + '」\n行为格子：踩点 = 明确主题 · 核对 = 出处可查 · 余波 = 代价具象到人。' },
    { key: 'quickq', name: '快速问片段卡', need: scope.includes('quickq') || scope.length === 0,
      build: () => '【快速问·片段卡】' + (mat.kind === 'R2' ? '（同路人灯角素材，已授权）' : '') + '\n开头："有人在这道题上这样选过——"\n片段：' + mat.text.slice(0, 90) + (mat.text.length > 90 ? '…' : '') + '\n判词：' + firstLine(mat.text) + '\n出处：' + mat.source + '（可查原文）' },
    { key: 'lesson', name: '识字课案例位', need: scope.includes('lesson') || scope.length === 0,
      build: () => '【识字课·案例位】\n概念卡关联：依据素材主题生成释义\n案例标题：' + mat.source + '\n一句话案例：' + firstLine(mat.text, 40) + '\n教学题：这个案例里的"代价"是什么？→ 回看素材核对。' },
    { key: 'podcast', name: '播客脚本素材块', need: scope.includes('podcast') || scope.length === 0,
      build: () => '【播客·脚本素材块】\n片头固定语："这是第 X 个人走出来的故事"\n讲述稿（15–25 分钟单集素材）：\n' + mat.text.slice(0, 200) + (mat.text.length > 200 ? '…' : '') + '\n口播结尾：出处 ' + mat.source + ' · AI 辅助创作，经人工深度修订。' },
    { key: 'seo', name: 'SEO 长尾页', need: scope.includes('seo') || scope.length === 0,
      build: () => '【SEO 长尾页】\nH1：' + seoTitle(mat) + '\n简介：' + firstLine(mat.text, 60) + '\n正文：以素材为核心，按"问题—出处—换种说法"三段重排。\n底部：来源链接 + "截至 2026 年编，以官方现行口径为准"。' }
  ];
  const granted = mat.granted || [];
  const variants = payouts
    .filter(p => p.need)
    .map(p => {
      const strict = granted.includes(p.key) || p.key === 'mirror';
      const content = p.build();
      const crisis = manuals.scanCrisis(content);
      const dignity = manuals.scanDignity(content);
      return {
        key: p.key, name: p.name,
        content,
        lineage: [...mat.lineage, p.key + ':' + nowTs()],
        authBoundary: strict ? '授权已确认，可发布' : '授权待确认（需人工勾选载体）',
        crisis: crisis.crisis, dignity: dignity.passes,
        publishable: strict && !crisis.crisis && dignity.passes
      };
    });
  store.update('repurposes', id, { variants, lineage: [...mat.lineage, 'repurposed:' + nowTs()] }, '内容复用·一料五吃');
  return { id, kind: mat.kind, source: mat.source, variants };
}

// —— 授权边界勾选：素材出现在哪种输出，以勾选为准（变型≠授权扩张）——
function grant(id, keys) {
  const mat = store.list('repurposes').find(x => x.id === id);
  if (!mat) throw new Error('原料不存在');
  const set = new Set(mat.granted || []);
  (keys || []).forEach(k => set.add(String(k)));
  store.update('repurposes', id, { granted: [...set] }, '内容复用·授权勾选', [...set].join(','));
  return { id, granted: [...set] };
}

function list() {
  return store.list('repurposes').reverse().map(x => ({
    id: x.id, kind: x.kind, source: x.source,
    variants: (x.variants || []).map(v => ({ key: v.key, name: v.name, publishable: v.publishable })),
    granted: x.granted || [], text: x.text.slice(0, 60)
  }));
}

// helpers
function firstLine(t, n) { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > (n || 80) ? s.slice(0, (n || 80)) + '…' : s; }
function seoTitle(mat) {
  const kws = { R1: '历史案例', R2: '走出来的同路人', R3: '决策数据' };
  return (mat.kind === 'R2' ? '有一个人这样走出来了：' : '这道题的解法样本：') + firstLine(mat.text, 24) + '（' + (kws[mat.kind] || '决策实录') + '）';
}

module.exports = { feedMaterial, repurpose, grant, list };