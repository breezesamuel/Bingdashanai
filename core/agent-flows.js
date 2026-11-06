// core/agent-flows.js — Agent 可视化流程库（借鉴 skill-flow-visualizer / transit / mermaid-skill 范式，自建·零依赖）
//
// 【为什么有它】真实存在的一批 agent 流程可视化 skill（Yep49/skill-flow-visualizer、
// tabtab-ai/skill-flow、israelvicars/transit、sohampatwardhan/mermaid-skill、
// ArunJRK/audit-flow 等）的共同范式是：
//   真实代码/数据 → JSON 中间表示(IR) → Mermaid 源码（flowchart/sequence）→ 交互 HTML
// 本模块把本仓 40+ 真实 core 模块串成 **23 条 agent 业务/工程流程**（≥20），
// 每条都给出：IR、Mermaid 源码（可拷进任意 Mermaid 渲染器）、零依赖内联 SVG
// （仓库零原生依赖纪律：不引 mermaid.js，SVG 直接渲染，Mermaid 源码做导出）。
//
// 诚实纪律（与 business-loop 同一套）：
//   1. 每个节点标注真实模块（core/*.js 文件全部真实存在，probe 44/44）+ 真实函数名。
//   2. 缺数据/模块缺失 → null，不编造；边标 condition（闸口/回边）不省略。
//   3. 全程只读：本模块零写，只把 IR/图算出来。

'use strict';

