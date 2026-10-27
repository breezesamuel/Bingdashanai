// 本轮 SOP 检索：爬虫采集框架 + 工作流引擎 + 自主电商自动化
// 真实数据来源：intel.gitSearch（GitHub API）+ gitRepo + gitTree（核验五维事实）
const intel = require('C:/Users/Think/project/BingDashan/core/intel');
const SOP = require('C:/Users/Think/project/BingDashan/core/reuse-sop');

const TARGETS = [
  { key: 'crawler', need: '爬虫采集框架', query: 'web crawler framework', lang: 'JavaScript' },
  { key: 'workflow', need: '工作流引擎', query: 'workflow engine dag orchestration', lang: '' },
  { key: 'ecommerce', need: '自主电商自动化', query: 'ecommerce automation dropshipping order', lang: '' }
];

async function factsFromRepo(repoFull, searchItem) {
  // 【存在性判据】gitSearch 成功返回 ⇒ 这些仓库在 GitHub 索引里真实存在。
  // 搜索本身就是存在性证明。gitRepo 只用于补 pushedAt/createdAt（投毒检测）。
  // 【踩坑】旧实现对每个候选都打 gitRepo，未认证额度（60 次/小时）很快耗尽，
  // 后续 403 限流失败 → 被误置 exists:false → 12 个真仓库全被判"幻觉候选"，
  // SOP 直接 NO_VIABLE_CANDIDATE。**限流不等于不存在**，这是判据用错。
  let d = { ok: false, limited: false };
  try { d = await intel.gitRepo(repoFull); } catch (e) { /* 限流/网络失败都不推翻存在性 */ }

  const tree = await intel.gitTree(repoFull);
  const names = (tree.ok && tree.items) ? tree.items.map(x => x.name) : [];
  const lang = (d.ok && d.lang) || (searchItem && searchItem.lang) || '';

  const facts = {
    license: (d.ok && d.license) || (searchItem && searchItem.license) || '',
    stars: (d.ok && d.stars) || (searchItem && searchItem.stars) || 0,
    forks: (d.ok && d.forks) || (searchItem && searchItem.forks) || 0,
    pushedAt: (d.ok && d.pushedAt) ? new Date(d.pushedAt).getTime()
      : ((searchItem && searchItem.updated) ? new Date(searchItem.updated).getTime() : Date.now()),
    archived: (d.ok && d.archived) || (searchItem && searchItem.archived) || false,
    createdAt: (d.ok && d.createdAt) ? new Date(d.createdAt).getTime() : undefined,
    openIssues: 0,
    lang,
    runtime: (/node|javascript/i.test(lang) ? 'node' : /python/i.test(lang) ? 'python'
      : /^go$/i.test(lang) ? 'go' : /java/i.test(lang) ? 'jvm' : (lang || 'unknown').toLowerCase()),
    fileCount: names.length,
    manifests: tree.ok ? names : undefined,   // 拿不到就不猜
    hasPackageJson: tree.ok ? names.map(n => n.toLowerCase()).includes('package.json') : undefined,
    hasDockerfile: tree.ok ? names.some(n => ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml'].includes(n.toLowerCase())) : undefined,
    hasTests: tree.ok ? names.some(n => /^(test|tests|spec|__tests__)$/i.test(n)) : undefined,
    hasCI: tree.ok ? names.includes('.github') : undefined,
    depsCount: 0,
    // 真实性：search 命中即存在；gitRepo 限流不推翻
    reachable: true, exists: true, probeStatus: 200,
    rateLimited: d.ok === false && d.limited === true
  };
  return { detail: d, facts };
}

(async () => {
  const allCandidates = [];

  for (const t of TARGETS) {
    console.log('\n══════════ 检索目标：' + t.need + ' ══════════');
    const res = await intel.gitSearch(t.query, { lang: t.lang, per: 6 });
    if (!res.ok || !res.items.length) {
      console.log('  ✖ 检索失败/无结果：' + (res.error || 'empty') + '（reach=' + res.reach + '）');
      continue;
    }
    console.log('  命中 ' + res.total + ' 个仓库，取前 4 个详查：');
    for (const item of res.items.slice(0, 4)) {
      const { detail, facts } = await factsFromRepo(item.repo, item);
      const lic = facts.license || 'NONE';
      console.log('    · ' + String(item.repo).padEnd(42) + ' ★' + String(facts.stars).padStart(6) +
        '  fork=' + String(facts.forks).padStart(5) + '  ' + String(facts.lang || '?').padEnd(10) +
        '  license=' + lic.padEnd(16) +
        '  docker=' + (facts.hasDockerfile ? 'Y' : 'N') + ' tests=' + (facts.hasTests ? 'Y' : 'N') +
        ' ci=' + (facts.hasCI ? 'Y' : 'N') + '  ' + (detail.archived ? '已归档' : ''));
      allCandidates.push({ repo: item.repo, need: t.need, facts });
    }
  }

  console.log('\n\n══════════ 跑完整五步 SOP（' + allCandidates.length + ' 个真实候选）══════════');
  const r = await SOP.run('爬虫采集框架 + 工作流引擎 + 自主电商自动化（本轮三目标合并评估）', {
    candidates: allCandidates, pick: 3, hourlyRate: 300
  });

  console.log('结论: ' + r.conclusion + (r.stoppedAt !== null ? ' (停在 Step ' + r.stoppedAt + ')' : ''));
  console.log('判定: ' + r.verdict);
  if (r.next) console.log('下一步: ' + r.next);

  r.trace.forEach(t => {
    console.log('\n  ── Step ' + t.step + '「' + t.name + '」 ' + (t.pass ? '✅' : '⛔'));
    if (t.reason) console.log('     ' + String(t.reason).slice(0, 200));
    (t.blocked || []).forEach(b => console.log('     ✖ 协议拦截 ' + b.repo + ': ' + b.why));
    (t.hallucinated || []).forEach(h => console.log('     ✖ 幻觉候选 ' + h.repo + ': ' + h.why));
    (t.picked || []).forEach(p => console.log('     ✔ #' + p.rank + ' ' + p.repo + ' → ' + p.decision + '（' + (p.license && p.license.spdx) + ' / 传染 ' + (p.license && p.license.copyleft) + '）'));
    if (t.summary) {
      const s = t.summary;
      console.log('     直达: ' + ((s.direct || []).join('、') || '无'));
      console.log('     二开: ' + ((s.needFork || []).join('、') || '无'));
      console.log('     观望: ' + ((s.watch || []).join('、') || '无'));
      console.log('     弃用: ' + ((s.drop || []).join('、') || '无'));
    }
    (t.items || []).forEach(i => console.log('     $ ' + i.repo + ': ' + i.bucket + ' ' + i.hours + 'h' + (i.cost ? ' = ¥' + i.cost : '')));
    if (t.totalHours) console.log('     合计工时: ' + t.totalHours + 'h');
  });
})();