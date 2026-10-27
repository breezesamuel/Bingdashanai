# DECISION-SKILLS-CATALOG.md
> 决策中心 · 50+ 决策技能来源目录（2026-09-29 全网调研第一版）
> 目标：为「决策中心」7 大域（宏观经济/政治舆情、石油、电力、大宗贸易、股票行情、Web3、虚拟货币、AI 技术趋势）采集 50+ 可直接落地或复刻的决策类 skills。

---

## 0. 总览

| 领域 | 分类 | 采集仓库数 | 代表库 |
|------|------|-----------|--------|
| A. 股票 / 量化 / 财务 | 行情·策略·回测·风险管理 | 9 | TradingAgents, alpha-skills(129), AgentQuant, market-skills, vizier-trading-skill |
| B. 大宗商品 (石油/金属/农业) | 供需·期限结构·宏观信号 | 5 | commodity-macro-signal, LLMQuant-commodities, finance_skills/commodities |
| C. 虚拟货币 / Web3 | 情绪·链上·DeFi·行情 | 7 | crypto-skills, awesome-crypto-skills, ai-crypto-claude(15), Cryptosentinator |
| D. 宏观经济 / 政治舆情 | 预测市场·概率·地缘 | 12 | forecasting-tools, polymarket-brain, superforecasting-skill, presage, vox |
| E. 电力 / 能源 | 电价·负载·网格智能 | 5 | smard-cli, grid402, Energy-Prediction-ML, PowerSkills |
| F. AI 技术趋势 | 弱信号·情景·因果推演 | 5 | SKTPG, aleph-skill, trend-forecast, superforecaster(lyndonkl) |
| G. 通用决策方法论 | 预测流程·校准·聚合 | 6 | 并入 D 的 superforecasting 族 + bdistill-predict + akorchak-forecast |
| 合计 | | **~49 仓库 / 300+ 可复用 skills** | 覆盖官网全部 7 决策域 |

---

## A. 股票 / 量化 / 财务（行情·策略·回测·风险管理）

### A1. TauricResearch/TradingAgents ★32k
- **域**：股票全流程多智能体交易框架
- **核心**：LLM 多智能体（基本面/情绪/新闻/技术分析师 → 看多看空研究者 → Trader → 风控→ 组合经理）模拟真实交易公司；LangGraph 编排；决策日志持久化（`~/.tradingagents/memory/trading_memory.md`）
- **期刊更新**：v0.4.0（2026-08）含 look-ahead 修正、FRED 宏观、decision-log 记忆、GPT-5.6/GLM-5.3
- **入口**：`TradingAgentsGraph().propagate("NVDA","2026-01-15")` → decision
- **License/成本**：研究用途；支持 DeepSeek/Qwen/GLM/MiniMax/OpenRouter/Ollama
- **采集价值**：多智能体辩论+决策记忆闭环 = 决策中心「股票域」骨架模板

### A2. mphinance/alpha-skills ★129 skills
- **域**：量化交易全链路（回测/边缘研究/市场结构/筛选/期权/风控）+ Agent 基础设施
- **亮点**：`stanley-druckenmiller-investment`(8 信号合成 0-100)、`urithiru`(5-7 模型多路校验)、`edge-*` 六技能流水线、`mental-model-evaluator`(inversion/first-principles/second-order)、`future-predictor`
- **依赖**：FMP_API_KEY / TRADIER_API_KEY / OPENROUTER_API_KEY（多数技能无需 key）
- **采集价值**：直接拿来主义率最高的一包（129 个 SKILL.md 标准技能）

### A3. OnePunchMonk/AgentQuant
- **域**：自进化量化研究 agent
- **核心**：ReAct 循环（analyze→hypothesize→backtest→reflect→store→improve）；遗传算法/差分进化优化 harness；SQLite 跨会话记忆；look-ahead 护栏；6 epoch Sharpe 0.452→0.621 (+37.4%)
- **采集价值**：自进化循环 + falsifiable claims 校验（决策中心记分牌可以抄）

