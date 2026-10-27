const adoption = require('C:/Users/Think/project/BingDashan/core/adoption');

// 对上面每个存活候选单独评估，看 activity/integration 分数与 risks
const surv = [
  { repo: 'achannarasappa/locust', stars: 16, forks: 1, lang: 'JavaScript', pushedAt: Date.now() - 30*86400000, createdAt: Date.now()-400*86400000, archived: false, openIssues: 0, hasDockerfile: false, hasTests: true, hasCI: false, fileCount: 5 },
  { repo: 'hatchet-dev/hatchet', stars: 8099, forks: 519, lang: 'Go', pushedAt: Date.now() - 2*86400000, createdAt: Date.now()-700*86400000, archived: false, openIssues: 0, hasDockerfile: true, hasTests: false, hasCI: true, fileCount: 5 },
  { repo: 'weibocom/rill-flow', stars: 410, forks: 50, lang: 'Java', pushedAt: Date.now() - 400*86400000, createdAt: Date.now()-1500*86400000, archived: false, openIssues: 0, hasDockerfile: false, hasTests: false, hasCI: true, fileCount: 5 },
  { repo: 'gorango/flowcraft', stars: 211, forks: 17, lang: 'TypeScript', pushedAt: Date.now() - 200*86400000, createdAt: Date.now()-900*86400000, archived: false, openIssues: 0, hasDockerfile: false, hasTests: false, hasCI: true, fileCount: 5 },
  { repo: 'p0nymc1/cee', stars: 100, forks: 1, lang: 'Go', pushedAt: Date.now() - 600*86400000, createdAt: Date.now()-800*86400000, archived: false, openIssues: 0, hasDockerfile: false, hasTests: false, hasCI: true, fileCount: 5 },
  { repo: 'superjack2050/1688-cli', stars: 115, forks: 28, lang: 'TypeScript', pushedAt: Date.now() - 100*86400000, createdAt: Date.now()-500*86400000, archived: false, openIssues: 0, hasDockerfile: false, hasTests: true, hasCI: false, fileCount: 5 },
  { repo: 'reham00025/ecommerce-dropshipping-ai-agent', stars: 0, forks: 0, lang: '', pushedAt: Date.now() - 10*86400000, createdAt: Date.now()-20*86400000, archived: false, openIssues: 0, hasDockerfile: false, hasTests: false, hasCI: false, fileCount: 3 }
];

surv.forEach(c => {
  const a = adoption.assess(c.repo, c);
  const A = a.checklist.activity, I = a.checklist.integration;
  console.log(c.repo);
  console.log('  decision=' + a.decision + ' activity.score=' + A.score + ' integration.score=' + I.score);
  console.log('  activity.risks=' + JSON.stringify(A.risks || []));
  console.log('  integration.risks=' + JSON.stringify(I.risks || []));
  console.log('  reasons=' + JSON.stringify(a.reasons).slice(0, 200));
});