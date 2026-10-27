/* ============================================================
   ui.js — 自适应左栏：光标靠近显现 / 点击锁定 / 选中后保持展开
   ============================================================ */
'use strict';

(() => {
  const NAV = document.getElementById('nav');
  if (!NAV) return;
  const PEEK = document.getElementById('navPeek');
  const RTL = () => document.body.dir === 'rtl' || document.body.getAttribute('dir') === 'rtl';
  let shown = false;      // 当前是否展开
  let pinned = false;     // 用户点击汉堡后锁定，直到再点一次/Esc/点菜单项

  function show() {
    if (shown) return;
    shown = true;
    document.body.classList.add('nav-show');
  }
  function hide() {
    if (!shown) return;
    shown = false;
    document.body.classList.remove('nav-show');
  }
  function setPinned(v) {
    pinned = v;
    document.body.classList.toggle('nav-pin', v);
    if (v) show();
  }

  function overNav(x, y) {
    const r = NAV.getBoundingClientRect();
    return x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12;
  }
  function nearEdge(x) {
    if (RTL()) return x >= window.innerWidth - 20;
    return x <= 20;
  }

  // —— 悬停显现/隐藏（仅在未锁定时生效）——
  let lastX = -9;
  document.addEventListener('mousemove', e => {
    lastX = e.clientX;
    if (pinned) return;
    if (nearEdge(e.clientX)) { show(); return; }
    if (shown && overNav(e.clientX, e.clientY)) return;
    if (shown) hide();
  });
  NAV.addEventListener('mouseleave', () => {
    if (pinned) return;
    if (!nearEdge(lastX)) hide();
  });

  // —— 收起态的边缘把手：悬停或点击都能展开 ——
  if (PEEK) {
    PEEK.addEventListener('mouseenter', () => show());
    PEEK.addEventListener('click', e => { e.stopPropagation(); setPinned(true); });
  }

  // —— 点击汉堡：常驻切换按钮（顶栏），锁定展开 ——
  const burger = document.getElementById('navBurger');
  if (burger) {
    burger.addEventListener('click', e => { e.stopPropagation(); setPinned(!pinned); });
  }

  // —— 点击导航区：切 tab，或（点在空白处）锁定展开 ——
  //
  // 【2026-09 修复·把手点不到就锁不住】
  // 原来的问题：#navPeek 是鼠标用户唯一可发现的入口，但 hover 展开后
  // CSS 里 `body.nav-show #navPeek{pointer-events:none}` 让它当场失去点击能力，
  // 于是"点把手"只会把侧栏窥开一下就再也锁不住——用户必须去顶栏找那个不起眼的按钮。
  // 现在：点击导航的**空白处**等价于"锁定展开"，符合"它已经露出来了，我要留住它"的直觉。
  NAV.addEventListener('click', e => {
    const item = e.target.closest('.nav-item');
    if (!item) {
      if (!pinned) setPinned(true);
      return;
    }
    // 不改 pinned；保持展开，用户可继续点其他 tab
    show();
  });

  // —— 点击导航外部：解锁并收起（仅在锁定态下生效）——
  document.addEventListener('click', e => {
    if (!pinned) return;
    if (NAV.contains(e.target) || (PEEK && PEEK.contains(e.target)) || (burger && burger.contains(e.target))) return;
    setPinned(false);
    hide();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { setPinned(false); hide(); }
  });
})();