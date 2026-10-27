// core/payout.js — 收款账户权威配置 + 付款指令生成
//
// 存在的原因：付款指令此前是手写文件，漏掉了网点号与银行机构代码。
// 跨行/柜台汇款缺这两项，轻则汇款被退回，重则钱到了但流水对不上订单号，
// 结果就是「客户说付了、我方显示未到账」——最难自证的一类纠纷。
//
// 纪律：
//   1. 收款信息只存在一份（data/payout.json，data/ 已被 .gitignore 排除，不入库）。
//      代码里不硬编码卡号，避免密钥/账户随提交外泄。
//   2. 生成前做完整性校验：缺网点号/机构代码直接拒绝生成，不产出半份指令。
//   3. 指令必须带订单号与金额，作为对账锚点。
//   4. 本模块只生成「付款信息」。它不证明钱已到账 —— 到账确认只由 money.settle()
//      凭回单执行。生成指令 ≠ 收款。

const fs = require('fs');
const path = require('path');
const store = require('./store');

// 【2026-09】asar 内不可写，改走统一可写数据目录
const ASSET_DIR = store.dataPath('assets');
const CONFIG_PATH = path.join(store.dataPath(), 'payout.json');

// 必填字段：缺任一项都不允许生成指令
const REQUIRED = ['bank', 'account', 'holder', 'branchCode', 'institutionCode'];
const FIELD_LABEL = {
  bank: '开户银行',
  account: '银行账号',
  holder: '开户姓名',
  branchCode: '网点号',
  institutionCode: '银行机构代码',
  branchName: '网点名称',
  branchAddress: '网点地址'
};

function config() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// 脱敏视图：可用于日志/接口回显，绝不返回完整卡号
function masked() {
  const c = config();
  if (!c) return null;
  const a = String(c.account || '');
  return {
    bank: c.bank,
    holder: c.holder,
    accountMasked: a.length >= 8 ? a.slice(0, 4) + ' **** ' + a.slice(-4) : '****',
    branchCode: c.branchCode,
    institutionCode: c.institutionCode,
    branchName: c.branchName,
    complete: REQUIRED.every(k => !!String(c[k] || '').trim())
  };
}

// 买家视图：付款指令就是要让买家看到完整卡号，否则他没法转账。
// 与 masked() 的区别是刻意的：这里不是日志回显，是交付给付款人。
// 配置不完整时返回 ok:false —— 不能交付半份信息让买家照着填然后失败。
function buyerDetails() {
  const v = validate();
  if (!v.ok) return v;
  const c = v.config;
  return {
    ok: true,
    bank: c.bank,
    account: c.account,
    holder: c.holder,
    branchCode: c.branchCode,
    institutionCode: c.institutionCode,
    branchName: c.branchName || '',
    branchAddress: c.branchAddress || '',
    alipay: c.alipay || ''
  };
}

// 校验配置完整性 —— 返回缺失字段列表
function validate() {
  const c = config();
  if (!c) return { ok: false, error: '未配置收款账户：' + CONFIG_PATH + ' 不存在或不是合法 JSON' };
  const missing = REQUIRED.filter(k => !String(c[k] || '').trim());
  if (missing.length) {
    return {
      ok: false,
      error: '收款配置不完整，缺：' + missing.map(k => FIELD_LABEL[k] + '(' + k + ')').join('、')
        + '。跨行/柜台汇款缺网点号与机构代码会导致退回或流水对不上号，不予生成指令',
      missing
    };
  }
  return { ok: true, config: c };
}

// 保存配置（写本地 data/，不入库）
// 注意：不能用 validate() 来校验「待写入」的对象 —— 它读的是磁盘上的旧文件，
// 那样会拿旧配置的完整度去放行新配置。这里直接对入参做字段校验。
function save(obj) {
  const c = Object.assign({}, obj || {});
  REQUIRED.forEach(k => { if (c[k] !== undefined) c[k] = String(c[k]).trim(); });
  const missing = REQUIRED.filter(k => !String(c[k] || '').trim());
  if (missing.length && !(obj && obj.__force)) {
    return {
      ok: false,
      error: '配置不完整，缺：' + missing.map(k => FIELD_LABEL[k] + '(' + k + ')').join('、'),
      missing
    };
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
  return { ok: true, saved: true, missing, masked: masked() };
}

const yuan = n => '¥' + (Math.round(Number(n) * 100) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 });

