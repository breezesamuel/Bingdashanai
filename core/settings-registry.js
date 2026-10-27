// core/settings-registry.js — 系统设置注册表（第 7 条：设置中枢）
//
// 【为什么要有这个，而不是继续往设置页里手写卡片】
// 实测 `getSetting('x')` 在全系统被读了 **19 个不同的键**，
// 而设置页 UI 只能管 4 个（theme / sound / lang / provider）。
// 也就是说：
//   · alertEmail（告警收件箱）—— 没有任何 UI 可填 → 自愈邮件永远发不出去
//   · receiveAccount / receiveQrAlipay / receiveQrWechat（收款账号与收款码）
//     —— 没有任何 UI 可填 → 收款信息只能改代码
//   · platformFee / partnerSharePct（平台费率与合伙人分成）
//   · watchdogScanSec（监控间隔）、orcaSlots（并发槽位）
//   …… 全部只能靠手改库文件。
// 这就是用户说的「他不是管理整个系统设置的平台」。
//
// 【做法：注册表是唯一事实来源】
// 1. 每条声明：键、类型、分组、标签、说明、谁在消费、校验规则。
// 2. UI 由注册表生成 —— 加一个设置项只需加一行，不会漏。
// 3. coverage() 扫全代码里的 getSetting('x')，凡是没登记的都报出来。
//    这样"没人能在界面上配"这个洞以后不会再静默出现。
//
// 【安全边界】
//   · secret 型（访问密钥/管理令牌）**不返回值**，只回"是否已配置 + 掩码尾巴"，
//     否则设置页就成了密钥泄露面。
//   · 涉及钱的键（收款账号/费率/分成）标注 money:true，前端要二次确认。
const fs = require('fs');
const path = require('path');
const store = require('./store');

// 分组（对应设置页的卡片顺序）
const GROUPS = [
  { key: 'lang', label: '界面语言', icon: '🌐' },
  { key: 'sound', label: '警告音', icon: '🔔' },
  { key: 'keys', label: '模型通道 · 密钥', icon: '🔑' },
  { key: 'alert', label: '监控与告警', icon: '🛡' },
  { key: 'money', label: '收款与分润', icon: '💰' },
  { key: 'exec', label: '执行与并发', icon: '⚙️' },
  { key: 'billing', label: '订阅与收费墙', icon: '💳' },
  { key: 'outreach', label: '真实触达', icon: '📬' },
  { key: 'spider', label: '24h 蜘蛛入料', icon: '🕷', hidden: true },
  { key: 'adv', label: '高级 · 数据', icon: '🗄' }
  // 注：目标任务不作为设置项登记 —— 它有独立的增删/设核心窗口（set.goal 卡片 + goalList），
  //     走的是 goals 模块的 add/setPrimary/remove，不属于 getSetting 单键配置。
];

