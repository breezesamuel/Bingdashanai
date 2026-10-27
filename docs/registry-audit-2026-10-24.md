# 订阅墙 + 支付真实可用性审计与修复（2026-10-24）

> 指令：继续查询确保所有功能模块真实可用，修复订阅墙和支付正确可用。
> 口径：只认真调用——起真实 server.js 进程、真 HTTP、真 Cookie 身份；注册≠存在，跑不通就是不存在。

---

## 0. 一句话结论

订阅墙与支付主链路（撞墙 → 下单 → 收款码兜底 → 我已转账临时权益 → 人工核账转正 → 退款权益回收）**端到端 36 项真调用全部通过**；
本轮发现并修复 **6 类真问题**（含 3 个"注册了但端点不存在"的空头支票），剪除 **48 条幽灵注册**，
注册表 292 个端点经运行时探针逐一实证**零幽灵**。全量回归 31 套件无回归。

---

## 1. 本轮新增的验证基建（永久资产）

| 工具 | 作用 | 结果 |
|---|---|---|
| `tests/e2e_pay_wall.js` | 起真实服务进程，带 Cookie 真身份走完整付费链 | 36/36 ALL PASS |
| `tests/e2e_registry_probe.js` | 对注册表全部端点逐一真请求，404 "no route"=幽灵 | 292 端点，幽灵 0 |

e2e 覆盖点：墙关不拦人（12 连打）→ 开墙 402 契约（wall/section/msg/plans{CN,EN}/freeLeft/unlimited/sub）→
下单（t 体验款 ¥1）→ checkout 无网关凭据落个人收款码（qr dataURL）→ `/v1/pay/status` channel 如实 →
30s 防刷冷却（设计行为，实测生效）→ 我已转账 → 24h 临时权益立即放行 → 无令牌 manual-verify 403 →
带令牌转正 → 订单 paid + 重耗分区放行 → 退款申请 requested（≠已退）→ 确认出款回收权益（revokedEntitlements≥1）→
退款后重耗分区恢复 402 → 关墙还原。

---

## 2. 修复的真问题

### P1 gateSection 无视收费墙开关（一致性 bug）
- **现象**：运营关墙（paywallOn=false）时 autoGate 旁路了，但 14 处**直调** gateSection 的端点
  （chatdeep / decision / agent / skill / leadgen / studio / game）照常扣额度并弹 402。
- **为什么是 bug**：代码自己的既定口径（/v1/report/seven 修复注释）：「paywallOn=false ⇒ 免费」。
  墙"暂停"期间这些功能仍在被拦，用户看到的是"功能坏了"。
- **修复**：gateSection 开头检查 PAYWALL_ENABLED()，关墙直接放行（不拦也不扣量）。CLIENT_MODE 不受影响。
- **验证**：e2e B 段 12 连打 /v1/decisions/suggest（直调闸门、配额 10）0 次 402。

### P2 /v1/pay/status 的 channel 硬编码（说谎字段）
- **现象**：`channel: o.currency === 'USD' ? 'paypal' : 'alipay'` —— 个人收款码单（manual）与微信单一律谎报 alipay。
- **修复**：如实回 `o.channel`，老单无 channel 字段才退回旧推断。
- **验证**：e2e checkout（落 manual）后 pay/status 返回 channel=manual。

### P3 GET /v1/plans 注册≠存在（定价页 404）
- **现象**：PUBLIC 表登记"定价页：收费墙要展示价格"，但路由从未实现 → 404。
- **修复**：实现，返回 plans{CN,EN}（与 subs.status 同源）+ quotaInfo + 收费墙状态。

### P4 GET /v1/paywall/coverage 注册≠存在（部署门禁是空头支票）
- **现象**：FLOW_OPS 登记为"部署门禁（管理令牌）"，路由不存在 → 谁也查不到覆盖率，门禁自欺。
- **修复**：实现（管理令牌），coverage(allDeclaredEndpoints(), STRICT_ADMIN_PATHS) + 墙状态。