### A4. krzysu/market-skills
- **域**：交易技术分析 skills（纯数学指标 L1 → 形态检测 L2 → 策略 L3）
- **核心**：`market-macro`(F&G/VIX/DXY/US10Y/BTC.D/总市值 → 三轴 regime)、`market-snapshot`、`market-basis`(CCXT perp funding)、risk-engine(advisory vet)、decision tracing
- **无需 API key**；LLM-first（无 Python orchestrator）
- **采集价值**：L1/L2/L3 结构化分层 + `decision.py` 决策追踪 schema 可照抄

### A5. pedrobraiti/vizier-trading-skill
- **域**：agentic-trading 决策脑（IBKR 美股/ETF + CCXT 加密现货）
- **核心**：SKILL.md 判断 + 确定性 Python 安全核（金额计算不让 LLM 心里算）；paper-first 阶梯（shadow→paper→live）；确定性 scorecard（对标基准，不吹 alpha）
- **采集价值**：SKILL.md + 确定性核心混合架构 + 诚实评分 = 教科书级设计

### A6. HKUDS/Vibe-Trading（含 commodity-analysis 等 skills）
- **域**：个人交易 agent；已产出多枚可装 skills（commodity-analysis 等）
- **亮点**：`npx mdskill add HKUDS/Vibe-Trading/commodity-analysis` 单条安装
- **采集价值**：现成 SKILL.md 单技能（commodity-analysis 归属 B 域，见 B4）

### A7. ghostinsh/OpenMobius-skill
- **域**：ICT/SMC 交易知识技能（964 张知识卡）
- **核心**：ChromaDB 向量检索 380 概念+584 案例；实时数据+60+ 指标（Binance/Bybit/OKX/Hyperliquid/A股/港股/美股/外汇）；轻量 charts 出图
- **无需 LLM API key**；兼容 Claude Code/Codex/OpenClaw/Hermes
- **采集价值**：领域知识库向量化范式（决策中心「专家知识≠模型记忆」）

### A8. qaim-khanx/Nexus-AI
- **域**：机构级多智能体 AI 交易平台（10 个专业 agent：动量/情绪/相关性/风险/波动/成交量/事件/预测/策略/元评估）
- **技术**：LSTM/Transformer/CNN-LSTM 预测；PPO 强化学习；RAG 事件分析（9324 文档）；集成融合（72% 质量分）；VaR/CVaR 风控
- **采集价值**：RG + 事件感知 + 元评估 agent 轮换（决策中心 agent routing）

### A9. jack139/Vibe-Trading（独立版）
- **域**：个人交易 agent（含跨市场并发回测、27 tools、107 tests）
- **采集价值**：跨市场组合回测引擎（A股+加密共享资金池）

---

## B. 大宗商品（石油 / 金属 / 农业 · 供需·期限·宏观）

### B1. finskills/commodity-macro-signal ★最佳现成
- **域**：能源/金属/农产品 → 跨资产宏观信号
- **数据**：免费 Finskills API（WTI/Brent/天然气/黄金/白银/铜/铁矿石/玉米/小麦/咖啡）+ FRED + IMF 商品指数
- **输出**：石油 4 态信号（需求驱动/供给收缩/正常/通缩下滑）、Dr.Copper 铜金比、商品周期八相分类（early bull→late bear）、行业权重建议
- **采集价值**：一幅"商品→板块→资产"映射矩阵直接抄进决策中心大宗域

### B2. LLMQuant/skills（llmquant-commodities / llmquant-etfs / llmquant-options / llmquant-prediction-markets）
- **域**：数据驱动商品/期权/ETF/预测市场，配套 LLMQuant Data MCP
- **亮点**：com.android跨平台插件市场式安装（Claude/Codex/Cursor/Gemini）
- **采集价值**：commodities 技能 + prediction-markets 技能（概率缺口套利审查）

### B3. JoelLewis/finance_skills → plugins/wealth-management/skills/commodities
- **域**：商品期货曲线/roll yield/供给需求/通胀对冲
- **知识深度**：cost-of-carry 定价、contango/backwardation 判定、商品指数构造（GSCI vs BCOM）
- **采集价值**：期限结构判定 skill（与 B1 形成互补：宏观信号×微观期限）

