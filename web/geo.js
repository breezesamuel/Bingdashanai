/* web/geo.js — 客户地理定位上报（可选、需用户授权）
   行为：页面加载后静默询问一次定位权限；用户同意则上报坐标，���绝/不支持则完全无感知。
   定位结果只落库到后台（/v1/geo/clients），不在界面暴露任何位置信息。
   可通过 localStorage bd_geo=off 彻底关闭。 */
'use strict';

(() => {
  const KEY = 'bd_geo';
  let done = false;
  try { if (localStorage.getItem(KEY) === 'off') return; } catch (e) { return; }

  const post = payload => {
    fetch('/v1/geo/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).then(r => r.json()).then(j => {
      // 用户明确拒绝过：不再重复询问
      if (j && j.error === 'denied') { try { localStorage.setItem(KEY, 'off'); } catch (e) {} }
    }).catch(() => {});
  };

  function report(kind, pos) {
    if (done) return;
    done = true;
    const c = pos.coords || {};
    post({
      kind: kind || 'visitor',
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      source: 'browser'
    });
  }

  function start() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => report('visitor', pos),
      err => {
        // PERMISSION_DENIED: 记住拒绝，避免反复弹窗
        if (err && err.code === 1) { try { localStorage.setItem(KEY, 'off'); } catch (e) {} }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
    );
  }

  // 暴露给业务模块：潜在线索/付费客户在登记时带上位置
  window.GEO = {
    // 定位潜在线索（传入 lead id）
    lead: id => {
      if (!navigator.geolocation || !id) return;
      navigator.geolocation.getCurrentPosition(
        pos => {
          const c = pos.coords || {};
          post({ kind: 'lead', id, lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, source: 'browser' });
        },
        () => {},
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 }
      );
    },
    // 定位付费客户
    customer: () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        pos => {
          const c = pos.coords || {};
          post({ kind: 'customer', lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, source: 'browser' });
        },
        () => {},
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 }
      );
    },
    turnOff: () => { try { localStorage.setItem(KEY, 'off'); } catch (e) {} }
  };

  // 首屏加载后 1.5s 再问，避免与页面主流程抢资源
  if (document.readyState === 'complete') setTimeout(start, 1500);
  else window.addEventListener('load', () => setTimeout(start, 1500));
})();