// 生成付款指令 Markdown：买家可直接照着填
function instruction(order) {
  const v = validate();
  if (!v.ok) return v;
  const c = v.config;
  const revId = String((order && order.revId) || '').trim();
  const amt = Number(order && order.amt);
  if (!revId) return { ok: false, error: '缺少订单号（revId）：没有订单号无法对账' };
  if (!(amt > 0)) return { ok: false, error: '金额必须 > 0' };
  const title = String((order && order.title) || '定制服务').slice(0, 80);
  const from = String((order && order.from) || '').trim();

  const rows = REQUIRED.concat(['branchName', 'branchAddress'])
    .filter(k => k !== 'branchName' || c.branchName)
    .filter(k => k !== 'branchAddress' || c.branchAddress)
    .map(k => '| ' + FIELD_LABEL[k] + ' | ' + String(c[k]) + ' |');

  const md = [
    '# 付款指令 · ' + title,
    '',
    '## 汇款金额',
    '',
    '请按 **' + yuan(amt) + '** 汇款（人民币，**不要**多汇零头，尾数对不上会难以核销）',
    '',
    '## 收款信息',
    '',
    '| 项目 | 内容 |',
    '|---|---|',
    ...rows,
    '',
    '## 关键：汇完必做两步',
    '',
    '1. 拍一张转账成功截图（含付款方姓名、金额、时间、流水号）',
    '2. 备注里写上订单号 **' + revId + '**',
    '',
    '两步缺一，我方无法确认到账，订单会一直挂在「待到账」。',
    '',
    '## 订单信息',
    '',
    '| 项目 | 内容 |',
    '|---|---|',
    '| 订单号 | ' + revId + ' |',
    '| 金额 | ' + yuan(amt) + ' |',
    '| 事由 | ' + title + ' |',
    ...(from ? ['| 付款方 | ' + from + ' |'] : []),
    '',
    '---',
    '',
    '## 状态说明（避免误会）',
    '',
    '- 发出本指令 **不等于** 收款完成。我方账上会先记为「待到账」。',
    '- 只有在银行流水中**实际看到这笔钱**，我方才把它转为「已收」并计入 KPI。',
    '- 若超过约定天数仍未到账，该笔会从「待到账」转为「核销」，并在应收台账里留痕。',
    '- 核销不等于成交被抹掉，只是确认这笔钱收不回；订单历史仍可查。',
    ''
  ].join('\n');

  const file = path.join(ASSET_DIR, '付款指令_' + revId + '.md');
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  fs.writeFileSync(file, md, 'utf8');
  store.push('audit', { action: '生成付款指令', detail: revId + ' ' + yuan(amt) + ' → ' + path.basename(file), at: Date.now() }, null, null);
  return { ok: true, file, revId, amt, masked: masked() };
}

// 列出所有待到账订单及其指令状态
function pendingList() {
  const rows = store.list('revenue').filter(r => !money_isSettled(r) && r.status !== 'written_off');
  return rows.map(r => ({
    revId: r.id, amt: r.amt, at: r.at,
    instruction: fs.existsSync(path.join(ASSET_DIR, '付款指令_' + r.id + '.md'))
  }));
}

function money_isSettled(r) {
  if (!r) return false;
  if (r.settled === true) return true;
  if (r.settled === false) return false;
  const s = String(r.status || '').toLowerCase();
  return s === 'paid' || s === 'settled' || s === 'received';
}

