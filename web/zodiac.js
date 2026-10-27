// web/zodiac.js — 十二生肖桌面宠物（12 只同屏 · 自主行为 · 养成互动）
// 状态权威在服务端 core/zodiac.js（db.zodiac），前端只渲染 + 发送互动。
// 桌面圈养：每只生肖是独立 DOM 个体，自主游走/动作/睡觉，由服务端 tick 驱动。
const ZODIAC = (() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // 舞台：承载 12 只宠物，覆盖整个工作区，pointer-events 交给宠物本体
  const stage = document.createElement('div');
  stage.id = 'zodiStage';
  const nodes = {};      // id -> {root, face, shot, name}
  let board = null;      // 服务端状态

  function makePet(p) {
    const root = document.createElement('div');
    root.className = 'zodi zodi-pet' + (p.unlocked ? '' : ' locked');
    root.dataset.id = p.id;
    root.style.setProperty('--zc1', p.z1);
    root.style.setProperty('--zc2', p.z2);
    root.title = `${p.name}·${p.organ}｜Lv.${p.level} ${p.unlocked ? '（点击互动）' : '（未解锁）'}`;

    const body = document.createElement('div');
    body.className = 'zodi-body';
    const shot = document.createElement('span');
    shot.className = 'zodi-shot';
    const face = document.createElement('span');
    face.className = 'zodi-face';
    face.textContent = p.e;
    const zzz = document.createElement('span');
    zzz.className = 'zodi-z';
    zzz.textContent = '💤';
    const footL = document.createElement('span'); footL.className = 'zodi-foot l';
    const footR = document.createElement('span'); footR.className = 'zodi-foot r';
    const bar = document.createElement('div');      // 等级/心情小进度条
    bar.className = 'zodi-bar';
    const name = document.createElement('span');
    name.className = 'zodi-name';
    name.textContent = p.name;

    body.append(shot, zzz, face, footL, footR, bar, name);
    root.appendChild(body);
    stage.appendChild(root);
    nodes[p.id] = { root, face, shot, name, bar };
    return root;
  }

  // 应用服务端下发的位置与状态
  // 【2026-09·只显示客户选中的那一只】客户从已解锁的生肖里选一只作为伙伴，
  // 悬浮层**只显示这一只**（其余 11 只 display:none，不再是 opacity 0.28 的"幽灵"）。
  // 选谁由服务端 board.myZodiac 决定（可随时切换，锁定的不给选）。
  function apply(pet) {
    const n = nodes[pet.id];
    if (!n) return;
    const mine = !board || !board.myZodiac || pet.id === board.myZodiac;
    n.root.style.display = mine ? '' : 'none';
    if (!mine) return;
    n.root.style.left = pet.x + '%';
    n.root.style.top = pet.y + '%';
    n.root.classList.toggle('locked', !pet.unlocked);
    n.face.textContent = pet.e;
    n.root.title = `${pet.name}·${pet.organ}｜Lv.${pet.level}｜心情${Math.round(pet.mood*100)}% 精力${Math.round(pet.energy*100)}% ${pet.unlocked ? '（点击互动）' : '（未解锁）'}`;
    n.bar.style.setProperty('--lv', (pet.level / 20 * 100) + '%');
    n.bar.style.setProperty('--mood', (pet.mood * 100) + '%');
  }

  // 播放动作（纯 CSS 动画类）
  function play(id, act) {
    const n = nodes[id];
    if (!n) return;
    const map = {
      float: 'a-float', walk: 'a-walk', run: 'a-run', jump: 'a-jump',
      dance: 'a-dance', sleep: 'a-sleep', eat: 'a-eat', happy: 'a-happy',
      play: 'a-play', alert: 'a-alert', patrol: 'a-patrol', think: 'a-think',
      stretch: 'a-stretch', groom: 'a-groom', idle: 'a-float', lie: 'a-sleep'
    };
    n.root.classList.remove('a-float','a-walk','a-run','a-jump','a-dance','a-sleep','a-eat','a-happy','a-play','a-alert','a-patrol','a-think','a-stretch','a-groom');
    void n.root.offsetWidth;  // 触发重排以重启动画
    n.root.classList.add(map[act] || 'a-float');
    // 情绪气泡
    n.shot.textContent = ({ happy:'💖✨', dance:'✨✨', eat:'🍚', play:'🎾', alert:'❗', patrol:'🔍', think:'💭', groom:'✨', sleep:'💤' })[act] || '';
    n.shot.classList.toggle('on', !!n.shot.textContent);
  }

  async function refresh() {
    try {
      const r = await fetch('/v1/zodiac').then(x => x.json());
      if (!r || !r.ok) return;
      board = r;
      // 首次建 DOM
      (r.pets || []).forEach(p => { if (!nodes[p.id]) makePet(p); });
      (r.pets || []).forEach(apply);
      const ctl = $('#zodiCtl');
      if (ctl) ctl.innerHTML = (r.pets || []).map(p =>
        // type="button" 必须显式写：<button> 默认 type=submit，若祖先里有 <form>，
        // 点击会变成表单提交（页面跳转），事件委托根本收不到 —— 表现为"点了没反应"。
        `<button type="button" class="zodi-chip${p.unlocked ? '' : ' off'}${p.isMine ? ' mine' : ''}" data-zsel="${p.id}"` +
        ` style="--zc1:${p.z1}" title="${p.isMine ? '当前伙伴（悬浮层只显示它）' : (p.unlocked ? '点击选它作为伙伴' : '未解锁：把伙伴养到 3 级自动解锁')}"` +
        `>${p.e} ${p.name} Lv.${p.level}</button>`).join('') +
        `<span class="sub">已解锁 ${r.unlocked}/${r.total} · 点一只即成为你的伙伴（悬浮层只显示它）</span>`;
      bindSelect(ctl);
    } catch (e) { /* 网络异常时静默，宠物仍在本地活动 */ }
  }

  // ===== 选择自己的生肖伙伴 =====
  // 事件委托挂在容器上（chips 每次 refresh 都重建，绑在每个 chip 上会丢）
  function bindSelect(ctl) {
    if (!ctl || ctl.__selBound) return;
    ctl.__selBound = true;
    ctl.addEventListener('click', async e => {
      const btn = e.target.closest('[data-zsel]');
      if (!btn) return;
      const id = btn.dataset.zsel;
      try {
        const r = await fetch('/v1/zodiac/select', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        }).then(x => x.json());
        if (!r || !r.ok) { flash(ctl, (r && r.error) || '选择失败'); return; }
        flash(ctl, '已选择「' + r.name + '」为你的伙伴，悬浮层只显示它');
        await refresh();
      } catch (err) { flash(ctl, '网络异常，未能保存'); }
    });
  }
  // 轻提示：复用容器，不引入新依赖
  function flash(ctl, msg) {
    let t = ctl.querySelector('.zodi-flash');
    if (!t) { t = document.createElement('span'); t.className = 'zodi-flash sub'; ctl.appendChild(t); }
    t.textContent = msg;
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }

  // 自主行为循环：向服务端要"该谁动"，本地播放动画
  async function loop() {
    try {
      const r = await fetch('/v1/zodiac/tick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }).then(x => x.json());
      if (r && r.ok && r.acted) r.acted.forEach(a => { play(a.id, a.act); const p = (board.pets || []).find(x => x.id === a.id); if (p) { p.lastAct = a.act; } });
    } catch (e) {}
    // 状态轮询（较慢，30s 一次足够）
    if (Math.random() < 0.2) refresh();
  }

  // 互动：点击宠物 → 随机一种互动（真实发到服务端累积）
  async function onClick(e) {
    const t = e.target.closest('.zodi-pet');
    if (!t) return;
    const id = t.dataset.id;
    const kinds = ['pet', 'play', 'feed'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    try {
      const r = await fetch('/v1/zodiac/interact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, kind })
      }).then(x => x.json());
      if (r && r.ok) {
        play(id, kind === 'feed' ? 'eat' : kind === 'play' ? 'play' : 'happy');
        // 更新本地状态
        const p = (board.pets || []).find(x => x.id === id);
        if (p) { p.exp = r.exp; p.level = r.level; p.mood = r.mood; p.energy = r.energy; apply(p); }
        if (r.unlocked) refresh();
      }
    } catch (err) {}
  }

  // ===== 自主行为心跳：自适应节流 =====
  //
  // 【2026-09·操作卡死/启动慢】原来固定 `setInterval(loop, 3000)` + `setInterval(refresh, 30000)`，
  // 无条件常驻，实测占全部后台请求的 40%（tick 20 次 + 状态 7 次 / 60 秒）。
  // 更要紧的是：每次 tick 命中动作时服务端就会 **写一次库**（core/zodiac.js 的 save()），
  // 等于每分钟凭空多出约 20 次同步写盘 —— 这正是启动后偶发 1.4 秒冻结的来源之一。
  //
  // 而服务端 core/zodiac.js 有 minGap（默认 9s）：每只生肖两次动作至少隔 9 秒。
  // 于是**每 3 秒里有 2 秒的 tick 必然谁都不动**，纯属空跑。
  //
  // 改为自适应：
  //   1) 页面不可见 → 停（没人看宠物，不该消耗服务端写盘）
  //   2) 连续若干次 tick 没有任何宠物动作 → 逐步退避到 9s（对齐服务端 minGap）
  //   3) 真的有动作 → 立刻回到 3s，保证观感不变
  let timer = null;
  let refreshTimer = null;
  const BASE_MS = 3000;
  const IDLE_BACKOFF = [3000, 5000, 7000, 9000];   // 逐级退避，最后一档对齐服务端 minGap
  let idleStep = 0;
  let busy = false;

  async function loop() {
    if (busy) return;                 // 上一次还没回来，不叠加
    if (document.hidden) return;       // 不可见不打扰服务端
    busy = true;
    try {
      const r = await fetch('/v1/zodiac/tick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }).then(x => x.json());
      if (r && r.ok) {
        if (r.acted && r.acted.length) {
          (r.acted || []).forEach(a => play(a.id, a.act));
          idleStep = 0;               // 有动作 → 恢复高频
        } else {
          idleStep = Math.min(idleStep + 1, IDLE_BACKOFF.length - 1);
        }
      }
    } catch (err) {
      /* 网络异常：静默，下一轮再来 */
    } finally {
      busy = false;
      scheduleTick();
    }
  }

  // 不用 setInterval 固定频率，而是**每轮结束后按当前节奏重排下一次**（自适应退避）
  function scheduleTick() {
    if (timer) clearTimeout(timer);
    if (document.hidden) return;       // 隐藏时不排期
    const ms = IDLE_BACKOFF[idleStep];
    timer = setTimeout(loop, ms);
    if (timer.unref) timer.unref();
  }

  // 状态同步同样只在页面可见时做，且频率下调
  async function refreshQuiet() {
    if (document.hidden) return;
    try { await refresh(); } catch (e) { /* 静默 */ }
  }

  function startTimers() {
    if (!document.getElementById('zodiStage')) return;
    if (!timer) { idleStep = 0; scheduleTick(); }
    if (!refreshTimer) refreshTimer = setInterval(refreshQuiet, 60000);   // 30s → 60s
  }
  function stopTimers() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function boot() {
    if (document.getElementById('zodiStage')) return;
    document.body.appendChild(stage);
    document.addEventListener('click', onClick);
    refresh();
    startTimers();
    // 隐藏时彻底停掉（宠物看不见，动它没有意义，还白耗服务端写盘）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopTimers();
      else { startTimers(); refresh(); }   // 回到前台立刻同步一次最新状态
    });
  }

  return { boot, refresh, play, board: () => board };
})();

window.ZODIAC = ZODIAC;
document.addEventListener('DOMContentLoaded', () => { try { ZODIAC.boot(); } catch (e) {} });
