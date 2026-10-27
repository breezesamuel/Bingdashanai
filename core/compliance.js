// core/compliance.js — 出海合规声明与自查（PCI-DSS / GDPR / CAN-SPAM / 税务KYC）
//
// 【为什么单独一个模块】合规条款散在各处（gtm 里一句 CAN-SPAM、partner 里一段反传销、
// subs 里一句人工把关）是**给代码读者看**的；用户和审计面对的是**界面上有没有明示**。
// 本模块把"该告诉用户的、该自查看有没有做到的"集中成可查询、可断言的一份清单：
//   · 前端页面（收银台/分润/触达/线索）按 context 位取对应声明直接展示
//   · auditSelfCheck() 返回当前实现与条款的差距，缺口如实上报而非假装合规
//
// 红线：不承诺做不到的事。查不到凭证/没落地的机制，一律标 unmet 而不是手写"合规"。

const store = require('./store');

// ===== 1. 声明位：每条 = 一个法规域 × 一个适用场景 =====
const CLAUSES = [
  {
    id: 'pci-dss-no-card',
    frame: 'PCI-DSS v4.0',
    context: 'payment',
    title: '卡数据不落库',
    body: '本系统不存储、不传输完整银行卡号与 CVV。在线支付由持牌通道（支付宝/PayPal/MoltSpay）托管，卡信息直接进入通道侧，本系统只接收支付结果回调。',
    evidence: 'server.js /v1/pay/* 只处理订单与回调，不设 card 字段'
  },
  {
    id: 'gdpr-dpa',
    frame: 'GDPR Art.28',
    context: 'payment',
    title: '数据处理协议（DPA）',
    body_cn: '跨境处理个人数据前，您可作为数据控制者与我们签署 DPA，明确处理目的、期限、子处理者清单与协助义务。',
    body_en: 'Before cross-border processing of personal data, you (as controller) may sign a DPA with us defining purpose, retention, sub-processors and assistance obligations.',
    evidence: '模板待法务出具；当前代码未内置生成器 → unmet'
  },
  {
    id: 'gdpr-erasure',
    frame: 'GDPR Art.17',
    context: 'lead',
    title: '被遗忘权（删除/匿名化）',
    body: '您可要求删除或匿名化某条线索的全部个人数据（姓名/联系方式/对话记录）。我们按"先匿名化、保留统计口径"执行，确保已成交的财务凭证不被破坏。',
    endpoint: '/v1/privacy/erase',
    evidence: 'privacy.js erasure() 已落地'
  },
  {
    id: 'gdpr-breach-notice',
    frame: 'GDPR Art.33',
    context: 'global',
    title: '数据泄露 72 小时通报',
    body: '发生个人数据泄露时，我们将在知悉后 72 小时内向监管机构通报，并向受影响用户告知。',
    evidence: '流程待演练；代码未内置时钟 → unmet'
  },
  {
    id: 'canspam-optout',
    frame: 'CAN-SPAM / GDPR Art.21',
    context: 'outreach',
    title: '一键退订与拒收',
    body: '每封外发邮件/消息均带退订入口。用户退订后该渠道立即静默，不再触达，且留审计记录。中国境内同步遵守《互联网电子邮件服务管理办法》。',
    evidence: 'outreach.js OPT_OUT 常量 + ingestReply(optout) 已落地'
  },
  {
    id: 'canspam-honest-subject',
    frame: 'CAN-SPAM §5(a)',
    context: 'outreach',
    title: '标题与内容一致',
    body: '外发主题必须真实反映内容，不使用欺骗性标题、伪造发件人。系统模板的 subject 直接取自触达意图，不走"诱导点击"改写。',
    evidence: 'outreach.js compose() 的 subject 由模板生成，已审查无诱导词'
  },
  {
    id: 'partner-kyc',
    frame: '反洗钱 / 税务申报',
    context: 'partner',
    title: '合伙人身份与税务',
    body: '合伙人分润前须完成身份核验（KYC）并留存税务资料；分润记录按当地要求代扣代缴或出具凭证。单层分润，绝不向下穿透。',
    evidence: 'partner.js 已拒绝多层计酬；KYC 登记入口待补 → partial'
  },
  {
    id: 'anti-mlm',
    frame: '《禁止传销条例》',
    context: 'partner',
    title: '单层封顶·零入门费',
    body: '分润只认"该笔真实成交"的唯一直接服务人，禁止任何基于下线/上级业绩的层级计酬；注册不收取任何入门费、资格费。',
    evidence: 'partner.js rejectMultilevel() + entryFee=0 均已落地'
  },
  {
    id: 'consumer-refund',
    frame: '消费者权益保护法',
    context: 'payment',
    title: '退款与售后通道',
    body: '买家可在工单发起退款，需提供订单号与凭证；系统真实冲减营收并回退推广费计提，整过程留审计。平台不设置"一经售出不退"条款。',
    evidence: 'money.refund() / tickets.refund 已落地'
  }
];

