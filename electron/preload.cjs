// electron/preload.cjs — 最小桥：只暴露桌面宿主信息，不开放 Node 能力
const { contextBridge, ipcRenderer } = require('electron');

// 管理令牌闭包持有，永不暴露到渲染进程全局作用域
let _adminToken = null;
ipcRenderer.invoke('get-admin-token').then(t => { _adminToken = t; }).catch(() => {});

contextBridge.exposeInMainWorld('bingdashan', {
  isElectron: true,
  platform: process.platform,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  // 自动带管理令牌的 fetch（用于资金/凭据类接口）
  adminFetch: (url, options) => {
    return new Promise((resolve, reject) => {
      const tryFetch = (token) => {
        const opts = Object.assign({}, options || {});
        opts.headers = Object.assign({}, opts.headers || {});
        if (token) opts.headers['x-admin-token'] = token;
        fetch(url, opts).then(resolve).catch(reject);
      };
      if (_adminToken) tryFetch(_adminToken);
      else ipcRenderer.invoke('get-admin-token').then(t => { _adminToken = t; tryFetch(t); }).catch(reject);
    });
  }
});