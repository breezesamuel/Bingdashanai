# 桌面（EXE）/移动（APK）打包准备与网站挂载渠道（2026-10-25）

## 一、渠道已就绪的部分（本轮验收过）

| 件 | 状态 | 位置 |
|---|---|---|
| 下载页 | ✅ 已有 | web/download.html（三语 page-i18n；六平台卡片；无包时如实显示原因，绝不放假按钮） |
| 二进制静态服务 | ✅ 已有 | server.js serveStatic：.exe/.apk/.dmg/.deb/.appimage MIME + Content-Disposition: attachment + Content-Length + Accept-Ranges + 单段 Range/206 断点续传（80MB 安装包断网可续传） |
| 发布清单 | ✅ 本轮补齐 | web/releases.json 由 `node scripts/make-releases.js` 生成：扫描 web/downloads/ 产物 → {platform,file,url,size,sha256}，缺的平台自动登记 unavailable 原因；下载页 no-store 拉取 |
| gzip 弱网提速 | ✅ 本轮补齐 | 文本资产 ≥1KB 自动 gzip（app.js 306KB→94KB，31%）；Range/HEAD/安装包不压缩，断点续传语义不受影响 |
| 100+ 轮稳定性基线 | ✅ 本轮验收 | scripts/probe_storm.js：110 轮零 5xx、p50=7ms/p95=38ms、20 并发 OK |

**发布操作**：打包机把 `bingdashan-<版本>-windows.exe` / `-android.apk` 放进 `web/downloads/` →
`node scripts/make-releases.js --version x.y.z` → 下载页 /download.html 立即出现可点按钮（带 sha256 校验）。
没有任何一步需要改代码。

## 二、打包技术选型（2026-10 全网竞品结论）

对标数据（2026-09 基准）：Tauri 安装包 ~3-8MB vs Electron ~85-100MB（小 96%）；内存 ~30-80MB vs 150-400MB（省 58-75%）。AI 本地应用的 2026 主流形态是 **Tauri 壳 + sidecar 后端进程**（tauri.conf.json 的 externalBin 把 server 打成独立二进制随包分发，WebView 只做 UI），且**不把大模型打进安装包**——首次运行再下载，安装包保持小体积。

对本项目的落地建议（按优先级）：
1. **APK（Android）— 优先做**：两条路。A. WebView 壳（Tauri 2 mobile / Capacitor）包住线上站点，包体最小、发布最快，CLIENT_MODE 已在 server.js 预留（桌面交付强制开墙口径已处理）；B. 远期原生壳。先用 A。
2. **EXE（Windows）**：Tauri 2 + sidecar = `pkg`/`node --sea` 把 server.js 打成单文件 exe 作为 externalBin，壳启动 sidecar 监听 127.0.0.1 随机端口后加载。备选 Electron（团队熟 Node 生态时工具链更省心，代价是 ~90MB 包体）。
3. **iOS / 鸿蒙**：维持 PWA（download.html 已写明"添加到主屏幕"路径）；原生 HAP 需 DevEco、iOS 需 Mac+Xcode+开发者账号，收益低不抢跑。

## 三、打包前置检查清单（生成 exe/apk 前必跑）

- [ ] `bash tests/run_all.sh` 全绿（28 套件）
- [ ] `node scripts/probe_storm.js` 零 5xx（110+ 轮 + 并发）
- [ ] CLIENT_MODE 冒烟：桌面壳内墙强制开启（paywall 不因回环放行而失效）
- [ ] 数据目录：桌面版 data/ 落用户目录（%APPDATA%/bingdashan），绝不再写安装目录
- [ ] `node scripts/make-releases.js --version <版本>` 后人工核对 sha256 与包体大小
- [ ] 签名：Windows 侧至少自签 + 说明书注明 SmartScreen"仍要运行"；Android 侧 keystore 固定（丢了无法同包名升级）
