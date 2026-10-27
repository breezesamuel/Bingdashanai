// 陪护 PWA service worker（scope 限定 /care/，不拦截主站）
// 【为什么只缓存外壳】老人端页面必须能看到“最新告警/任务”，HTML 走网络优先；
// 断网时至少还能打开 SOS 页面并显示离线提示，不会白屏。
'use strict';
const CACHE = 'bd-care-v1';
const SHELL = ['/care/elder.html', '/care/family.html', '/care/icon.svg', '/care/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/care/') !== 0) return;             // 主站/接口一律不碰
  if (url.pathname.indexOf('/v1/') === 0) return;
  // 网络优先，失败回落缓存（保证告警/任务不是旧的）
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && req.mode === 'navigate') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('/care/elder.html')))
  );
});