### B4. HKUDS/Vibe-Trading → commodity-analysis（见 A6）
- **域**：石油供需平衡/黄金定价/铜经济晴雨表/库存周期/期限结构/季节性 → 方向性信号
- **数据**：OPEC/EIA/Baker Hughes/IEA/海关
- **信号规则**：`if opec_compliance>90% and rig_count_declining → tight`；铜金比 r>0.7 vs 美债 10Y
- **采集价值**：可直接抄的条件信号模板（5 步法：供需定向→库存定节奏→期限确认→季节性叠加→宏观验证）

### B5. 时序列预测通用件（跨域数据层）
- **代表**：jeremylongshore/claude-code-plugins-plus-skills → forecasting-time-series-data（ARIMA/Prophet 置信区间）；brprojects/Energy-Prediction-ML（XGBoost/TFT 97.5%）
- **采集价值**：决策中心统一「回测/预测」执行层可直接复用这两套模型配方

---

## C. 虚拟货币 / Web3（情绪·链上·DeFi·行情）

### C1. kukapay/crypto-skills（6 技能）+ awesome-crypto-skills ★聚合索引
- **6 技能**：evm-swiss-knife / market-sentiment(RSS情绪-1..+1) / meme-scout / token-minter / trading-strategist(Binance+SMA/EMA/RSI/BB/MACD+情绪) / yield-opportunities(DeFi 收益率风险评分)
- **awesome-crypto-skills**：集成 Binance Skills Hub(10+)、MoonPay(20+)、Bitget(6)、okx、CryptoSkills(97+)、区块链 MCP 大全
- **安装**：`npx skills add kukapay/crypto-skills`
- **采集价值**：single-catalog 里挑出情绪/策略/DeFi 三件直接装

### C2. zubair-trabzada/ai-crypto-claude ★15 skills / 5 agents
- **域**：完整代币研究（5 并行 agent：链上/代币经济/情绪/技术/基本面 → 综合 Crypto Score 0-100）
- **命令**：`/crypto analyze BTC` 等一串 slash 命令；1700 行 SKILL.md 路由器
- **采集价值**：决策中心「虚拟货币域」完整命令面直接对标

### C3. MANU-de/Cryptosentinator
- **域**：加密情绪多智能体系统（4 agent：Scout→Analyst→Strategist→Evaluator）
- **亮点**：topic modeling 挖掘情绪「为何」；Evaluator 每次运行附带自评（信任闭环）
- **采集价值**：叙事级情绪 + 自评循环（比单纯正/负/中性高一档）

### C4. yoshikazuuu/crypto-agent-forecaster
- **域**：多模态加密价格预测（CoinGecko + 4chan /biz/ 情绪 + TA + 视觉图表）
- **4-agent 流水线**：行情数据→情绪→技术分析→综合预测；backtest 模式；FUD/Shill 检测
- **采集价值**：极端噪音源多模态融合 + 回测对比（全代理/仅图/仅情绪）

### C5. MoonPay skills（prediction-market / messari-deep-research）
- **域**：Polymarket/Kalshi 预测市场 + Messari AI 深度研究
- **采集价值**：Web3 域与 D 域（预测市场）的交界件

### C6. rickkdev/awesome-ethereum-ai-skills（聚合索引）
- Ethereum/Web3 AI skills + MCP 大盘点（Dune/Hive/CoinGecko/CoinMarketCap/CCXT/DexScreener/Whale/Fear&Greed MCP…）
- **采集价值**：链上数据底座备料清单（决策中心 Web3 数据适配器候选）

---

## D. 宏观 / 政治舆情（预测市场·概率·地缘）

### D1. Metaculus/forecasting-tools ★官方框架
- **域**：通用预测机器人框架（Metaculus AI 竞赛官方工具）
- **核心**：MainBot/TemplateBot（research 报告→多模型独立预测→聚合→可选发布）；Metaculus API wrapper；GeneralLlm(litellm+重试+结构化输出)；成本管理器
- **采集价值**：决策中心「概率聚合引擎」直接可借鉴（跑在自家 LLM 上）