// 催款函：账已确认成交、资金未到账时发给买家
// 纪律：
//   1. 必须从权威配置取收款信息，不手写 —— 手写正是当初漏网点号的原因。
//   2. 必须带订单号作为对账锚点，否则钱到了也认不出是谁的。
//   3. 只陈述事实（已确认成交 / 未收到款 / 逾期天数），不编造违约金、利息、
//      诉讼等不存在的约定，也不威胁客户。
//   4. 主动给出多种付款方式与「已付但我方没收到」的申诉通道 —— 催款函的目的
//      是把钱要回来，不是把关系搞僵。若对方其实付了（流水对不上），这封信是
//      帮他补回单的台阶。
function dunningLetter(order) {
  const v = validate();
  if (!v.ok) return v;
  const c = v.config;
  const revId = String((order && order.revId) || '').trim();
  if (!revId) return { ok: false, error: '缺少订单号（revId）：催款函必须可对账' };
  const amt = Number(order && order.amt);
  if (!(amt > 0)) return { ok: false, error: '金额必须 > 0' };

  const payer = String((order && order.payer) || '').trim() || '客户';
  const subject = String((order && order.title) || '定制服务').slice(0, 80);
  const round = Math.max(1, Number(order && order.round) || 1);
  const overdueDays = Number(order && order.overdueDays) || 0;
  const lastNote = String((order && order.lastContact) || '').trim();

  const dl = overdueDays > 0
    ? '距约定付款日已过去 ' + overdueDays + ' 天。'
    : '目前尚未收到款项。';

  const md = [
    '# 付款提醒（第 ' + round + ' 次）· ' + subject,
    '',
    '致 ' + payer + '：',
    '',
    '关于「' + subject + '」，我们需要确认一项付款状态。',
    '',
    '## 当前状态',
    '',
    '| 项目 | 内容 |',
    '|---|---|',
    '| 订单号 | ' + revId + ' |',
    '| 约定金额 | ' + yuan(amt) + ' |',
    '| 成交确认 | 已确认 |',
    '| 到账状态 | **未收到** |',
    '',
    dl,
    '',
    '我方账面已确认这笔成交，但银行账户尚未收到对应款项，因此订单仍停留在「待到账」。',
    '',
    '## 如果你已付款',
    '',
    '**这封信不是说你没付。** 如果你已经转了款，只是我方流水没识别到（金额零头不同、'
      + '转错账户、跨行延迟等都很常见），请直接把下面两样发给我，10 分钟内核对完给你确认：',
    '',
    '1. 转账截图（含付款方姓名、金额、时间、流水号）',
    '2. 银行 App 里的转账详情页',
    '',
    '## 如果还没付，付款信息如下',
    '',
    '| 项目 | 内容 |',
    '|---|---|',
    '| 金额 | ' + yuan(amt) + '（请勿多汇零头） |',
    ...REQUIRED.map(k => '| ' + FIELD_LABEL[k] + ' | ' + String(c[k]) + ' |'),
    ...(c.branchName ? ['| 网点名称 | ' + c.branchName + ' |'] : []),
    ...(c.branchAddress ? ['| 网点地址 | ' + c.branchAddress + ' |'] : []),
    ...(c.alipay ? ['| 支付宝 | ' + c.alipay + ' |'] : []),
    '',
    '**汇款时请在备注写上订单号 ' + revId + '**，这能让我们对账时一眼认出来。',
    '跨行或柜台汇款请一并填写**网点号 ' + c.branchCode + '** 与**机构代码 ' + c.institutionCode
      + '**，否则可能被退回。',
    '',
    '## 关于这笔订单',
    '',
    '- 交付不会因为催促而中断，款项到账后我们继续按约定推进。',
    '- 若你这边有付款困难或需要分期，请直接说，我们商量一个你能做到的时间表，'
      + '而不是让这笔单子一直悬着。',
    ...(lastNote ? ['- 上次沟通：' + lastNote.slice(0, 120)] : []),
    '',
    '有任何问题直接回这封信。',
    '',
  ].join('\n');

  const file = path.join(ASSET_DIR, '催款函_' + revId + '_第' + round + '次.md');
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  fs.writeFileSync(file, md, 'utf8');
  store.push('audit', {
    action: '生成催款函',
    detail: revId + ' ' + yuan(amt) + ' 第' + round + '次 → ' + path.basename(file),
    at: Date.now()
  }, null, null);
  return { ok: true, file, revId, amt, round, overdueDays };
}

module.exports = { REQUIRED, FIELD_LABEL, config, masked, buyerDetails, validate, save, instruction, dunningLetter, pendingList, ASSET_DIR, CONFIG_PATH };
