# 丙大山AI · 多平台交付与上线手册

> 目标：同一套 `server.js` + `web/` 资产，交付到 **Windows / macOS / iOS / Android / 鸿蒙 / 任意浏览器**，
> 收费墙与订阅闭环配置好，给出完整的上线路径。
>
> 本文只写**真实可执行**的东西。凡涉及 Apple 账号、商店审核、支付签约等外部许可的，明确标注
> “需要你提供 X 才能做”，绝不伪造产物或截图。

---

## 0. 一张图看懂各平台怎么来的

服务端是零依赖原生 Node HTTP（`server.js` + `core/*`），前端是原生 HTML/CSS/JS（`web/`）。
因此“跨平台”不需要重写业务，只需要给同一套资产套不同的壳：

| 平台 | 交付形态 | 壳 | 产物 | 现在能否在本机构建 |
|---|---|---|---|---|
| Windows | 桌面应用 | Electron | `.exe`（NSIS 安装包） | ✅ 本机可（已产出过） |
| macOS | 桌面应用 | Electron | `.dmg` / `.zip` | ❌ 必须在 macOS 上（CI 里可） |
| Linux | 桌面应用 | Electron | `.AppImage` / `.deb` | ⚠️ 可在 Windows 交叉构建，建议 Linux/CI |
| iOS | 原生应用 | Capacitor 8 | `.ipa`（需签名） | ❌ 需 Mac + Xcode + Apple 开发者账号 |
| Android | 原生应用 | Capacitor 8 | `.apk` / `.aab` | ⚠️ 需 Android SDK（CI 里已配好） |
| 鸿蒙 HarmonyOS | PWA（浏览器安装） | 系统浏览器（ArkWeb） | 无独立产物 | ✅ 同一套 web 资产 |
| 任意浏览器 | PWA（可安装） | 浏览器 | 无独立产物 | ✅ 已验证 |

**关键取舍**：iOS / Android / 鸿蒙都能走“PWA 添加到主屏”——**免上架、免审核、免开发者账号**，
是零门槛先把产品交付到用户手机上的路径。原生壳（Capacitor）用于需要进 App Store / 应用商店的场景。

**用户怎么拿到这些东西**：一个页面 `web/download.html` 列出全部平台（自动识别来访系统），
清单 `web/releases.json` 只登记**真实存在**的产物（真实大小 + 真实 SHA256），没有产物的平台
照实显示“尚未产出 + 原因”。见 §3.6。

---

## 1. 通用安装型 Web 应用（PWA）— 已在本机验证

这是覆盖 **iOS + Android + 鸿蒙 + 桌面浏览器** 的统一底座，且完全不需要商店。

**真实产物（已生成并验证）：**

```
web/icons/favicon-32.png            32×32     714 B
web/icons/favicon-64.png            64×64     1,286 B
web/icons/icon-192.png             192×192    3,279 B
web/icons/icon-512.png             512×512    8,190 B
web/icons/apple-touch-icon-180.png 180×180    2,552 B
web/icons/maskable-512.png         512×512    7,177 B
web/manifest.webmanifest
web/sw.js
```

- 图标由 `scripts/gen-icons.js` **零依赖**生成（纯 JS 的 PNG 编码器：CRC32 + IHDR/IDAT/IEND + zlib），
  山峰形状是几何绘制，不依赖字体——避免目标机器缺字导致图标空白。
- `server.js` 的 MIME 表已补 `.webmanifest → application/manifest+json`。
- 实测静态服务（本机探针）：

```
/                             200  text/html; charset=utf-8
/manifest.webmanifest         200  application/manifest+json; charset=utf-8
/sw.js                        200  text/javascript; charset=utf-8
/icons/icon-192.png           200  image/png
/icons/maskable-512.png       200  image/png
/icons/apple-touch-icon-180.png 200 image/png
```

**重新生成图标：** `npm run icons`