// type: text | number | bool | email | secret | select | json
// secret → 只回 configured + mask
// money  → 涉及资金，前端二次确认
const ITEMS = [
  // —— 界面语言 ——
  { key: 'lang', group: 'lang', type: 'select', label: '界面语言', desc: '选择后整个系统立即切换（中/英/阿），不会出现语言混杂', options: ['zh', 'en', 'ar'] },

  // —— 警告音 ——
  { key: 'sound', group: 'sound', type: 'bool', label: '启用警告音', desc: '不同事件使用不同提示音' },
  { key: 'soundKind', group: 'sound', type: 'select', label: '默认事件类型', desc: '普通提醒 / 告警 / 成功', options: ['notice', 'alert', 'success'] },

  // —— 模型通道 ——
  { key: 'provider', group: 'keys', type: 'select', label: '默认模型通道', desc: '对话默认使用哪个通道（不可用时自动降级）' },

  // —— BYOK：自带模型密钥（8 家，优先级：设置库 > .env > 进程环境）————
  { key: 'AGNES_API_KEY', group: 'keys', type: 'secret', label: 'Agnes API Key', desc: 'https://api.agnes.ai' },
  { key: 'ZHIPU_API_KEY', group: 'keys', type: 'secret', label: '智谱 API Key', desc: 'https://open.bigmodel.cn' },
  { key: 'DEEPSEEK_API_KEY', group: 'keys', type: 'secret', label: 'DeepSeek API Key', desc: 'https://api.deepseek.com' },
  { key: 'SILICONFLOW_API_KEY', group: 'keys', type: 'secret', label: '硅基流动 API Key', desc: 'https://api.siliconflow.cn' },
  { key: 'VOLCENGINE_API_KEY', group: 'keys', type: 'secret', label: '火山引擎 API Key', desc: 'https://ark.cn-beijing.volces.com' },
  { key: 'MINIMAX_API_KEY', group: 'keys', type: 'secret', label: 'MiniMax API Key', desc: 'https://api.minimax.chat' },
  { key: 'MOONSHOT_API_KEY', group: 'keys', type: 'secret', label: 'Kimi (Moonshot) API Key', desc: 'https://api.moonshot.cn' },
  { key: 'NVIDIA_API_KEY', group: 'keys', type: 'secret', label: 'NVIDIA API Key', desc: 'https://integrate.api.nvidia.com' },

  // —— 监控与告警（第 15 条的关键）——
  { key: 'alertEmail', group: 'alert', type: 'email', label: '告警收件邮箱',
    desc: '监控发现异常时把诊断与处置结果发到这里。不填则只在本机记录，不会丢但也没人知道', critical: true },
  { key: 'watchdogScanSec', group: 'alert', type: 'number', label: '监控扫描间隔（秒）',
    desc: '24h 监控多久扫一次异常。默认 60 秒；调小会增加磁盘与 CPU 开销', min: 30, max: 3600, default: 60 },
  { key: 'autoHeal', group: 'alert', type: 'bool', label: '启用自动修复闭环',
    desc: '开启后诊断→处置→复检全自动跑。涉钱/对外发声/篡改数据的项一律仍会转人工', default: false },

  // —— 收款与分润（此前无任何 UI 可配）——
  { key: 'receiveAccount', group: 'money', type: 'text', label: '收款账号',
    desc: '客户付款时告知的收款账号（支付宝账号 / 银行卡号）', money: true, critical: true },
  { key: 'receiveQrAlipay', group: 'money', type: 'text', label: '支付宝收款码',
    desc: '订阅页展示的支付宝收款码图片路径或 data URI', money: true },
  { key: 'receiveQrWechat', group: 'money', type: 'text', label: '微信收款码',
    desc: '订阅页展示的微信收款码图片路径或 data URI', money: true },
  // 【类型踩坑】platformFee 不是数字，是**阶梯对象**：
  //   { revenueTiers: [{ maxAnnual, pct, note }, ...] }
  // 按 number 声明会导致三处坏掉：validate 用 Number() 判范围把真实配置拒掉、
  // UI 渲染成 NaN 输入框、对话拼成 "[object Object]"（被 test-capability-all 抓到）。
  // 用 json 型：可整体编辑，校验走 JSON.parse。
  { key: 'platformFee', group: 'money', type: 'json', label: '平台费率阶梯（JSON）',
    desc: '按近 365 天已结算实收判定的阶梯费率，形如 {"revenueTiers":[{"maxAnnual":100000,"pct":3}]}', money: true },
  { key: 'partnerSharePct', group: 'money', type: 'number', label: '合伙人分成（%）',
    desc: '合伙人分润比例，与平台费率合计不得超过 100', money: true, min: 0, max: 100, default: 0 },
  { key: 'kpiStart', group: 'money', type: 'text', label: 'KPI 起算日',
    desc: '日均实收从哪天开始算（YYYY-MM-DD）。改了会影响营收进度口径', money: true },

  // —— 执行与并发 ——
  { key: 'orcaSlots', group: 'exec', type: 'number', label: 'Orca 并发槽位（1-4）',
    desc: '同时能跑多少个后台作业。调高会同时压更多模型通道，可能触发限流', min: 1, max: 4, default: 2 },
  { key: 'autopilot', group: 'exec', type: 'bool', label: '24h 自主运营', desc: '开启后按间隔自动跑运营轮次', default: false },
  { key: 'lessonNoiseFloor', group: 'exec', type: 'number', label: '经验入库噪声阈值',
    desc: '低于该置信度的结论不入经验库，避免污染长期记忆', min: 0, max: 1 },

  // —— 订阅与收费墙 ——
  { key: 'paywallOn', group: 'billing', type: 'bool', label: '启用订阅收费墙',
    desc: '关闭时全部端点免费开放（当前为暂停状态；修完全部问题后再开）', default: false },
  { key: 'publicBase', group: 'billing', type: 'text', label: '对外公开地址',
    desc: '生成对外链接与回调时使用的基地址（如 https://xxx.com）' },

  // —— 真实触达（AI 自主外发，人工只确认大额成交）——
  { key: 'outreachEnabled', group: 'outreach', type: 'bool', label: '启用真实触达',
    desc: '开启后 24h 引擎对「促单」线索真实外发（邮件/webhook）。首封送达计入真实触达；客户回复后自动升「商机候选」', critical: true, default: false },
  { key: 'outreachDailyCap', group: 'outreach', type: 'number', label: '每日外发上限',
    desc: '真实发送的每日预算，防打扰也防被拉黑', min: 1, max: 200, default: 20 },
  { key: 'outreachMaxPerLead', group: 'outreach', type: 'number', label: '单线索外发上限',
    desc: '同一条线索最多外发几轮，超过即转人工处理', min: 1, max: 10, default: 3 },
  { key: 'outreachCooldownH', group: 'outreach', type: 'number', label: '冷却间隔（小时）',
    desc: '同一条线索两次外发之间至少间隔多久', min: 1, max: 720, default: 48 },
  { key: 'outreachWebhookUrl', group: 'outreach', type: 'text', label: 'IM 机器人中转地址',
    desc: '配置后触达改走 webhook（企业微信/飞书机器人回调），此时 SMTP 被旁路；未填则用 SMTP' },
  { key: 'outreachWebhookChannel', group: 'outreach', type: 'text', label: 'webhook 渠道名',
    desc: '走 webhook 时，触达在 ROI 看板归因到哪个渠道', default: '企业微信' },
  { key: 'outreachReplyToken', group: 'outreach', type: 'secret', label: '回复令牌',
    desc: '入站回复接口的校验令牌；不配置则外部回复一律被拒（回复进不来，无法晋级商机候选）', critical: true },
  { key: 'smtpHost', group: 'outreach', type: 'text', label: 'SMTP 服务器',
    desc: '发送服务器地址（如 smtp.qq.com）', default: 'smtp.qq.com' },
  { key: 'smtpPort', group: 'outreach', type: 'number', label: 'SMTP 端口',
    desc: '465 = SSL 直连；587 / 25 = STARTTLS', min: 1, max: 65535, default: 465 },
  { key: 'smtpUser', group: 'outreach', type: 'text', label: 'SMTP 账号',
    desc: '发件账号（未填时自动落到 .env 的 MAIL_SENDER）' },
  { key: 'smtpFrom', group: 'outreach', type: 'email', label: '发件人地址',
    desc: '显示在收件人一栏的地址（未填则用账号）' },
  { key: 'smtpPass', group: 'outreach', type: 'secret', label: 'SMTP 授权码',
    desc: '发送授权码（未填时自动落到 .env 的 MAIL_AUTH），只显示是否已配置', critical: true },

  // —— 24h 蜘蛛入料（寻客 + 深爬入库）——
  { key: 'crawlerOn', group: 'spider', type: 'bool', label: '启用 24h 蜘蛛入料',
    desc: '开启后运营引擎每轮轮换主题去 GitHub 探测新仓库登记成线索，并对公开页面网页深爬后回填知识库（完善网站内容）', critical: true, default: false },
  { key: 'crawlerTopics', group: 'spider', type: 'json', label: '周巡搜索主题（JSON）',
    desc: 'GitHub 周巡按主题轮换搜索，形如 ["claude skills","mcp server agent"]', default: '["claude skills","mcp server agent","ai agent workflow","writing automation","workflow automation"]' },

  // —— Firecrawl 网页深爬（替代/补充本地抓取，支持 JS 渲染与 Markdown 清洗）——
  { key: 'firecrawlApiKey', group: 'spider', type: 'secret', label: 'Firecrawl API Key', desc: 'Firecrawl 网页深爬 API Key【https://firecrawl.dev】数据库列网维整', critical: true },
  { key: 'firecrawlBase', group: 'spider', type: 'text', label: 'Firecrawl Base URL', desc: '自建 Firecrawl 实例地址（留空用官方 https://api.firecrawl.dev）', default: 'https://api.firecrawl.dev' },
  { key: 'firecrawlTimeout', group: 'spider', type: 'number', label: 'Firecrawl 超时（秒）', desc: '单次深爬请求超时，默认 60 秒，建议 30-120', min: 10, max: 300, default: 60 },

  // —— MoltSpay【未接入·2026-10-18 收口】——
  // 官方 MoltsPay 是 x402 服务商框架：收币靠钱包地址 + Coinbase CDP 凭证，**不发** API Key/Secret。
  // 以下三项保留仅为兼容历史数据；填了也不会产生可用收款通道（checkout 已 fail-closed 拒绝）。
  { key: 'moltspayApiKey', group: 'spider', type: 'secret', label: 'MoltSpay API Key（未接入）', desc: '未接入。MoltsPay 是 x402 服务商框架，不提供 API Key；填了不生效', critical: true },
  { key: 'moltspaySecret', group: 'spider', type: 'secret', label: 'MoltSpay Secret（未接入）', desc: '未接入。MoltsPay 不提供 Secret；填了不生效', critical: true },
  { key: 'moltspayMode', group: 'spider', type: 'select', label: 'MoltSpay 模式（未接入）', desc: '未接入。保留字段，暂无作用', options: ['live', 'test'], default: 'test' },

  { key: 'logisticsQueryCooldownMin', group: 'spider', type: 'number', label: '物流自动查询冷却（分钟）',
    desc: '对快递100 的自动查单冷却间隔，避免重复打付费接口。默认 30', min: 1, max: 1440, default: 30 },

  // —— 高级/数据 ——
  { key: 'devcapOverrides', group: 'adv', type: 'json', label: '研发能力人工覆写',
    desc: '对自动评估出的研发能力做人工修正（JSON）。用于环境受限时的兜底', advanced: true },
  { key: 'visitorSecret', group: 'adv', type: 'secret', label: '访客密钥',
    desc: '外部访客调用凭据。只显示是否已配置，不回显明文', advanced: true },
  { key: 'adminToken', group: 'adv', type: 'secret', label: '管理令牌',
    desc: '管理员操作凭据。只显示是否已配置，不回显明文', advanced: true },
  { key: 'theme', group: 'adv', type: 'text', label: '主题', desc: '配色方案 ID', advanced: true }
];