### D2. No-Stream/metaculus-bot
- **域**：Metaculus 预测 bot（6-LLM 集成 + 条件栈叠加）
- **核心**：CONDITIONAL_STACKING（模型一致取中位，分歧时 stacker 改写）；AskNews+Gemini 搜索+Perplexity/Exa 兜底；yfinance/FRED/预测市场研究；数值 CDF 管线（PCHIP+尾部加宽）
- **采集价值**：LLM 集成聚合 + 分歧驱动针对性研究（抄这俩算法）

### D3. adjacentresearchxyz/vox
- **域**：Metaculus 5-agent 委员会（base_rate/market_prior/status_quo/devil's_advocate/synthesizer）
- **核心**：ADJ 政治指数 API 做贝叶斯先验；logit 空间加权聚合；peer review 投票
- **采集价值**：agent 权重设计（market_prior 1.5x）+ 对抗式评审机制

### D4. dimaschand29/polymarket-brain（OpenClaw 生态）
- **域**：地缘+宏观经济全自动流水线（CNBC World Politics RSS → 专家路由）
- **核心**：IRGCistan 军事分析 / Dot Plot 美联储框架；专家概率 vs 市场赔率 → 20%+ 缺口触发；Discord 告警
- **采集价值**：地缘专家 agent（伊朗/霍尔木兹/五途径模型）——决策中心「政治舆情域」为数不多可用的

### D5. Seenfinity/presage-skill（OpenClaw）
- **域**：Presage 预测市场终端（Solana 上、Kalshi 驱动）：体育/加密/政治 YES-NO
- **工具**：analyzeMarkets/analyzeMarket/findOpportunities/getPortfolio；Node+fetch 零依赖
- **采集价值**：预测市场机会发现件（跨域复用）

### D6. sundial-org/awesome-openclaw-skills → polymarket-agent
- **域**：自主预测市场 agent（分析+新闻研究+机会识别，poly CLI 执行）
- **6 大策略**：新闻抢跑/相关性套利/情绪vs赔率/鲸鱼跟单/事件日历/结算衰减
- **采集价值**：策略模板库（每一条都可抽成决策中心 skill）

### D7. gnosis/prediction-market-agent
- **域**：多智能体框架全景样例库（run_agent.py 内置 15+ agent：coinflip…metaculus_bot…prophet_kelly）
- **采集价值**：agent 实现方案字典（想抄哪种架构都有现成参考）

### D8. deusyu/superforecasting-skill ★方法论级
- **域**：超预测方法论工程化（Tetlock/Good Judgment Project）
- **核心**：8 道门（resolvability→Fermi→reference class→base rate→内观校准→forecast≠decision）；状态机 `DRAFT→SCOPED→ACTIVE→UPDATED*→SETTLED→SCORED`（自动 Brier 打分）；全局台账 `~/.superforecast/`
- **采集价值**：决策中心「校准纪律」底座——概率必须有期限+判定标准，禁止事后改写，Brier 自动持续评估

### D9. lyndonkl/claude → agents/superforecaster.md + 6 子 skills
- **域**：精英预测 agent（5 阶段流水线：Triage/ŌutIn →福米→冲刺→证伪检查出→校准）
- **6 子技能清单**：reference-class-forecasting / estimation-fermi / bayesian-reasoning-calibration / forecast-premortem / scout-mindset-bias-check / slop-detector
- **采集价值**：子技能命名与职责切割（决策中心可拆成 6 枚独立装填）

### D10. francyjglisboa/bdistill-skills → bdistill-predict
- **域**：结构化预测组装（4 阶段：问题分解→证据提取→对抗自检→校准置信）带 Brier 结算台账
- **安装**：`npx skills add ... --skill bdistill-predict`
- **采集价值**：抗自检（challenge your own reasoning）阶段与 D8/D9 互补