**Service Worker 的诚实边界**：`web/sw.js` 只缓存静态外壳（HTML/CSS/JS/图标），
`/v1/*`、`/ws`、`/verify/` 一律**不缓存**——否则用户离线时会把上一次的营收/订单当成当前值，
那就是假数据。导航请求走 network-first，在线永远拿最新页面。

**各平台安装方式：**
- Android / 鸿蒙：系统浏览器打开站点 → 菜单「添加到主屏幕」→ 生成独立图标应用。
- iOS Safari：分享 → 「添加到主屏幕」。
- 桌面 Chrome/Edge：地址栏右侧「安装」按钮（`beforeinstallprompt` 已在前端捕获，供设置页展示引导）。

---

## 2. 桌面端（Windows / macOS / Linux）

壳在 `electron/`：`main.cjs` 启动内置 API 服务并加载 UI（内置服务被强杀时自动重启），
`preload.cjs` 通过 IPC 把管理令牌交给渲染层，**令牌不进入渲染进程全局作用域**。

`package.json` 的 `build` 现在是三平台配置（`win` / `mac` / `linux`），产物命名
`BingDashanAI-${version}-${os}-${arch}.${ext}`。

```bash
npm run icons          # 先生成图标（mac/linux 的图标从这里来）
npm run dist:win       # Windows 本机可直接出 .exe
npm run dist:mac       # 只能在一台 macOS 上跑
npm run dist:linux     # Linux 或 CI
npm run dist:all       # 三平台一起（各自在对应系统上）
```

**CI 一键出全平台包**：`.github/workflows/build-desktop.yml`
（`windows-latest` / `macos-latest` / `ubuntu-latest` 各建各的，产物上传到 Actions Artifacts）。
打 tag（`v*`）或手动 `workflow_dispatch` 触发。

**诚实说明：**
- macOS 的 `.dmg` **只能在 macOS 上**构建（Electron 硬性限制），所以放在 CI 的 mac runner 上，本地 Windows 出不了。
- 未签名的 mac 包首次打开需“右键 → 打开”，或 `xattr -dr com.apple.quarantine <App>`。
  正式对外分发要 **Apple Developer 账号（$99/年）+ 开发者证书 + 公证（notarization）**，这一步需要你提供账号。
- Windows 安装包目前 `signAndEditExecutable: false`（未做代码签名，会触发 SmartScreen 提示）；
  去除警告需要 **Windows 代码签名证书**。

---

## 3. 移动端原生壳（iOS / Android）— Capacitor 8.5.3，已生成真实工程

已执行并可复现：

```bash
npx cap add android     # 生成 android/（Gradle 工程，AGP 8.13 / Gradle 8.14 / compileSdk 36）
npx cap add ios         # 生成 ios/（Xcode 工程，Capacitor 8 用 SPM）
npm run cap:sync        # 把 web/ 资产同步进两个工程
```

**真实产物（已确认存在）：**

```
android/gradlew                                       # Gradle 包装器
android/settings.gradle
android/app/build.gradle                              (namespace com.bingdashan.agent)
android/app/src/main/AndroidManifest.xml
android/app/src/main/assets/capacitor.config.json
android/app/src/main/assets/public/index.html          # 打包进 App 的 web 资产
ios/App/App.xcodeproj/project.pbxproj
ios/App/App/Info.plist
ios/App/App/public/index.html
```

**壳的加载方式（`capacitor.config.json`）**：因为前端用的是相对路径 `/v1/...`，
壳配置 `server.url = https://bingdashanai.highkingflower.com`，即 App 直接加载**线上站点**。
好处是零前端改动、永远是最新版；代价是必须联网（见下方“商店风险”）。

**构建：**
```bash
# Android（需 Android SDK + JDK 21）
npm run cap:sync
npm run cap:open:android          # 打开 Android Studio，或：
cd android && ./gradlew assembleDebug   # 产物 android/app/build/outputs/apk/debug/app-debug.apk

# iOS（需 macOS + Xcode）
npm run cap:sync
npm run cap:open:ios              # 打开 Xcode 签名并 Archive
```
CI：`.github/workflows/build-mobile.yml`（Android 真出 debug APK；iOS 只做「工程可编译」校验）。