// —— 取值：secret 只回掩码 ——
function maskTail(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 6) return '••••';
  return '••••••' + s.slice(-4);
}

function readValue(it) {
  let raw;
  try { raw = store.getSetting(it.key); } catch (e) { raw = undefined; }
  const has = raw !== undefined && raw !== null && raw !== '' && raw !== false;
  if (it.type === 'secret') {
    return { key: it.key, configured: !!has, mask: has ? maskTail(raw) : '', type: 'secret' };
  }
  return { key: it.key, value: raw === undefined ? (it.default !== undefined ? it.default : null) : raw, type: it.type };
}

function list(opt) {
  const o = opt || {};
  const items = ITEMS
    .filter(it => (o.group ? it.group === o.group : true))
    .filter(it => (o.includeAdvanced || !it.advanced))
    .filter(it => !it.hidden)
    .map(it => {
      const base = {
        key: it.key, group: it.group, type: it.type, label: it.label, desc: it.desc,
        money: !!it.money, critical: !!it.critical, advanced: !!it.advanced,
        min: it.min, max: it.max, options: it.options, default: it.default
      };
      return Object.assign(base, readValue(it));
    });
  const groups = GROUPS.filter(g => !g.hidden);
  return { groups: o.includeAdvanced ? groups : groups, items };
}

