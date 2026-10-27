/* ============================================================
   ops.js — 运营台前端（收钱 / 退款 / 自动开通通道）
   纪律：
   - 缺数据一律显示「无数据」，绝不显示 0（别把"没数据"读成"没生意"）
   - 申请 ≠ 已退款：只有运营**真的**转账并点确认，才显示已退款
   - 没有令牌就明说"没权限"，不装作有数据
   ============================================================ */
'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  const NA = '无数据';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const token = () => { try { return (localStorage.getItem('bd_adminToken') || '').trim(); } catch (e) { return ''; } };
  const setToken = (v) => { try { localStorage.setItem('bd_adminToken', v); } catch (e) {} };

  async function api(p, opt) {
    const t = token();
    if (!t) return { ok: false, error: 'no_token', status: 0 };
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(p, Object.assign({
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': t },
        signal: ctrl.signal,
      }, opt || {}));
      clearTimeout(tm);
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok) return { ok: false, error: (j && (j.error || j.reason)) || ('HTTP ' + r.status), status: r.status };
      return j || { ok: true };
    } catch (e) {
      clearTimeout(tm);
      return { ok: false, error: 'network: ' + String(e && e.message || e).slice(0, 80), status: 0 };
    }
  }

  function money(n, cur) {
    const v = Number(n);
    if (!isFinite(v)) return NA;
    return (String(cur || 'CNY').toUpperCase() === 'USD' ? '$' : '¥') + v.toFixed(2);
  }
  function when(ts) {
    if (!ts) return NA;
    try { return new Date(Number(ts)).toLocaleString('zh-CN'); } catch (e) { return NA; }
  }
  function kpi(k, v, cls) {
    return '<div class="kpi"><div class="v ' + (cls || '') + '">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>';
  }
  function setGate(msg, cls) {
    const g = $('#gate');
    g.className = 'banner ' + (cls || 'warn');
    g.textContent = msg;
    g.hidden = !msg;
  }

  // ── 钱 ───────────────────────────────────────────────
  async function loadMoney() {
    const r = await api('/v1/subs/orders?limit=500');
    if (!r.ok) {
      $('#moneyNote').textContent = '读取失败：' + (r.error || '未知') + (r.status === 403 ? '（令牌不对或没填）' : '');
      $('#kpis').innerHTML = '';
      return r;
    }
    const orders = r.orders || [];
    const paid = orders.filter((o) => o.paid === true);
    const pending = orders.filter((o) => o.paid !== true);
    const sum = (arr) => arr.reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const byCur = {};
    for (const o of paid) {
      const c = String(o.currency || 'CNY').toUpperCase();
      byCur[c] = (byCur[c] || 0) + (Number(o.amount) || 0);
    }
    const curText = Object.keys(byCur).length
      ? Object.keys(byCur).map((c) => c + ' ' + byCur[c].toFixed(2)).join(' / ')
      : NA;
    $('#kpis').innerHTML = [
      kpi('已付订单', paid.length + ' 笔', 'ok'),
      kpi('已付金额（按订单原币种）', curText),
      kpi('待付订单', pending.length + ' 笔', pending.length ? 'warn' : 'dim'),
      kpi('待付金额', money(sum(pending), 'CNY'), pending.length ? 'warn' : 'dim'),
      kpi('订单总数', orders.length + ' 笔'),
    ].join('');
    $('#moneyNote').textContent = '订单口径（不含未入账的挂账与自测单；要精确到账口径用服务器上的商业驾驶舱）。';
    return r;
  }

  // ── 待核账 ───────────────────────────────────────────
  async function loadManual() {
    const r = await api('/v1/pay/manual-queue');
    const box = $('#manualBox');
    if (!r.ok) {
      box.innerHTML = '<div class="empty">' + NA + '：' + esc(r.error || '') + (r.status === 403 ? '（需要运营令牌）' : '') + '</div>';
      return;
    }
    const rows = r.rows || [];
    if (!rows.length) { box.innerHTML = '<div class="empty">没有待核账订单。</div>'; return; }
    box.innerHTML = '<table><thead><tr><th>订单</th><th>金额</th><th>方案</th><th>状态</th><th>凭证</th><th>剩余小时</th><th>操作</th></tr></thead><tbody>' +
      rows.map((x) => {
        const st = x.manualStatus === 'provisionally_active'
          ? '<span class="pill warn">临时通行中</span>'
          : (x.manualStatus === 'needProof' ? '<span class="pill bad">缺凭证</span>' : '<span class="pill ok">已确认</span>');
        const hours = x.hoursLeft == null ? NA : (Number(x.hoursLeft) <= 0
          ? '<span class="bad">已超时（应判定失败）</span>' : Number(x.hoursLeft).toFixed(1) + ' 小时');
        const proof = x.proofImage ? '有图' : (x.proofNote ? '有文字' : (x.proofCount ? (x.proofCount + ' 次') : '无'));
        return '<tr><td><code>' + esc(x.id) + '</code></td><td>' + esc(money(x.amount, x.currency)) + '</td><td>' + esc(x.plan || '-') +
          '</td><td>' + st + '</td><td>' + esc(proof) + '</td><td>' + hours + '</td><td>' +
          (x.paid ? '<span class="dim">已开通</span>' : '<button class="primary" data-confirm="' + esc(x.id) + '">确认到账并开通</button>') +
          '</td></tr>';
      }).join('') + '</tbody></table>';
    box.querySelectorAll('button[data-confirm]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('确认已收到订单 ' + b.dataset.confirm + ' 的转账？\n这会记账并开通订阅。')) return;
        b.disabled = true;
        const res = await api('/v1/subs/confirm', { method: 'POST', body: JSON.stringify({ orderId: b.dataset.confirm }) });
        alert(res.ok ? '已确认到账并开通。' : ('确认失败：' + (res.error || '未知')));
        await refresh();
      };
    });
  }

  // ── 待支付订单 ───────────────────────────────────────
  async function loadPending() {
    const r = await api('/v1/subs/orders?limit=500');
    const box = $('#pendingBox');
    if (!r.ok) { box.innerHTML = '<div class="empty">' + NA + '：' + esc(r.error || '') + '</div>'; return; }
    const pend = (r.orders || []).filter((o) => o.paid !== true);
    if (!pend.length) { box.innerHTML = '<div class="empty">没有待支付订单。</div>'; return; }
    box.innerHTML = '<table><thead><tr><th>订单</th><th>金额</th><th>方案</th><th>下单时间</th><th>操作</th></tr></thead><tbody>' +
      pend.slice(0, 100).map((o) => '<tr><td><code>' + esc(o.id) + '</code></td><td>' + esc(money(o.amount, o.currency)) +
        '</td><td>' + esc(o.plan || '-') + '</td><td>' + esc(when(o.at)) + '</td><td>' +
        '<button class="warn" data-confirm2="' + esc(o.id) + '">已确认收到款</button></td></tr>').join('') +
      '</tbody></table>' + (pend.length > 100 ? '<p class="note">仅显示最近 100 笔，共 ' + pend.length + ' 笔。</p>' : '');
    box.querySelectorAll('button[data-confirm2]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('确认已收到订单 ' + b.dataset.confirm2 + ' 的转账？')) return;
        b.disabled = true;
        const res = await api('/v1/subs/confirm', { method: 'POST', body: JSON.stringify({ orderId: b.dataset.confirm2 }) });
        alert(res.ok ? '已确认到账并开通。' : ('确认失败：' + (res.error || '未知')));
        await refresh();
      };
    });
  }

  // ── 退款待办 ─────────────────────────────────────────
  async function loadRefunds() {
    const r = await api('/v1/pay/refund/queue');
    const box = $('#refundBox');
    if (!r.ok) {
      box.innerHTML = '<div class="empty">' + NA + '：' + esc(r.error || '') + (r.status === 403 ? '（需要运营令牌）' : '') + '</div>';
      return;
    }
    const rows = r.rows || [];
    if (!rows.length) { box.innerHTML = '<div class="empty">没有退款申请。</div>'; return; }
    const st = r.stat || {};
    box.innerHTML = '<p class="note">待出款 <b>' + (st.pending || 0) + '</b> 笔 · 已退 <b>' + (st.refunded || 0) +
      '</b> 笔' + (st.suspicious ? ' · <span class="bad">异常 ' + st.suspicious + ' 笔（订单本身没付过钱，请人工核对）</span>' : '') + '</p>' +
      '<table><thead><tr><th>订单</th><th>金额</th><th>状态</th><th>原因</th><th>申请时间</th><th>操作</th></tr></thead><tbody>' +
      rows.map((x) => '<tr><td><code>' + esc(x.orderId) + '</code></td><td>' + esc(money(x.amount, x.currency)) +
        '</td><td>' + (x.status === 'refunded' ? '<span class="pill ok">已退款</span>' : '<span class="pill warn">待出款</span>') +
        '</td><td>' + esc(x.reason || '-') + '</td><td>' + esc(when(x.createdAt)) + '</td><td>' +
        (x.status === 'refunded'
          ? '<span class="dim">已由 ' + esc(x.paidOutBy || 'ops') + ' 于 ' + esc(when(x.paidOutAt)) + ' 确认</span>'
          : '<button class="warn" data-refund="' + esc(x.orderId) + '">我已实际转账</button>') +
        '</td></tr>').join('') + '</tbody></table>';
    box.querySelectorAll('button[data-refund]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('请确认：订单 ' + b.dataset.refund + ' 的退款**已经实际转给客户**。\n点确认会写进账本并通知客户。')) return;
        b.disabled = true;
        const res = await api('/v1/pay/refund/confirm', { method: 'POST', body: JSON.stringify({ orderId: b.dataset.refund }) });
        // 【2026-10-21】退款确认会**回收该订单带来的权益**（钱退了服务不能白用）→ 如实告诉运营回收了几份
        const revoked = (res && res.revokedEntitlements) || 0;
        alert(res.ok
          ? ('已确认出款。' + (revoked ? ('已回收该单带来的 ' + revoked + ' 份订阅权益（客户将回到免费额度）。') : '（该单未带来订阅权益，无需回收）'))
          : ('确认失败：' + (res.error || '未知')));
        await refresh();
      };
    });
  }

  // ── 自动开通通道 ─────────────────────────────────────
  async function loadChannel() {
    const r = await api('/v1/pay/auto-settle/status');
    const box = $('#chanBox');
    const note = $('#chanNote');
    if (!r.ok) {
      note.textContent = NA + '：' + (r.error || '') + (r.status === 403 ? '（需要运营令牌）' : '');
      box.innerHTML = '';
      return;
    }
    note.textContent = '通道状态（到账邮件 → 严格唯一匹配 → 自动开通；匹配不唯一/金额不符/超时间窗 → 绝不开通，转人工）';
    const st = r.status || r;
    const rows = Object.keys(st).map((k) => '<tr><td>' + esc(k) + '</td><td>' + esc(typeof st[k] === 'object' ? JSON.stringify(st[k]) : st[k]) + '</td></tr>').join('');
    // 【2026-10-21 合规可见】当前收款形态踩在哪条线上，必须让运营一眼看到：
    // 2026-05-01 起个人收款码**严禁经营性收款**；央行规定个人静态码不得用于远程非面对面收款。
    const avail = Array.isArray(st.available) ? st.available : [];
    const onlyManual = avail.length === 1 && avail[0] === 'manual';
    const compliance = onlyManual
      ? '<div class="note" style="margin-top:10px;color:var(--danger);line-height:1.8">⚠ <b>合规提示</b>：当前只有「个人收款码 + 邮件核账」通道。'
        + '按 2026-05-01 起的新规，个人收款码<b>严禁用于经营性收款</b>，且个人静态码不得用于<b>远程非面对面</b>收款；'
        + '客户远程扫码属于这一形态，存在<strong>收款功能被限制 → 到账信号断 → 自动开通整体停摆</strong>的风险。'
        + '根治路径：开<b>商户网关</b>（支付宝/微信商户号，线上可用、支持回调+查单，本项目代码已就绪）；'
        + '过渡方案：支付宝「个人经营收款码」（提现 0.1%）。详见 docs/MARKET-AND-COMPLIANCE.md。</div>'
      : '<div class="note" style="margin-top:10px;color:var(--muted);line-height:1.8">可用通道：' + esc(avail.join(', ') || '无') + '（网关通道已配置时建议做 0.01 元小额实测，回调+查单全链跑通再放量）。</div>';
    box.innerHTML = '<table><tbody>' + rows + '</tbody></table>' + compliance;
  }

  // ===== 审计结论（闭环健康度）=====
  // 纪律：缺数据显示「无数据」，不显示 0；有钱漏或墙真漏网时**明确报红**。
  async function loadAudit() {
    const box = $('#auditBox');
    const note = $('#auditNote');
    const r = await api('/v1/audit/summary');
    if (!r || r.ok === false) {
      if (box) box.innerHTML = '<div class="empty">' + NA + '</div>';
      if (note) note.textContent = (r && r.error === 'no_token') ? NA + '（未填令牌）' : ((r && r.error) || NA);
      return;
    }
    const wall = r.wall || {};
    const live = r.live || {};
    const rep = r.auditReport || null;
    const moneyLeak = rep && rep.paid_without_revenue && rep.paid_without_revenue.length ? rep.paid_without_revenue.length : 0;
    const leak = Number(wall.uncoveredCount || 0);
    const bad = moneyLeak > 0 || leak > 0;
    const q = (r.queues && r.queues.meta) || {};
    const rows = [
      ['审计门禁', rep ? (moneyLeak > 0 ? '❌ 钱漏 ' + moneyLeak + ' 笔' : '✅ 通过（无钱漏）') : NA + '（首次巡检前）'],
      ['收费墙真漏网', leak > 0 ? '❌ ' + leak + ' 个端点' : '✅ 0 个（覆盖 ' + (wall.rate != null ? wall.rate + '%' : NA) + '）'],
      ['真实到账', live.revenueRealRecords != null ? (live.revenueRealAmount + ' 元 / ' + live.revenueRealRecords + ' 笔') : NA],
      ['已作废虚拟单', live.voidedVirtual != null ? (live.voidedVirtual + ' 笔') : NA],
      ['工作流队列', q.dropped != null ? ('拒收 ' + q.dropped + ' · 淘汰 ' + (q.evicted || 0) + ' · 已消费 ' + (q.compacted || 0)) : NA],
    ];
    if (box) {
      box.innerHTML = '<table><tbody>' + rows.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</tbody></table>';
    }
    if (note) {
      note.textContent = bad
        ? '⚠ 有需要处理的项（钱漏 / 收费墙漏网），详情见 data/runtime/audit_latest.json 与对账器。'
        : '✅ 闭环健康：钱账一致、墙无漏网。';
      note.style.color = bad ? 'var(--danger)' : 'var(--muted)';
    }
  }

  // ===== 协助队列（2026-10-23）=====
  // 客户主动发起 + 勾同意书；运营在这里接单/归档。全程审计，不含屏幕控制。
  async function loadAssist() {
    const box = $('#assistBox');
    const note = $('#assistNote');
    if (!box) return;
    const r = await api('/v1/assist/queue');
    if (!r || r.ok === false) {
      box.innerHTML = '<div class="empty">' + NA + '</div>';
      if (note) note.textContent = (r && r.error) ? ('读取失败：' + r.error) : NA;
      return;
    }
    const items = r.items || [];
    if (note) {
      note.textContent = '待接单 ' + (r.requested || 0) + ' · 处理中 ' + (r.accepted || 0)
        + ' · 超 30 分钟 ' + (r.overdue || 0)
        + '（' + (r.mode === 'coordination-only' ? '协调通道，不含屏幕控制' : '') + '）';
      note.style.color = r.overdue ? 'var(--warn)' : 'var(--dim)';
    }
    if (!items.length) { box.innerHTML = '<div class="empty">当前没有协助请求。</div>'; return; }
    const rows = items.map((a) => {
      const st = a.status === 'requested' ? (a.overdue ? '⚠ 待接单(超时)' : '待接单')
        : a.status === 'accepted' ? '处理中' : a.status;
      const act = a.status === 'requested'
        ? '<button data-act="accept" data-id="' + esc(a.id) + '" class="primary">接单</button>'
        : (a.status === 'accepted'
          ? '<button data-act="complete" data-id="' + esc(a.id) + '" class="primary">完成归档</button>'
          : '<span class="dim">—</span>');
      return '<tr><td>' + esc(st) + '</td><td>' + esc(a.visitor) + '</td><td>' + esc(a.topic)
        + '<div class="dim">' + esc(a.scope) + (a.contact ? ' · ' + esc(a.contact) : '') + '</div></td>'
        + '<td>' + esc(a.opsName || NA) + '</td><td>' + (a.ageMin != null ? esc(a.ageMin + ' 分钟') : NA) + '</td><td>' + act + '</td></tr>';
    }).join('');
    box.innerHTML = '<table><thead><tr><th>状态</th><th>客户</th><th>问题 / 范围</th><th>处理人</th><th>已等待</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    box.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        const id = b.getAttribute('data-id');
        const act = b.getAttribute('data-act');
        let r2;
        if (act === 'accept') r2 = await api('/v1/assist/accept', { method: 'POST', body: JSON.stringify({ id, opsName: '运营台' }) });
        else {
          const noteText = prompt('处理结论（客户可见，写清楚做了什么）', '已联系客户并解决') || '';
          if (!noteText) { b.disabled = false; return; }
          r2 = await api('/v1/assist/complete', { method: 'POST', body: JSON.stringify({ id, note: noteText }) });
        }
        if (!r2 || r2.ok === false) alert('操作失败：' + ((r2 && r2.error) || '未知'));
        loadAssist();
      };
    });
  }

  // ===== 订阅闭环体检（2026-10-23）=====
  async function loadLoop() {
    const box = $('#loopBox');
    const note = $('#loopNote');
    if (!box) return;
    const r = await api('/v1/loop/saas');
    if (!r || r.ok === false) {
      box.innerHTML = '<div class="empty">' + NA + '</div>';
      if (note) note.textContent = (r && r.error) ? ('读取失败：' + r.error) : NA;
      return;
    }
    const f = r.funnel || {};
    const s = r.stickiness || {};
    const stages = (f.stages || []).map((x) => {
      const c = x.conversionPct == null ? '—' : (x.conversionPct + '%');
      return '<div class="kpi"><div class="v">' + esc(x.count) + '</div><div class="k">' + esc(x.name)
        + (x.denominator ? ' · <span class="dim">' + esc(c) + '</span>' : '') + '</div></div>';
    }).join('');
    const checks = (r.integrity && r.integrity.checks || []).filter((c) => c.count > 0);
    const checkRows = checks.length
      ? checks.map((c) => '<tr><td><span class="pill ' + (c.severity === 'high' ? 'bad' : 'warn') + '">'
        + esc(c.severity) + '</span></td><td>' + esc(c.title) + '</td><td>' + esc(c.count)
        + '</td><td>' + esc(c.action) + '</td></tr>').join('')
      : '<tr><td colspan="4" class="ok">✅ 无断裂：付钱有权益、开通有使用、无悬挂队列。</td></tr>';
    box.innerHTML = '<div class="kpis">' + stages + '</div>'
      + '<table><thead><tr><th>级别</th><th>断裂</th><th>条数</th><th>处置</th></tr></thead><tbody>' + checkRows + '</tbody></table>';
    if (note) {
      note.textContent = (r.nextAction || '') + ' ｜ 活跃（7日）' + (s.wau == null ? NA : s.wau)
        + ' · 付费活跃率 ' + (s.paidActivePct == null ? NA : s.paidActivePct + '%')
        + ' · 沉默付费客户 ' + (s.dormantPaid == null ? NA : s.dormantPaid);
      note.style.color = (r.integrity && !r.integrity.healthy) ? 'var(--warn)' : 'var(--dim)';
    }
  }

  async function refresh() {
    if (!token()) {
      setGate('先填运营令牌：资金类接口（确认到账 / 退款出款 / 核账台）必须带令牌，回环也不例外。', 'warn');
      $('#moneyNote').textContent = NA + '（未填令牌）';
      $('#kpis').innerHTML = '';
      $('#manualBox').innerHTML = '<div class="empty">' + NA + '</div>';
      $('#pendingBox').innerHTML = '<div class="empty">' + NA + '</div>';
      $('#refundBox').innerHTML = '<div class="empty">' + NA + '</div>';
      $('#chanNote').textContent = NA + '（未填令牌）';
      $('#chanBox').innerHTML = '';
      if ($('#auditBox')) $('#auditBox').innerHTML = '<div class="empty">' + NA + '</div>';
      if ($('#auditNote')) $('#auditNote').textContent = NA + '（未填令牌）';
      if ($('#assistBox')) $('#assistBox').innerHTML = '<div class="empty">' + NA + '（未填令牌）</div>';
      if ($('#assistNote')) $('#assistNote').textContent = NA + '（未填令牌）';
      if ($('#loopBox')) $('#loopBox').innerHTML = '<div class="empty">' + NA + '（未填令牌）</div>';
      if ($('#loopNote')) $('#loopNote').textContent = NA + '（未填令牌）';
      return;
    }
    setGate('', 'ok');
    await Promise.all([loadMoney(), loadManual(), loadPending(), loadRefunds(), loadChannel(), loadAssist(), loadLoop(), loadAudit()]);
    setGate('已连接（数据来自站点实时账本）。', 'ok');
  }

  $('#saveTok').onclick = () => {
    const v = $('#tok').value.trim();
    if (!v) return alert('请粘贴运营令牌');
    setToken(v);
    refresh();
  };
  $('#refresh').onclick = refresh;
  $('#tok').value = token();

  window.OPS = { refresh, api, token };
  refresh();
})();