// ── IR：节点 kind = start/proc/gate/desc/store/end ──
// 节点：[id, 标签, 模块(core 文件), kind]
// 边：[from, to, 标签?, isBack?]
const FLOWS = [
  {
    id: 'lead-to-paid', label: '线索→成交主漏斗', cat: 'growth', type: 'flow',
    desc: '获客到收钱的完整主链路：找客→识客→建档→触达(草稿→人工发)→下单→记账→确认→结算',
    nodes: [
      ['a', '检索线索 leadgen.find', 'leadgen', 'start'],
      ['b', 'ICP 画像匹配 persona.fit', 'persona', 'proc'],
      ['c', '线索建档 crm.new', 'crm', 'proc'],
      ['d', '触达草稿 gtm.touch(draft)', 'gtm', 'proc'],
      ['e', '人工确认闸口 gtm.markSent', 'gtm', 'gate'],
      ['f', '回复跟进 gtm.markReply', 'gtm', 'proc'],
      ['g', '下单 subs.order', 'subs', 'proc'],
      ['h', '记账挂账 money.credit(rev-订单号幂等)', 'money', 'proc'],
      ['i', '人工结算闸口 subs.confirm + money.settle', 'money', 'gate'],
      ['j', '成交入管道 commercial-loop 段3/4', 'commercial-loop', 'end']
    ],
    edges: [
      ['a', 'b', '命中 ICP'], ['b', 'c'], ['c', 'd'], ['d', 'e', 'status=draft'],
      ['e', 'f', '已发·温度宪法过'], ['f', 'g', '有意向'], ['g', 'h', '订单号'],
      ['h', 'i', '挂账待收'], ['i', 'j', 'settled 实收'], ['j', 'f', '复购钩子', true]
    ]
  },
  {
    id: 'trial-to-paid', label: '试用→付费转化', cat: 'growth', type: 'flow',
    desc: '¥1 体验单 → 试用粘性 → 升级 offer（live SKU 实价）→ 人工确认成交',
    nodes: [
      ['a', '领试用 subs.claimFreeTrial(¥1·7天)', 'subs', 'start'],
      ['b', '试用粘性 saas-loop 试用段', 'saas-loop', 'proc'],
      ['c', '升级 offer conversion-engine.offers（实价）', 'conversion-engine', 'proc'],
      ['d', '草稿队列 conversion-engine.queue(draft)', 'conversion-engine', 'proc'],
      ['e', '人工闸口 gtm.markSent', 'gtm', 'gate'],
      ['f', '成交 subs.order + confirm', 'subs', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c', '活跃用户'], ['c', 'd'], ['d', 'e'], ['e', 'f', '成交→repeat_pay'], ['b', 'f', '直接转正']]
  },
  {
    id: 'trial7-day', label: '7 天转正窗口（可回收授权）', cat: 'growth', type: 'flow',
    desc: '真实客户优先（自测剔除）；7 天走独立 provisional 集合，绝不碰已付费订阅',
    nodes: [
      ['a', '真实试用客户 trial-conversion.realTrialers', 'trial-conversion', 'start'],
      ['b', '自测剔除 saas-loop.isInternal', 'saas-loop', 'desc'],
      ['c', '发 7 天临时授权 grant7', 'trial-conversion', 'proc'],
      ['d', 'provisional 独立集合 subs.activateProvisional', 'subs', 'store'],
      ['e', '第5天关怀 / 第7天 offer nurture(5|7)', 'trial-conversion', 'proc'],
      ['f', '人工闸口 gtm.markSent', 'gtm', 'gate'],
      ['g', '转正 confirmProvisional + subs.confirm', 'subs', 'end'],
      ['h', '超时回收 sweepProvisionalSubs', 'subs', 'desc']
    ],
    edges: [['a', 'b'], ['b', 'c', 'isInternal=false'], ['c', 'd', 'reviewUntil=7d'], ['d', 'e'], ['e', 'f'], ['f', 'g'], ['h', 'd', '到期未转正→回收', true]]
  },
  {
    id: 'partner-recruit', label: '合伙人招募飞轮（合规单层）', cat: 'growth', type: 'seq',
    desc: '零入门费·单层封顶·锚定真实成交（partner.js 禁止传销红线）；招募码=额度≠成交',
    nodes: [
      ['P', '合伙人', 'partner', 'start'],
      ['R', '平台', 'partner-recruit', 'proc'],
      ['L', '招募落地页 recruitLanding', 'partner-recruit', 'proc'],
      ['E', '登记 partner.enroll(零门槛)', 'partner', 'proc'],
      ['C', '专属码 issueReferralCode', 'partner-recruit', 'proc'],
      ['D', '交付 partner.deliver', 'partner', 'proc'],
      ['A', '验收 partner.accept', 'partner', 'proc'],
      ['Y', '分润 partner.pay（仅真实成交）', 'partner', 'end']
    ],
    edges: [
      ['R', 'L', '发布文案'], ['P', 'E', '注册·零入门费'], ['E', 'C', '发专属码'],
      ['C', 'D', '被邀人成交→挂交付'], ['D', 'A', '核验交付'], ['A', 'Y', '平台抽成+合伙人分润'], ['Y', 'E', '老带新', true]
    ]
  },
  {
    id: 'outreach-multi', label: '多渠道触达（温度宪法闸口）', cat: 'growth', type: 'flow',
    desc: '多渠道路由 + 话术序列 + 禁词扫描；草稿必须人工 markSent 才发（防群发防骚扰）',
    nodes: [
      ['a', 'ICP 人群 leadgen.ICP', 'leadgen', 'start'],
      ['b', '渠道路由 outreach-multichannel', 'outreach-multichannel', 'proc'],
      ['c', '序列与话术 gtm.SEQUENCES/ICPS', 'gtm', 'proc'],
      ['d', '温度宪法闸口 manuals.scanDignity', 'manuals', 'gate'],
      ['e', '落草稿 gtmTouches(draft)', 'gtm', 'store'],
      ['f', '人工发送 gtm.markSent', 'gtm', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd', '话术'], ['d', 'e', '过禁词'], ['e', 'f']]
  },
  {
    id: 'pay-ledger', label: '支付记账闭环（幂等·凭证闸口）', cat: 'commerce', type: 'seq',
    desc: '订单→收银→webhook→幂等记账→5% 计提→人工凭证结算；假账可 ledger-clean 清除',
    nodes: [
      ['O', '订单 subs.order', 'subs', 'start'],
      ['W', '收银 paywall / pay', 'paywall', 'proc'],
      ['N', '支付通知 pay-notify(webhook)', 'pay-notify', 'proc'],
      ['M', '幂等记账 money.credit(rev-订单号)', 'money', 'proc'],
      ['P', '5% 推广计提 promo 自动 accrue', 'money', 'desc'],
      ['C', '结算闸口 subs.confirm + money.settle(凭证)', 'money', 'gate'],
      ['S', '入账 saas-loop 营收段', 'commercial-loop', 'end']
    ],
    edges: [['O', 'W'], ['W', 'N', '回调'], ['N', 'M', '幂等去重'], ['M', 'P'], ['M', 'C', '挂账'], ['C', 'S', 'settled'], ['C', 'N', '补单/对账', true]]
  },
  {
    id: 'refund-care', label: '退款与口碑挽回', cat: 'commerce', type: 'flow',
    desc: '工单分级 → 温度宪法回复 → 带 revId 退款记账 → 写白名单核销',
    nodes: [
      ['a', '工单 tickets.new(P0/P1/P2)', 'tickets', 'start'],
      ['b', 'SLA 待命 cs-sla.standby', 'cs-sla', 'proc'],
      ['c', '回复闸口 tickets.respond + scanDignity', 'manuals', 'gate'],
      ['d', '退款 tickets.refund(revId 记账)', 'tickets', 'proc'],
      ['e', '白名单核销 money.writeoff(WRITEOFF_REASONS)', 'money', 'proc'],
      ['f', '留存挽回 saas-loop → cs-sla 草稿', 'cs-sla', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c', '分级响应'], ['c', 'd', '退则记账'], ['d', 'e'], ['e', 'f']]
  },
  {
    id: 'silent-retention', label: '沉默付费客户挽回', cat: 'commerce', type: 'flow',
    desc: '有效订阅 14 天没用 → 三步关怀（先关怀→提醒权益→限时钩子）→ 续费/升级',
    nodes: [
      ['a', '粘性扫描 saas-loop.stickiness(dormantPaid)', 'saas-loop', 'start'],
      ['b', '沉默名单 cs-sla.dormant', 'cs-sla', 'proc'],
      ['c', 'CARE/NUDGE/OFFER cs-sla.queue(draft)', 'cs-sla', 'proc'],
      ['d', '温度宪法闸口 scanDignity', 'manuals', 'gate'],
      ['e', '人工发送 gtm.markSent', 'gtm', 'proc'],
      ['f', '续费 subs.dueList / renewalState', 'subs', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd', '文案'], ['d', 'e', '过禁词'], ['e', 'f', 'repeat_pay']]
  },
  {
    id: 'ledger-clean', label: '假账清除 + 挂账核销（默认 dry-run）', cat: 'commerce', type: 'flow',
    desc: '只读三分类 → 预览 → 备份 → 命中数复核 → 物理清除 → 审计留痕；真实挂账 24h 核销',
    nodes: [
      ['a', '三分类 auditOnly(selfTest/realSettled/realPending)', 'ledger-clean', 'start'],
      ['b', '预览 purgeSelfTest(dry-run)', 'ledger-clean', 'proc'],
      ['c', '备份 db.json.purgebak', 'ledger-clean', 'store'],
      ['d', '命中数复核（≠预览即中止）', 'ledger-clean', 'gate'],
      ['e', '物理清除 + audit 留痕', 'ledger-clean', 'proc'],
      ['f', '挂账核销 writeoffStalePending(>24h)', 'ledger-clean', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e', 'execute=true'], ['a', 'f', '真挂账']]
  },
  {
    id: 'sku-pricing', label: 'SKU 定价注册（live 实价）', cat: 'commerce', type: 'flow',
    desc: 'catalog 内存注册进 subs.PLANS_CN（数组·amount 字段）；转化率全部读 live 价，不编折扣',
    nodes: [
      ['a', 'CATALOG 4 包 commerce-skus', 'commerce-skus', 'start'],
      ['b', 'boot 注册 register → subs.PLANS_CN', 'subs', 'proc'],
      ['c', '实价读取 conversion-engine.livePlans', 'conversion-engine', 'proc'],
      ['d', '收银展示 paywall plans', 'paywall', 'proc'],
      ['e', '成交 subs.order(plan.key)', 'subs', 'end']
    ],
    edges: [['a', 'b', '幂等·不碰 m=¥99'], ['b', 'c', 'amount→price'], ['c', 'd'], ['b', 'd'], ['d', 'e']]
  },
  {
    id: 'brain-decision', label: '决策大脑（观察→决策→调度→反思）', cat: 'decision', type: 'flow',
    desc: '大脑层闭环：brain 观察 → decision/goals 决策 → orchestrator 调度 → 执行 → lessons 反思回流',
    nodes: [
      ['a', '观察 brain(状态汇总)', 'brain', 'start'],
      ['b', '决策 decision / decision_focus', 'decision', 'proc'],
      ['c', '目标 goals / goalpilot', 'goals', 'proc'],
      ['d', '调度 orchestrator → conductor', 'orchestrator', 'proc'],
      ['e', '执行 agents / agentcenter', 'agentcenter', 'proc'],
      ['f', '协同 agentmesh(多体)', 'agentmesh', 'proc'],
      ['g', '反思 lessons / harness-reflection', 'lessons', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f', '需协作'], ['f', 'g'], ['g', 'a', '经验回流', true]]
  },
  {
    id: 'goal-loop', label: '目标驱动自治环', cat: 'decision', type: 'flow',
    desc: '定目标→排程→自治跑→取证据→决策引擎→目标跟踪',
    nodes: [
      ['a', '定目标 goals.define', 'goals', 'start'],
      ['b', '排程 scheduler.plan', 'scheduler', 'proc'],
      ['c', '自治执行 autopilot.run', 'autopilot', 'proc'],
      ['d', '证据采集 market-evidence / evidence-pipeline', 'market-evidence', 'proc'],
      ['e', '决策 decision_engine', 'decision_engine', 'proc'],
      ['f', '目标跟踪 goalpilot(track/漂移)', 'goalpilot', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'a', '复盘改目标', true]]
  },
  {
    id: 'sop-reuse', label: 'SOP 知识复用', cat: 'decision', type: 'flow',
    desc: '技能/剧本沉淀 → 复用 → 工厂产出 → 多形态再加工',
    nodes: [
      ['a', '技能库 skills / skilllib', 'skills', 'start'],
      ['b', 'SOP 复用 reuse-sop', 'reuse-sop', 'proc'],
      ['c', '剧本 playbook', 'playbook', 'proc'],
      ['d', '工厂 foundry(批量产出)', 'foundry', 'proc'],
      ['e', '再加工 repurpose(多形态)', 'repurpose', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]
  },
  {
    id: 'mcp-tools', label: 'MCP 工具互联', cat: 'decision', type: 'flow',
    desc: '协议层 → 枢纽路由 → 客户端外呼；安全闸双保险',
    nodes: [
      ['a', '协议 mcp / mcp-protocol', 'mcp', 'start'],
      ['b', '枢纽路由 mcp-hub', 'mcp-hub', 'proc'],
      ['c', '客户端 mcp-client', 'mcp-client', 'proc'],
      ['d', '安全闸 wallguard / guard', 'guard', 'gate'],
      ['e', '外部工具/服务', 'external', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd', '每次外呼'], ['d', 'e', '放行']]
  },
  {
    id: 'care-sms', label: '客户关怀外呼（短信/加签）', cat: 'decision', type: 'flow',
    desc: '关怀决策 → 短信网关 → 加密凭证；节奏由 cs-sla 统管',
    nodes: [
      ['a', '关怀决策 care', 'care', 'start'],
      ['b', '短信网关 care-sms', 'care-sms', 'proc'],
      ['c', '凭证加密 care-crypto', 'care-crypto', 'desc'],
      ['d', 'SLA 节奏 cs-sla', 'cs-sla', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c', '密钥'], ['b', 'd', '发送回执']]
  },
  {
    id: 'compliance', label: '合规红线（反传销·隐私·禁词）', cat: 'decision', type: 'flow',
    desc: '《禁止传销条例》红线内置：零入门费/单层/锚定真实成交；禁词扫描全链路',
    nodes: [
      ['a', '红线规则 compliance(禁止传销条例)', 'compliance', 'start'],
      ['b', '合伙人闸口 partner(单层·零入门)', 'partner', 'gate'],
      ['c', '隐私 privacy', 'privacy', 'proc'],
      ['d', '禁词闸口 wallguard / manuals', 'wallguard', 'gate'],
      ['e', '全链路生效', 'external', 'end']
    ],
    edges: [['a', 'b'], ['a', 'c'], ['c', 'd'], ['d', 'e', '不过即拦截']]
  },
  {
    id: 'stress-capacity', label: '极限测试→容量规划', cat: 'resilience', type: 'flow',
    desc: 'Locust 风格：并发压测+混沌注入+业务场景（默认隔离子进程·不污染生产账本）',
    nodes: [
      ['a', '目标 targets(subs.order/money.credit/…)', 'stresslab', 'start'],
      ['b', '并发压测 loadTest(RPS/p50/p95/p99)', 'stresslab', 'proc'],
      ['c', '混沌注入 chaosTest(超时/坏数据/幂等重放)', 'stresslab', 'proc'],
      ['d', '业务场景 scenarioRun(下单→确认→退款→审计)', 'stresslab', 'proc'],
      ['e', '容量结论 capacity.plan(实例数/SLO/韧性分)', 'capacity', 'end']
    ],
    edges: [['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'e'], ['c', 'e', 'crashRate'], ['d', 'e', 'idemHold']]
  },
  {
    id: 'storage-cutover', label: '存储灰度切读（可 30s 回滚）', cat: 'resilience', type: 'flow',
    desc: '全量快照 → 双向对账 0-diff 闸口 → shard 引擎+WAL 注入 → 周期回填 native 保持回滚点',
    nodes: [
      ['a', '快照 syncToShards(db.json→shards/)', 'shard-migrate', 'start'],
      ['b', '对账闸口 reconcile(0-diff)', 'shard-migrate', 'gate'],
      ['c', '切读预检 readiness', 'shard-migrate', 'proc'],
      ['d', '引擎注入 storage-engine.init(shard+WAL)', 'storage-engine', 'proc'],
      ['e', '崩溃恢复 replayWal(启动幂等回放)', 'shard-store', 'desc'],
      ['f', '周期回填 syncFromShards(每5min)', 'shard-migrate', 'proc'],
      ['g', '回滚预案 去 env + restart(30s)', 'storage-engine', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c', 'diff=0'], ['c', 'd', 'BINGDASHAN_STORE_ENGINE=shard'], ['d', 'e'], ['f', 'd', '保 native 新鲜', true], ['g', 'f', '触发回滚', true]]
  },
  {
    id: 'self-heal', label: '自愈守护环', cat: 'resilience', type: 'flow',
    desc: '看门狗观察 → 自愈处置（bootlock 防雪崩）→ 指标监控 → 需要时重启',
    nodes: [
      ['a', '观察 watchdog', 'watchdog', 'start'],
      ['b', '自愈 self-heal(处置/自愈动作)', 'self-heal', 'proc'],
      ['c', '启动闸 bootlock(防重启风暴)', 'bootlock', 'desc'],
      ['d', '指标 monitor(heartbeat)', 'monitor', 'proc'],
      ['e', '重启 restart.sh(nohup 孤儿 daemon)', 'external', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c', '连续失败才放行'], ['b', 'd'], ['d', 'e', '异常时'], ['e', 'a', '重启后重观察', true]]
  },
  {
    id: 'integrity', label: '台账/系统体检', cat: 'resilience', type: 'flow',
    desc: '心跳 → 闭环体检 → 假账三分类 → 完整性报告',
    nodes: [
      ['a', '心跳 monitor', 'monitor', 'start'],
      ['b', '闭环体检 business-loop.ledgerCheck', 'business-loop', 'proc'],
      ['c', '假账三分类 ledger-clean.auditOnly', 'ledger-clean', 'proc'],
      ['d', '完整性 business-loop.integrity(缺失/异常)', 'business-loop', 'proc'],
      ['e', '报告 verdict + diagnosis', 'business-loop', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]
  },
  {
    id: 'dataq-ask', label: '智能问数（LLM→反幻觉闸→只读执行）', cat: 'meta', type: 'seq',
    desc: 'SQLBot 范式：NL→LLM 查询计划→schema 白名单闸→只读执行→chart.js；双回落不编数',
    nodes: [
      ['U', '用户', 'external', 'start'],
      ['L', 'LLM 计划 free-tier.chat(zhipu/nvidia…)', 'free-tier', 'proc'],
      ['G', '反幻觉闸 dataq-sql.validate(schema 白名单)', 'dataq-sql', 'gate'],
      ['E', '只读执行 dataq-sql.execute(limit≤100)', 'dataq-sql', 'proc'],
      ['C', '图表 chart.js 规格 + 确定性洞察', 'dataq-sql', 'proc'],
      ['F', '固定 12 意图回落 dataq.ask', 'dataq', 'desc']
    ],
    edges: [['U', 'L', '自然语言'], ['L', 'G', 'JSON 计划'], ['G', 'E', '放行'], ['G', 'F', '拒绝/无LLM', true], ['E', 'C', '结果+口径'], ['C', 'U', '答案+图']]
  },
  {
    id: 'business-loop', label: '商业闭环总览（8 段管道×11 模块）', cat: 'meta', type: 'flow',
    desc: '一屏总览：管道 8 段 + 11 运营模块 + 台账体检 + 最大断点诊断',
    nodes: [
      ['a', '8 段管道 commercial-loop.status', 'commercial-loop', 'start'],
      ['b', '11 模块聚合 loadModules(缺则 null)', 'business-loop', 'proc'],
      ['c', '台账体检 ledger-clean.auditOnly', 'ledger-clean', 'proc'],
      ['d', '断点诊断 diagnosis(真实 drop-off)', 'revenue-ops', 'proc'],
      ['e', '结论 verdict(loopHealth 口径)', 'business-loop', 'end']
    ],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'a', '下一轮体检', true]]
  },
  {
    id: 'release-exe-apk', label: '出包发布（tag→CI→9 资产→下载页）', cat: 'meta', type: 'flow',
    desc: '打 tag vX → GitHub Actions 5 job → EXE/APK 等 9 资产 → releases.json → 下载页',
    nodes: [
      ['a', '打 tag vX(含全部提交)', 'external', 'start'],
      ['b', 'CI release.yml(win/linux/mac/android)', 'external', 'proc'],
      ['c', '挂资产 9 件(exe/apk/dmg/deb/AppImage+json)', 'external', 'proc'],
      ['d', '清单 make-release.js(真实 sha256)', 'external', 'proc'],
      ['e', '下载页 download.html 动态渲染', 'external', 'end']
    ],
    edges: [['a', 'b', 'push 触发'], ['b', 'c', '5 job 全绿'], ['c', 'd', 'releases.json'], ['d', 'e']]
  }
];

// ══════════ 渲染：Mermaid 源码 ══════════
const CATS = { growth: '获客增长', commerce: '交易商务', decision: '决策智能', resilience: '韧性工程', meta: '元能力' };

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// 每条流程 → Mermaid（flowchart TD / sequenceDiagram）
function mermaid(f) {
  const L = [];
  if (f.type === 'seq') {
    L.push('sequenceDiagram');
    const seen = [];
    f.nodes.forEach(n => { if (!seen.includes(n[0])) { seen.push(n[0]); L.push('  participant ' + n[0] + ' as ' + String(n[1]).split(' ')[0]); } });
    f.edges.forEach(e => {
      const label = e[2] ? ': ' + e[2] : '';
      L.push('  ' + e[0] + '->>' + e[1] + label + (e[3] ? ' %% 回边' : ''));
    });
    L.push('  Note over ' + seen[0] + ',' + seen[seen.length - 1] + ': ' + f.label + '（' + f.id + '）');
  } else {
    L.push('flowchart TD');
    f.nodes.forEach(n => {
      const [id, label, mod, kind] = n;
      const t = label + '<br/>' + mod;
      const shape = kind === 'start' ? '([' : kind === 'end' ? '([' : kind === 'gate' ? '{' : kind === 'store' ? '((' : '[';
      const close = kind === 'gate' ? '}' : kind === 'store' ? '))' : kind === 'start' || kind === 'end' ? '])' : ']';
      L.push('  ' + id + shape + '"' + t + '"' + close);
    });
    f.edges.forEach(e => {
      const lbl = e[2] ? ' |' + e[2] + '|' : '';
      L.push('  ' + e[0] + ' -->' + lbl + ' ' + e[1] + (e[3] ? ' %% 回边' : ''));
    });
  }
  L.push('  title: ' + f.label);
  return L.join('\n');
}

// ══════════ 渲染：零依赖 SVG（flowchart 类） ══════════
// 层级：Kahn 拓扑 + 最长路分层；回边（isBack）虚线不进入分层
function layersOf(f) {
  const ids = f.nodes.map(n => n[0]);
  const indeg = {}; ids.forEach(i => indeg[i] = 0);
  f.edges.forEach(e => { if (!e[3]) indeg[e[1]] = (indeg[e[1]] || 0) + 1; });
  const layer = {}; ids.forEach(i => layer[i] = 0);
  const queue = ids.filter(i => indeg[i] === 0);
  const remain = Object.assign({}, indeg);
  let guard = 0;
  while (queue.length && guard++ < 1000) {
    const u = queue.shift();
    f.edges.forEach(e => {
      if (e[0] !== u || e[3]) return;
      layer[e[1]] = Math.max(layer[e[1]] || 0, (layer[u] || 0) + 1);
      remain[e[1]] -= 1;
      if (remain[e[1]] === 0) queue.push(e[1]);
    });
  }
  // 未覆盖节点（有环未分层）补一层
  ids.forEach(i => { if (layer[i] === undefined) layer[i] = 1; });
  return layer;
}

function svgOf(f, opt) {
  const NW = 218, NH = 56, GX = 64, GY = 44, PAD = 18;
  const layer = layersOf(f);
  const byCol = {};
  f.nodes.forEach(n => { const l = layer[n[0]]; (byCol[l] = byCol[l] || []).push(n); });
  const cols = Object.keys(byCol).map(Number).sort((a, b) => a - b);
  const maxRow = Math.max.apply(null, cols.map(c => byCol[c].length));
  const width = PAD * 2 + cols.length * NW + Math.max(0, cols.length - 1) * GX;
  const height = PAD * 2 + maxRow * (NH + GY) + (maxRow > 1 ? GY * (maxRow - 1) : 0) + 8;
  const pos = {};
  cols.forEach((c, ci) => {
    const list = byCol[c];
    const total = list.length * NH + (list.length - 1) * GY;
    let y = (height - total) / 2;
    list.forEach(n => { pos[n[0]] = { x: PAD + ci * (NW + GX), y, w: NW, h: NH, node: n }; y += NH + GY; });
  });
  const S = [];
  S.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '" font-family="system-ui,\'Noto Sans SC\',sans-serif">');
  S.push('<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#0e7a5a"/></marker></defs>');
  S.push('<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#fbfdfc"/>');
  S.push('<text x="' + PAD + '" y="26" font-size="15" font-weight="700" fill="#104e41">' + esc(f.label) + ' <tspan font-weight="400" fill="#5b7d72" font-size="12">' + esc(f.id) + ' · ' + esc(CATS[f.cat] || f.cat) + '</tspan></text>');
  const off = 40;
  const P = {}; // 实际坐标（含标题偏移）
  Object.keys(pos).forEach(k => { P[k] = { x: pos[k].x, y: pos[k].y + off, w: pos[k].w, h: pos[k].h, node: pos[k].node }; });
  // 边（先画，压在节点下）
  f.edges.forEach(e => {
    const a = P[e[0]], b = P[e[1]];
    if (!a || !b) return;
    const back = !!e[3];
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    let d;
    if (x2 > x1 + 4) d = 'M' + x1 + ',' + y1 + ' C' + (x1 + (x2 - x1) / 2) + ',' + y1 + ' ' + (x2 - (x2 - x1) / 2) + ',' + y2 + ' ' + x2 + ',' + y2;
    else { // 回边/同层：下弯
      const dip = Math.max(y1, y2) + 34;
      d = 'M' + (a.x + a.w / 2) + ',' + (a.y + a.h) + ' L' + (a.x + a.w / 2) + ',' + dip + ' L' + (b.x + b.w / 2) + ',' + dip + ' L' + (b.x + b.w / 2) + ',' + (b.y + b.h) + ' M' + (b.x + b.w / 2) + ',' + (b.y + b.h);
    }
    S.push('<path d="' + d + '" fill="none" stroke="' + (back ? '#b45309' : '#0e7a5a') + '" stroke-width="' + (back ? 1.4 : 1.8) + '" ' + (back ? 'stroke-dasharray="5,4"' : '') + ' marker-end="url(#ar)"/>');
    if (e[2]) {
      const mx = Math.min(x1, x2) + Math.abs(x2 - x1) / 2 + (x2 < x1 ? 0 : 2), my = (y1 + y2) / 2 - 6;
      S.push('<text x="' + mx + '" y="' + my + '" font-size="10" fill="' + (back ? '#b45309' : '#5b7d72') + '" text-anchor="middle">' + esc(e[2]) + '</text>');
    }
  });
  // 节点
  f.nodes.forEach(n => {
    const [id, label, mod, kind] = n;
    const p = P[id];
    const tx = p.x + p.w / 2;
    if (kind === 'gate') {
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2, r = p.h / 2 - 4;
      S.push('<polygon points="' + cx + ',' + (cy - r) + ' ' + (cx + r * 1.6) + ',' + cy + ' ' + cx + ',' + (cy + r) + ' ' + (cx - r * 1.6) + ',' + cy + '" fill="#fff7ed" stroke="#b45309" stroke-width="1.5"/>');
      S.push('<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" font-size="11" fill="#7c2d12">' + esc(label) + '</text>');
      S.push('<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="9" fill="#b45309">' + esc(mod) + '·闸口</text>');
      return;
    }
    if (kind === 'store') {
      S.push('<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="10" fill="#f1f5f4" stroke="#64748b" stroke-width="1.4" stroke-dasharray="none"/>');
      S.push('<line x1="' + p.x + 14 + '" y1="' + (p.y + 12) + '" x2="' + (p.x + p.w - 14) + '" y2="' + (p.y + 12) + '" stroke="#64748b" stroke-width="1"/>');
      S.push('<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + 30) + '" text-anchor="middle" font-size="11" fill="#1f2937">' + esc(label) + '</text>');
      S.push('<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + 45) + '" text-anchor="middle" font-size="9" fill="#64748b">' + esc(mod) + '·存储</text>');
      return;
    }
    const startEnd = kind === 'start' || kind === 'end';
    const desc = kind === 'desc';
    const fill = startEnd ? '#104e41' : desc ? '#f5f3ff' : '#ffffff';
    const stroke = startEnd ? '#104e41' : desc ? '#6b4fa0' : '#0e7a5a';
    S.push('<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="' + (startEnd ? p.h / 2 : 10) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5" ' + (desc ? 'stroke-dasharray="4,3"' : '') + '/>');
    S.push('<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + 24) + '" text-anchor="middle" font-size="11" font-weight="' + (startEnd ? 700 : 400) + '" fill="' + (startEnd ? '#ffffff' : '#1f2937') + '">' + esc(label) + '</text>');
    S.push('<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + 40) + '" text-anchor="middle" font-size="9" fill="' + (startEnd ? '#bfe3d8' : (desc ? '#6b4fa0' : '#5b7d72')) + '">' + esc(mod) + '</text>');
  });
  S.push('</svg>');
  return S.join('');
}

// 地铁图总览（transit 范式）：5 条线 × 23 站 + 中央枢纽
function masterMap() {
  const CAT_COLORS = { growth: '#0e7a5a', commerce: '#b45309', decision: '#6b4fa0', resilience: '#0369a1', meta: '#be123c' };
  const rows = Object.keys(CATS);
  const RH = 96, W = 1180, H = rows.length * RH + 130;
  const S = [];
  S.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="system-ui,\'Noto Sans SC\',sans-serif">');
  S.push('<rect width="' + W + '" height="' + H + '" fill="#fbfdfc"/>');
  S.push('<text x="20" y="26" font-size="16" font-weight="700" fill="#104e41">丙大山 Agent · 23 条可视化流程（' + FLOWS.length + ' 条）<tspan font-size="12" font-weight="400" fill="#5b7d72">借鉴 skill-flow-visualizer / transit / mermaid-skill 范式 · 零依赖 SVG · 每站=一条真实模块链路</tspan></text>');
  rows.forEach((c, ri) => {
    const y0 = 58 + ri * RH;
    const flows = FLOWS.filter(f => f.cat === c);
    S.push('<line x1="40" y1="' + (y0 + RH / 2) + '" x2="' + (W - 40) + '" y2="' + (y0 + RH / 2) + '" stroke="' + CAT_COLORS[c] + '" stroke-width="5" opacity="0.25"/>');
    S.push('<text x="40" y="' + (y0 + 20) + '" font-size="12" font-weight="700" fill="' + CAT_COLORS[c] + '">' + CATS[c] + '（' + flows.length + '）</text>');
    flows.forEach((f, fi) => {
      const x = 40 + 40 + fi * 172;
      S.push('<circle cx="' + x + '" cy="' + (y0 + RH / 2 + 12) + '" r="9" fill="#fff" stroke="' + CAT_COLORS[c] + '" stroke-width="3.5"/>');
      S.push('<text x="' + x + '" y="' + (y0 + RH / 2 + 16) + '" text-anchor="middle" font-size="10" fill="' + CAT_COLORS[c] + '">' + (fi + 1) + '</text>');
      S.push('<text x="' + x + '" y="' + (y0 + RH / 2 + 40) + '" text-anchor="middle" font-size="10" fill="#374151">' + esc(f.label) + '</text>');
    });
  });
  // 中央枢纽：商业闭环
  const hy = 58 + rows.length * RH - 26;
  S.push('<rect x="' + (W / 2 - 190) + '" y="' + hy + '" width="380" height="52" rx="26" fill="#104e41"/>');
  S.push('<text x="' + (W / 2) + '" y="' + (hy + 24) + '" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">商业闭环 business-loop（8 段管道 × 11 模块 × 台账体检）</text>');
  S.push('<text x="' + (W / 2) + '" y="' + (hy + 42) + '" text-anchor="middle" font-size="10" fill="#bfe3d8">每行 5 条线 23 站汇入闭环 · 点击站号看详情 SVG + Mermaid 源码</text>');
  S.push('</svg>');
  return S.join('');
}

// ══════════ 对外接口（只读） ══════════
function board() {
  return {
    ok: true,
    at: Date.now(),
    count: FLOWS.length,
    categories: Object.assign({}, CATS, { count: {} }),
    byCategory: Object.keys(CATS).map(c => ({ cat: c, label: CATS[c], n: FLOWS.filter(f => f.cat === c).length, ids: FLOWS.filter(f => f.cat === c).map(f => f.id) })),
    flows: FLOWS.map(f => ({ id: f.id, label: f.label, cat: f.cat, type: f.type, desc: f.desc, nodes: f.nodes.length, edges: f.edges.length })),
    svg: masterMap(),
    paradigm: 'JSON IR → Mermaid 源码(可拷进任意渲染器) + 零依赖内联 SVG；节点=真实模块/函数（core/ 44/44 文件核实），回边=回收/复盘/补单等反向流',
    honesty: '每条流程的节点全部标注真实模块名与真实函数名（markSent/auditOnly/syncToShards 等已逐一核对）；无外部库引入。'
  };
}

function render(id) {
  const f = FLOWS.find(x => x.id === String(id));
  if (!f) return { ok: false, error: 'flow 不存在: ' + id, available: FLOWS.map(x => x.id) };
  const m = mermaid(f);
  const s = f.type === 'seq' ? null : svgOf(f);
  return {
    ok: true, flow: { id: f.id, label: f.label, cat: f.cat, type: f.type, desc: f.desc },
    ir: { nodes: f.nodes, edges: f.edges },
    mermaid: m,
    svg: s,
    svgNote: f.type === 'seq' ? '时序图请用 Mermaid 渲染器（sequenceDiagram）；flowchart 类给 SVG' : '零依赖 SVG，可直接内联',
    howto: 'copy mermaid → 任意 Mermaid 渲染器（mermaid.live / 文档站）；SVG 直接贴进任何页面'
  };
}

module.exports = { FLOWS, CATS, board, render, mermaid: mermaidOfId, svg: svgOfId, masterMap };
function mermaidOfId(id) { const f = FLOWS.find(x => x.id === id); return f ? mermaid(f) : null; }
function svgOfId(id) { const f = FLOWS.find(x => x.id === id); return f ? svgOf(f) : null; }