**需要你提供才能完成的部分（不伪造）：**
- Android 上架：**Google Play 开发者账号（$25 一次性）+ 签名 keystore**（`keytool` 生成，务必离线备份）。
- iOS 上架：**Apple Developer 账号 + 证书 + Provisioning Profile**；iOS 构建**必须有 macOS**。

**⚠️ 商店审核风险（必须提前知道，避免白做）：**
把网站直接包一层 WebView 提交，Apple 审核指南 **4.2「最低功能要求」** 很可能以
“只是一个网页包装”为由拒审。要过审通常需要：离线可用、推送、原生能力（相机/通知/钱包）等。
**因此本项目的主推移动方案是 PWA（第 1 节），原生壳作为“进商店”的备选。**
这是行业事实，不是我们可以绕过的。

---

## 3.5 鸿蒙 HarmonyOS

鸿蒙系统浏览器（ArkWeb）对 PWA / Web 标准的支持与 Chrome 系一致，**同一套 `web/` 资产直接可用**，
通过“添加到主屏幕”安装，无需 HarmonyOS 专用壳工程或 HAP 打包。

- 已具备：`manifest.webmanifest` + `sw.js` + 图标，覆盖鸿蒙浏览器可安装条件。
- 诚实说明：**没有**提供 `.hap` 原生包。那需要 DevEco Studio + 华为开发者账号 + ArkTS 工程，
  属于另一条独立产线；在只有浏览器可用性需求时，PWA 已经等价可用。若确实要做原生 HAP，
  告诉我，我按华为官方流程单独出一套（同样不会伪造产物）。

---

## 3.6 客户自助下载：一个页面 + 一条命令 + 一个 tag

```bash
git add -A && git commit -m "cross-platform packaging"
git tag v2026.0.1 && git push origin v2026.0.1
# CI → .github/workflows/release.yml：3 家 runner 各建各的 + Android APK，
#      算真实 SHA256 生成清单，挂到 GitHub Release
```

- **页面** `web/download.html`：自动识别来访系统、按平台给按钮、显示真实大小与 SHA256。
  **没有产物的平台照实写“尚未产出 + 原因”**，绝不放会 404 的假链接。
- **清单** `web/releases.json`：由 `scripts/make-release.js` 扫描**真实存在的产物**生成，SHA256 是本地实算。
  三态分明：`有下载地址` / `已构建·未发布` / `完全没有`。
- **发布（本机/服务器）**：

```bash
npm run release:make                # 只更新清单
npm run release:make -- --copy      # 复制产物到 web/downloads/，写 /downloads/<file> 地址（自托管）
npm run release:make -- --base https://github.com/OWNER/REPO/releases/download/v2026.0.1
```

- 两个 CI 的分工：`build-desktop.yml` 只把产物留在 Actions Artifacts（给人看）；
  `release.yml` 才会**发布成对外可下载的 Release 资产 + 清单**。
- `web/downloads/` 已进 `.gitignore`（单个 Windows 安装包约 81MB，不进 git 历史）。
- 静态服务已为 `.exe/.dmg/.apk/.deb/.AppImage/.zip` 补上正确 MIME + `Content-Disposition: attachment`，
  并过滤文件名中的非 ASCII 字符（防响应头注入），避免浏览器把安装包当文本内联打开。
- Service Worker **不缓存** `/releases.json` 与 `/downloads/*`：否则用户会一直看到旧版本、点旧安装包。

---

## 4. 收费墙与订阅（已配置，可运行）

**规则（`core/subs.js` 顶部注释，产品钦定）：**
- 全站免费额度 **10 次**（`FREE_USES = 10`），用尽进入订阅墙。
- 定价：中文 首月体验 ¥1 / 月度 ¥99 / 季度 ¥269 / 年度 ¥899；
  英文 首月体验 $1 / 月度 $12 / 季度 $29 / 年度 $119。