// —— 写入 + 校验 ——
function validate(it, val) {
  if (it.type === 'number') {
    const n = Number(val);
    if (!isFinite(n)) return '必须是数字';
    if (it.min !== undefined && n < it.min) return '不能小于 ' + it.min;
    if (it.max !== undefined && n > it.max) return '不能大于 ' + it.max;
    return null;
  }
  if (it.type === 'email') {
    if (val === '' || val === undefined || val === null) return null;   // 允许清空
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val))) return '邮箱格式不正确';
    return null;
  }
  if (it.type === 'bool') return null;
  if (it.type === 'select') {
    if (it.options && it.options.length && it.options.indexOf(val) < 0) {
      return '可选值：' + it.options.join(' / ');
    }
    return null;
  }
  if (it.type === 'json') {
    // 【踩过的坑】原来写 JSON.parse(String(val))：
    // 若传入的已经是对象（前端 PUT json、或服务端内部调用），
    // String(obj) === "[object Object]" → 解析必然失败 → 合法值被拒。
    // 所以要先判断是不是已经是非字符串。
    if (val !== null && typeof val === 'object') return null;
    try { JSON.parse(String(val)); return null; } catch (e) { return 'JSON 格式不正确'; }
  }
  if (it.type === 'text' && it.money && val && String(val).length > 200) return '过长';
  return null;
}

