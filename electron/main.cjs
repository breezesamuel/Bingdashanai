// electron/main.cjs — 丙大山AI 桌面壳
// 启动内置 API 服务 + 加载 UI（内置服务被强杀时自动重启，保证 exe 稳定）
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 管理令牌：主进程从 DB 读取，通过 IPC 交给 preload。
// 令牌永不进入渲染进程全局作用域，只存在于 preload 闭包中。
function getAdminToken() {
  try {
    const dataDir = process.env.BINGDASHAN_DATA_DIR || path.join(app.getPath('userData'), 'data');
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    return (db.settings && db.settings.adminToken) || null;
  } catch (e) { return null; }
}

ipcMain.handle('get-admin-token', () => getAdminToken());

const PORT = Number(process.env.BINGDASHAN_PORT || 3721);
// Hosted 模式：设置 SERVER_URL 时，本应用只当**客户端**连远端站点，不在本机起服务。
// 【真实事故】这里原来直接写 `if (!SERVER_URL)` 而 SERVER_URL **从未声明** →
//   app.whenReady() 回调里抛 ReferenceError → bootServer() 与 createWindow() 都不执行
//   → 桌面端**一个窗口都没有**、本机服务也没起。
//   （出包校验只查了 asar 里的静态内容，没真启动过，所以这个坏客户端一直发出去。）
const SERVER_URL = String(process.env.SERVER_URL || '').replace(/\/+$/, '');
const URL = SERVER_URL || ('http://127.0.0.1:' + PORT);

let win = null;
let server = null;
let alive = false;

function bootServer() {
  try {
    server = require('../server');
    // 探测服务就绪
    const tryOnce = () => fetch(URL + '/v1/status', { signal: AbortSignal.timeout(800) })
      .then(r => r.json()).then(d => { alive = !!(d && d.ok); })
      .catch(() => { alive = false; });
    const tick = async () => {
      await tryOnce();
      if (!alive) {
        // 服务不在 -> 暴力重载一次（自动恢复）
        try { delete require.cache[require.resolve('../server')]; server = require('../server'); } catch (e) {}
      }
    };
    tick();
    setInterval(tick, 3000);
  } catch (e) {
    console.error('[main] server boot failed', e);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1080, minHeight: 680,
    title: '丙大山AI', backgroundColor: '#f4f4f0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  win.loadURL(URL);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  if (!SERVER_URL) bootServer();   // Hosted 模式只当客户端，不启动本机服务
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((e) => {
  // 【为什么必须 catch】启动链路里的任何异常都会让桌面端**一个窗口都不出现**，
  // 而用户只看到「双击没反应」——连报错都看不到。至少要弹出来。
  console.error('[main] startup failed', e);
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox('丙大山AI 启动失败', String((e && e.stack) || e));
  } catch (e2) { /* 连 dialog 都拿不到就只能记日志 */ }
});

app.on('window-all-closed', () => { app.quit(); });