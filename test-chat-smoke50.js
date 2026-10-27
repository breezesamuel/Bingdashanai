const http = require('http');

const QUESTIONS = [
  '你好，请介绍一下你的核心能力',
  '帮我分析一下当前的线索漏斗状况',
  '制定一个本周的获客行动计划',
  '用决策框架评估：是否应该把定价从 99 提到 129',
  '创建一个项目：上线新版官网',
  '给这个项目拆解里程碑和首个任务',
  '查询一下组织里有哪些员工',
  '派个任务给最合适的人：写一篇技术博客',
  '用风险矩阵分析：上线前的主要风险',
  '用加权排序选技术栈：Node vs Python vs Go',
  '记一条记忆：客户偏好用中文沟通',
  '检索一下刚才那条记忆',
  '沉淀一条知识：定价策略要基于价值而非成本',
  '用七段报告分析：Q3 营收为何未达标',
  '生成一份获客诊断报告',
  '帮我写个冷邮模板给独立开发者',
  '用 AHP 分析：产品路线图的三个优先级',
  '立项检查：新功能上线需要哪些条件',
  '任务优先级矩阵：这周要做的 5 件事',
  '记忆进化：总结一下刚才的对话重点',
  '推荐一个 GitHub 上的 agent skill 库',
  '分析一下竞品 Cursor 的定价策略',
  '制定一个内容生产的 SOP',
  '用决策桥接：把聊天里的结论同步到决策中心',
  '查一下当前的营收 KPI 进度',
  '如果我是独立开发者，你会怎么向我推销',
  '模拟一次专家会诊：analyst 视角看漏斗',
  '用组织大脑：技能匹配"写技术文档"',
  '生成一首背景音乐：轻快、BPM 100',
  '创建一个简单游戏点子：记忆翻牌',
  '语音朗读：欢迎使用丙大山 AI',
  '检查一下系统健康状态',
  '导出最近的决策记录为 CSV',
  '切换主题到深色模式',
  '设置目标：半年营收 1000 万',
  '查看目标追赶节奏',
  '添加一个合伙人：张三，邮箱 zhang@example.com',
  '生成一条外发触达话术',
  '跑一次自主运营轮次',
  '检查收费墙覆盖率',
  '查看漏斗诊断结果',
  '有什么功能是我还没用过的？',
  '帮我规划下个月的 OKR',
  '总结一下：我们现在最缺什么？',
  '如果明天只有 1 小时，我该做什么？',
  '给新用户的上手指南',
  '最后一轮：用一句话总结我的现状',
];

function chat(msg, history = [], depth = false) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ text: msg, history, mode: 'text', depth });
    const req = http.request({
      hostname: '127.0.0.1', port: 3721, path: '/v1/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, data: d })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function run() {
  const h = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const depth = i % 5 === 0; // 每 5 轮开一次深度
    const r = await chat(q, h.slice(-10), depth);
    if (r.status === 200) {
      ok++;
      try {
        const j = JSON.parse(r.data);
        const preview = (j.reply || '').slice(0, 60).replace(/\n/g, ' ');
        console.log(`[${i+1}/${QUESTIONS.length}] ✓ ${preview}... | engine: ${j.engine} | tools: ${(j.tools||[]).join(',')||'无'}`);
        h.push({ role: 'user', content: q });
        h.push({ role: 'assistant', content: j.reply || '' });
      } catch (e) {
        console.log(`[${i+1}/${QUESTIONS.length}] ✓ 200 but parse fail`);
      }
    } else {
      fail++;
      console.log(`[${i+1}/${QUESTIONS.length}] ✗ ${r.status}: ${r.data.slice(0,100)}`);
    }
    // 小延迟避免触发限流
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\n=== 结果: 成功 ${ok}, 失败 ${fail}, 成功率 ${(ok/QUESTIONS.length*100).toFixed(1)}% ===`);
}
run().catch(console.error);