function set(patch) {
  const applied = [], rejected = [];
  for (const k of Object.keys(patch || {})) {
    const it = ITEMS.find(x => x.key === k);
    if (!it) { rejected.push({ key: k, error: '未登记的设置项（不在注册表里）' }); continue; }
    let v = patch[k];
    if (it.type === 'bool') {
      if (typeof v === 'string') v = /^(1|true|on|yes)$/i.test(v);
      else v = !!v;
    }
    if (it.type === 'number' && v !== '' && v !== null && v !== undefined) v = Number(v);
    const err = validate(it, v);
    if (err) { rejected.push({ key: k, label: it.label, error: err }); continue; }
    try {
      store.setSetting(k, v);
      applied.push({ key: k, label: it.label, value: it.type === 'secret' ? '(已更新)' : v });
    } catch (e) {
      rejected.push({ key: k, label: it.label, error: String(e.message || e).slice(0, 80) });
    }
  }
  if (applied.length) {
    try {
      store.push('audit', {
        action: '设置·变更',
        detail: applied.map(a => a.label + '=' + a.value).join('；'),
        at: Date.now()
      });
    } catch (e) {}
  }
  return { ok: rejected.length === 0, applied, rejected };
}

// —— 覆盖率：所有 getSetting('x') 是否都能在界面上配 ——
// 【这是本模块的核心保障】新增一个 getSetting 读取却忘了登记，
// 就会重演"alertEmail 无人能填"的老问题。这里主动扫出来。
function coverage() {
  const coreDir = path.join(__dirname);
  let files = [];
  try { files = fs.readdirSync(coreDir).filter(f => f.endsWith('.js')); } catch (e) {}
  const serverPath = path.join(coreDir, '..', 'server.js');
  const targets = files.map(f => path.join(coreDir, f)).concat(fs.existsSync(serverPath) ? [serverPath] : []);

  // 【必须剥离注释】本文件顶部的说明里就写了 `getSetting('x')` 这个例子，
  // 不剥离就会把 'x' 当成一个真实被读取的设置键，报出
  // "1 个设置项被代码读取却无法在界面配置：x" —— 纯误报，还会让真正的盲区被淹没。
  function stripComments(src) {
    let out = '', i = 0, state = 'code';
    const n = src.length;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (state === 'code') {
        if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
        if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
        if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        out += c; i++; continue;
      }
      if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
      if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; continue; } i++; continue; }
      out += c;
      if (c === '\\') { out += d; i += 2; continue; }
      if (state === 'sq' && c === "'") state = 'code';
      else if (state === 'dq' && c === '"') state = 'code';
      else if (state === 'tpl' && c === '`') state = 'code';
      i++;
    }
    return out;
  }

  const used = new Map();       // key -> [文件]
  for (const f of targets) {
    let src = '';
    try { src = stripComments(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    const re = /getSetting\(\s*['"]([\w-]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const k = m[1];
      if (!used.has(k)) used.set(k, []);
      const base = path.basename(f);
      if (!used.get(k).includes(base)) used.get(k).push(base);
    }
  }

  const registered = {};
  ITEMS.forEach(it => { registered[it.key] = it; });
  // 少数设置只存在于 store 初始化（如 theme/sound/goals），不在代码里被 getSetting 读
  const missing = [...used.keys()].filter(k => !registered[k]);
  const unused = ITEMS.filter(it => !used.has(it.key)).map(it => it.key);

  return {
    usedKeys: used.size,
    registeredKeys: ITEMS.length,
    missing,
    unused,
    rate: used.size ? Math.round((used.size - missing.length) * 100 / used.size) : 100,
    verdict: missing.length
      ? (missing.length + ' 个设置项被代码读取却无法在界面配置：' + missing.join(',')
        + ' —— 这些只能改库文件，属于管理盲区')
      : ('全部 ' + used.size + ' 个被读取的设置项都能在设置页配置（覆盖 100%）'),
    consumers: Object.fromEntries([...used.entries()].map(([k, v]) => [k, v]))
  };
}

// —— 体检：给设置页一个"现在有什么问题"的总览 ——
function health() {
  const problems = [];
  const cov = coverage();
  if (cov.missing.length) problems.push({ level: 'warn', key: 'coverage', text: cov.verdict });

  const val = k => { try { return store.getSetting(k); } catch (e) { return undefined; } };

  // 告警邮箱：这是自愈链路的最后一环
  const mail = val('alertEmail');
  if (!mail) problems.push({ level: 'warn', key: 'alertEmail', text: '未填告警收件邮箱：监控发现异常只记在本机，不会发给你' });

  // 邮件凭据（QQ 授权码）
  const hasSender = !!(process.env.MAIL_SENDER || val('mailSender'));
  const hasAuth = !!(process.env.MAIL_AUTH || val('mailAuth'));
  if (!hasSender || !hasAuth) {
    problems.push({ level: 'warn', key: 'mail', text: '邮件凭据未配置（MAIL_SENDER / MAIL_AUTH）：告警邮件发不出去' });
  }

  // 真实触达：开启后必须有通道与回复令牌，否则"自主获客"只是排计划不自转
  if (val('outreachEnabled')) {
    const hasTransport = !!(val('outreachWebhookUrl') || (val('smtpUser') && val('smtpPass')) ||
      (process.env.MAIL_SENDER && process.env.MAIL_AUTH));
    if (!hasTransport) {
      problems.push({ level: 'warn', key: 'outreachTransport', text: '已开启真实触达但未配置发送通道（webhook 或 SMTP 凭据）' });
    }
    if (!val('outreachReplyToken')) {
      problems.push({ level: 'warn', key: 'outreachReply', text: '已开启真实触达但未配置回复令牌：客户回复进不来，无法自动晋级商机候选' });
    }
  }

  // 收款信息
  if (!val('receiveAccount')) problems.push({ level: 'warn', key: 'receive', text: '未填收款账号：订阅页无法告知客户如何付款' });

  // 费率与分成之和。
  // platformFee 是阶梯对象 { revenueTiers: [{maxAnnual, pct, note}] }，
  // 取**最高档**的 pct 来做上限校验 —— 用低档校验会漏掉高收入段的超额。
  const feeRaw = val('platformFee');
  const tiers = (feeRaw && feeRaw.revenueTiers) || null;
  const fee = tiers
    ? Math.max.apply(null, tiers.map(t => Number(t.pct) || 0).concat([0]))
    : Number(feeRaw || 0);
  const share = Number(val('partnerSharePct') || 0);
  if (fee + share > 100) {
    problems.push({
      level: 'error', key: 'fee',
      text: '最高档平台费率 ' + fee + '% + 合伙人分成 ' + share + '% = ' + (fee + share) + '%，超过 100%'
    });
  }
  if (tiers && tiers.length) {
    // 阶梯必须是单调不下降的，否则会出现"收入越高抽成越低"的反直觉规则
    const pcts = tiers.map(t => Number(t.pct) || 0);
    const bad = pcts.some((v, i) => i > 0 && v < pcts[i - 1]);
    if (bad) problems.push({ level: 'warn', key: 'tiers', text: '平台费率阶梯不是单调递增：' + pcts.join('% → ') + '%，请确认是否有意为之' });
  }

  // 目标
  let goals = [];
  try { goals = require('./goals').all(); } catch (e) {}
  if (!goals.length) problems.push({ level: 'warn', key: 'goal', text: '尚未设定目标任务：指挥塔与 24h 运营没有准绳' });
  if (goals.length && !goals.some(g => g.primary)) {
    problems.push({ level: 'warn', key: 'goalPrimary', text: '有多条目标但未指定核心目标，各模块对齐时无主次' });
  }

  return {
    ok: problems.filter(p => p.level === 'error').length === 0,
    problems,
    verdict: problems.length
      ? ('发现 ' + problems.length + ' 项设置问题：'
        + problems.slice(0, 3).map(p => p.text).join('；')
        + (problems.length > 3 ? ' 等' : ''))
      : '设置完整，无待修项'
  };
}

module.exports = { GROUPS, ITEMS, list, set, validate, coverage, health, maskTail };