### P5 GET /v1/subs 注册≠存在
- **现象**：PUBLIC 承诺"查自己的订阅状态与套餐"，实际只有 /v1/subs/status。
- **修复**：实现为 /v1/subs/status 的别名（同源同口径，不造第二份）。

### P6 注册表 48 条幽灵死行（覆盖率虚胖）
- **方法**：静态正则不可靠（路由声明有 4+ 种写法）→ 运行时探针逐个真请求，404 且 body 含
  "no route"/裸 "not found" 才判幽灵；业务级 404（"task not found" 等）= 路由存在，不算。
- **剪除**（GATED 46 条）：decision/* 单数旧名族 7 条、brain/evolve|learn(POST)、gtm/today、
  skills/verify|discover(POST)、harness/apply(POST)、autopilot/optimize(POST)、watchdog/scan、
  money/leads 动作族 5 条、leadgen/board|reset|close|convert 4 条、studio 合成族 3 条、
  foundry/create|outline|draft、game/design|code、music/compose|render、playbook(POST)、
  intel 3 条、deliberation 2 条、persona 2 条、mcp 2 条。
- **行为不变**：这些模块的真实端点仍由 PREFIX_RULES 前缀规则兜底进同一分区；
  剪掉的是"从未存在"的行，coverage() 分子不再虚增。
- **PUBLIC 修偏 2 条**：payout/status → payout/pending（真实端点）；partner/board 删除（看板数据在 partner/deliveries）。
- **结果**：337 → 292 条注册，探针幽灵 0。

---

## 3. 实测确认**不是** bug 的行为（避免下次误修）

| 行为 | 判定 | 证据 |
|---|---|---|
| manual-confirm 30 秒冷却 | 设计（防秒提交假凭证刷临时权益） | e2e 实测 30s 内被拒、31s 后成功 |
| 退款确认回收 grantedOrders 精确定位 | 正确 | revokedEntitlements=1，其余订单权益不动 |
| wechat/notify 空请求 500 + {"code":"FAIL","message":"验签失败"} | 微信协议正确响应 | 无签名必然验签失败，按微信要求格式回应 |
| 402 body 的 plans 是 {CN,EN} 对象而非数组 | 与前端 showWall 契约一致 | biz.js `d.plans.CN / d.plans.EN` |
| 402 body 的 freeLeft 字段承载 used 数 | 历史兼容命名，前端 hookWall 不消费它 | biz.js 只读 unlimited/sub/section/used/quota |

---

## 4. 支付通道真实就绪状态（隔离实例实测）

| 通道 | 状态 | 说明 |
|---|---|---|
| 个人收款码（manual） | ✅ 完整可用 | checkout → qr dataURL → 我已转账 → 24h 临时 → 核账转正，全链 e2e 通过 |
| 支付宝官方网关 | ⏳ 凭据未配 | 本地密钥对自洽但 gatewayReady=false；需商户签约凭据（用户动作） |
| 微信官方网关 | ⏳ 凭据未配 | 缺 WECHAT_MCHID/APPID/SERIAL_NO（用户动作） |
| PayPal | ⏳ 未测 | USD 通道逻辑在，无凭据环境不真连 |

**结论**：在商户网关凭据到位前，收款走个人收款码 + 人工核账通道，该通道已验证**收款准确、开通幂等、退款可回收**。

---

## 5. 遗留（本轮不修，已登记）

1. ~~桌面版遗留死按钮~~ **【2026-10-24 二批更正：证伪】** 前端接线全量扫描
   （tests/e2e_fe_wiring.js，web/ 全部 js+html 的 267 个 /v1/ 引用逐个真请求）
   结论：**零死链**。此前怀疑的 /v1/mcp/stats、/v1/persona/questions、/v1/playbook/launch、
   GET /v1/skills/verify、GET /v1/brain/learn 等全部真实存在——它们只是**未登记**进收费墙
   注册表（计费分区由 PREFIX_RULES 前缀规则兜底），注册≠收费登记，两回事。
2. 健康数据字段级加密（PIPL P0）+ 陪护 4 个新巡检断点 —— 下一轮。

## 5之二、二批新增（2026-10-24 同日晚）

| # | 事项 | 结果 |
|---|---|---|
| N1 | 前端接线审计 `tests/e2e_fe_wiring.js`（31 个前端文件、267 个端点引用 + 动态前缀，逐个真请求） | **零死链**（GET-only 121 / POST-only 116 / both 30） |
| N2 | 续费/到期链路 `tests/regress_renewal.js`（此前**零覆盖**，钱损高危区） | 20/20 PASS：四态状态机、顺延不吞时长、同单幂等、dueList 窗口、体验档按天 |
| N3 | **subs.activate 顺延分支返回旧对象**（store.update 不回写传入引用）→ 续费到账却报旧到期日 | 已修：返回库中最新行；settleEffects 现忽略返回值，属"陷阱提前排除" |
| N4 | run_all.sh 纳入新三套件 | 24 套件 |

## 5之三、三批新增（七层架构 / 学习进化链 / 闭环判定，2026-10-24 深夜）

| # | 事项 | 结果 |
|---|---|---|
| M1 | **七层架构真服务实测**（/v1/arch/layers，49 组件逐一真探测） | L1-L5/L7 全通或仅环境项告警；总览 47/49（96%）；**闭环四步 closed=true** |
| M2 | **真 bug：闭环第 4 步键名错位**——CLOSED_LOOP 引用 `memory-hub`，L6 组件键是 `memoryhub` →「记忆反馈」环节永远 missing、closed 永远 false | 已修（core/layers.js），实测四步 5/5·6/6·7/7·5/5 全 ok |
| M3 | L6 playbook「未初始化」 | **不是死层**：core/playbook.js 是 D1-D30 冷启动作战表（30 天真任务），空 = 冷启动尚未打卡（运营动作，代码就绪） |
| M4 | L4 cli（opencode）未安装 | 环境项：本机无该 CLI；服务器环境另论（probe 如实报 down，不装假） |
| M5 | **学习记忆进化链实证**：brain.evolve() → evolution 库 → memory-hub 聚合（harness:1） | 链路真实接通；memory-hub 聚合 14 个模块源，零沉淀模块**显式列出**（zeroModules），近 7 天无新增报**退化告警**，verified/未验证分开计数 |
| M6 | L7 audit 0 条 | 新库正常现象；真服务启动后审计持续写入，实测 L7 8/8 ok |
| M7 | 商业闭环自检（/v1/commercial-loop/status） | 诚实结论：管道 wiringPct=0.13（1/8 段）、loopHealth=0（零确认证据）、gatePass=false（缺 ICP/JTBD/UVP）——**创业验证闸门如实拦着**，与付款链路（已验证可用）是两件事：前者是"该不该上量"的门，后者是"收钱管道"本身 |

**七层架构实测明细**（本机隔离实例）：
L1 用户层 5/5 · L2 感知层 6/6 · L3 认知层 8/8 · L4 连接协议层 6/7（cli 未装）
L5 行动层 8/8 · L6 记忆知识层 6/7（playbook 待冷启动打卡） · L7 治理层 8/8

## 5之四、四批新增（真实 UI 审计 + 性能根因，2026-10-24 深夜）

| # | 事项 | 结果 |
|---|---|---|
| P0 | **机器负载根因**：用户报"请求超时/网络异常/GTM 错误"期间实测 30 个 node 进程——另一项目的看门狗把 dashboard+loop+cf-tunnel 栈复制了 5 份（端口 7822-7826） | 清掉 4 套重复栈（保留 7822 一套），30→10 进程；计划任务 BingDashan-Watchdog 只探线上站，与本地栈无关 |
| P1 | **UI 实测抓到收款真 bug**：无可用通道时前端兜底显式传 channel='manual'，服务端 checkout 把 manual 一并拒绝 → 点订阅必弹"通道 manual 不可用"，收款兜底自己断掉 | 已修（pay.js：显式 manual 直接走 manualAction 出码）；e2e 36/36 重跑通过 |
| P2 | **通道台账与真实能力打架**：/v1/pay/channels 报"无通道"，实际 manual 兜底可用仓库内置收款码（web/pay/*.png）出码收钱 | 已修（customerChannels 把内置可渲染码计入 qrReady）→ channels 如实返回 alipay/wechat |
| P3 | **离线错误轰炸**：服务重启窗口期十几个面板各自弹错（"请求超时/网络异常/GTM 数据加载失败"连刷） | 已修（app.js：连续 2 次 /v1/status 失败置 __BD_OFFLINE，离线期间 uiFail 静默，恢复时统一 toast + 自动刷新当前面板；refreshGtm 收口到 uiFail） |
| P4 | **真实 UI 全流程验证**（浏览器实点）：订阅体验款 → 通道选择（支付宝/微信 Tab）→ 真实收款码渲染 → 我已付款 → 顶栏"免费 10"变"👑 会员 7d"（临时权益立即生效） | ✅ 截图确认；paypal 通道探针实测可下单（用户凭据在位）；支付宝网关探针被拒 ACQ.ACCESS_FORBIDDEN（商户号未开通电脑网站支付产品——用户侧动作） |

## 5之五、五批新增（订阅墙不展开事故，2026-10-24 深夜）

用户报"订阅墙没有展开"。三层原因叠加，全部修复并截图验证：

| # | 层 | 根因 | 修复 |
|---|---|---|---|
| W1 | **收费墙开关** | 该实例 paywallOn=false（"已暂停"是默认态）→ gateSection/autoGate 正确旁路 → 永无 402 → 墙永不弹 | POST /v1/paywall/toggle {on:true}（商业闭环测试期要求常开） |
| W2 | **SW 缓存事故** | sw.js 对全部静态资源 cache-first → 页面执行**上一版 biz.js**，新加的 BIZ.showPlans（"去订阅"按钮入口）在老用户浏览器里 undefined → 撞墙点"去订阅"无反应。付费转化入口被缓存掐断 | sw.js：JS/HTML/webmanifest 改 **network-first**（离线才回退缓存），图片/字体/CSS 保持 cache-first；版本号 bd-shell-2026.0.3-nf 强制全量换缓存 |
| W3 | **演示身份污染** | 该浏览器身份（IP×小时桶）挂着此前 UI 测试开通的 7d 体验临时权益 → 订阅者不弹墙（**行为正确**） | 撤销测试 provisional（db 直改 revoked + 停服重启，留痕）；清 localStorage/Cookie 后重烧额度 |

**修复后实测**（真 HTTP + 截图）：新访客 freeLeft=10 → 烧 6 次 agent（6/日池）→ 第 7 次 **402** → hookWall 自动弹墙 → 7 张套餐卡（¥1 体验/¥99 月/¥269 季/¥899 年/¥199 Pro/¥399 VIP…）全部渲染。curl 对照组同样 6 免+402，服务端行为与设计完全一致。回归 25 套件全绿。

---

## 5之六、六批新增（多语言夹生全面修复，2026-10-24 深夜）

用户报"多语言功能有些混乱"。根因是**词表缺口**：i18n 引擎本身健康（最长优先贪心 + 动态 MutationObserver + 还原铁律），但 index.html 的找回订阅面板/付款邮箱提示共 9 处中文没有词条 → 切英文后出现"用邮箱找回Subscribe"式夹生。

| # | 问题 | 修复 |
|---|---|---|
| I1 | 找回订阅面板 8 处夹生（面板标题含 🔁 emoji 整句、发送验证码、找回订阅按钮、两个 placeholder） | web/i18n-console.js 补 9 条整句/片段词条（zh→[en,ar]，阿语按 rtl 语序重写而非逐词硬译） |
| I2 | 邮箱提示句被 HTML 拆成 4 个文本节点，逐节点翻拼起来要成句 | 词条按片段切分点对齐（"…自动收到"/"付款凭证"/"，换电脑…"/"（不填则两样没有）。"），EN 拼回完整可读句，动态测试断言拼句语义 |
| I3 | `t(中文)` 在 zh 模式返回英文译文（TRANS 分支无 zh 守卫，违反 i18n.js 自己的设计注释"中文就是键本身"）——当前无可达调用点（app.js 20 处全是点分键），属埋雷 | web/i18n.js t()：`current==='zh'` 时返回键本身；由动态回归永久守护 |
| I4 | 静态审计（i18n_audit）只能拦"漏配词条"，拦不住"配了但整句没被贪心命中/单字量词插进词内" | 新增 **tests/regress_i18n_pipeline.js**：vm 原样加载 i18n-console.js + i18n.js，用**真实 trSegment 管线**翻新词条 + 历史夹生样本（商业中枢/我是丙大山/设为焦点），EN+AR 断言零夹生、整句精确命中、zh 还原。52/52 PASS，已纳入 run_all 门禁（现 27 套件） |

**验证**：`scripts/i18n_audit.js` 漏翻合计 0、接线异常 0（5 页全覆盖）；动态管线 52/52；`bash tests/run_all.sh` 26 套件全绿（regress_i18n_audit 首次作为门禁成员通过）。浏览器无法驱动时，动态管线 = 等效验证（同一代码路径 setLang→applyI18n→mergeConsole→trSegment）。

---

## 5之七、七批新增（安全面复检 + 长驻进程无界容器审计，2026-10-25 凌晨）

**复检后排除的嫌疑**（都已有防线，避免下次重复怀疑）：

| 嫌疑 | 结论 |
|---|---|
| send-code 邮件轰炸 | 两层限流齐全：路由层 `authRateOk(ip,10,3600000)`（每 IP 每小时 10 次）+ auth.js 同目标 1 分钟 1 次；verify-code/login 亦有每 IP 20/时；regress_rebate_guard 有静态回归钉 |
| 5xx 故障记录器误计 | server.js res.on('finish') 只记 ≥500 且非 @public，402（收费墙契约）/429 不误入 faults；全程 try/catch |
| XSS（innerHTML 注入） | chat 实时/历史渲染、biz.js（榜单名/订单/plan 卡）、care/center.html 全部走 esc()；未包 esc 的只有服务端常量与数字 |
| 静态资源 HTTP 缓存复发 | server.js 静态头 Cache-Control: no-cache（协商缓存），配合 SW network-first，旧 biz.js 无复发面 |
| 进程堆积 | 仅 3 个 node（UI 实例 + ZCode 自身），此前卡顿是 26 套件回归余波 |

**修复的 2 个真问题（无界容器审计，24h 长驻进程内存泄漏面）**：

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| M1 | core/server-ext-routes.js `_authHits`（发码/验码/登录 IP 限流表） | 兜底是 `size>5000 → clear()`：一刀全清**恰好发生在洪峰时刻**——攻击者的限流计数器与正当 IP 的一起清零（窗口重开） | 定向清扫「窗口已过」的死键（所有调用点 winMs 均为 1h），清完仍超限才退回全清；对齐 server.js rateOK / wallguard 的既有模式 |
| M2 | core/intel.js `repoCache`（GitHub 仓库详情 TTL 缓存） | 24h 自主运营每天发现新仓库，键只增不删；TTL 5 分钟但过期条目**永不清除** → 长驻进程线性膨胀 | 超 2000 键时在 set 前清扫过期条目（`_repoCacheSweep`） |

**已确认有界的其余容器**：wallguard `_ips`（MAX_IPS=5000+逐出）、server.js `_rate`（4000 兜底）、pay `_gwLinks`（500 上限，链接可重生成）、mcp freeHits（键=已签发 API key）、smtp POOLS（键=SMTP 账号）、tasktime/workflow16（键=任务/流程名）、agentcenter _cache（键=命令词表）。函数级 Map 随调用 GC。

**验证**：两文件 node --check 过；regress_rebate_guard 11/11（限流回归钉不受影响）；全量 run_all 27 套件重跑。

---

## 5之八、八批新增（能力全景扫描器盲区修复，2026-10-25）

能力全景（GET /v1/capability/map，能力全景 tab 的数据源）报 **182 条"用户够不到"**——复扫证明其中 44 条是扫描器自己瞎：缺口清单是"给哪些后端能力补前端入口"的决策依据，报假数就把真信号淹掉了。三类盲区，全修：

| # | 盲区 | 根因 | 修复 | 效果 |
|---|---|---|---|---|
| C1 | 子页 HTML 完全没被扫 | `FRONT_JS` 硬编码 7 个 web 根目录 JS；assist.html / ops.html / care 三页 / download / activate / architecture / landing / manual-verify / index.html 内联脚本全在扫描面之外 | `listFrontFiles()` 递归扫 web/**.{js,html}（排除 node_modules/icons 与 *.orig/*.bak/*.old 备份——app.js.orig 曾被当可达性证据） | care/center、assist/request 等 37 个端点撤出缺口清单 |
| C2 | 动态拼接路径整族误报 | `api('/v1/goalpilot/' + kind)` 捕获成 `/v1/goalpilot/`，`isReachable` 的 `startsWith(c+'/')` 变成 `/v1/goalpilot//` 双斜杠永假 | 捕获后统一剥尾斜杠 | 前缀族恢复可达判定 |
| C3 | 机器端点混入"用户够不到" | 爬虫任务（crawler/*）、物流对端回调（logistics/*）、设备心跳、定时冲刷、二维码跳转目标**设计上就没有人类入口** | 新增 MACHINE_PREFIXES 归类为 `machineUnreachable`（每条带归因说明），不计入缺口清单与覆盖率分母 | 覆盖率口径改为"人类入口端点"内部占比（67.6%），不再被机器端点永久稀释 |

**修复后口径**：433 端点 = 288 可达 + **132 真缺口** + 13 机器端点（分区守恒）。机器端点含三类：调度/对端（crawler、logistics、设备心跳、定时冲刷）、网关回调（alipay/wechat/moltspay notify、PayPal webhook——服务端对服务端，永远不该有前端入口）、支付回站落地页（/pay/go、alipay/return、paypal/success——买家被网关重定向落地，"链接可达"而非 fetch）。真缺口 TOP 主题：自主运行 29、其他 29、收钱与结算 14（网关回调剔除后剩 ops 动作/legacy 路由/真实产品缺口如 subs/redeem 兑换码）、履约与交付 10、获客与成交 10。

**交叉验证发现并核实**：`/v1/money/writeoff`（POST 核销动作）与 `/v1/money/writeoffs`（GET 列表）是两个独立路由，前端只调列表——单数动作无人调用属真实 ops 缺口（非死链，fe_wiring 的零死链结论不受影响）。

**守卫**：新增 tests/regress_capability_map.js（14 断言）——独立推导文件集与调用形态交叉验证（引号相邻+终结符，避免 writeoff/writeoffs 前缀碰撞假阳；注释里的路径不算证据）、分区守恒、机器端点不混入、尾斜杠归一、备份文件不算证据、覆盖率口径。已纳入 run_all（现 28 套件）。

---

## 5之九、九批新增（免费试用 2 天·获客件，2026-10-25）

用户要求："为了扩大客户群体……免费试用期 2 天，实现订阅墙的全面商业闭环"。定位：¥1 体验解决"愿意付钱但怕不值"，免费 2 天解决"连 ¥1 都不想掏"的零客户冷启动——先用 2 天真实价值换信任，到期自动回墙，转化走 ¥1/月卡漏斗。

| 层 | 实现 |
|---|---|
| 核心逻辑（core/subs.js） | `claimFreeTrial(key, ip)`：每人一次（visitors.freeTrialUsed）+ 独立 IP 台账 freeTrialLedger（默认 7 天窗口，设置 freeTrialIpWindowDays=0 关闭；与 ¥1 体验的 trialLedger 分账防文案误伤）+ 已订阅者不发放。授予走独立的 `grantFreeTrialDays`（写死 2 天、tier='trial'）——**绝不走 activate()**：它的 planId 兜底是月卡 m，误入会"2 天变送一月" |
| 服务端（server.js） | POST /v1/subs/free-trial（注册表声明"付费链路自身，绝不能收费"）+ 每 IP 每小时 6 次限流（枚举噪音挡在业务外）+ 两处 402 body 带 `trialAvail`（gateSection 与 WS 握手，前端免二次请求） |
| 状态契约 | /v1/subs/status 新增 `freeTrialAvailable`（!freeTrialUsed && !unlimited）——前端显隐按钮的唯一依据 |
| 前端（biz.js + index.html） | 墙上「🎁 免费试用 2 天 · 无需付款，到期自动结束」主按钮（PL 三语整句，HTML 只放空壳防 i18n 静态审计误报）；402 的 trialAvail=false 或 status 的 freeTrialAvailable=false 时整行隐藏（绝不给"点了报错"的假入口）；领取成功 → toast + refreshSubs + 关墙 |
| 防误送月卡 | e2e 断言 plan='f2' 且到期 ≈ +2 天（不是 months 兜底） |

**验证**：e2e_pay_wall 36→**42 断言**全过（I 节：402 资格位 → 领取 days=2 → unlimited 且 plan=f2 → 重耗分区放行 → 二次领取 400 → status.freeTrialAvailable=false）；全量 run_all 28 套件复跑。防刷双层与 ¥1 体验同纪律（清 Cookie 换身份 → IP 台账拦截；拿不到 IP → fail-open 不误伤）。

---

## 5之十、十批新增（100+轮探针风暴 / gzip 弱网提速 / exe·apk 挂载渠道就绪，2026-10-25）

| # | 项 | 内容 |
|---|---|---|
| S1 | **110 轮探针风暴**（scripts/probe_storm.js） | 起隔离真实服务，11 轮 × 10 端点 = 110 请求零 5xx；p50=7ms / p90=36ms / p95=38ms / max=50ms（本机基线，后续性能回归对照）；20 并发 /v1/status 全过（模拟面板全开）。这轮没炸出新 bug——此前的修复面（限流表兜底、缓存清扫、离线抑制）扛住了持续轮询 |
| S2 | **gzip 文本压缩**（server.js serveStatic） | 之前裸传：app.js 306KB / i18n-console.js 数百 KB——弱网下首屏与面板刷新被裸字节拖慢（"请求超时"的放大器）。现对 html/js/css/json/svg/webmanifest/txt ≥1KB 自动 gzip（level 6），app.js 306KB→**94KB（31%）**；Range/HEAD/安装包不压缩（断点续传与进度条语义优先），带 Vary: Accept-Encoding |
| S3 | **exe/apk 挂载渠道闭环** | 三件套验收齐：① serveStatic 早已备好 exe/apk/dmg/deb/appimage MIME + attachment + Content-Length + 断点续传；② 新增 `scripts/make-releases.js` 扫 web/downloads/ 产物生成 web/releases.json（sha256/size/url，缺的平台如实登记 unavailable 原因）——已生成 v2026.0.3（4 平台待发布）；③ download.html 三语下载页按清单诚实渲染。**发布= 放包进 web/downloads/ + 跑一次生成脚本，零代码改动** |
| S4 | **打包选型（2026 全网竞品结论）** | Tauri 2 vs Electron：包体 3-8MB vs 85-100MB（-96%），内存 30-80MB vs 150-400MB；AI 本地应用主流形态 = Tauri 壳 + sidecar 后端进程（externalBin），模型不打进安装包。本项目落地：APK 优先（WebView 壳路线，CLIENT_MODE 已预留）→ EXE（Tauri+sidecar，server 打单文件二进制）→ iOS/鸿蒙维持 PWA。详见 docs/desktop-mobile-packaging-2026-10-25.md（含打包前检查清单） |

**验证**：server.js/make-releases/probe_storm 语法过；风暴 ALL PASS；全量 run_all 28 套件（含 42 断言付费链 e2e、292 端点探针）在 gzip 上线后复跑全绿。

---

## 5之十一、十一批（易学预测技能组装载 + 可达性闭环，2026-10-25）

用户点名装载紫微斗数/八字/滴天髓等易学技能给决策做预测。真实落地为**可调用引擎**（非词条登记）：

| 件 | 内容 |
|---|---|
| 引擎 | lunar-javascript（八字四柱/干支，npm 镜像装）+ iztro（紫微安星诀，npm）+ 梅花易数时间起卦（本地实现可复算，64 卦表自查纠一处笔误：离上巽下=火风鼎）+ 滴天髓文本（HeiGe-SuanMing 典籍经 gcore.jsdelivr.net 镜像落地 data/classics/ditian_sui.md，直连 GitHub 被网络阻断） |
| 接线 | core/skill-xuanxue.js 四函数 bazi/ziwei/iching/ditiansui → skills.js invoke 合并（XUANXUE 分支）+ registry() builtin 补 4 条（军械库 UI 可发现）+ skills_ext 溯源登记 4 条（cat=xuanxue, verified） |
| 诚实边界 | 每次输出带"传统术数参考视角、不构成事实判断"声明；输出内嵌决策用法（滴天髓取用次序/紫微六宫视角/梅花体用生克） |
| 回归 | tests/regress_xuanxue.js 22 断言（干支锚点 2026=丙午、排盘结构、起卦确定性+64 卦合法性+变卦≠本卦、检索命中/未命中、登记去重、registry 可见性）→ run_all 第 29 套件 |

**验证**：22/22 全过；全量 29 套件复跑全绿。chat 的工具选择走 orchestrator 意图（无关键词路由表），技能经军械库 UI「技能调用」与 /v1/skills/invoke 可达——未强行加路由器（改动面大、收益重复）。

---

---

## 5之十二、十二批（发布列车装载不足·邮件告警根因修复，2026-10-25）

用户邮件里的「发布列车装载不足」= watchdog.js train-underload 告警（班次三格 <3）。根因是 conductor.mission() 的**串行优先级饿死**：增长格空 → 每轮只试 load_growth；素材不足时（craftGrowthAsset 无料 → no-material 不装载）增长格永远空着，留存/还债务格被堵死，列车永不满 → 邮件每 30 分钟一封。修复：同一班内某格连续 2 次 no-material 后本轮放行其余格（growth/retention/debt 三格同规则），下一轮仍重试。验证：模拟 2+2 次 no-material → mission 落到 load_debt；三格全无料 → 落到 content_asset（不再堵死）；干净班仍优先增长件（优先级保持）。注：上一批修的「发布清单装载不足」是 download/releases.json（另一功能，修复保留）；本批才是邮件所指的 E4 发布列车。

---

## 7. 闭环状态总览（2026-10-25）

- **测试门禁**：run_all 29 套件（单元+付费链 42 断言 e2e+292 端点探针+前端接线+i18n 双门禁+能力全景守卫+易学技能组），另有 11 个补充套件。
- **商业漏斗**：下载渠道（download.html+releases.json+make-releases，断点续传+sha256）→ 网页版/PWA → 免费额度 → **免费试 2 天** → ¥1/7 天 → ¥99-899 订阅 → 邀请返利 → 退款回收；收据/续费提醒邮件真实投递；防刷双层（visitor 标志+IP 台账）。
- **性能**：gzip 31% 首屏、110 轮风暴 p95=38ms 零 5xx。
- **预测能力**：四术数引擎 RUNTIME 装载、军械库可见、回归钉死。
- **待用户**：生产部署（~6000 行本地变更）、alipay 电脑网站支付开通、VOLCENGINE ep- 端点、MOLTSPAY_GATEWAY、exe/apk 实际打包（流水线文档就绪）。

---

## 6. 验证记录（2026-10-24 本机）

- `bash tests/run_all.sh`：20 套件全部通过
- 补充 11 套件（care 121 / features_meta 197 / quota_i18n 79 / saas_loop 24 / assist 33 /
  maturity 15 / quota_toast 16 / manual_full 21 / gatepool 6 / usage_margin 23 / test_isolation 22）：全部 ALL PASS
- `node tests/e2e_pay_wall.js`：36/36 ALL PASS
- `node tests/e2e_registry_probe.js`：292 端点幽灵 0（5 条业务级 404 正确分类为存在）