- 收款：微信或支付宝收，入账统入支付宝（settle = 支付宝）。
- 邀请返利：1 个付费好友 → 返 1 个月；3 个 → 3 个月；10 个 → 1 年。首月 ¥1 体验单**不计入**返利（防刷）。

**分区分节配额**：权威定义在 `core/paywall.js` 的 `SECTIONS`（端点→分区映射 + 每区配额），
`core/subs.js` 从中读取，避免两处漂移。

**三道闸门（`server.js`）：**
1. `autoGate(req,q,res,p)`：对所有登记为“应收”的端点统一拦截（第 15 条）。
2. 变更限权：非回环 + 无 `X-Admin-Token` 的 POST/PUT/PATCH/DELETE 一律 403（`PUBLIC_MUTATE` 白名单除外）。
3. 端点内 `gateContent` / `gateSection`（如 `/v1/report/seven` 返回 402 收费墙）。

> 本轮修复的一个真 bug：`isLoopback()` 现在识别代理头（`X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Host`）。
> 否则经 nginx 反代后，**所有**请求的 `remoteAddress` 都是 `127.0.0.1`，公网任意访客都会被判成“本机运营”，
> 运营接口与收费墙对全世界敞开。配套把 `/v1/report/seven` 加进 `PUBLIC_MUTATE`，让公网访客能走到
> 端点内部的 402 收费墙，而不是被权限 403 一刀切（否则这条付费转化链在公网是断的）。

**收款配置（上线后必须做，否则用户看到的是空收款信息）：**
```bash
# 读取当前运营令牌
node -e "console.log(require('./core/store').getSetting('adminToken'))"
# 写入收款方式（令牌走 header；敏感键不会回吐）
curl -X POST https://<域名>/v1/subs/pay-config \
  -H "X-Admin-Token: <令牌>" -H "Content-Type: application/json" \
  -d '{"receiveAccount":"你的支付宝账号","receiveQrAlipay":"<支付宝收款码URL>","receiveQrWechat":"<微信收款码URL>"}'
```

---

## 4.5 下载版的收费墙：离线授权码（Ed25519 签名）

§4 的收费墙是按**访客**判定的，前提是能分清“公网访客”和“本机运营”。**下载安装后的桌面/手机版没有这个前提**：
`electron/main.cjs` 里那个内置服务只监听 `127.0.0.1`，所有请求都是“回环”，用户既是本机运营、
也能自己改设置 → 原来的**下载版等于没有收费墙**。这是本轮修掉的设计缺口，不是配置问题。

**两层修法**

| 模式 | 客户端怎么跑 | 收费墙在哪 | 能不能绕过 |
|---|---|---|---|
| **客户端模式**（安装包默认） | `BINGDASHAN_CLIENT=1`；强制开启收费墙且**禁止关闭**；不提供签发接口 | 本机，用**授权码**换出的本机权益 | 改程序/内存能绕过（离线 DRM 的通病）——**如实说明，不吹** |
| **托管模式**（要“绝对拦得住”就用它） | `BINGDASHAN_SERVER_URL=https://域名`；App 只当纯客户端，**不启动本机服务** | 运营方服务器，看订阅表 | 绕不过（权益与计费都在服务器判定） |

**授权码怎么工作**

- 算法 **Ed25519**（`core/license.js`）：运营方持**私钥**签发，客户端只内置**公钥** `license.pub`
  （已加进 `package.json` 的 `build.files`，随安装包发布）→ 客户端能验签，**无法伪造**授权码。
- 格式 `BDS1-<base64url(payload)>.<base64url(sig)>`；payload 含 `plan / iat / exp / fp(可选机器绑定) / who(买家备注)`。
- **激活** = 用授权码在本机换出一条与公网订阅**同构**的 `sublist` 记录 → 既有闸门
  （`gate` / `gatePool` / `autoGate`）**不改一行**就生效。
