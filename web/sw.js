/* sw.js — 丙大山AI 的离线应用外壳（只缓存静态壳，永不缓存业务数据）
 *
 * 诚实边界（与 core/money.js、evidence-pipeline.js 同一套纪律）：
 *   · 只缓存静态资源（HTML/CSS/JS/图标）。`/v1/*` 等业务接口**一律不缓存**，
 *     否则用户离线时会看到"上次的营收/订单"被当成当前值 —— 那是假数据。
 *   · 导航请求走 network-first：在线时永远拿最新页面，离线才回退到缓存的壳。
 *   · 版本号变化即清掉旧缓存，避免旧 JS 与新服务端接口错配。
 *
 * 这个文件就是"iOS / Android / 鸿蒙 免上架即可安装"的技术底座：
 * 浏览器把站点作为一个独立应用安装到主屏，用同一套 web 资产服务所有平台。
 */
'use strict';

const VERSION = 'bd-shell-2026.0.3-nf';   // nf=network-first：JS/HTML 永远以在线版为准（2026-10-24 收费墙缓存事故）
const SHELL = [
  '/',
  '/index.html',
  '/download.html',
  '/activate.html',
  '/app.css',
  '/ui.js',
  '/i18n.js',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isBusinessPath(pathname) {
  return pathname.startsWith('/v1/') ||
    pathname.startsWith('/ws') ||
    pathname.startsWith('/orca') ||
    pathname.startsWith('/verify/') ||
    // 发布清单与安装包**绝不能进缓存**：缓存住 releases.json 会让用户在旧版本上
    // 看不到新版本（甚至点了旧安装包）；缓存几百 MB 的安装包更会撑爆用户磁盘配额。
    pathname === '/releases.json' ||
    pathname.startsWith('/downloads/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // 变更请求永不缓存
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;        // 跨域（外链/模型 API）直接放行
  if (isBusinessPath(url.pathname)) return;               // 业务数据绝不缓存

  // 页面导航：network-first，离线才回退应用外壳
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))));
    return;
  }

  // 【2026-10-24 收费墙缓存事故修复】JS/HTML 改 **network-first**（离线才回退缓存）：
  // 此前所有静态资源 cache-first + 后台更新 → 页面拿到的是**上一版脚本**（差一拍），
  // biz.js 新加的 BIZ.showPlans（「去订阅」按钮的入口）在老用户浏览器里是 undefined →
  // 撞墙后点「去订阅」没有任何反应，订阅墙弹不出来。付费转化入口被缓存掐断，纯事故。
  // HTML/JS 是业务逻辑载体，必须永远以在线版本为准；图片/字体/CSS 才适合 cache-first。
  if (/\.(js|mjs|html|webmanifest)$/i.test(url.pathname) || url.pathname === '/') {
    event.respondWith(
      fetch(req).then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          caches.open(VERSION).then((c) => c.put(req, resp.clone())).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  // 图片/字体/CSS：cache-first，并在后台顺手更新缓存
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req).then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          caches.open(VERSION).then((c) => c.put(req, resp.clone())).catch(() => {});
        }
        return resp;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
