# 丙大山AI Agent（BingDashanAI）

跨世代智能助理系统：对话 + 决策 + 组织 + 项目 + 审计 + 设置 + **大脑（记忆/学习/进化/自适应/命令）**。

## 功能全景
| 模块 | 核心能力 |
|---|---|
| 智能对话 | 语音🎤、摄像头📷、8家模型、中/英/法/阿 语言、文本/语音输出、文件拖放 |
| 决策中心 | 自动下滑、手动/对话双写决策、CSV 导出 |
| 组织大脑 | 员工自建/点选、在岗统计、健康心跳 |
| 项目管理 | 多项目并行、进度/状态管理、自动下滑 |
| 审计日志 | 每操作留痕、筛选、CSV 导出 |
| 系统设置 | 十色主题、警告声、自更新检查、默认模型/语言 |
| 大脑(Brain) | 记忆召回、学习统计、进化日志、命令路由、智能降级、自适应参数 |

## 8 家模型密钥
在 `.env` 填入即可（留空则该家显示"未配置"，对话自动降级到已配置通道）：
`AGNES_API_KEY` / `ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY` / `VOLCENGINE_API_KEY` / `MINIMAX_API_KEY` / `MOONSHOT_API_KEY` / `NVIDIA_API_KEY`

## 命令（对话框以 / 开头）
`/help` `/stats` `/evolve` `/remember <内容>` `/recall <关键词>` `/model <id>` `/theme <名称>` `/lang <中|en>` `/clearmem`

## 启动
```bash
npm install
npm run dev      # 仅后端 + 浏览器访问 http://127.0.0.1:3721
npm start        # Electron 桌面
npm run dist:win # 打包 Windows 安装包（输出 app/BingDashanAI-<版本>-win-x64.exe）
npm run release:make   # 扫描真实产物生成客户下载清单 web/releases.json（真实大小 + 真实 SHA256）
npm run release:make -- --copy   # 同时把产物复制到 web/downloads/，下载页立刻可用
```

## 授权与收费墙（下载版）
安装到用户电脑上的版本**没有**公网/本机之分：内置服务只监听 `127.0.0.1`，原来的"按访客判定"
收费墙等于不存在。现在用**离线授权码（Ed25519 签名）**补齐：

```bash
npm run license:keygen    # 只做一次：license.pub（打包进客户端）+ license.key（数据目录，机密，务必备份）
npm run license:signing   # 自查本机签发能力
npm run license:issue -- --plan m --who buyer@example.com   # 可选 --fp <机器码> 绑定设备
npm run license:verify -- BDS1-...
```

- 客户端只内置**公钥**，能验签、**无法伪造**授权码；激活后写出一条与公网订阅同构的记录，
  既有闸门一行不改即生效。
- 打包版默认进入**客户端模式**（`BINGDASHAN_CLIENT=1`）：强制开收费墙、禁止关闭、不提供签发接口。
- 要"不可绕过"的收费墙，用**托管模式**：`BINGDASHAN_SERVER_URL=https://域名`，App 只当纯客户端，
  权益与计费全在服务端判定（此时不启动本机服务）。
- **诚实边界**：纯离线授权不可能 100% 防破解（能改本机程序的人仍可绕过），它解决的是
  "让正常用户买得到、白嫖不再点一下就成"。要不可绕过请用托管模式。
- 客户端界面：`web/activate.html`（状态/到期/剩余天数/机器码/解绑，每个失败码都有中文处置说明）。

## 能力架构
- `server.js` 原生 http API（零框架），端口 3721（BINGDASHAN_PORT 可改）
- `core/providers.js` 8 家 LLM 适配器（OpenAI 兼容）
- `core/brain.js` 记忆/学习/进化/命令/自适应/降级
- `core/store.js` JSON 持久化（data/db.json，零 native 依赖）
- `web/index.html` 单文件 UI（设计系统 + 十色主题 + 自动下滑）

## 文档
- `MCP.md` — 标准 MCP 协议适配（服务端 + 客户端）与只读经营视图 `/v1/crm/*`
- `LIGHTNING.md` — Agent Lightning 原理落地（模型代理层 / 轨迹 / 奖励 / 训练样本导出）
- `WLED.md` — WLED 物理通知桥（真实开源固件，只走其本地 JSON API；灯亮≠收入）
- `COMMERCIAL-AUDIT.md` — 商业闭环逐阶段体检、竞品实证、定价与粘性数据、查缺补漏清单
- `DECISION-SKILLS-CATALOG.md` · `SKILL-INTEGRATION-PLAN.md` — 决策技能与技能接入
- `CROSS-PLATFORM.md` — **多平台交付与上线手册**（Windows/macOS/iOS/Android/鸿蒙/浏览器安装、收费墙与授权码、自助下载、部署与上线检查清单）
- `SERVER-STATUS.md` — 服务端文件事故的恢复结论与当前状态
- `skills/SOURCES.md` — 各技能包的仓库出处、许可证、锁定 commit 与它们各解决什么问题（含逐字节核对结论）

## 多平台交付（一套资产，多种壳）

同一个零依赖 Node 服务 + 原生 web 前端，交付到所有平台：

| 平台 | 形态 | 命令 |
|---|---|---|
| Web / iOS / Android / 鸿蒙 | **PWA（可安装，免上架）** | `npm run icons` → 部署后浏览器“添加到主屏” |
| Windows 桌面 | Electron 安装包 | `npm run dist:win` |
| macOS 桌面 | Electron dmg/zip（须在 Mac 上） | `npm run dist:mac` |
| Linux 桌面 | Electron AppImage/deb | `npm run dist:linux` |
| iOS / Android 原生 | Capacitor 壳 | `npm run cap:sync` → `cap:open:android` / `cap:open:ios` |

自动化出全平台包：`.github/workflows/build-desktop.yml`（构建到 Actions Artifacts）、`build-mobile.yml`（Capacitor）。
**客户自助下载 + 发布**：`web/download.html`（自动识别系统、真实大小与 SHA256、没产出的平台照实写原因）+
`web/releases.json`（`npm run release:make` 扫描真实产物生成）；打 tag（`v*`）由
`.github/workflows/release.yml` 在 3 家 runner + Android 上产出并发布到 GitHub Release。详见 `CROSS-PLATFORM.md`。


## 经营口径（重要，防止看错数）

`/v1/commercial-loop/status` 里有两个**必须分开看**的数：

- **`loopHealth` 闭环健康度** = 已确认证据维度 ÷ 总维度，只认真实产出。零成交时就是 `0`。
- **`wiringPct` / `stagesWired` 已建管道** = 8 个阶段里建好几段管道，与闭环成不成**无关**。

以前这两个数被合成一个：管道建了 7/8 就报"健康度 0.88"，而真实收入是 0、客户是 0 ——
那是在用好看的数字骗自己。现在管道齐备但零产出时，闭环健康度一定是 0。