### D11. 57uff3r/akorchak-forecast
- **域**：概率预测+情景建模（agentskill.sh 发布）
- **采集价值**：情景模型件（与 aleph 呼应）

### D12. AIsa-team/agent-skills → trend-forecast
- **域**：多信号趋势预测（预测市场赔率+Twitter情绪+新闻速度+行情数据 5 数据流合一）
- **核心**：查询分解→4 源并行采集→LLM 合成（confidence 0-100 + signal_agreement + 风险项）
- **采集价值**：多信号融合器模板（决策中心「跨源合成」层）

> 注：D 域重合度最高（方法论几乎同源），落地时优先 D1+D2（引擎）、D8/D9（纪律）、D4（政治专家）、D6（策略模板）即可全覆盖。

---

## E. 电力 / 能源（电价 / 负载 / 网格智能）

### E1. maschinenlesbar-org/smard-cli ★德电现货
- **域**：德国电力市场智能（SMARD/Bundesnetzagentur 开放 API）
- **3 技能**：smard-generation-mix(发电结构/可再生占比) / smard-price-watch(日前价格/最低小时) / smard-series-export(序列导出 CSV/JSON)
- **关键知识固化**：`null` 尾部陷阱、DE-LU 计价、filter id vs region 坑
- **采集价值**：把"API 反直觉细节"写进 SKILL.md 的范式（决策中心其他域照此办理）

### E2. carbonsteward/grid402
- **域**：电力网格数据原生 API（5 分钟发电结构/碳强度/现货价，USDC-on-Base 按次结算）
- **能力**：/cleanest-window 决策端点、/historical 回测、预测市场 oracle 用途（ISO 数据无争议结算）
- **采集价值**：电力域数据底座 + 「数据即结算」范式说明

### E3. brprojects/Energy-Prediction-ML
- **域**：西班牙日前电力需求/价格预测（XGBoost 97.5%/TFT 97%）
- **要点**：602万点数据工程；需求→价格两段式（价格不直接当特征防循环依赖）
- **采集价值**：模型配方 + 特征工程纪律（见 B5）

### E4. Power-Agent/PowerSkills
- **域**：电力系统仿真/分析/优化技能层（PowerMCP 之上，20 技能：10 软件工作流+10 缓解手册）
- **软件**：ANDES/Egret/OpenDSS/PSLF/PSSE/PowerWorld/PyPSA/pandapower/surge
- **亮点**：渐进式信息揭示（先 load→inspect→solve→再高级研究）+ Escalation triggers 表（数字驱动交接）
- **采集价值**：「渐进式工作流 + 升级触发器」模式抄给决策中心复杂仿真域

### E5. frootai-mcp 智慧能源 Grid AI（solution-play 71）
- **域**：智能电网部署 playbook（Azure IoT+负荷预测 Prophet/LightGBM/LSTM+需求响应+异常检测 Isolation Forest）
- **采集价值**：数字孪生/需求响应配置模板（决策中心「电力域」预案细化时参考）

---

## F. AI 技术趋势（弱信号·情景·因果推演）

### F1. New1Direction/SKTPG ★方向智能
- **域**：前瞻智能（skate where the puck is going）
- **核心**：reference class & base rate / weak signals / 激励地图 / 瓶颈地图 / 二阶问题（10× 更便宜/被监管/默认基建）/ 6-18 月 base/bull/bear/wild-card 全可证伪 / 24h·7d·30d·pre-consensus 行动图 / pre-mortem / 绿黄红记分板 / 6 行 verdict
- **★评分系统**：信号强度20+激励对齐20+瓶颈转移15+二阶上行15+时点优势15+可证伪10+个人边际5 = 0-100（噪声→紧急机会）
- **黄金测试**：`references/` 内建验证用例（hype-only 应得 0-20 等）
- **采集价值**：趋势域现成 SKILL.md，含内建校准测试，直接装

