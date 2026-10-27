/* ============================================================
   biz.js — 商业中枢前端（订阅/收费墙 / 排行榜 / 24h监控 / 半年千万KPI）
   三语：zh / en / ar；科幻主题联动 app.js THEMES['scifi']。
   访客身份：localStorage bd_visitor；内容端点 10 次免费后弹收费墙。
   ============================================================ */
'use strict';

const BIZ = (() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const api = async (path, opt) => {
    // 统一护栏：12s 超时 + 网络失败节流提示（不吞错）；失败返回空态代理，深层访问永不抛错
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 12000);
    const safeEmpty = () => new Proxy(function () {}, { get: () => safeEmpty() });
    // 运营令牌透传：非回环部署（云服务器）资金/凭据类接口必须带 X-Admin-Token，
    // 否则 adminAuthed 会 403。回环时服务端放行，带上也不影响。
    let _t = null;
    try { _t = localStorage.getItem('bd_adminToken'); } catch (e) { _t = null; }
    const hdrs = { 'Content-Type': 'application/json', 'X-Visitor': vid() };
    if (_t) hdrs['X-Admin-Token'] = _t;
    try {
      const r = await fetch(path, Object.assign({ headers: hdrs, signal: ctrl.signal }, opt));
      clearTimeout(tm);
      return r.json().catch(() => safeEmpty());
    } catch (e) {
      clearTimeout(tm);
      bErr();
      return safeEmpty();
    }
  };
  let _bErr = 0;
  function bErr() {
    const now = Date.now();
    if (now - _bErr < 2000) return;
    _bErr = now;
    toast('⚠️ 服务连接异常，请重试', 'bad');
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString('zh-CN', { hour12: false });
  const loc = { CN: 'zh', US: 'en', AE: 'ar' };

  // —— 访客身份（持久，同一浏览器同一人）——
  function vid() {
    let v = localStorage.getItem('bd_visitor');
    if (!v) { v = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('bd_visitor', v); }
    return v;
  }

  // —— 三语词典 ——
  const I18N = {
    zh: { free: '免费次数', wallT: '🔒 免费次数已用完', wallM: '订阅后解锁全部功能。支持微信 / 支付宝，入账一律进支付宝。', later: '再逛逛', subNow: '订阅解锁' },
    en: { free: 'Free uses left', wallT: '🔒 Free quota used up', wallM: 'Subscribe to unlock everything. WeChat / Alipay accepted; all revenue settles to Alipay.', later: 'Browse more', subNow: 'Subscribe to unlock' },
    ar: { free: 'الاستخدامات المجانية المتبقية', wallT: '🔒 انتهت الاستخدامات المجانية', wallM: 'اشترك لفتح كل المزايا. يقبل WeChat / Alipay، وكل الإيرادات تُحصّل في Alipay.', later: 'تصفح أكثر', subNow: 'اشترك الآن' }
  };
  const curLang = () => {
    const v = ($('#langSel') && $('#langSel').value) || 'zh';
    return loc[v] || 'zh';
  };
  const T = k => (I18N[curLang()] || I18N.zh)[k] || I18N.zh[k] || k;

  // ===== 收费墙弹窗 =====
  let wallPlan = null;
  function showWall(plans) {
    $('#wallPlans').innerHTML = (plans && plans.CN ? plans.CN : []).map(p =>
      '<div class="subs-card" data-plan="' + p.id + '"><div>' + esc(p.label + ' · ' + (plans.EN.find(x => x.id === p.id) || {}).label + '') + '</div>' +
      '<div class="sc-price">¥' + p.amount + ' / $' + ((plans.EN.find(x => x.id === p.id) || {}).amount || 0) + '</div>' +
      '<div class="sc-term">' + esc(p.en || '') + '</div></div>').join('');
    $('#wallTitle').textContent = T('wallT');
    $('#wallMsg').textContent = T('wallM');
    $('#wallLater').textContent = T('later');
    [...$('#wallPlans').querySelectorAll('.subs-card')].forEach(c => {
      c.onclick = () => {
        wallPlan = c.dataset.plan;
        [...$('#wallPlans').querySelectorAll('.subs-card')].forEach(x => x.classList.remove('cur'));
        c.classList.add('cur');
        subscribe(wallPlan);
      };
    });
    $('#wallOverlay').hidden = false;
    setTimeout(() => { if ($('#subsQuotaCard')) refreshSubs(); }, 300);
  }
  function hideWall() { $('#wallOverlay').hidden = true; }
  $('#wallLater').onclick = hideWall;

  // ===== 订阅下单（真实收款：网关二维码/跳转 或 收款码+人工确认 → 运营核验到账后自动激活）=====
  let _payPoll = null;
  // 当前订单可用的支付方式（买家在弹窗里可切换）
  let _payModes = [];
  async function subscribe(plan) {
    const o = await api('/v1/subs/order', { method: 'POST', body: JSON.stringify({ plan, lang: curLang() }) });
    if (!o.order) return toast('下单失败：' + (o.error || '未知'), 'bad');
    const p = o.order;
    const po = document.getElementById('payOverlay');
    const paidBox = document.getElementById('payPaid'); if (paidBox) paidBox.hidden = true;
    if (po) po.hidden = false;
    document.getElementById('payPlan').textContent = '订阅 ' + p.amount + ' ' + p.currency + '（' + p.plan + ' 计划）';
    document.getElementById('payOrderId').textContent = p.id;
    _payModes = [];
    // 尝试网关结账：返回 内嵌付款码/跳转/表单/手动 四种动作
    let pw = null;
    try { pw = await api('/v1/pay/checkout', { method: 'POST', body: JSON.stringify({ orderId: p.id, plan: p.plan, amount: p.amount, currency: p.currency }) }); } catch (e) {}
    const act = pw && pw.action ? pw.action : null;
    // 通道状况：买家据此知道还能用什么方式付（如实展示，不虚假承诺）
    let chans = null;
    try { chans = await api('/v1/pay/channels'); } catch (e) {}
    const qrBox = document.getElementById('payQr');
    qrBox.innerHTML = '';

    // —— 内嵌付款码渲染：Data URL 直接进 <img>，不走静态路径 ——
    const qrImg = (src, size) => '<img src="' + esc(src) + '" alt="付款码" style="width:' + (size || 220) + 'px;height:' + (size || 220) + 'px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:6px;display:block">';
    const chanTabs = (list, active, onPick) => '<div style="display:flex;justify-content:center;gap:6px;margin:6px 0;flex-wrap:wrap">'
      + list.map(x => '<button class="btn small ' + (x.key === active ? '' : 'ghost') + '" data-paymode="' + esc(x.key) + '">' + esc(x.label) + '</button>').join('')
      + '</div>';

    if (pw && pw.ok && pw.mode === 'gateway' && (pw.qrData || pw.payUrl)) {
      // —— 网关模式（PayPal / Moltspay）：服务端生成的付款码，扫码或点击前往支付 ——
      const gwName = pw.channel === 'paypal' ? 'PayPal' : (pw.gateway === 'moltspay' ? 'Moltspay' : '在线支付');
      const gws = [];
      if (pw.channel === 'paypal') gws.push({ key: 'paypal', label: 'PayPal' });
      else if (pw.channel === 'moltspay') gws.push({ key: 'moltspay', label: 'Moltspay' });
      _payModes = gws;
      document.getElementById('payAccount').textContent = gwName;
      qrBox.innerHTML = chanTabs(gws, pw.channel, null)
        + '<div style="display:flex;justify-content:center;margin-top:4px">' + qrImg(pw.qrData || pw.payUrl) + '</div>'
        + '<div class="sub" style="text-align:center;margin-top:6px">用手机扫一扫付款；或在电脑上点【前往支付】完成付款。</div>';
      const go = document.createElement('button');
      go.className = 'btn primary'; go.style.marginTop = '8px';
      go.textContent = '前往支付（' + gwName + '）';
      go.onclick = () => { if (pw.payUrl) window.open(pw.payUrl, '_blank', 'noopener'); };
      qrBox.appendChild(go);
      document.getElementById('payHint').textContent = '付款成功后自动回到本页，订阅即时开通（每 5 秒自动检测）。';
    } else if (act && act.type === 'redirect' && act.url) {
      document.getElementById('payAccount').textContent = 'PayPal';
      document.getElementById('payHint').textContent = '点击【前往支付】跳转 PayPal 安全结账，完成后自动回到本页。';
      const btn = document.createElement('button'); btn.className = 'btn primary'; btn.style.marginTop = '8px';
      btn.textContent = '前往支付'; btn.onclick = () => { window.location.href = act.url; };
      qrBox.appendChild(btn);
    } else if (act && act.type === 'form' && act.html) {
      // 支付宝表单：新窗口提交收银台（HTML 表单自含跳转脚本）
      const w = window.open('', '_blank', 'width=900,height=700');
      if (w) { w.document.write(act.html); w.document.close(); }
      else { // 弹窗被拦截 → 就地嵌入 iframe 并自动提交
        const ifr = document.createElement('iframe'); ifr.style.cssText = 'width:100%;height:520px;border:1px solid var(--line);border-radius:8px;background:#fff';
        qrBox.appendChild(ifr);
        const doc = ifr.contentDocument;
        doc.open(); doc.write(act.html); doc.close();
      }
      document.getElementById('payAccount').textContent = '支付宝';
      document.getElementById('payHint').textContent = '已拉起支付宝收银台，付款完成后回到本页。';
    } else {
      // —— 手动收款：收款码由服务端转成 Data URL 内嵌下发，任何环境都能出码 ——
      const aImg = (act && (act.qrAlipayData || act.qrAlipay)) || (o.pay && o.pay.receive && o.pay.receive.alipay) || '';
      const wImg = (act && (act.qrWechatData || act.qrWechat)) || (o.pay && o.pay.receive && o.pay.receive.wechat) || '';
      const list = [];
      if (aImg) list.push({ key: 'alipay', label: '支付宝', src: aImg });
      if (wImg) list.push({ key: 'wechat', label: '微信', src: wImg });
      _payModes = list;
      const hint = (act && act.notice) || (o.pay && o.pay.receive && o.pay.receive.hint) || '请扫码付款并备注订单号，运营确认到账后自动激活。';
      if (!list.length) {
        document.getElementById('payAccount').textContent = '支付宝 / 微信（国内扫码）· PayPal（海外）';
        qrBox.innerHTML = '<div class="sub" style="text-align:center;color:var(--danger);margin:10px 0">收款渠道正在配置中，请先联系客服完成下单。</div>';
      } else {
        qrBox.innerHTML = chanTabs(list, list[0].key, null)
          + '<div style="display:flex;justify-content:center;margin-top:4px">' + qrImg(list[0].src) + '</div>'
          + '<div class="sub" style="text-align:center;margin-top:6px;color:var(--muted)">转账请备注订单号：<b style="color:var(--fg)">' + p.id + '</b></div>';
      }
      document.getElementById('payAccount').textContent = '支付宝 / 微信（国内扫码）· PayPal（海外）';
      document.getElementById('payHint').textContent = hint;
      // 渠道切换：一枚码一个渠道，点tag换码（Data URL 秒切，无闪烁）
      qrBox.querySelectorAll('[data-paymode]').forEach(btn => {
        btn.onclick = () => {
          const hit = list.find(x => x.key === btn.dataset.paymode);
          if (!hit) return;
          qrBox.querySelectorAll('[data-paymode]').forEach(b => b.classList.add('ghost'));
          btn.classList.remove('ghost');
          const img = qrBox.querySelector('img');
          if (img) img.src = hit.src;
        };
      });
    }
    if (_payPoll) clearInterval(_payPoll);
    _payPoll = setInterval(async () => {
      try {
        const st = await api('/v1/pay/status?order=' + encodeURIComponent(p.id));
        if (st && st.paid) {
          clearInterval(_payPoll); _payPoll = null;
          if (po) po.hidden = true;
          hideWall(); refreshSubs(); refreshKPI();
          toast('✅ 支付到账，订阅已激活', 'ok');
        }
      } catch (e) {}
    }, 5000);
    hideWall();
  }
  // 买家点「我已付款」：把回传记录进订单（提醒运营核账），然后等检测。
  // 绝不在此处开通权益——那等于谁点谁白嫖；开通只认网关回调或运营令牌确认。
  async function payDone() {
    const oid = document.getElementById('payOrderId').textContent.trim();
    const pb = document.getElementById('payPaid');
    try {
      await api('/v1/pay/manual-confirm', { method: 'POST', body: JSON.stringify({ orderId: oid, visitor: vid() }) });
      if (pb) pb.hidden = false;
      toast('已记录：运营确认到账后自动激活（每 5 秒自动检测）', 'ok');
    } catch (e) {
      toast('提交失败：' + (e.message || '请稍后重试'), 'bad');
    }
  }

  // ===== 订阅面板 =====
  async function refreshSubs() {
    const d = await api('/v1/subs/status');
    const free = d.wall ? '0' : (d.freeLeft === Infinity ? '∞' : d.freeLeft);
    $('#subsQuotaCard').textContent = '🧾 我的额度 · 访客 ' + vid() + ' · ' + T('free') + ' ' + free + '·' + d.used;
    $('#subsStatusBox').innerHTML =
      '<span class="watch-pill">' + (d.wall ? '🔒 已到墙' : '✅ 免费可用 ' + free + ' 次') + '</span>' +
      '<span class="watch-pill">' + (d.sub ? ('已订阅 ' + esc(d.sub.plan) + ' · 剩余 ' + d.sub.daysLeft + ' 天') : '未订阅') + '</span>' +
      '<span class="watch-pill">' + (d.inviteCode && d.inviteCode.length ? '邀请码 ' + esc(d.inviteCode[0]) : '我的邀请码待生成') + '</span>' +
      (d.wall ? '<button class="btn primary" onclick="BIZ.showPlans()">去订阅</button>' : '');
    // 方案卡
    const grid = $('#subsPlansGrid');
    if (grid) {
      const cn = d.plans.CN || [], en = d.plans.EN || [];
      grid.innerHTML = cn.map(p => {
        const e = en.find(x => x.id === p.id) || {};
        const price = d.sub && d.sub.plan === p.id ? '（当前）' : '';
        return '<div class="subs-card' + (d.sub && d.sub.plan === p.id ? ' cur' : '') + '" onclick="BIZ.subscribe(\'' + p.id + '\')">' +
          '<div>' + esc(p.label) + ' · ' + esc(e.label || '') + '</div>' +
          '<div class="sc-price">¥' + p.amount + '</div>' +
          '<div class="sc-term">周期 ' + p.months + ' 个月 · $' + (e.amount || 0) + ' · ' + price + '</div></div>';
      }).join('');
    }
    // 订单
    const od = await api('/v1/subs/orders?limit=10');
    const oe = $('#subsOrders'); oe.hidden = false;
    oe.textContent = (od.orders || []).length
      ? (od.orders || []).map(o => (o.paid ? '✅' : '⏳') + ' ' + o.amount + o.currency + ' ' + o.plan + ' @' + fmt(o.at) + (o.paid ? ' 已入账支付宝' : '（' + vid() + ' 待确认）')).join('\n')
      : '暂无订单。';
  }
  // ===== 我的沉淀（数据归属层 → 留存的真实理由） =====
  // 诚实口径：资产"挂在你的账号下，到期也不会被清掉"。绝不用"续费即保住"这类假威胁——
  // 到期只收起订阅时长（sublist.expireAt），数据从不删除（core/tenancy.js 红线）。
  // 用恐吓留人，用户换台设备登录发现数据还在，信任一次性归零。
  async function refreshMyAssets() {
    const box = $('#myAssetsBox'); if (!box) return;
    const d = await api('/v1/my/assets');
    const s = (d && d.summary) || {};
    const bc = s.byCollection || {};
    const rows = Object.keys(bc).filter(c => bc[c] > 0)
      .map(c => '<span class="watch-pill">' + esc(c) + ' ' + bc[c] + '</span>');
    box.innerHTML =
      '<div class="sub" style="flex-basis:100%">' + esc(s.message || '还没有专属沉淀——多问几个问题、多沉淀几条知识。') + '</div>' +
      (rows.length ? rows.join('') : '<span class="sub">（暂无已归属资产）</span>') +
      (s.renewAnchor ? '<div class="sub" style="flex-basis:100%;opacity:.75">' + esc(s.renewAnchor) + '</div>' : '');
  }
  window.BIZ = { subscribe, refreshSubs, refreshMyAssets, showPlans: () => api('/v1/subs/status').then(d => showWall(d.plans)) };
  $('#subsRefresh').onclick = () => refreshSubs();
  $('#subsBind').onclick = async () => {
    const code = $('#subsInviteCode').value.trim();
    if (!code) return toast('请填写邀请码', 'bad');
    const r = await api('/v1/subs/bind', { method: 'POST', body: JSON.stringify({ code }) });
    toast(r.ok ? '已绑定推荐人 ' + r.host : (r.error || '绑定失败'), r.ok ? 'ok' : 'bad');
    refreshSubs();
  };
  $('#subsTestPay').onclick = async () => {
    // 运营对账：列出待付款订单，逐单核验收款（确认即入账+激活）
    const od = await api('/v1/subs/orders?limit=30');
    const pending = (od.orders || []).filter(o => !o.paid);
    const pb = $('#subsPendingBox'); if (pb) pb.hidden = false;
    const pe = $('#subsPending'); if (!pe) return;
    pe.hidden = false;
    pe.innerHTML = pending.length
      ? pending.map(o => '<div class="row" style="gap:8px;margin:4px 0;flex-wrap:wrap"><span>⏳ ¥' + o.amount + o.currency + ' ' + esc(o.plan) + ' · <b>订单 ' + esc(o.id) + '</b> · ' + fmt(o.at) + '</span><button class="btn primary pending-confirm" data-oid="' + esc(o.id) + '">✓ 已确认收到款</button></div>').join('')
      : '暂无待确认订单——有买家付款后会列在这里等你核验。';
    pe.querySelectorAll('.pending-confirm').forEach(b => b.onclick = () => confirmOrder(b.dataset.oid));
  };
  async function confirmOrder(orderId) {
    if (!confirm('已确认收到订单 ' + orderId + ' 的转账？确认后即入账支付宝并激活订阅。')) return;
    const r = await api('/v1/subs/confirm', { method: 'POST', body: JSON.stringify({ orderId }) });
    toast(r.ok ? ('✅ 已确认到账，¥' + r.order.amount + ' 入账支付宝' + (r.inviteBonus ? '，返利 ' + r.inviteBonus.addedMonths + ' 个月' : '')) : ('确认失败：' + (r.error || '')), r.ok ? 'ok' : 'bad');
    refreshSubs(); refreshKPI(); $('#subsTestPay').click();
  }

  // ===== 排行榜 =====
  async function refreshRank() {
    const [s, m] = await Promise.all([api('/v1/rank?field=score'), api('/v1/rank?field=money')]);
    const render = field => {
      const d = field === 'score' ? s : m;
      const box = field === 'score' ? $('#rankScoreBox') : $('#rankMoneyBox');
      const rows = d.rows || [];
      box.innerHTML = rows.length ? '<table class="rank-table"><tr><th>#</th><th>名字</th><th>' + (field === 'score' ? '分数' : '金额') + '</th><th>超前一档</th></tr>' +
        rows.map(r => '<tr><td><span class="rk">' + r.rank + '</span></td><td>' + esc(r.name) + '</td><td><b>' + (field === 'score' ? r.score : '¥' + r.money) + '</b></td><td>' + (r.aheadBy == null ? '—' : '+' + r.aheadBy) + '</td></tr>').join('') + '</table>'
        : '暂无上榜。补录一条点亮榜单。';
    };
    render('score'); render('money');
    const ig = s.integrity || { ok: true };
    $('#rankIntegrity').innerHTML = '榜单完整性：' + (ig.ok ? '✅ 前一名严格 > 后一名（差值全部 ≥1）' : '⚠ ' + (ig.bad || []).map(x => esc(x.name) + ' vs ' + esc(x.next)).join('、') + ' 需补录重排');
  }
  $('#rankRefresh').onclick = () => refreshRank();
  $('#rankEnter').onclick = async () => {
    const name = $('#rankName').value.trim(), score = $('#rankScore').value.trim(), field = $('#rankField').value;
    if (!name || !score) return toast('请填写名字和分数', 'bad');
    const r = await api('/v1/rank/enter', { method: 'POST', body: JSON.stringify({ name, score, field }) });
    if (r.ok) {
      $('#rankResult').hidden = false;
      $('#rankResult').textContent = '✅ 上榜成功：' + name + ' · ' + score + (r.violated && r.violated.length ? '\n⚠ 提示：与下一位差值 <1（' + JSON.stringify(r.violated.map(x => x.diff)) + '），已自动重排' : '\n前一名差值规则已校验干净');
      refreshRank();
    } else toast(r.error || '上榜失败', 'bad');
  };

  // ===== 24h 监控 =====
  async function refreshWatch() {
    const d = await api('/v1/watch');
    $('#watchStatusBox').innerHTML =
      '<span class="watch-pill">哨兵 ' + (d.running ? '🟢 运行中' : '🔴 停止') + '</span>' +
      '<span class="watch-pill">体检周期 <b>' + Math.round((d.scanMs || 0) / 1000) + 's</b></span>' +
      '<span class="watch-pill">冷静期 <b>' + (d.cooldownMin || 30) + 'min</b></span>' +
      '<span class="watch-pill">告警邮箱 <b>' + esc(d.inbox) + '</b></span>' +
      '<span class="watch-pill">上次巡检 <b>' + (d.lastScan ? fmt(d.lastScan) : '—') + '</b></span>';
    const al = $('#watchAlerts'); al.hidden = false;
    al.textContent = (d.alerts && d.alerts.length)
      ? d.alerts.map(x => '🚨 [' + x.level.toUpperCase() + '] ' + x.title + ' — ' + x.detail).join('\n')
      : '暂无告警（一切正常）。';
    const ml = await api('/v1/mail/log?limit=8');
    const me = $('#watchMailLog'); me.hidden = false;
    me.textContent = (ml.mails || []).length
      ? ml.mails.map(x => (x.ok ? '✅' : '❌') + ' → ' + esc(x.to) + ' · ' + esc(x.subject || '') + ' · ' + fmt(x.at) + (x.error ? ' · ' + esc(x.error) : '')).join('\n')
      : '暂无外发记录（有异常触发才会发信）。';
  }
  $('#watchRefresh').onclick = () => refreshWatch();
  $('#watchScan').onclick = async () => {
    const r = await api('/v1/watch/scan');
    toast('巡检完成：发现 ' + r.count + ' 项异常，' + (r.alert.sent ? '已告警 ' + r.alert.sent + ' 信' : '无需告警'), r.count ? 'bad' : 'ok');
    refreshWatch();
  };

  // ===== 半年千万 KPI =====
  async function refreshKPI() {
    const k = await api('/v1/money/kpi');
    const pct = Math.max(0, Math.min(100, Math.round(k.pct * 10)));
    // #kpiGauge 在 KPI 面板里并不存在（进度已由面板标题 + #kpiBox 呈现）。旧代码直接
    // $('#kpiGauge').innerHTML=… 会抛 "Cannot set properties of null (setting 'innerHTML')"，
    // 整个 refreshKPI 在此中断 → KPI 面板空白 + 一条红色报错。存在才写。
    const gauge = $('#kpiGauge');
    if (gauge) gauge.innerHTML = '🎯 进度 <span class="tag">半年 ' + (k.target / 10000).toFixed(0) + ' 万</span>';
    $('#kpiBox').innerHTML =
      '<div class="panel" style="flex:1;min-width:200px"><div>真实入账（支付宝）</div><div class="kpi-big">¥' + k.revenue.toFixed(0) + '</div><div class="kpi-bar"><i style="width:' + pct + '%"></i></div><div class="sub">' + pct + '% · 已过 ' + k.daysPast + ' 天</div></div>' +
      (k.testCount ? '<div class="panel" style="flex:1;min-width:180px"><div>自测单（不计营收）</div><div class="kpi-big" style="color:#94a3b8">¥' + k.testRevenue.toFixed(0) + '</div><div class="sub">' + k.testCount + ' 笔本机联调单 · 台账全额 ¥' + k.grossRevenue.toFixed(0) + '</div></div>' : '') +
      '<div class="panel" style="flex:1;min-width:180px"><div>目标</div><div class="kpi-big">¥' + (k.target / 10000).toFixed(0) + '万</div><div class="sub">截止 ' + esc(k.inboundDate) + '</div></div>' +
      '<div class="panel" style="flex:1;min-width:180px"><div>实际日均</div><div class="kpi-big">¥' + k.regDaily.toFixed(0) + '</div><div class="sub">需求日均 ¥' + k.needDaily.toFixed(0) + '</div></div>' +
      '<div class="panel" style="flex:1;min-width:170px"><div>状态</div><div class="kpi-big">' + (k.onTrack ? '✅ 达标' : '📉 落后') + '</div><div class="sub">' + k.daysLeft + ' 天后见分晓</div></div>';
    // 营收
    const rev = await api('/v1/money/budget');
    const re = $('#moneyRevenues'); re.hidden = false;
    re.textContent = (rev.revenues || []).length
      ? rev.revenues.map(x => (/test/i.test(String(x.source || '')) ? '🧪 ' : '✅ ') + '¥' + x.amt + ' · ' + esc(x.source) + ' · ' + esc(x.method) + ' → ' + esc(x.settle) + ' · ' + fmt(x.at) + (/test/i.test(String(x.source || '')) ? '  ← 自测单，不计真实营收' : '')).join('\n')
      : '暂无营收——记一笔入账即启动半年千万征程。';
    const pe = $('#moneyPromos'); pe.hidden = false;
    pe.textContent = (rev.promos || []).length
      ? '推广池：拨备 ¥' + rev.budget.allotted.toFixed(2) + ' · 已支 ¥' + rev.budget.spent.toFixed(2) + ' · 可用 ¥' + rev.budget.avail.toFixed(2) + '\n——\n' +
        rev.promos.map(x => (x.kind === '支出' ? '📤 支 ¥' : '📥 拨 ¥') + x.amt + ' · ' + esc(x.note) + ' · ' + fmt(x.at)).join('\n')
      : '推广池空——每笔入账自动计提 5%。';
    const ld = await api('/v1/money/leads?limit=15');
    const le = $('#moneyLeads'); le.hidden = false;
    le.textContent = (ld.leads || []).length
      ? ld.leads.map(x => '🎯 [' + esc(x.source) + '] ' + esc(x.hook) + ' · ' + x.status + ' · ' + fmt(x.at)).join('\n')
      : '暂无获客线索——自主运营每轮自动铺市场。';
    // 赚钱目标无人驾驶（暗线每日闭环）
    try {
      const g = await api('/v1/goalpilot/status');
      const d = g.lastDaily || null;
      const gp = $('#goalPilotBox'); if (gp) {
        gp.hidden = false;
        gp.textContent = d
          ? '📌 今日闭环 · ' + esc(d.day) + ' · 状态「' + esc(d.status) + '」（Q' + d.quarter + ' 剩 ' + d.quarterDaysLeft + ' 天）\n' +
            '  累计 ¥' + d.kpi.revenue + ' / 目标 ¥' + (d.kpi.target / 10000).toFixed(0) + '万（' + d.kpi.pct + '%）· 今日 +¥' + d.todayRevenue + ' · 剩 ' + d.kpi.daysLeft + ' 天需日均 ¥' + d.kpi.needDaily + '\n' +
            '  本周可及 ¥' + d.milestone.weekReach + '（计划 ¥' + d.milestone.weekPlan + '）\n—— 优化目标 ——\n' +
            (d.advises || []).map(x => '  · ' + esc(x)).join('\n') +
            '\n—— 逼近动作 ——\n' + ((d.acted || []).length ? (d.acted || []).map(x => '  ✓ ' + esc(x)).join('\n') : '  本轮无外部动作（维持自主运营节奏）') +
            (g.lastWeekly
              ? '\n\n📅 本周闭环 · ' + esc(g.lastWeekly.weekKey) + ' · 状态「' + esc(g.lastWeekly.status) + '」\n' +
                '  本周 ¥' + g.lastWeekly.week.inWeek + ' / 计划 ¥' + g.lastWeekly.week.weekPlan + '（差 ¥ ' + g.lastWeekly.week.needThisWeek + '·剩 ' + g.lastWeekly.week.leftInWeek + ' 天）\n' +
                (g.lastWeekly.acted || []).map(x => '  ✓ ' + esc(x)).join('\n')
              : '')
          : '今日闭环尚未运行——点击下方"记一笔入账"或刷新触发。';
      }
    } catch (e) {}
  }
  window.__goalReport = async () => {
    try {
      const rp = await api('/v1/goalpilot/report');
      const rb = $('#goalReportBox'); if (rb) { rb.hidden = false; rb.textContent = rp.text || JSON.stringify(rp, null, 2); }
    } catch (e) { toast(e.message, 'bad'); }
  };
  $('#kpiRefresh').onclick = () => refreshKPI();
  $('#moneyCredit').onclick = async () => {
    const amt = $('#moneyAmt').value.trim(), source = $('#moneySource').value.trim();
    if (!amt || !(Number(amt) > 0)) return toast('请填写金额', 'bad');
    const r = await api('/v1/money/credit', { method: 'POST', body: JSON.stringify({ amt, source: source || '手工入账', method: $('#moneyMethod').value }) });
    toast(r.ok ? ('入账 ¥' + amt + ' → 支付宝，自动计提 5% 推广费 ¥' + r.promo) : (r.error || '入账失败'), r.ok ? 'ok' : 'bad');
    refreshKPI();
  };
  $('#promoSpend').onclick = async () => {
    const amt = $('#promoAmt').value.trim(), note = $('#promoNote').value.trim();
    if (!amt || !(Number(amt) > 0)) return toast('请填写投放金额', 'bad');
    const r = await api('/v1/money/spend', { method: 'POST', body: JSON.stringify({ amt, note: note || '自主投放' }) });
    toast(r.ok ? ('已支出 ¥' + amt + ' 推广费') : (r.error || '支出失败'), r.ok ? 'ok' : 'bad');
    refreshKPI();
  };

  // ===== 三语联动：监听语言切换 =====
  function initLangWatch() {
    const sel = $('#langSel');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const lang = sel.value;
      document.body.dir = lang === 'ar' ? 'rtl' : 'ltr';
      document.body.dataset.onlang = lang;
      if ($('#subsQuotaCard')) { refreshSubs(); refreshMyAssets().catch(() => {}); }
    });
  }

  // ===== 顶栏加一个订阅状态芯片 =====
  function initChip() {
    const st = $('#sbStats');
    if (!st) return;
    const chip = document.createElement('span');
    chip.className = 'sb-chip'; chip.id = 'subsChip'; chip.title = '点开订阅面板';
    chip.style.cursor = 'pointer'; chip.style.color = 'var(--accent)'; chip.style.border = '1px solid var(--line)'; chip.style.padding = '2px 8px'; chip.style.borderRadius = '12px';
    st.parentNode.insertBefore(chip, st);
    chip.onclick = () => { const it = [...document.querySelectorAll('.nav-item')].find(x => x.dataset.tab === 'subs'); if (it) it.click(); };
    setInterval(async () => {
      try { const d = await api('/v1/subs/status'); chip.textContent = d.wall ? '🔒 订阅' + (d.freeLeft === Infinity ? '✓' : '') : (d.sub ? '📡 会员 ' + d.sub.daysLeft + 'd' : '🎟 免费 ' + (d.freeLeft === Infinity ? '∞' : d.freeLeft)); }
      catch (e) { chip.textContent = '🎟 …'; }
    }, 15000);
  }

  // ===== 付款弹窗接线（真实收款）=====
  const _po = document.getElementById('payOverlay');
  const _pl = document.getElementById('payLater');
  const _pd = document.getElementById('payDone');
  if (_po && _pl) _pl.onclick = () => { _po.hidden = true; if (_payPoll) { clearInterval(_payPoll); _payPoll = null; } };
  // 「我已付款」= 回传转账凭证（留痕 + 提醒运营核账），不是开通开关
  if (_pd) _pd.onclick = () => { payDone(); };

  // ===== 收款配置（运营）=====
  const _tokSave = document.getElementById('opTokenSave');
  if (_tokSave) _tokSave.onclick = () => {
    const v = document.getElementById('opToken').value.trim();
    if (!v) return toast('请粘贴运营令牌', 'bad');
    try { localStorage.setItem('bd_adminToken', v); } catch (e) {}
    toast('✅ 运营令牌已保存', 'ok');
    loadPayConfig();
  };
  async function loadPayConfig() {
    const r = await api('/v1/subs/pay-config');
    if (!r.ok) { const st = document.getElementById('payConfigStatus'); if (st) st.textContent = '未保存令牌或令牌无效——云服务器运营请先在上方填入运营令牌。'; return; }
    const c = r.config || {};
    const a = document.getElementById('payAccountCfg'); if (a) a.value = c.receiveAccount || '';
    const q1 = document.getElementById('payQrAlipay'); if (q1) q1.value = c.receiveQrAlipay || '';
    const q2 = document.getElementById('payQrWechat'); if (q2) q2.value = c.receiveQrWechat || '';
    const st = document.getElementById('payConfigStatus');
    if (st) st.textContent = c.receiveAccount ? '当前收款账号：' + c.receiveAccount + (c.receiveQrAlipay ? ' · 已配支付宝收款码' : '') + (c.receiveQrWechat ? ' · 已配微信收款码' : '') : '未配置——买家将看到"待设置"提示。';
  }
  function isOp() {
    // 运营身份：服务端对非回环请求用 X-Admin-Token 鉴权；前端以本地存过令牌为准（首访提示获取方式）
    try { return !!localStorage.getItem('bd_adminToken'); } catch (e) { return false; }
  }
  $('#payConfigSave').onclick = async () => {
    const body = {
      receiveAccount: $('#payAccountCfg').value.trim(),
      receiveQrAlipay: $('#payQrAlipay').value.trim(),
      receiveQrWechat: $('#payQrWechat').value.trim()
    };
    if (!isOp()) return toast('请先在下方保存运营令牌，再保存收款配置', 'bad');
    const r = await api('/v1/subs/pay-config', { method: 'POST', body: JSON.stringify(body) });
    toast(r.ok ? '✅ 收款配置已保存（买家下单即可看到）' : (r.error || '保存失败'), r.ok ? 'ok' : 'bad');
    if (r.ok) loadPayConfig();
  };

  // ===== 收费墙硬网关：对 /v1/report/seven 等服务端 402 拦截 - 自动弹墙 =====
  function hookWall() {
    const orig = window.fetch;
    window.fetch = async (input, init) => {
      const headers = new Headers((init && init.headers) || {});
      try { headers.set('X-Visitor', vid()); } catch (e) {}
      const resp = await orig(input, Object.assign({}, init, { headers }));
      if (resp.status === 402) {
        try { const d = await resp.clone().json(); showWall(d.plans); } catch (e) {}
      }
      return resp;
    };
  }

  // ===== 买卖交互 + 初始化 =====
  function bindTabs() {
    $$('.nav-item[data-tab="subs"]').forEach(a => a.addEventListener('click', () => { refreshSubs().catch(e => toast(e.message, 'bad')); refreshMyAssets().catch(() => {}); loadPayConfig().catch(() => {}); }));
    $$('.nav-item[data-tab="rank"]').forEach(a => a.addEventListener('click', () => refreshRank().catch(e => toast(e.message, 'bad'))));
    $$('.nav-item[data-tab="watch"]').forEach(a => a.addEventListener('click', () => refreshWatch().catch(e => toast(e.message, 'bad'))));
    $$('.nav-item[data-tab="kpi"]').forEach(a => a.addEventListener('click', () => refreshKPI().catch(e => toast(e.message, 'bad'))));
  }

  function boot() {
    hookWall();
    bindTabs();
    initLangWatch();
    setTimeout(initChip, 800);
    setTimeout(() => { refreshSubs().catch(() => {}); refreshMyAssets().catch(() => {}); }, 1000);
    setInterval(() => { refreshSubs().catch(() => {}); }, 60000);
  }
  document.addEventListener('DOMContentLoaded', boot);
  return { boot, subscribe, refreshSubs, refreshMyAssets, refreshRank, refreshWatch, refreshKPI, vid };
})();