- **反重用**：每枚码的 `id` 在本机有一条 `licenseActivated` 账，同一枚码在同一台机器二次激活会被拒（`REUSED`）。
- **机器绑定**：签发时带 `--fp <机器码>`，则只能在那台机器激活；换机先在激活页「解绑」。

**运营端闭环（三条命令）**

```bash
npm run license:keygen     # 只做一次：生成 license.pub（仓库根，随包发布）+ license.key（数据目录，机密）
npm run license:signing    # 自查：私钥是否就位、可信公钥从哪来
npm run license:issue -- --plan m --who buyer@example.com        # 可选 --fp <机器码> 绑定设备
npm run license:verify -- BDS1-...                              # 只验签，不激活
```

> 私钥来源顺序：环境变量 `BINGDASHAN_LICENSE_KEY` → **数据目录** `license.key` → 仓库根 `license.key`。
> 私钥**绝不进安装包、绝不进 git**（`.gitignore` 已拦 `license.key`）。
> 客户端模式下**只认**环境变量与随包发布的 `license.pub`，不允许从设置里读公钥——
> 否则用户写进自己的公钥就能自签自验，整个机制归零。

**用户界面**：`web/activate.html`（App 内打开，调用 `/v1/license/status|activate|deactivate`）。
它会显示状态、到期时间、剩余天数、机器码（可复制发给客服），并能解绑换机；
每个失败码（`BAD_SIGN` / `EXPIRED` / `FP_MISMATCH` / `REUSED` / `NO_PUBKEY`）都有对应的中文处置说明。

**诚实边界（已写进 `core/license.js` 顶部注释）**：纯离线授权**不可能 100% 防破解**——
有能力的用户仍可改本机程序。它的作用是让正常用户**买得到**、让白嫖不再“点一下就行”，并把商业闭环接上。
要“不可绕过”，用上表的**托管模式**。

---

## 5. 商业闭环（端到端，已实现）

```
落地页/访问 → /v1/subs/identity 建立访客身份
  → 免费 10 次（免费墙内试用到价值）
  → 额度用尽 → 收费墙 402 → 收银台 /v1/subs/order 生成订单
  → 用户支付（支付宝/微信收款码）
  → 运营侧 /v1/subs/confirm 确认到账（真实到账才开通，绝不预开通）
  → /v1/subs/activate 开通订阅 → 收费墙对该访客全放开
  → 邀请返利 /v1/subs/bind、/v1/subs/redeem 拉新
  → 到期 /v1/subs/renewal、/v1/subs/due 提醒续费
  → 我的沉淀 /v1/my/assets 按访客隔离（续费价值锚点）
```
配套模块：`core/money.js`（只认真实到账）、`core/crm.js`（漏斗，金额只认人工确认的成交）、
`core/evidence-pipeline.js`（证据管线）、`core/free-tier.js`（免费额度发现）。

**当前真实经营数据：0 客户 / 0 营收。** `loopHealth` 保持 0，直到有真实营收才允许 >0。
Alipay 直连目前 `isv.invalid-signature`（无有效密钥对）→ **当前不具备在线自动收款能力**，
线上收款走“收款码 + 人工/对账确认”这条真实可行的路径。

---

## 6. 上线部署（Linux 服务器，完整路径已存在）

```bash
bash deploy/deploy.sh <服务器IP> <SSH用户> [SSH端口]
# 例：bash deploy/deploy.sh 8.155.53.12 root 22
```
脚本真实执行：装 Node20 + nginx + certbot → `rsync` 代码到 `/opt/bingdashan` →
写 systemd（`deploy/bingdashan.service`）与 nginx（`deploy/nginx.conf`）→
Let's Encrypt 签发证书 → 启动并自检。域名：`bingdashanai.highkingflower.com`。