// ===== 2. 按场景取声明（前端页脚/支付页/触达页/分润页直接渲染）=====
function disclosuresFor(context) {
  const ctx = String(context || 'global');
  const list = CLAUSES.filter(c => c.context === ctx || c.context === 'global');
  return {
    ok: true, context: ctx,
    items: list.map(c => ({
      id: c.id, frame: c.frame, title: c.title,
      body: c.body_cn || c.body || '',
      body_en: c.body_en || '', endpoint: c.endpoint || null,
      status: statusOf(c.id)
    }))
  };
}

// ===== 3. 落地状态：抽查实现，不自己宣称合规 =====
function statusOf(clauseId) {
  switch (clauseId) {
    case 'gdpr-erasure': {
      try {
        const p = require('./privacy');
        return typeof p.erasure === 'function' ? 'met' : 'unmet';
      } catch (e) { return 'unmet'; }
    }
    case 'canspam-optout': {
      const O = require('./outreach');
      return (O.OPT_OUT && typeof O.ingestReply === 'function') ? 'met' : 'unmet';
    }
    case 'anti-mlm':
    case 'partner-kyc': {
      const P = require('./partner');
      return (typeof P.rejectMultilevel === 'function') ? (clauseId === 'anti-mlm' ? 'met' : 'partial') : 'unmet';
    }
    case 'pci-dss-no-card': {
      // 抽查 pay 模块是否暴露任何卡字段
      const src = require('fs').readFileSync(require('path').join(__dirname, 'pay.js'), 'utf8');
      const leak = /(?:cardNo|cvv|pan)\s*[:=]/i.test(src);
      return leak ? 'unmet' : 'met';
    }
    case 'consumer-refund': {
      try {
        const m = require('./money');
        return typeof m.refund === 'function' ? 'met' : 'unmet';
      } catch (e) { return 'unmet'; }
    }
    default:
      return 'unmet'; // 声明存在但无自动判据 → 如实标未落地
  }
}

// ===== 4. 自审清单：把差距摆出来，供前端"合规体检"面板展示 =====
function auditSelfCheck() {
  const byFrame = {};
  CLAUSES.forEach(c => {
    if (!byFrame[c.frame]) byFrame[c.frame] = { frame: c.frame, met: 0, partial: 0, unmet: 0 };
    const s = statusOf(c.id);
    byFrame[c.frame][c.id === 'partner-kyc' ? 'partial' : s]++;
  });
  const rows = Object.values(byFrame).map(f => ({
    frame: f.frame,
    met: f.met, partial: f.partial, unmet: f.unmet,
    verdict: f.unmet === 0 && f.partial === 0 ? 'fully-declared'
      : (f.met + f.partial > 0 ? 'partial' : 'declared-not-implemented')
  }));
  return {
    ok: true,
    generatedAt: Date.now(),
    frames: rows,
    // 未落地项 == 缺口清单，而不是"合规已覆盖"
    gaps: CLAUSES.filter(c => statusOf(c.id) === 'unmet').map(c => ({
      id: c.id, frame: c.frame, title: c.title, note: c.evidence || ''
    })),
    honesty: '未落地项已如实列出；met 表示有可自动判据支撑，不代表法务意见。'
  };
}

module.exports = { CLAUSES, disclosuresFor, auditSelfCheck, statusOf };