### F2. d-init-d/aleph-skill
- **域**：证据落地时间线模拟（counterfactual pasts / 交替现在 / 分支未来）
- **核心**：证据→类型化因果结构→可执行 trace→分支权重→仅在有依据时才校准概率；7 阶段流水线（frame→research→construct→link→propagate→branch→human decisions→report/audit）
- **采集价值**：AI 技术领域"蝴蝶效应"推演（例：原油 +40% 冲击推 24 个月通胀/央行动作），与决策中心事件推演闭环吻合

### F3. trend-analyst（Skills.lc 发布）
- **域**：趋势专家 agent（现状检测/早期弱信号/德尔菲/交叉影响矩阵/情景规划）
- **采集价值**：系统化弱信号扫描清单（34 趋势/12.3K 信号级漏斗）

### F4. AIsa trend-forecast（见 D12 复用）
- 技术趋势同理可用（AI 芯片/agent 框架爆炸等）。

---

## G. 通用决策方法论 / 校准（贯穿层）

| 库 | 价值 | 引入方式 |
|----|------|----------|
| deusyu/superforecasting-skill | 8 门+状态机+Brier 台账 | 作为决策中心「校准基线」独立装 |
| lyndonkl superforecaster + 6 子技能 | 5 阶段流水线 = 决策中心默认提问管线 | 拆成 6 枚子 skill |
| bdistill-predict | 4 阶段组装+对抗自检 | 参考 rework 卡 |
| Metaculus forecasting-tools | 概率聚合引擎 | 内部封装 agent |
| No-Stream metaculus-bot | 条件栈叠加算法 | 抄算法不抄代码 |
| vox | 权重委员会+logit 聚合 | agent router 权重方案 |

---

## 装配建议（决策中心 7 域 × 首批 10 个）

### Tier 1 —— 直接安装/适配（零 key，SKILL.md 现成）
1. `finskills/commodity-macro-signal`（B1·大宗）
2. `New1Direction/SKTPG`（F1·AI 趋势）
3. `deusyu/superforecasting-skill`（G·校准纪律）
4. `smard-cli` 三技能（E1·电力）
5. `krzysu/market-skills`（A4·股票技术面）
6. `bdistill-predict`（D10·结构化预测）

### Tier 2 —— 需 API key / 轻改造
7. `alpha-skills` 精选 20 枚（A2·量化，需 FMP key）
8. `ai-crypto-claude`（C2·加密 15 技能，需 LLM）
9. `TradingAgents`（A1·多智能体全链路，需 LLM）
10. `Metaculus forecasting-tools`（D1·概率聚合引擎，需 LLM+search key）

### 架构落点（决策中心 3 层）
- **SkillRegistry**：Tier1 全量注册 + Tier2 按 key 激活（沿用 skills 军械库 452 技能现有注册机制）
- **DataAdapters**：数据底座优先接 B1(Finskills)/E2(Grid402)/C1(market-sentiment)/D5(presage)
- **ExecutionLayer → DecisionEngine**：聚合算法抄 D2 条件栈 + D3 logit 加权 + D8 Brier 校准

---

## 数据源 / key 备忘

| Key | 用途 | 获取 |
|-----|------|------|
| FINSKILLS_API_KEY | B1 大宗信号 | finskills.net 免费 |
| FMP_API_KEY | A2 筛选器 18 枚 | Financial Modeling Prep |
| TRADIER_API_KEY | A2 ghost-auto-trader | Tradier 经纪 |
| POLYMARKET_KEY | D6 polymarket-agent | poly setup |
| METACULUS_TOKEN | D1/D2 | Metaculus AI 竞赛 |
| AISA_API_KEY | D12/F4 五信号 | aisa.one |
| NUMINOUS_X402_EVM_PRIVATE_KEY | D 系 Numinous 校准概率 | x402 钱包 |
| OPENROUTER_API_KEY | A2 urithiru 多模型校验 | openrouter.ai |

> 加工原则：所有结论必须带供应商（市场赔率≠事实）；决策中心默认不执行交易/发布，只产出 0-100 置信度 + 可证伪跟踪项（抄 SKTPG 内建测试、superforecasting Brier 结算）。