**部署前置（需要你提供/做）：**
1. ECS 安全组放行 **80 / 443**；**不要**对公网放行 3721（Node 只监听 `127.0.0.1:3721`）。
2. DNS：`bingdashanai.highkingflower.com` 的 A 记录指向服务器 IP（`nslookup` 验证）。

**部署后必做：**
1. 取运营令牌（见 §4），在 `/app` 的“运营令牌”输入框填入并保存（前端存 `localStorage.bd_adminToken`，
   之后接口自动带 `X-Admin-Token`；公网非回环必须带，否则被闸门拦）。
2. 配置收款方式（见 §4 的 `pay-config`）。
3. 泄露则轮换：`curl -X POST https://<域名>/v1/subs/rotate-admin-token -H 'X-Admin-Token: <旧令牌>'`。

`render.yaml` 也在（供 Render 平台托管，可选）。

---

## 7. 上线前检查清单

- [ ] `node test/e2e/suites/goal-e2e-runner.js` 全绿（见 `SERVER-STATUS.md`）
- [ ] `npm run icons` 已生成图标，`/manifest.webmanifest`、`/sw.js` 返回 200 且 MIME 正确
- [ ] **`license.pub` 已提交进仓库，且 `asar list` 里能看到它**（缺失 ⇒ 下载版所有授权码都报 `NO_PUBKEY`，且只有到用户手里才发现）
- [ ] **`asar list` 里能看到 `core/license.js` 与 `skills/agent-skills/**`**（`!**/*.md` 会把 `SKILL.md` 一起排掉，必须用**后置** include 补回）
- [ ] **`.env` 与 `license.key` 不在包内**（`asar list` 搜不到；私钥只在数据目录/环境变量）
- [ ] 下载页 `/download.html` 显示真实版本与 SHA256；**没有产物的平台显示“尚未产出 + 原因”**，不是假按钮
- [ ] `/releases.json` 与 `/downloads/*` 不被 Service Worker 缓存（能看到最新版本）；`npm run release:make` 后 SHA256 与产物一致
- [ ] 装一遍**下载版**（客户端模式）：无授权码时付费功能确实被拦；粘贴正确授权码后开通；乱改的码被拒（`BAD_SIGN`）
- [ ] 至少一个平台产物可安装（Windows `.exe` 已可；mac/linux/手机走 CI）
- [ ] 服务器：80/443 放行、DNS 生效、`deploy.sh` 跑通、HTTPS 证书有效
- [ ] 运营令牌已在管理端保存；收款方式已写入并被回显（mask 后）
- [ ] 用真实访客身份走一遍：免费 10 次 → 402 → 下单 → 确认到账 → 开通 → 墙消失
- [ ] `loopHealth` 仍为 0 直到有真实营收（诚实红线）

---

## 8. 我没有伪造的东西（诚实边界）

- 没有编造任何客户、营收、评价、付款能力或“已上架”的证据。
- 没有产出 macOS `.dmg` / iOS `.ipa` / 鸿蒙 `.hap`——它们在当前 Windows 环境里本就产不出，
  我给的是**能在对应环境里真实构建的配置、脚手架和 CI**，以及它们在哪儿被构建。
- macOS/iOS 需要 Apple 硬件与开发者账号；Android 签名需要 keystore；这些是外部许可，只能由你提供。
- 直连支付宝支付当前不可用（`isv.invalid-signature`），所以线上收款不谎称“自动到账”。
- `loopHealth = 0`、真实经营 0 客户 0 营收，照实呈现。
- **安装包未做代码签名**（本机没有 Windows 代码签名证书 / Apple Developer 证书）：Windows 会弹
  SmartScreen 警告、macOS 需右键→打开，下载页已如实提示。不谎称“已签名”。
- **离线授权码不可能 100% 防破解**：能改本机程序的人仍可绕过。它解决的是"让正常用户买得到、
  白嫖不再点一下就成"；要不可绕过请用**托管模式**（`BINGDASHAN_SERVER_URL`）。
  这一点写在了 `web/activate.html` 与 `core/license.js` 的注释里，不藏着。
