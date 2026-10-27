// zhihu-login-capture.js — 知乎扫码登录收割器
// 真实打开 chromium 窗口加载知乎首页，你扫码登录后，把登录态(持久 profile + storageState)落库 data/autopub/zhihu-state.json。
// 用法：node zhihu-login-capture.js
// 之后 autopub.publish('zhihu', ...) 会自动复用该登录态实现自主发布。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, 'data', 'autopub');
const PROFILE = path.join(ROOT, 'zhihu-profile');
const STATE = path.join(ROOT, 'zhihu-state.json');

async function waitLoggedIn(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const judge = async () => {
    try {
      await page.waitForSelector('div.AppHeader-userInfo, .AppHeaderProfileMenu, [data-tooltip*="消息"], .Popover.NormalSearchBar-toggleButton', { timeout: 1500 });
      return true;
    } catch (e) { return false; }
  };
  while (Date.now() < deadline) {
    if (await judge()) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

(async () => {
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) {}
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ userDataDir: PROFILE });
  const page = await context.newPage();
  console.log('[capture] 真实浏览器窗口已打开 — 若未看到窗口，请把引擎窗口切换到前台。');
  console.log('[capture] 请在弹出的窗口中手动打开 zhihu.com 首页（或等待 signin 页），扫码登录。');
  console.log('[capture] 登录成功自动保存登录态；180 秒无操作则退出（可重跑）。');
  await page.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const ok = await waitLoggedIn(page, 180000);
  if (ok) {
    const state = await context.storageState({ path: STATE });
    console.log('[capture] 登录成功！登录态已保存：' + STATE);
    process.exit(0);
  } else {
    console.log('[capture] 未检测到登录成功（超时）。无法保存登录态，请重试。');
    process.exit(1);
  }
})().catch(e => { console.error('[capture] 出错：' + (e.message || e)); process.exit(1); });