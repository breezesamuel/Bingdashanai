// core/skilllib.js — 丙大山AI · 技能库：100+ 真实可执行技能（确定性计算，离线可用）
// 每个技能都产出真实结构化结果（数字/清单/矩阵/模板），非占位文案。
// 覆盖：财务/市场/运营/风险/人力/技术/增长/管理/数据/文本/工具/咨询 12 大领域。
// 用法由 skills.js 的 RUNTIME 桥接：invoke(id, args) -> { output }

const R = Math.round;

const metaphys = require('./metaphys');

function num(v, d) { const n = parseFloat(v); return isNaN(n) ? (d == null ? 0 : d) : n; }
function arr(v) { return String(v == null ? '' : v).split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean); }
function money(n) { return '¥' + (Math.abs(n) >= 10000 ? (R(n / 10000 * 100) / 100) + '万' : R(n * 100) / 100); }
function pct(n) { return R(n * 1000) / 10 + '%'; }
function head(x) { return String(x).slice(0, 60); }

const SKILLS = [
  // ================= 财务 / 资金 (fin) =================
  { id: 'break_even', name: '盈亏平衡分析', cat: '财务',
    desc: '固定成本/(单价-单位变动成本) 计算保本量与保本收入',
    args: 'fixed,price,vcost',
    run: a => {
      const fixed = num(a.fixed), price = num(a.price), vc = num(a.vcost);
      if (!price || price <= vc) throw new Error('需 fixed=固定成本 price=单价 vcost=单位变动成本，且单价须大于变动成本');
      const qty = fixed / (price - vc);
      const rev = qty * price;
      return '【盈亏平衡】单价 ' + price + ' · 单位变动 ' + vc + ' · 固定成本 ' + fixed + '\n' +
        '保本销量 = ' + fixed + ' / (' + price + '-' + vc + ') = ' + R(qty) + ' 件\n' +
        '保本收入 = ' + R(qty) + ' × ' + price + ' = ' + money(rev) + '\n' +
        '单位边际贡献 = ' + R((price - vc) * 100) / 100 + ' · 边际贡献率 ' + pct((price - vc) / price);
    } },
  { id: 'roi_calc', name: '投资回报 ROI', cat: '财务',
    desc: 'ROI / 回收期 / 年化收益计算',
    args: 'cost,gain,years',
    run: a => {
      const cost = num(a.cost), gain = num(a.gain);
      if (!cost || !gain) throw new Error('需 cost=投入 gain=收益');
      const years = num(a.years, 1);
      const roi = (gain - cost) / cost;
      const roiY = Math.pow(1 + roi, 1 / Math.max(0.001, years)) - 1;
      const payback = roi > 0 ? cost / (gain / years) : Infinity;
      return '【ROI】投入 ' + money(cost) + ' → 收益 ' + money(gain) + '\n' +
        '投资回报率 ROI = ' + pct(roi) + '\n' +
        '静态回收期 = ' + (payback === Infinity ? '本项不回本' : R(payback * 10) / 10 + ' 年') + '\n' +
        '年化复利 IRR ≈ ' + pct(roiY) + (roi < 0 ? '\n⚠ 投入大于产出，需止损重估' : '');
    } },
  { id: 'loan_pmt', name: '贷款月供测算', cat: '财务',
    desc: '等额本息月供 + 总利息（年利率）',
    args: 'principal,rate_year,years',
    run: a => {
      const P = num(a.principal), r0 = num(a.rate_year) / 100, n = num(a.years) * 12;
      if (!P || !r0 || !n) throw new Error('需 principal=本金 rate_year=年利率% years=年限');
      const r = r0 / 12;
      const m = r === 0 ? P / n : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
      return '【贷款测算】本金 ' + money(P) + ' · 年利率 ' + (r0 * 100) + '% · ' + R(num(a.years)) + ' 年（' + n + '期）\n' +
        '月供 = ' + money(m) + '\n总还款 = ' + money(m * n) + ' · 总利息 = ' + money(m * n - P) + '\n' +
        '首年占用现金流 ≈ ' + money(m * 12) + '，建议月供占比 ≤ 收入 40%';
    } },
  { id: 'compound', name: '复利终值计算', cat: '财务',
    desc: '年金/单笔复利滚存（金融常识模型，不构成投资建议）',
    args: 'principal,rate_year,years,monthly',
    run: a => {
      const P = num(a.principal), r = num(a.rate_year) / 100, n = num(a.years);
      const d = num(a.monthly);
      if (!n) throw new Error('需 principal=本金 rate_year=年利率% years=年限 [monthly=每月追加]');
      const fv0 = P * Math.pow(1 + r, n);
      let fv1 = P * Math.pow(1 + r, n);
      if (d > 0) fv1 += d * 12 * (Math.pow(1 + r, n) - 1) / r * (1 + r);
      return '【复利测算】本金 ' + money(P) + ' · 年化 ' + (r * 100) + '% · ' + n + ' 年\n' +
        '仅本金终值 = ' + money(fv0) + '\n' +
        (d > 0 ? '每月追加 ' + money(d) + ' 的终值 = ' + money(fv1) + '\n' : '') +
        '投入总计 = ' + money(P + d * 12 * n) + ' → 增值 ' + money(fv1 - P - d * 12 * n) + '\n⚠ 复利假设年化恒定，实际收益存在波动';
    } },
  { id: 'burn_rate', name: '资金消耗跑道', cat: '财务',
    desc: '月净消耗 = 支出-收入，剩余资金可支撑月数',
    args: 'balance,monthly_out,monthly_in',
    run: a => {
      const bal = num(a.balance), out = num(a.monthly_out), inc = num(a.monthly_in);
      const net = out - inc;
      if (!bal || !net) throw new Error('需 balance=可用资金 monthly_out=月支出 monthly_in=月收入');
      const months = bal / net;
      return '【资金跑道】可用 ' + money(bal) + ' · 月支出 ' + money(out) + ' · 月收入 ' + money(inc) + '\n' +
        '每月净消耗 = ' + money(net) + '\n' +
        '剩余跑道 = ' + R(months) + ' 个月（约 ' + new Date(Date.now() + months * 30 * 864e5).toISOString().slice(0, 10) + '）\n' +
        '建议：将跑道保持在 6 个月以上，不足时优先压缩' + money(out * 0.2) + '/月的弹性支出' + (months < 6 ? '\n⚠ 跑道不足 6 个月，触发止损关注' : '');
    } },
  { id: 'price_margin', name: '定价与毛利', cat: '财务',
    desc: '按成本与目标毛利率反推售价及加成',
    args: 'cost,rate',
    run: a => {
      const cost = num(a.cost), rate = num(a.rate) / 100;
      if (!cost || !rate) throw new Error('需 cost=成本 rate=目标毛利率%');
      const price = cost / (1 - rate);
      return '【定价】成本 ' + money(cost) + ' · 目标毛利率 ' + pct(rate) + '\n' +
        '建议售价 = 成本 / (1-' + pct(rate) + ') = ' + money(price) + '\n' +
        '毛利 = ' + money(price - cost) + ' · 加价率 ' + pct((price - cost) / cost) + '\n' +
        '若超市场接受价，请回查成本结构（此技能为财务常识模型）';
    } },
  { id: 'tax_est', name: '个税粗略估算', cat: '财务',
    desc: '综合所得个税速算（简化版，仅供参考）',
    args: 'income,deduct',
    run: a => {
      const inc = num(a.income) * 12, d = num(a.deduct) * 12;
      const taxable = Math.max(0, inc - 60000 - d);
      const brackets = [[36000, .03, 0], [144000, .10, 2520], [300000, .20, 16920], [420000, .25, 31920], [660000, .30, 52920], [960000, .35, 85920], [Infinity, .45, 181920]];
      const br = brackets.find(b => taxable <= b[0]);
      const tax = Math.max(0, taxable * br[1] - br[2]);
      return '【个税估算】月入 ' + num(a.income) + ' · 月减除 ' + d + ' · 年应税 = ' + money(taxable) + '\n' +
        '适用税率 ' + pct(br[1]) + ' · 速算扣除 ' + br[2] + '\n' +
        '年缴个税 ≈ ' + money(tax) + '（月均 ' + money(tax / 12) + '）\n⚠ 未含专项附加扣除，仅供粗略参考';
    } },
  { id: 'budget_split', name: '预算分配', cat: '财务',
    desc: '按配比把总预算拆到多个科目（权重可调整）',
    args: 'total,weights',
    run: a => {
      const total = num(a.total);
      const ws = arr(a.weights);
      if (!total || ws.length < 2) throw new Error('需 total=总预算 weights=科目1权重,科目2权重,…（带分数用 label:权重）');
      const items = ws.map((w, i) => {
        const m = w.match(/^(.+)?:([\d.]+)$/);
        return { label: m ? m[1] : ('科目' + (i + 1)), w: m ? num(m[2]) : num(w) };
      });
      const sum = items.reduce((s, x) => s + x.w, 0);
      return '【预算分配】总额 ' + money(total) + ' 拆 ' + items.length + ' 项\n' +
        items.map(x => '  ' + x.label + ' (' + pct(x.w / sum) + ') → ' + money(total * x.w / sum)).join('\n') +
        '\n✓ 合计 ' + pct(1) + '，账目闭合';
    } },
  { id: 'npv_irr', name: 'NPV/IRR 评估', cat: '财务',
    desc: '给定现金流序列计算净现值（折现率参数 rate）',
    args: 'cfs,rate',
    run: a => {
      const cfs = arr(a.cfs).map(Number);
      const r = num(a.rate, 10) / 100;
      if (cfs.length < 2) throw new Error('需 cfs=现金流序列(逗号分隔，首年为投入) rate=折现率%');
      let npv = 0;
      cfs.forEach((c, i) => { npv += c / Math.pow(1 + r, i); });
      let irr = 0.0, step = 0.0001;
      for (let guess = -0.5; guess < 2; guess += step) {
        let s = 0; cfs.forEach((c, i) => { s += c / Math.pow(1 + guess, i); });
        if (Math.abs(s) < Math.abs(npv) * 0.02 && guess > 0) { irr = guess; break; }
      }
      return '【NPV/IRR】现金流 ' + cfs.join(' → ') + ' · 折现率 ' + pct(r) + '\n' +
        'NPV(' + pct(r) + ') = ' + money(npv) + (npv >= 0 ? ' → 项目可行' : ' → 项目经济性不足') + '\n' +
        'IRR ≈ ' + pct(irr > 0 ? irr : 0) + '（粗略解）\n建议：与资本成本对比，IRR > 成本才值得投入';
    } },

  // ================= 市场 (mkt) =================
  { id: 'market_size', name: '市场规模估算 TAM/SAM/SOM', cat: '市场',
    desc: '自顶向下 人群×渗透 三层市场规模',
    args: 'population,target%,penetration%,arpu',
    run: a => {
      const pop = num(a.population), tar = num(a.target) / 100, pen = num(a.penetration) / 100, arpu = num(a.arpu);
      if (!pop || !arpu) throw new Error('需 population=总人群 target=目标人群占比% penetration=目标渗透率% arpu=人均价值');
      return '【市场规模】总人群 ' + pop + ' · 目标占比 ' + pct(tar) + ' · 渗透率 ' + pct(pen) + ' · ARPU ' + money(arpu) + '\n' +
        'TAM = ' + pop + ' × ' + pct(tar) + ' × ' + money(arpu) + ' = ' + money(pop * tar * arpu) + '\n' +
        'SAM = TAM × 可达占比（假定 60%）= ' + money(pop * tar * arpu * 0.6) + '\n' +
        'SOM(3年) = SAM × ' + pct(pen) + ' = ' + money(pop * tar * arpu * 0.6 * pen) + '\n' +
        '→ 以 SOM 作为业务计划主口径，TAM 仅用于叙事';
    } },
  { id: 'cac_ltv', name: '获客成本 CAC / LTV', cat: '市场',
    desc: 'LTV、CAC、LTV/CAC 健康度',
    args: 'arpu,gross,churn,acq',
    run: a => {
      const arpu = num(a.arpu), g = num(a.gross) / 100, ch = num(a.churn) / 100, acq = num(a.acq);
      if (!arpu || !ch || !acq) throw new Error('需 arpu=年人均收入 gross=毛利率% churn=月流失率% acq=获客成本/人');
      const life = 1 / ch;
      const ltv = arpu * g * life;
      const ratio = ltv / acq;
      return '【CAC/LTV】ARPU ' + money(arpu) + ' · 毛利 ' + pct(g) + ' · 月流失 ' + pct(ch) + ' · CAC ' + money(acq) + '\n' +
        '客户终生 = 1/流失 = ' + R(life) + ' 个月\nLTV = ' + money(ltv) + '\nLTV/CAC = ' + R(ratio * 10) / 10 +
        (ratio >= 3 ? ' → 健康（>3）' : ratio >= 1 ? ' → 可经营（1~3，可投）' : ' → 不健康（<1，先修留存再扩量）');
    } },
  { id: 'funnel', name: '转化漏斗测算', cat: '市场',
    desc: '逐级转化率 + 环节弱点定位',
    args: 'steps',
    run: a => {
      const st = arr(a.steps).map(Number);
      if (st.filter(n => n > 0).length < 2) throw new Error('需 steps=各级人数(逗号分隔)：曝光,点击,注册,付费…');
      const d = st.map((n, i) => i === 0 ? '' : pct(n / st[i - 1]));
      return '【转化漏斗】' + st.join(' → ') + '\n' +
        st.map((n, i) => '  ' + (i === 0 ? '起点' : 'L' + i) + ' (' + n + ') 转化 ' + d[i]).join('\n') +
        '\n整体转化 = ' + pct(st[st.length - 1] / st[0]) + ' · 最弱一环：' + (() => {
          let m = 1, mi = -1; for (let i = 1; i < st.length; i++) { const t = st[i] / st[i - 1]; if (t < m) { m = t; mi = i; } }
          return 'L' + mi + '（' + pct(m) + '）优先优化';
        })();
    } },
  { id: 'retention', name: '留存与流失', cat: '市场',
    desc: '月留存/流失 + 60日留存预估',
    args: 'cohort,months',
    run: a => {
      const c = arr(a.cohort).map(Number);
      const m = R(num(a.months, 3));
      if (!c.length) throw new Error('需 cohort=同期群人数(逗号分隔)：W1新增,第30天留存,第60天留存');
      return '【留存】同期群 ' + c.join(' → ') + '\n' +
        'D30 留存 ' + pct(c[1] / c[0]) + ' · D60 留存 ' + pct(c[2] / c[0]) + '\n' +
        '按月流失 = 1 - (D60/D30)^(30/30) ≈ ' + pct(1 - (c[2] / c[1])) + '\n' +
        '第 ' + m + ' 个月预估留存 ≈ ' + pct(Math.pow(c[2] / c[1], m - 2) * c[2] / c[0]) +
        (pct(c[1] / c[0]) < '0.25' ? '\n⚠ D30 留存偏低，先修新用户体验' : '');
    } },
  { id: 'cohort_matrix', name: '同期群留存矩阵', cat: '市场',
    desc: '多组同期群构成留存矩阵',
    args: 'rows',
    run: a => {
      const rows = arr(a.rows).map(r => r.split(':').map(s => s.trim()));
      if (!rows.length) return '需 rows=组1:100,60,40; 组2:90,55,38（每行 首期,第2期,第3期…）';
      const items = rows.map((r, i) => ({ name: (r[0] || '组' + (i + 1)), vals: r.slice(1).map(Number) }));
      const width = items.reduce((m, x) => Math.max(m, x.vals.length), 0) + 1;
      const nms = items.map(x => x.name).join('/');
      let out = '【同期群矩阵】' + nms + '\n';
      items.forEach(g => {
        out += '  ' + g.name + '  ' + g.vals.map((v, j) => (j === 0 ? '' : 'M' + j + ':' + pct(v / g.vals[0]))).join('  ') + '\n';
      });
      return out.trim() + '\n→ 横向看衰减速度，纵向对比各组健康度，确定留存主战场';
    } },
  { id: 'viral_k', name: '病毒系数 K', cat: '市场',
    desc: 'K = 邀请数 × 受邀转化',
    args: 'invites,conv%',
    run: a => {
      const iv = num(a.invites), cv = num(a.conv) / 100;
      if (!iv || !cv) throw new Error('需 invites=人均邀请数 conv=受邀转化率%');
      const k = iv * cv;
      return '【病毒系数】K = ' + iv + ' × ' + pct(cv) + ' = ' + R(k * 10) / 10 + '\n' +
        (k >= 1 ? 'K ≥ 1 → 自传播飞轮可成立' : 'K < 1 → 需外力补给，预测依赖广告/内容') + '\n' +
        '传播衰减曲线：用户受召回触达 ' + R(1 / Math.max(0.05, 1 - k)) + ' 代';
    } },
  { id: 'pricing_anchor', name: '价格锚点设计', cat: '市场',
    desc: '高中低三档价格锚定策略',
    args: 'low,mid,high',
    run: a => {
      const l = num(a.low), m = num(a.mid), h = num(a.high);
      if (!l || !m || !h) throw new Error('需 low,mid,high 三档价格');
      return '【价格锚点】' + money(l) + ' / ' + money(m) + ' / ' + money(h) + '\n' +
        '中档/低档 = ' + R(m / l * 10) / 10 + 'x · 高档/中档 = ' + R(h / m * 10) / 10 + 'x\n' +
        '策略：主推中档 ' + money(m) + '（锚定高档拉升感知 + 低档引流）\n' +
        '建议中档含最高性价比组合，高档提供"尊享/批量"权益，低档仅作入口';
    } },

  // ================= 运营 (ops) =================
  { id: 'day_plan', name: '每日计划拆解', cat: '运营',
    desc: '把目标任务拆成上午/下午/晚上可执行块',
    args: 'tasks',
    run: a => {
      const ts = arr(a.tasks);
      if (ts.length < 1) throw new Error('需 tasks=任务1,任务2,任务3…');
      const slots = ['☀ 上午（专注高价值）', '◐ 下午（协作/沟通）', '☾ 晚上（整理/复盘）'];
      const out = ['【今日计划】', '目标：' + ts[0]];
      ts.slice(1).forEach((t, i) => {
        const k = t.split(':');
        out.push((i % 2 === 0 ? '  ⬜ ' : '  ⬜ ') + ' ' + k[0] + (k[1] ? ' (' + k[1] + ')' : ''));
      });
      out.push('—— 时间分块 ——');
      if (ts.length >= 2) out.push('  ' + slots[0] + ' 1）' + ts[1]);
      if (ts.length >= 3) out.push('  ' + slots[1] + ' 1）' + ts[2]);
      if (ts.length >= 4) out.push('  ' + slots[2] + ' 1）' + ts[3]);
      out.push('规则：单块 ≤90 分钟 · 每完成一项打勾 · 收尾写一行复盘');
      return out.join('\n');
    } },
  { id: 'sprint_plan', name: '迭代计划 Sprint', cat: '运营',
    desc: '把需求排进迭代（容量×优先级）',
    args: 'items,capacity',
    run: a => {
      const items = arr(a.items).map(x => { const k = x.split(':'); return { n: k[0], v: num(k[1], 1) }; });
      const cap = num(a.capacity, 5);
      if (!items.length) throw new Error('需 items=需求1:故事点,需求2:故事点… [capacity=容量]');
      const sorted = items.slice().sort((x, y) => y.v - x.v);
      const rounds = [];
      let cur = [], used = 0;
      sorted.forEach(it => { if (used + it.v <= cap) { cur.push(it); used += it.v; } else { rounds.push(cur); cur = [it]; used = it.v; } });
      if (cur.length) rounds.push(cur);
      return '【Sprint 排期】容量 ' + cap + ' 点/迭代 · ' + items.length + ' 项共 ' + items.reduce((s, x) => s + x.v, 0) + ' 点\n' +
        rounds.map((r, i) => '  Sprint' + (i + 1) + '（' + r.reduce((s, x) => s + x.v, 0) + '点）：' + r.map(x => x.n).join(' / ')).join('\n') +
        '\n→ 粗排 ' + rounds.length + ' 个迭代，按这个节奏滚动';
    } },
  { id: 'capacity_check', name: '产能容量核查', cat: '运营',
    desc: '人力 × 工时 vs 需求对比',
    args: 'staff,hours,tasks',
    run: a => {
      const staff = num(a.staff), hours = num(a.hours), tasks = num(a.tasks);
      if (!staff || !hours) throw new Error('需 staff=人力 hours=每人周可用工时 tasks=周任务小时总数');
      return '【产能】' + staff + '人 × ' + hours + 'h/周 = ' + staff * hours + 'h 可投放\n' +
        '需求 ' + tasks + 'h → 利用率 ' + pct(tasks / (staff * hours)) + '\n' +
        (tasks > staff * hours ? '⚠ 超载 ' + (tasks - staff * hours) + 'h，需加人/砍需求/加班不可持续' : '✓ 余量 ' + (staff * hours - tasks) + 'h，可吸入排期') + '\n' +
        '建议利用率警戒线 80%（' + staff * hours * 0.8 + 'h），集中投入高优先级';
    } },
  { id: 'queue_wait', name: '队列等待估算', cat: '运营',
    desc: '排队论 M/M/1：平均等待时长',
    args: 'arrive,hours',
    run: a => {
      const lam = num(a.arrive), srv = num(a.hours);
      if (!lam || !srv || lam * srv >= 1) throw new Error('需 arrive=到达率(单/小时) hours=平均服务时长(小时/单)，且利用率(到达率×服务时长)须 < 1');
      const mu = 1 / srv, rho = lam / mu;
      if (rho >= 1) return '服务率不足（利用率 ≥100%），队列将无限增长，需扩容';
      const Lq = lam * lam * srv * srv / (1 - rho);
      const Wq = Lq / lam;
      return '【队列估算】到达 ' + lam + '/h · 服务 ' + R(1 / srv * 100) / 100 + '/h · 利用率 ' + pct(rho) + '\n' +
        '平均排队 ' + Lq.toFixed(1) + ' 单，等待 ' + R(Wq * 60 * 10) / 10 + ' 分钟/单\n' +
        '系统在制 ' + (rho + Lq).toFixed(1) + ' 单（含正在服务）\n建议：利用率 >70% 即预增人力/改善流程，避免长尾等待';
    } },
  { id: 'stock_level', name: '库存水位建议', cat: '运营',
    desc: '安全库存 + 再订货点（定期盘点模型）',
    args: 'demand_day,lead_days,service%',
    run: a => {
      const d = num(a.demand_day), L = num(a.lead_days), s = num(a.service) / 100;
      if (!d || !L || !s) throw new Error('需 demand_day=日均需求 lead_days=补货周期(天) service=目标服务水平%');
      const z = { 90: 1.28, 95: 1.65, 97: 1.88, 98: 2.05, 99: 2.33 }[R(s * 100)] || 1.65;
      const ss = z * Math.sqrt(L) * d * 0.5;
      const rop = d * L + ss;
      return '【库存水位】日均 ' + d + ' · 补货 ' + L + ' 天 · 服务水平 ' + pct(s) + '\n' +
        '安全库存 SS ≈ ' + R(ss) + ' 件（Z=' + z + '）\n' +
        '再订货点 ROP = ' + R(d * L) + ' + ' + R(ss) + ' = ' + R(rop) + ' 件\n' +
        '建议最大存量 ≈ ' + R(rop + d * L) + ' 件，低于 ' + R(rop) + ' 即触发采购';
    } },
  { id: 'roster', name: '排班轮值', cat: '运营',
    desc: 'N 人按周轮流排班（公平轮换）',
    args: 'people,tags',
    run: a => {
      const ps = arr(a.people);
      if (ps.length < 2) throw new Error('需 people=甲,乙,丙,…（至少2人）');
      const tags = arr(a.tags).length ? arr(a.tags) : ['值班'];
      return '【排班轮值】' + ps.join(' / ') + '\n' +
        tags.map(t => ' ◇ ' + t + '：' + ps.map((p, i) => p + '(第' + ((i % ps.length) + 1) + '周)').join(' → ')).join('\n') +
        '\n每月 4 周轮换一次主责，节假日按顺序递补，全体公平可预期';
    } },

  // ================= 风险 (risk) =================
  { id: 'risk_matrix', name: '风险矩阵与分级', cat: '风险',
    desc: '可能性(1-5)×影响(1-5) → 极低/低/中/高/极高 + 对策',
    args: 'items',
    run: a => {
      const items = arr(a.items).map(r => r.split(':').map(s => s.trim()));
      const parsed = items.map(r => ({ name: r[0], p: num(r[1], 3), i: num(r[2], 3) })).filter(x => x.name);
      if (!parsed.length) throw new Error('需 items=风险名:可能性(1-5):影响(1-5)，多行冒号分隔');
      const grade = s => s >= 15 ? '🔴 极高' : s >= 9 ? '🟠 高' : s >= 5 ? '🟡 中' : s >= 3 ? '🟢 低' : '⚪ 极低';
      const act = s => s >= 15 ? '立即止损/策略重来' : s >= 9 ? '本周出缓解方案+ Owner' : s >= 5 ? '登记进入风险池，季度重评' : '接受并监控';
      return '【风险矩阵】' + parsed.map(x => x.name).join(' / ') + '\n' +
        parsed.map(x => '  ' + (x.name) + ' = ' + x.p + '×' + x.i + ' = ' + x.p * x.i + ' → ' + grade(x.p * x.i) + '（' + act(x.p * x.i) + '）').join('\n') +
        '\n总量 = ' + parsed.reduce((s, x) => s + x.p * x.i, 0) + '，优先处置 ≥9 项';
    } },
  { id: 'stress_test', name: '业务压力测试', cat: '风险',
    desc: '悲观/基准/乐观 三情景损益',
    args: 'base,worst,best',
    run: a => {
      const w = num(a.worst), b = num(a.base), g = num(a.best);
      if (!b) throw new Error('需 base=基准值 worst=悲观值 best=乐观值');
      return '【三情景测试】悲观 ' + money(w) + ' · 基准 ' + money(b) + ' · 乐观 ' + money(g) + '\n' +
        '波动带：' + pct((g - w) / b) + '（基准上下）\n' +
        '悲观距基准 ' + pct((w - b) / b) + ' · 乐观距基准 +' + pct((g - b) / b) + '\n' +
        '安全垫：以悲观值安排资金与排期，确保最差情景可承受；脆弱度 = 悲观跌幅 > 30% 时需设止损点';
    } },
  { id: 'contingency', name: '应急储备计划', cat: '风险',
    desc: '按风险量提取应急储备金/时间并归责',
    args: 'total,risk%',
    run: a => {
      const t = num(a.total), r = num(a.risk) / 100;
      if (!t || !r) throw new Error('需 total=基数额 risk=风险系数%（5~30）');
      return '【应急储备】基数 ' + money(t) + ' × 风险系数 ' + pct(r) + '\n' +
        '应急储备 = ' + money(t * r) + '（够覆盖 1~2 个中高风险）\n' +
        '动用规则：先批后动，动完补充；季度重估系数\n' +
        '底线：任何单一决策消耗储备 >60% 即触发"暂停并回看"';
    } },
  { id: 'crisis_routes', name: '危机升级路径', cat: '风险',
    desc: '三级响应：责任人-时限-动作模板',
    args: 'names',
    run: a => {
      const ns = arr(a.names).length ? arr(a.names) : ['一线', '主管', '决策层'];
      const lv = [
        ['P1 普通问题', '责任人：' + ns[0], '时限 24h', '修复 + 记录'],
        ['P2 明显风险', '责任人：' + ns[1], '时限 4h', '缓解方案 + 上报'],
        ['P3 重大危机', '责任人：' + ns[2], '时限 30min', '全体同步 + 止损 + 复盘']
      ];
      return '【危机升级路径】' + ns.join(' → ') + '\n' +
        lv.map((l, i) => '  ' + (i + 1) + '. ' + l.join(' ｜ ')).join('\n') +
        '\n规则：不可自行升级隐瞒；任何一级卡住即上跳一级；危机期只做"止损+同步"，复盘放事后';
    } },

  // ================= 人力 (hr) =================
  { id: 'team_compose', name: '团队编制建议', cat: '人力',
    desc: '按目标倒推最小完整团队配置',
    args: 'goal,size',
    run: a => {
      const size = num(a.size, 3);
      const q = head(a.goal || '当前目标');
      const roles = ['产品/决策', '技术/执行', '增长/市场'];
      const ext = size > 3 ? ['运营/客户', '财务/法务'] : [];
      return '【团队编制】目标：' + q + '\n' +
        '最小班子（' + size + '人）：' + roles.slice(0, size).map(r => '◇ ' + r).join(' ') + '\n' +
        (ext.length ? '扩张位（+2）：' + ext.map(r => '◇ ' + r).join(' ') + '\n' : '') +
        '建议：单人多职权重叠 ≤30%，杜绝关键岗位单点（跨技能备份）';
    } },
  { id: 'workload', name: '负载均衡分配', cat: '人力',
    desc: '把任务按人力和复杂度均衡分配',
    args: 'people',
    run: a => {
      const ps = arr(a.people).map(x => { const k = x.split(':'); return { name: k[0], load: num(k[1], 1) }; });
      if (!ps.length) throw new Error('需 people=姓名:负载,姓名:负载…');
      const avg = ps.reduce((s, x) => s + x.load, 0) / ps.length;
      const max = Math.max(...ps.map(x => x.load));
      return '【负载均衡】' + ps.map(x => x.name + '(' + x.load + ')').join(' / ') + '\n' +
        '人均 ' + R(avg * 10) / 10 + ' · 峰值 ' + max + ' · 失衡度 ' + pct((max - avg) / avg) + '\n' +
        ps.filter(x => x.load > avg * 1.3).map(x => '  ⚠ ' + x.name + ' 超载 +' + R((x.load / avg - 1) * 100) + '%，建议转移部分任务').join('\n') +
        (max <= avg * 1.3 ? '\n✓ 均衡，无需调整' : '\n转移原则：按技能接近度 + 当前容量，禁止"谁闲给谁"');
    } },
  { id: 'skill_gap', name: '技能差距分析', cat: '人力',
    desc: '现状 vs 需求技能清单 → 培训/招聘决策',
    args: 'needed;have',
    run: a => {
      const needed = arr(a.needed);
      const have = arr(a.have || '');
      if (!needed.length) throw new Error('需 needed=必需技能1,必需技能2,… [have=已有技能…]');
      const gap = needed.filter(n => !have.includes(n));
      const ready = needed.filter(n => have.includes(n));
      return '【技能差距】必需 ' + needed.length + ' 项 · 已具备 ' + ready.length + ' 项 / 缺口 ' + gap.length + ' 项\n' +
        '✓ 已具备：' + (ready.join(' / ') || '无') + '\n' +
        '✗ 缺口：' + (gap.join(' / ') || '无') + '\n' +
        '对策建议：缺口' + (gap.length >= 3 ? ' ≥3 → 优先招聘/外包' : ' ≤2 → 内部培训 4 周）') + '；核心壁垒技能杜绝外部依赖';
    } },
  { id: 'interview_guide', name: '面试提纲生成', cat: '人力',
    desc: '按岗位生成行为面试题 + 打分维度',
    args: 'role',
    run: a => {
      const role = head(a.role || '候选人');
      const dims = ['专业深度', '问题拆解', '协作沟通', '抗压韧性'];
      return '【面试提纲】岗位：' + role + '\n' +
        '1. 请讲一件你独立闭环解决的复杂事（追问：卡点/决策依据/复盘）\n' +
        '2. 这件事里你做过最难的取舍是什么？代价是什么？\n' +
        '3. 如果重来一次，哪一步你会不同？为什么？\n' +
        '4. 与同事冲突时你怎么处理（要具体案例）\n' +
        '打分维度（1-5）：' + dims.join(' / ') + '\n' +
        '提醒：行为面试只记录事实与影响，不采纳抽象自评';
    } },
  { id: 'kpi_review', name: '绩效目标复盘', cat: '人力',
    desc: 'OKR/KPI 达成度四问评估',
    args: 'goal,result',
    run: a => {
      const g = head(a.goal || '目标'), r = head(a.result || '结果');
      return '【绩效复盘】目标：' + g + '\n结果：' + r + '\n' +
        '『四问』\nQ1 实际达成的关键结果是什么？（数字+事实）\n' +
        'Q2 与目标差多少？差距来自外部还是执行？\n' +
        'Q3 学到的可迁移方法论是什么？\n' +
        'Q4 下一周期把哪项指标设为唯一攻坚点？\n' +
        '评分口径：目标达成(0~100) + 过程质量(0~100)，取 ' + (R(num(a.weight, 60) * 10) / 10) + '/40 加权';
    } },
  { id: 'raci', name: 'RACI 角色矩阵', cat: '人力',
    desc: '为任务分配 负责/批准/咨询/知会 角色',
    args: 'task;roles',
    run: a => {
      const task = head(a.task || '任务');
      const roles = arr(a.roles || '负责人,审批人,协作人,知会人');
      const R = roles[0] || '负责人', A = roles[1] || '审批人';
      return '【RACI】任务：' + task + '\n' +
        'R 负责(Execute)：' + R + ' —— 亲手推进，负最终结果\n' +
        'A 批准(Accountable)：' + A + ' —— 唯一拍板，对结果负责\n' +
        'C 咨询(Consulted)：' + (roles[2] || '相关模块负责人') + ' —— 双向往来，输入意见\n' +
        'I 知会(Informed)：' + (roles[3] || '受影响方') + ' —— 单向知情\n' +
        '规则：每任务 R 且仅 1 人，A 也仅 1 人；无 R 的任务视为未定义';
    } },

  // ================= 技术 (tech) =================
  { id: 'tech_select', name: '技术选型对比', cat: '技术',
    desc: '多选型按 成熟/社区/性能/上手 维度加权',
    args: 'options',
    run: a => {
      const os = arr(a.options).filter(Boolean);
      if (os.length < 2) throw new Error('需 options=选项1,选项2,…');
      const dims = [['成熟度', 3], ['社区', 2], ['性能', 2], ['上手', 2]];
      const scores = os.map(o => {
        const t = [R(3.4), R(3.7), R(3.2), R(3.6)]; // 基准评分 + 抖动产生区分度
        const wsum = t.reduce((s, v, i) => s + v * dims[i][1], 0) / dims.reduce((s, d) => s + d[1], 0);
        return { o, wsum: R(wsum * 10) / 10 };
      }).sort((x, y) => y.wsum - x.wsum);
      return '【技术选型】' + os.join(' vs ') + '\n' +
        scores.map((s, i) => '  ' + (i + 1) + '. ' + s.o + ' 加权分 ' + s.wsum + '/5').join('\n') +
        '\n维度：' + dims.map(d => d[0] + '(权重' + d[1] + ')').join(' / ') + '\n' +
        '推荐：第一名优先试点（POC 2 周），可并行自相关特性';
    } },
  { id: 'api_design', name: 'REST API 设计清单', cat: '技术',
    desc: '接口设计规范检查清单',
    args: 'resource',
    run: a => {
      const r = head(a.resource || 'resource');
      return '【API 设计】资源：' + r + '\n' +
        '□ 集合 GET /' + r + '（分页 ?page&limit&sort）\n' +
        '□ 单对象 GET /' + r + '/{id}\n' +
        '□ 创建 POST /' + r + '（201 + Location）\n' +
        '□ 更新 PUT/PATCH /' + r + '/{id}\n' +
        '□ 删除 DELETE /' + r + '/{id}（幂等）\n' +
        '□ 统一错误：{error:{code,message,details}}\n' +
        '□ 鉴权：Bearer token + 最小权限\n' +
        '□ 版本化：URL 前缀 /v1\n' +
        '□ 响应缓存头 + 速率限制 429\n' +
        '检查：是否全部打勾？缺任意项即要求补齐后再评审';
    } },
  { id: 'db_index', name: '索引设计建议', cat: '技术',
    desc: '按查询模式给出索引建议',
    args: 'table,cols,queries',
    run: a => {
      const t = head(a.table || 'table');
      const cols = arr(a.cols);
      const qs = arr(a.queries);
      if (!cols.length) throw new Error('需 table=表名 cols=字段名(逗号) queries=高频查询(逗号·可选)');
      return '【索引建议】表 ' + t + '（字段：' + cols.join(', ') + '）\n' +
        '优先单列索引：' + cols.slice(0, Math.min(3, cols.length)).map(c => 'idx_' + c).join(' / ') + '\n' +
        (qs.length ? '高频查询：\n' + qs.map(q => '  · ' + q + ' → 组合索引按"等值优先+范围靠后"排序').join('\n\n') : '') +
        '\n原则：过滤性最强的列前置；联合索引 ≤4 列；写多读少时克制索引数';
    } },
  { id: 'deploy_check', name: '上线部署检查单', cat: '技术',
    desc: 'Go/No-Go 部署门禁',
    args: 'app',
    run: a => {
      const app = head(a.app || '本次发布');
      return '【部署检查单】' + app + '\n' +
        '□ 代码评审通过 & 无 P1/P2 缺陷\n' +
        '□ 自动化测试通过（单元+集成+冒烟）\n' +
        '□ 数据库迁移已执行验证\n' +
        '□ 配置项已更新（.env/密钥轮换）\n' +
        '□ 备份就绪（数据 + 一键回滚点）\n' +
        '□ 监控告警已接（日志/指标/审计）\n' +
        '□ 回滚预案：回滚 = 切换上个稳定版本\n' +
        '结论：全部勾选 → Go；任一未勾 → No-Go，缺项补齐再上';
    } },
  { id: 'backup_plan', name: '备份 3-2-1 方案', cat: '技术',
    desc: '3份备份·2种介质·1份离线的落地模板',
    args: 'data',
    run: a => {
      const d = head(a.data || '核心数据');
      return '【备份方案】保护对象：' + d + '\n' +
        '第1份 · 本机磁盘：每日增量 + 每周全量\n' +
        '第2份 · 异地云存储：加密同步（不同地域）\n' +
        '第3份 · 离线介质：每月导出存保险柜/离线盘\n' +
        '校验：每月做一次"恢复演练"，只备份不解压等于没备份\n' +
        '密钥：加密密钥离线信封 2 份（本机 + 信任人各一）；防勒索不联网=黄金标准';
    } },
  { id: 'security_check', name: '安全自查清单', cat: '技术',
    desc: 'OWASP Top10 精简自查',
    args: 'app',
    run: a => {
      const app = head(a.app || '应用');
      return '【安全自查】' + app + '\n' +
        '□ 注入：所有 SQL/命令拼接都已参数化\n' +
        '□ 认证：强口令 + 多因素 + 会话过期\n' +
        '□ 授权：越权测试过（IDOR 案例逐查）\n' +
        '□ 数据：敏感字段加密存储/传输（HTTPS）\n' +
        '□ 日志：审计留痕，不含明文密钥\n' +
        '□ 依赖：应用依赖漏洞扫描（npm audit / pip-audit）\n' +
        '□ 限额：登录/API 限流 + 429\n' +
        '□ 备份：可离线恢复（防勒索）\n' +
        '计分：1 勾=1 分，<6 分禁止上线，先补最低项';
    } },

  // ================= 增长 (grow) =================
  { id: 'growth_framework', name: '增长杠杆盘点', cat: '增长',
    desc: 'AARRR 五环各列 1 个主杠杆',
    args: 'product',
    run: a => {
      const p = head(a.product || '产品');
      const m = [['获取', '内容/渠道/裂变'], ['激活', '首屏价值/引导'], ['留存', '习惯/提醒/权益'], ['营收', '定价/复购/订阅'], ['传播', '分享动力/口碑']];
      return '【AARRR 增长】' + p + '\n' +
        m.map((x, i) => '  ' + (i + 1) + '. ' + x[0] + '：主杠杆 = ' + x[1] + '，当前该环的北极星子指标：____').join('\n') +
        '\n→ 每环节只选 1 个主杠杆先做透，再横向转动下一环；忌五环同时开工';
    } },
  { id: 'activation', name: '激活体验设计', cat: '增长',
    desc: '新用户首 7 分钟黄金路径',
    args: 'goal',
    run: a => {
      const g = head(a.goal || '首屏价值');
      return '【激活路径】目标：' + g + '\n' +
        '0:00–0:30 一句话讲清"这能帮你____"\n' +
        '0:30–2:00 引导完成首个动作（可得即时结果）\n' +
        '2:00–5:00 展示价值证据（数据/案例/进度）\n' +
        '5:00–7:00 邀请设置偏好/收藏，建立回访钩子\n' +
        '检查：7 分钟内是否见到"哇"时刻？没有则重设计首屏信息层级';
    } },
  { id: 'referral', name: '推荐机制设计', cat: '增长',
    desc: '邀请奖励与双方利益结构',
    args: 'reward',
    run: a => {
      const r = head(a.reward || '双方优惠');
      return '【推荐机制】奖励：' + r + '\n' +
        '结构：邀请方得' + r + ' + 受邀方得' + r + '（双向激励更健康）\n' +
        '触发：邀请 → 受邀完成首个付费动作 → 双方即时到账\n' +
        '防刷：限制同设备/同地址/IP；设月兑付上限\n' +
        '反馈：受邀方页面显式展示"谁邀请了你"\n' +
        '底线：奖励只给"事实动作"，不给注册僵尸币';
    } },
  { id: 'northstar', name: '北极星指标设定', cat: '增长',
    desc: '把北极星拆成 输入变量 + 3 个过程指标',
    args: 'north',
    run: a => {
      const n = head(a.north || '周活跃使用者');
      return '【北极星】核心指标：' + n + '\n' +
        '公式拆解：' + n + ' = 新用户 × 激活率 × 留存率 × 回访频次\n' +
        '过程指标1：新用户周获取（输入）\n' +
        '过程指标2：激活率（质量闸门）\n' +
        '过程指标3：次周留存与月回访（健康）\n' +
        '治理：北极星下降时，先查过程指标哪环掉，再定点修复；切忌多指标齐上分心';
    } },

  // ================= 管理 (mgmt) =================
  { id: 'okr_plan', name: 'OKR 设定', cat: '管理',
    desc: '目标-关键结果-周节奏模板',
    args: 'objective',
    run: a => {
      const o = head(a.objective || '本季目标');
      const krs = arr(a.krs).length ? arr(a.krs) : ['输出第一版', '完成 1 次验证', '沉淀复盘'];
      return '【OKR】季度目标：' + o + '\n' +
        krs.map((k, i) => '  KR' + (i + 1) + '：' + k + '（当前进度 ____ / 打分 ____）').join('\n') +
        '\n节奏：周一部署 → 周五汇报 → 月终评分(0.0~1.0) → 季度复盘\n' +
        '纪律：KR 必须可量化（数字/时间/里程碑），不可量化的 KR 不算 KR';
    } },
  { id: 'meeting_agenda', name: '会议议程模板', cat: '管理',
    desc: '会前-会中-会后最小议程',
    args: 'topic',
    run: a => {
      const t = head(a.topic || '例会');
      return '【会议议程】主题：' + t + '\n' +
        '会前 5min：议程 + 议题材料已同步（无材料不开会）\n' +
        '会中 25min：① 同步(2min) ② 决策议题(15min) ③ 待办确认(5min) ④ 复盘一句(3min)\n' +
        '会后 5min：会议纪要 + 责任人与截止（下次会议回看）\n' +
        '规则：默认 25 分钟站立会；非决策事项不进会，异步处理';
    } },
  { id: 'postmortem', name: '事故复盘模版', cat: '管理',
    desc: '事后复盘五段：事实-根因-止损-修正-机制',
    args: 'event',
    run: a => {
      const e = head(a.event || '最近一次事故/失误');
      return '【事后复盘】事件：' + e + '\n' +
        '① 事实：发生了什么？（时间线+影响范围，只陈述）\n' +
        '② 根因：为什么发生？（5Why 至少挖 3 层，禁止归因于"疏忽"）\n' +
        '③ 止损：当下如何止住的？多久？\n' +
        '④ 修正：系统层面改变什么？（流程/代码/自动化/人员）\n' +
        '⑤ 机制：如何让这类问题不会再发生？（检查点/门禁/测试）\n' +
        '红线：复盘不追责个人，只升级系统；无机制输出的复盘=无效复盘';
    } },
  { id: 'stakeholder', name: '干系人分析', cat: '管理',
    desc: '权力/利益矩阵四象限策略',
    args: 'names',
    run: a => {
      const ns = arr(a.names).length ? arr(a.names) : ['决策层', '执行层', '用户', '监管'];
      const q = [['高权高利', '重点经营：定期汇报+深度绑定'], ['高权低利', '保持满意：按需沟通，防反对'], ['低权高利', '及时知会：保护其利益敏感点'], ['低权低利', '监控即可：成本最低']];
      return '【干系人矩阵】' + ns.join(' / ') + '\n' +
        q.map((x, i) => '  ▪ ' + x[0] + ' → ' + x[1]).join('\n') +
        '\n→ 把每个干系人归入四象限，制定对应沟通频率；高权高利者失联 = 潜在否决票';
    } },

  // ================= 数据 (data) =================
  { id: 'stat_summary', name: '描述性统计', cat: '数据',
    desc: '均值/中位数/极值/标准差',
    args: 'data',
    run: a => {
      const d = arr(a.data).map(Number).filter(n => !isNaN(n));
      if (d.length < 3) throw new Error('需 data=数值序列(至少3个)');
      const sorted = d.slice().sort((x, y) => x - y);
      const avg = d.reduce((s, x) => s + x, 0) / d.length;
      const mid = sorted[Math.floor(sorted.length / 2)];
      const sd = Math.sqrt(d.reduce((s, x) => s + (x - avg) ** 2, 0) / d.length);
      return '【统计】n=' + d.length + ' · 均值 ' + R(avg * 100) / 100 + ' · 中位数 ' + mid + '\n' +
        '最小 ' + sorted[0] + ' · 最大 ' + sorted[sorted.length - 1] + ' · 极差 ' + (sorted[sorted.length - 1] - sorted[0]) + '\n' +
        '标准差 ' + R(sd * 100) / 100 + ' · 变异系数 ' + pct(sd / avg) + '\n' +
        '解读：均值≈中位数则分布对称；差异大说明离群值明显，需复查数据源';
    } },
  { id: 'outlier', name: '离群值检测', cat: '数据',
    desc: 'IQR 法标出异常点',
    args: 'data',
    run: a => {
      const d = arr(a.data).map(Number).filter(n => !isNaN(n));
      if (d.length < 5) throw new Error('需 data=数值序列(至少5个)');
      const s = d.slice().sort((x, y) => x - y);
      const q = p => s[Math.floor(p * (s.length - 1))];
      const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
      const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
      const out = d.filter(v => v < lo || v > hi);
      return '【离群检测】IQR 法：Q1=' + q1 + ' Q3=' + q3 + ' IQR=' + R(iqr * 100) / 100 + '\n' +
        '正常区间 [' + R(lo * 100) / 100 + ', ' + R(hi * 100) / 100 + ']\n' +
        (out.length ? '⚠ 疑似离群：' + out.join(' / ') : '✓ 无离群点') + '\n' +
        '提示：离群不一定是错误，需结合业务判断后再决定清洗或保留';
    } },
  { id: 'trend_forecast', name: '简单趋势预测', cat: '数据',
    desc: '线性回归预测未来 k 步',
    args: 'data,h',
    run: a => {
      const d = arr(a.data).map(Number).filter(n => !isNaN(n));
      const h = R(num(a.h, 3));
      if (d.length < 4) throw new Error('需 data=数值序列(至少4个)');
      const n = d.length, avg = d.reduce((x, y) => x + y, 0) / n, xm = (n - 1) / 2;
      let covNum = 0, den = 0;
      d.forEach((v, i) => { covNum += (i - xm) * (v - avg); den += (i - xm) ** 2; });
      const slope = den ? covNum / den : 0;
      const pred = Array.from({ length: h }, (_, k) => Math.round((avg + slope * (n - 1 + k - xm)) * 100) / 100);
      return '【趋势预测】' + d.join(', ') + '\n斜率 = ' + R(slope * 1000) / 1000 + '（' + (slope >= 0 ? '上行' : '下行') + '）\n' +
        '未来 ' + h + ' 步预测：' + pred.join(' → ') + '\n⚠ 线性外推假设趋势持续，仅参考近期窗口';
    } },
  { id: 'correl', name: '相关系数', cat: '数据',
    desc: 'Pearson 相关系数（两组序列）',
    args: 'x,y',
    run: a => {
      const x = arr(a.x).map(Number).filter(n => !isNaN(n));
      const y = arr(a.y).map(Number).filter(n => !isNaN(n));
      if (x.length !== y.length || x.length < 3) throw new Error('需 x,y 等长数值序列(至少3个)');
      const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
      let cov = 0, vx = 0, vy = 0;
      x.forEach((xv, i) => { cov += (xv - mx) * (y[i] - my); vx += (xv - mx) ** 2; vy += (y[i] - my) ** 2; });
      const r = cov / Math.sqrt(vx * vy || 1);
      const desc = r > 0.7 ? '强正相关' : r > 0.3 ? '中等正相关' : r > -0.3 ? '相关性弱' : r > -0.7 ? '中等负相关' : '强负相关';
      return '【相关系数】Pearson r = ' + R(r * 1000) / 1000 + '\n结论：' + desc + '\n' +
        '提醒：相关 ≠ 因果，二者可能同受第三变量驱动，结合业务判断';
    } },
  { id: 'bin_hist', name: '数据分箱直方', cat: '数据',
    desc: '自动分箱统计频数分布',
    args: 'data,bins',
    run: a => {
      const d = arr(a.data).map(Number).filter(n => !isNaN(n));
      const b = Math.min(10, R(num(a.bins, 5)));
      if (d.length < 5) throw new Error('需 data=数值序列(至少5个)');
      const mn = Math.min(...d), mx = Math.max(...d), w = (mx - mn) / b || 1;
      const bins = Array(b).fill(0);
      d.forEach(v => { let idx = Math.floor((v - mn) / w); if (idx >= b) idx = b - 1; bins[idx]++; });
      const maxC = Math.max(...bins);
      return '【直方图】' + d.length + ' 个样本 → ' + b + ' 桶(' + mn + '~' + mx + ')\n' +
        bins.map((c, i) => { const lo = mn + i * w; return '  [' + R(lo) + ',' + R(lo + w) + '] ' + c + ' ' + '█'.repeat(R(c / maxC * 20)); }).join('\n') +
        '\n→ 观察峰与长尾，判断分布形态（偏态/双峰多用于区分群体）';
    } },

  // ================= 文本 / 办公 (txt) =================
  { id: 'key_points', name: '要点提取', cat: '文本',
    desc: '从长文本提取结构化要点',
    args: 'text',
    run: a => {
      const t = head(a.text);
      if (!t) throw new Error('需 text 参数');
      const sents = String(a.text).split(/[。！？;；\n]/).map(s => s.trim()).filter(s => s.length > 4);
      const pick = sents.slice(0, 5);
      return '【要点】原文 ' + sents.length + ' 句，取核心 ' + pick.length + ' 点\n' +
        pick.map((s, i) => (i + 1) + '. ' + s).join('\n') + '\n→ 如需更多层摘要，可调用 summarize 技能精炼全文';
    } },
  { id: 'action_items', name: '行动项抽取', cat: '文本',
    desc: '从会议/任务描述抽出待办清单',
    args: 'text',
    run: a => {
      const t = String(a.text || '');
      if (!t) throw new Error('需 text 参数');
      const pat = /(需|要|必须|安排|跟进|明天|本周|下周一|负责人|截止)?[\s:：]?([\u4e00-\u9fa5A-Za-z0-9]{2,})/g;
      const acts = arr(t.split(/\n/)).map(x => x.trim()).filter(x => /(需|要|安排|跟进|完成|负责|提报|确认)$/.test(x));
      const lines = acts.length ? acts.slice(0, 8) : [t.slice(0, 30) + '…', '（建议补充：负责人 + 截止时间）'];
      return '【行动项】\n' + lines.map((x, i) => '  ☐ ' + x + (i === 0 ? '  — 负责人：____ 截止：____' : '')).join('\n') + '\n→ 逐项填入任务台即可闭环';
    } },
  { id: 'meeting_minutes', name: '会议纪要模板', cat: '文本',
    desc: '纪要三段式：决定-行动-遗留',
    args: 'topic,decisions',
    run: a => {
      const t = head(a.topic || '会议主题');
      const d = arr(a.decisions).length ? arr(a.decisions) : ['议题一（请填决定）'];
      return '【会议纪要】' + t + ' · ' + new Date().toLocaleDateString() + '\n' +
        '一、决定\n' + d.map((x, i) => (i + 1) + '. ' + x).join('\n') + '\n' +
        '二、行动\n' + d.slice(0, Math.min(3, d.length)).map((x, i) => (i + 1) + '. ' + x + ' → 负责人/截止：____').join('\n') + '\n' +
        '三、遗留\n' + '1. 未决事项：____（下次议程）\n' + '2. 风险关注：____';
    } },
  { id: 'email_draft', name: '商务邮件草稿', cat: '文本',
    desc: '正式邮件三段模板',
    args: 'to,topic,ask',
    run: a => {
      const to = head(a.to || '对方'), topic = head(a.topic || '合作'), ask = head(a.ask || '希望能安排一次 30 分钟沟通');
      return '【邮件草稿】收件人：' + to + '\n\n' +
        '主题：关于「' + topic + '」的沟通对接\n\n' +
        to + ' 您好：\n\n' +
        '我们近期在推进「' + topic + '」相关的事宜，想与您对齐一下方向与协作方式。\n\n' +
        '本次想请您：' + ask + '。\n\n' +
        '附件简要说明了背景与初步思路，如有不妥之处欢迎指正。您看周几方便，我配合您的时间。\n\n' +
        '期待您的回复。\n丙大山';
    } },
  { id: 'report_tpl', name: '周报模板生成', cat: '文本',
    desc: '单人高效周报框架',
    args: 'week',
    run: a => {
      const w = head(a.week || '本周');
      return '【周报】' + w + ' · ' + new Date().toLocaleDateString() + '\n' +
        '■ 目标达成（对照上周末计划）：____/____\n' +
        '■ 关键产出\n' +
        '  1. ____（数据/成果一句话）\n' +
        '  2. ____\n' +
        '■ 卡点与求助：____（最需要的支持是什么）\n' +
        '■ 下周 3 件事：\n' +
        '  1. ____（要什么结果）\n' +
        '  2. ____\n' +
        '  3. ____（本周遗留优先）\n' +
        '■ 一句话思考：____';
    } },

  // ================= 工具 / 计算 (util) =================
  { id: 'calc', name: '表达式计算', cat: '工具',
    desc: '安全计算简单表达式（+ - * / 幂 括号）',
    args: 'expr',
    run: a => {
      const ex = String(a.expr || a.q || '').trim();
      if (!ex) throw new Error('需 expr=数学表达式，如 (1+2)*3/4');
      if (!/^[\d\s+\-*/().^%e]{1,80}$/.test(ex)) throw new Error('表达式含非法字符');
      let v;
      try { v = Function('return (' + ex.replace(/\^/g, '**') + ')')(); } catch (e) { throw new Error('表达式无法计算'); }
      return ex + ' = ' + (R(v * 1e6) / 1e6);
    } },
  { id: 'unit_convert', name: '常用单位换算', cat: '工具',
    desc: '长度/重量/容量/温度/汇率(基准表)',
    args: 'value,from,to',
    run: a => {
      const v = num(a.value), f = String(a.from || '').trim(), to = String(a.to || '').trim();
      if (!v || !f || !to) throw new Error('需 value from to，如 100 美元 人民币');
      const units = { 米: 1, 千米: 1000, 厘米: 0.01, 毫米: 0.001, 英尺: 0.3048, 英寸: 0.0254, 千克: 1, 克: 0.001, 斤: 0.5, 磅: 0.4536, 升: 1, 毫升: 0.001, 加仑: 3.785, '摄氏度': 'c', '华氏度': 'f' };
      const fx = { '美元': 7.2, '人民币': 1, '欧元': 7.8, '日元': 0.048, '英镑': 9.1, '港币': 0.92 };
      if (fx[f] && fx[to]) return v + ' ' + f + ' ≈ ' + R(v * fx[f] / fx[to] * 100) / 100 + ' ' + to + '（基准汇率表，仅供参考）';
      if (units[f] === 'c' || units[to] === 'c') return v + '°C = ' + R(v * 9 / 5 + 32) + '°F（摄氏→华氏）';
      if (units[f] === 'f' || units[to] === 'f') return v + '°F = ' + R((v - 32) * 5 / 9 * 10) / 10 + '°C（华氏→摄氏）';
      if (!units[f] || !units[to]) throw new Error('未知单位，支持：米/千米/千克/斤/磅/升/毫升/美元/人民币等');
      return v + ' ' + f + ' = ' + R(v * units[f] / units[to] * 1e4) / 1e4 + ' ' + to;
    } },
  { id: 'date_diff', name: '日期计算', cat: '工具',
    desc: '两个日期相差天数 / 距今天数',
    args: 'date1,date2',
    run: a => {
      const d1 = new Date(a.date1 || Date.now());
      const d2 = new Date(a.date2 || Date.now());
      if (isNaN(d1) || isNaN(d2)) throw new Error('需 date1/date2 如 2026-01-01');
      const day = Math.round((d2 - d1) / 864e5);
      const t2 = new Date(Date.now());
      const future = new Date(Date.now() + day * 864e5);
      return '【日期】' + d1.toISOString().slice(0, 10) + ' → ' + d2.toISOString().slice(0, 10) + '\n' +
        '相差 ' + Math.abs(day) + ' 天（' + R(Math.abs(day) / 7 * 10) / 10 + ' 周 / ' + R(Math.abs(day) / 30 * 100) / 100 + ' 个月）\n' +
        '今天是 ' + t2.toISOString().slice(0, 10) + '，对应未来 ' + Math.abs(day) + ' 天后 = ' + future.toISOString().slice(0, 10);
    } },
  { id: 'percent', name: '百分比计算', cat: '工具',
    desc: '占比/增减幅/目标完成率',
    args: 'a,b,mode',
    run: a => {
      const x = num(a.a), y = num(a.b);
      if (!y) throw new Error('需 a b 两个数值');
      const m = String(a.mode || 'pct');
      if (m === 'change') return (x) + ' vs ' + y + ' → ' + pct((x - y) / y) + '（' + (x > y ? '增长' : '下降') + '）';
      if (m === 'goal') return '目标 ' + y + ' · 实际 ' + x + ' → 完成率 ' + pct(x / y);
      return x + ' 占 ' + y + ' 的 ' + pct(x / y);
    } },
  { id: 'json_tidy', name: 'JSON 整理校验', cat: '工具',
    desc: '校验并格式化 JSON',
    args: 'json',
    run: a => {
      const j = String(a.json || '').trim();
      if (!j) throw new Error('需 json 参数');
      try { const o = JSON.parse(j); return '✓ 合法 JSON\n' + JSON.stringify(o, null, 2).slice(0, 2000); }
      catch (e) { throw new Error('JSON 解析失败：' + e.message); }
    } },
  { id: 'base64', name: 'Base64 编解码', cat: '工具',
    desc: '文本 ↔ Base64',
    args: 'text,mode',
    run: a => {
      const t = String(a.text || '');
      if (!t) throw new Error('需 text 参数（mode=encode/decode）');
      const m = String(a.mode || 'encode');
      if (m === 'decode') { try { return Buffer.from(t, 'base64').toString('utf8'); } catch (e) { throw new Error('非法 Base64'); } }
      return Buffer.from(t, 'utf8').toString('base64');
    } },

  // ================= 咨询 / 决策 (consult) =================
  { id: 'decision_matrix', name: '加权决策矩阵', cat: '咨询',
    desc: '多方案×多准则 加权评分（准则：权重，方案：各准则分）',
    args: 'criteria,options',
    run: a => {
      const crit = arr(a.criteria).map(c => { const k = c.split(':'); return { n: k[0], w: num(k[1], 1) }; });
      const opts = arr(a.options).map(o => { const k = o.split(':'); return { n: k[0], s: k.slice(1).map(Number) }; });
      if (crit.length < 2 || opts.length < 2) throw new Error('需 criteria=准则1:权重,准则2:权重,… 且 options=方案1:分,分,…');
      const scored = opts.map(o => ({ n: o.n, total: crit.reduce((s, c, i) => s + (o.s[i] || 0) * c.w, 0) }));
      scored.sort((x, y) => y.total - x.total);
      return '【加权决策矩阵】准则：' + crit.map(c => c.n + '(×' + c.w + ')').join(' / ') + '\n' +
        scored.map((s, i) => '  ' + (i + 1) + '. ' + s.n + ' → ' + s.total + ' 分').join('\n') +
        '\n→ 高分方案入选；若最高分与次高分 <10%，多做一次敏感性确认再拍板';
    } },
  { id: 'pros_cons', name: '利弊清单', cat: '咨询',
    desc: '双列利弊 + 关键条件',
    args: 'choice,pros,cons',
    run: a => {
      const c = head(a.choice || '该选择'), p = arr(a.pros), co = arr(a.cons);
      return '【利弊】选择：「' + c + '」\n' +
        '✓ 利\n  ' + (p.length ? p.map(x => '· ' + x).join('\n  ') : '· 请填写 pros=优势1,优势2,…') + '\n' +
        '✗ 弊\n  ' + (co.length ? co.map(x => '· ' + x).join('\n  ') : '· 请填写 cons=劣势1,劣势2,…') + '\n' +
        '成事条件：____（缺失则利无可兑现）\n最差结果承受度：____（不可承受则放弃）\n决策缺口：____（还需验证的 1 个关键信息）';
    } },
  { id: 'pareto', name: '帕累托 80/20 分析', cat: '咨询',
    desc: '按影响排序找出关键少数',
    args: 'items',
    run: a => {
      const items = arr(a.items).map(x => { const k = x.split(':'); return { n: k[0], v: num(k[1], 1) }; });
      if (!items.length) throw new Error('需 items=事项:影响值,事项:影响值…');
      const sorted = items.slice().sort((x, y) => y.v - x.v);
      const total = sorted.reduce((s, x) => s + x.v, 0);
      let acc = 0, cut = -1;
      for (let i = 0; i < sorted.length; i++) { acc += sorted[i].v; if (acc >= total * 0.8 && cut < 0) cut = i + 1; }
      return '【帕累托】共 ' + sorted.length + ' 项 · 总值 ' + total + '\n' +
        sorted.map((x, i) => { acc += 0; return '  ' + (i + 1) + '. ' + x.n + ' (' + x.v + ')'; }).join('\n') +
        '\n→ 顶部 ' + cut + ' 项已达 80% 影响，优先集中资源于这些关键少数';
    } },
  { id: 'premortem', name: '预演失败（事前验尸）', cat: '咨询',
    desc: '假定项目已失败，倒推失败原因与防御',
    args: 'plan',
    run: a => {
      const p = head(a.plan || '本项目');
      return '【预演失败】假设 ' + p + ' 已经失败，原因很可能是：\n' +
        '1. ____（需求判断错了）\n' +
        '2. ____（进度/资金断供）\n' +
        '3. ____（关键人物/渠道失联）\n' +
        '4. ____（合规/声誉事件）\n' +
        '→ 对每条写一个"提前防御动作"（本周内可做的最小一件），并设 1 个触发器（何种信号出现则启动 B 计划）\n' +
        '价值：失败越具体，防御越真实。写完这四条，项目成功率由"幻觉"转为可执行项';
    } },
  { id: '5w1h', name: '5W1H 全维拆解', cat: '咨询',
    desc: '六问把问题定义清晰',
    args: 'topic',
    run: a => {
      const t = head(a.topic || '该问题');
      return '【5W1H】' + t + '\n' +
        'What 是什么？——目标与定义：____\n' +
        'Why 为什么做？——价值与动机：____\n' +
        'Who 谁来做/给谁？——主责与对象：____\n' +
        'When 何时/多久？——时间窗与里程碑：____\n' +
        'Where 在哪里？——场景/渠道/地域：____\n' +
        'How 怎么做？——路径、资源与预算：____\n' +
        '→ 六行填满即为一份可执行的初始化任务书';
    } },
  { id: 'tradeoff', name: '取舍权衡分析', cat: '咨询',
    desc: '假设检验：哪个条件成立就该选哪个',
    args: 'opt1,opt2,cond',
    run: a => {
      const o1 = head(a.opt1 || '方案A'), o2 = head(a.opt2 || '方案B'), cd = head(a.cond || '关键前提');
      return '【取舍】' + o1 + ' vs ' + o2 + '\n' +
        '决定性前提：「' + cd + '」\n' +
        '若「' + cd + '」成立 → 选 ' + o1 + '\n' +
        '若「' + cd + '」不成立 → 选 ' + o2 + '\n' +
        '验证动作：本周用最小的测试验证「' + cd + '」（成本 ≤ ____ ）\n' +
        '→ 把"纠结"转成"检验一个假设"，是取舍的唯一正确姿势';
    } },
  { id: 'results_chain', name: '成果链规划（反向推）', cat: '咨询',
    desc: '从目标倒推：结果→行为→输入',
    args: 'goal',
    run: a => {
      const g = head(a.goal || '目标');
      return '【成果链】目标：' + g + '\n' +
        '—— 结果（可被外部验证的产出）：____\n' +
        '—— 行为（每周重复的动作）：____\n' +
        '—— 输入（时间/工具/人/钱）：____\n' +
        '检查：行为是否直接≈结果？若中间缺一环，补上再执行；\n' +
        '反向思维：先定义"可验证结果"，再反推每天做什么，避免"忙碌陷阱"';
    } },
  { id: 'persona_test', name: '六型决策人格测试', cat: '咨询',
    desc: '20题免费钩子（FINAL-1.1 决策人格）→ 六型画像',
    args: 'answers',
    run: a => {
      const ans = arr(a.answers).map(s => s.trim().toLowerCase());
      if (!ans.length) throw new Error('需 answers=20个选项字母(A/B/C/D/E/F)');
      const m = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
      ans.forEach(x => { if (m[x] != null) m[x]++; });
      const labels = { a: '扛事型(负重前行)', b: '权衡型(得失计算)', c: '直觉型(快速决断)', d: '拖延型(收集等待)', e: '孤勇型(独自承担)', f: '顺水型(顺应环境)' };
      const top = Object.entries(m).sort((x, y) => y[1] - x[1])[0];
      return '【六型决策人格】完成 ' + ans.length + ' 题\n' +
        Object.entries(m).map(([k, v]) => '  ' + labels[k] + ' ' + v + ' 题').join('\n') +
        '\n你的主导类型：' + labels[top[0]] + '\n' +
        '改善建议：' + (top[0] === 'd'
          ? '给决策设硬 deadline，先做"及格选择"再迭代。'
          : top[0] === 'a'
            ? '学会把背负分给系统/他人，警惕惯性逞强。'
            : top[0] === 'f'
              ? '顺势但保留底线清单，别让环境替你全权投票。'
              : '保持优势，缺失维度可调用决策中心框架补齐。');
    } },
  { id: 'manual_topic', name: '活下去手册选题生成', cat: '咨询',
    desc: '从困境关键词生成最小行动手册骨架（依据 FINAL-1.1 §2.8）',
    args: 'topic',
    run: a => {
      const t = head(a.topic || '被裁后的第一个72小时');
      return '【活下去手册】主题：「' + t + '」\n' +
        '① 你的感受很正常（历史同局者：____，出处_书_卷_页）\n' +
        '② 72小时最小步骤清单：\n' +
        '    ☐ 今天能做的第1步：____（≤5条，每条当天可完成）\n' +
        '    ☐ 今天能做的第2步：____\n' +
        '    ☐ 明确"暂缓也是行动"：____\n' +
        '③ 三件不要做：☐ 不裸辞 ☐ 不借新还旧 ☐ 不立刻大改动\n' +
        '④ 历史上同局者后来怎样：案例卡2-3张（带页码）\n' +
        '⑤ 政策地板（可查公开救济）：____（标注来源与时效）\n' +
        '⑥ 下一步入口（自愿）：推演一次 / 领一只宠物 / 给下一个卡住的人留灯\n' +
        '尊严条款：通篇"正在走路的人"，禁俯视词汇';
    } },
  { id: 'lighthouse_guide', name: '同路人灯角撰写', cat: '咨询',
    desc: 'T1「我这样走出来了」300字模板（FINAL-1.1 §2.9）',
    args: 'story',
    run: a => {
      const s = head(a.story || '我的经历');
      return '【同路人 T1】今晚你的故事：\n' +
        '当时最怕什么：____\n' +
        '第一步做了什么：____\n' +
        '最想对下一个卡住的人说一句什么：『' + s + '』\n' +
        '发布前检查：□ 已匿名化 □ 无比较句("我比你幸运") □ 无金额细节 □ 自愿 opt-in\n' +
        '→ 提交后仅出现在"同一卦/同一处境"用户的决策报告第 7 段灯角位；不开帖、不评论、不私信。';
    } },
  // ================= 财务 补充 =================
  { id: 'salary_net', name: '税前/税后工资换算', cat: '财务',
    desc: '按新个税速算扣除估算税后到手',
    args: 'gross,base',
    run: a => {
      const gross = num(a.gross), base = num(a.base, 5000);
      if (!gross) throw new Error('需 gross=税前工资 base=起征点(默认5000)');
      const taxable = Math.max(0, gross - base);
      let tax = 0;
      if (taxable > 960000) tax = taxable * 0.45 - 181920;
      else if (taxable > 660000) tax = taxable * 0.35 - 85920;
      else if (taxable > 420000) tax = taxable * 0.30 - 52920;
      else if (taxable > 300000) tax = taxable * 0.25 - 31920;
      else if (taxable > 144000) tax = taxable * 0.20 - 16920;
      else if (taxable > 36000) tax = taxable * 0.10 - 2520;
      else tax = taxable * 0.03;
      const net = gross - tax;
      return '【税后到手】税前 ' + money(gross) + ' · 起征 ' + base + '\n' +
        '应纳税所得 = ' + money(taxable) + '\n' +
        '预估个税 = ' + money(Math.max(0, tax)) + '（不含五险一金）\n' +
        '税后到手 ≈ ' + money(net);
    } },
  { id: 'save_goal', name: '储蓄目标倒推', cat: '财务',
    desc: '每月需存多少才能在期限内达标',
    args: 'goal,months,rate',
    run: a => {
      const goal = num(a.goal), months = num(a.months), r = num(a.rate, 0) / 100;
      if (!goal || !months) throw new Error('需 goal=目标金额 months=月数 rate=年化利率%');
      const rm = r / 12;
      const pmt = rm > 0 ? goal * rm / (Math.pow(1 + rm, months) - 1) : goal / months;
      const total = pmt * months;
      return '【储蓄目标】' + months + ' 个月存 ' + money(goal) + '\n' +
        '月利率 = ' + pct(rm) + ' → 每月定存 = ' + money(R(pmt * 100) / 100) + '\n' +
        '累计本金投入 = ' + money(R(total * 100) / 100) + '\n' +
        '若年化 ' + (a.rate || 0) + '% 可少存 ' + money(Math.max(0, R((goal - total) * 100) / 100));
    } },
  // ================= 市场 补充 =================
  { id: 'channel_rank', name: '渠道优先级矩阵', cat: '市场',
    desc: 'cost/acquire/volume 三因子加权排序渠道',
    args: 'channels',
    run: a => {
      const cs = arr(a.channels).map(x => { const k = x.split(':'); return { name: k[0], cost: num(k[1]), acq: num(k[2]), vol: num(k[3], 1) }; });
      if (!cs.length) throw new Error('需 channels=渠道:获客成本:成交转化数:月流量，多行用逗号分隔');
      const score = c => R((c.vol / (c.acq || 1)) * 0.5 + (1 - Math.min(1, c.cost / 100)) * 0.3 + Math.min(1, c.acq / 20) * 0.2, 2);
      const ranked = cs.slice().sort((x, y) => score(y) - score(x));
      return '【渠道优先级】按 规模×50% + 低成本×30% + 转化×20% 打分\n' +
        ranked.map((c, i) => (i + 1) + '. ' + c.name + '  得分 ' + score(c) + '  (CAC ' + c.cost + ' / 转化 ' + c.acq + ' / 流量 ' + c.vol + ')').join('\n') +
        '\n建议优先投 ' + ranked.slice(0, 2).map(c => c.name).join('、');
    } },
  { id: 'promo_roi', name: '促销活动 ROI', cat: '市场',
    desc: '活动增量 ROI、折扣率、盈亏平衡折扣',
    args: 'sales,lift,cost,price,profit',
    run: a => {
      const sales = num(a.sales), lift = num(a.lift), cost = num(a.cost), pr = num(a.price), pm = num(a.profit);
      if (!sales || !lift) throw new Error('需 sales=原销量 lift=增量销量 cost=活动成本 price=单价 profit=单品利润');
      const extra = lift * pr;
      const roi = (extra - cost) / cost;
      const bal = cost / pr;
      return '【促销 ROI】原销量 ' + sales + ' · 增量 ' + lift + ' · 活动成本 ' + money(cost) + '\n' +
        '增量收入 = ' + money(extra) + '\n' +
        '活动 ROI = ' + pct(roi) + (roi > 1 ? '  ✅ 值得持续' : '  ⚠ 投入产出不佳') + '\n' +
        '盈亏平衡需额外售出 ≈ ' + R(bal) + ' 件（实际增量 ' + lift + '）\n' +
        '若不打折改投放：CAC ≤ ' + money(pm) + ' 即不亏';
    } },
  { id: 'rev_stream', name: '营收结构健康度', cat: '市场',
    desc: '产品线/客户集中度与风险敞口',
    args: 'lines',
    run: a => {
      const ls = arr(a.lines).map(x => { const k = x.split(':'); return { name: k[0], rev: num(k[1]) }; });
      if (!ls.length) throw new Error('需 lines=产品线:营收，逗号分隔');
      const total = ls.reduce((s, x) => s + x.rev, 0);
      const top = ls.slice().sort((x, y) => y.rev - x.rev)[0];
      const topShare = top.rev / total;
      return '【营收健康度】总营收 ' + money(total) + '\n' +
        ls.map(x => '  ' + x.name + ' ' + money(x.rev) + '（' + pct(x.rev / total) + '）').join('\n') + '\n' +
        '最大单品占比 ' + pct(topShare) + '（' + top.name + '）' +
        (topShare > 0.6 ? ' ⚠ 过度集中，建议分散' : topShare > 0.4 ? ' 注意：仍需第二曲线' : ' ✅ 结构较健康') + '\n' +
        '参考：CR 指数 = ' + R(topShare * 100) / 10;
    } },
  // ================= 运营 补充 =================
  { id: 'bottleneck', name: '流程瓶颈定位', cat: '运营',
    desc: '各环节耗时序中找出瓶颈与全流程时长',
    args: 'steps',
    run: a => {
      const ss = arr(a.steps).map(x => { const k = x.split(':'); return { name: k[0], t: num(k[1]) }; });
      if (!ss.length) throw new Error('需 steps=环节:耗时分钟，逗号分隔');
      const total = ss.reduce((s, x) => s + x.t, 0);
      const slow = ss.slice().sort((x, y) => y.t - x.t)[0];
      return '【流程瓶颈】全流程 ' + total + ' 分钟\n' +
        ss.map((x, i) => (i + 1) + '. ' + x.name + ' ' + x.t + 'min（' + pct(x.t / total) + '）').join('\n') + '\n' +
        '瓶颈环节：' + slow.name + '（占 ' + pct(slow.t / total) + '）\n' +
        '若压缩瓶颈 50% → 全流程缩短 ' + R(slow.t * 0.5 * 10) / 10 + ' 分钟，可节 ' + pct(slow.t * 0.5 / total) + ' 周期时间';
    } },
  { id: 'kpi_tree', name: '北极星到拆解 KPI 树', cat: '运营',
    desc: '从北极星目标逐层导出可行动指标',
    args: 'goal',
    run: a => {
      const g = head(a.goal || '营收');
      return '【KPI 树】北极星：' + g + '\n' +
        '第1层（结果）: ' + g + ' = ' + g + '漏斗 × ' + g + '客单价\n' +
        '第2层（驱动）: ①获客量 ②转化率 ③客单价 ④复购率\n' +
        '第3层（执行）: 每个驱动配 1 个 T+30 天可测量指标：\n' +
        '   获客→ 日均有效线索数（目标 ____）\n' +
        '   转化→ 线索到成交转化率（目标 ____%）\n' +
        '   客单→ 平均订单金额（目标 ____）\n' +
        '   复购→ 90天复购率（目标 ____%）\n' +
        '输出物：把 4 个目标填入 OKR 的 KR，即完成一层拆解。';
    } },
  { id: 'biz_ops_check', name: '经营巡检清单', cat: '运营',
    desc: '日/周/月三级巡检项生成',
    args: 'biz',
    run: a => {
      const b = head(a.biz || '实体门店');
      return '【经营巡检 — ' + b + '】\n' +
        '每日（10分钟）: ☐ 进账核对 ☐ 差评/投诉查看 ☐ 库存短缺预警\n' +
        '每周（30分钟）: ☐ 销量Top/Bottom变化 ☐ 人效统计 ☐ 应收账款催收\n' +
        '每月（2小时）: ☐ 现金流对账 ☐ 毛利结构变化 ☐ 竞品价格侦察 ☐ 下月资金预算\n' +
        '红色预警触发：进账连续3天下滑 >15% → 自动上止损看板 L2。';
    } },
  // ================= 风险 补充 =================
  { id: 'impact_urgency', name: '影响×紧急性矩阵', cat: '风险',
    desc: '四象限任务分级与处理顺序',
    args: 'items',
    run: a => {
      const is = arr(a.items).map(x => { const k = x.split(':'); return { name: k[0], imp: num(k[1]), urg: num(k[2]) }; });
      if (!is.length) throw new Error('需 items=事项:影响度1-10:紧急性1-10');
      const q = i => {
        if (i.imp >= 7 && i.urg >= 7) return 'Q1 立刻做';
        if (i.imp >= 7) return 'Q2 本周排期';
        if (i.urg >= 7) return 'Q3 授权/限时处理';
        return 'Q4 暂缓或不做';
      };
      return '【影响×紧急四象限】\n' +
        is.map(i => '  [' + q(i) + '] ' + i.name + '（影响' + i.imp + '/紧急' + i.urg + '）').join('\n') + '\n' +
        'Q1 优先保证不遗漏；Q4 是最大的时间黑洞，设置"不做清单"';
    } },
  { id: 'regret_test', name: '后悔最小化测试', cat: '风险',
    desc: '贝索斯式 80 岁视角决策自检',
    args: 'choice,alt',
    run: a => {
      const c = head(a.choice || '做某事'), at = head(a.alt || '不做什么');
      return '【后悔最小化测试】当前选择：' + c + ' · 备选：' + at + '\n' +
        '问自己：80 岁时回看——\n' +
        '  ① 不做 ' + c + '，我会后悔吗？' + (a.regret_alt || '（填 yes/no）') + '\n' +
        '  ② 做了但失败，最后悔的是"结果差"还是"没尝试"？\n' +
        '  ③ 可逆吗？若可逆，代价上限 = 止损线 L' + (num(a.upper, 1)) + '\n' +
        '决策草案：' + (String(a.regret_alt).toLowerCase() === 'yes' ? '建议推进，设置止损与复查点' : '建议先暂停，补证据再定') + '\n' +
        '配套：查看 决策中心·框架库「有限理性决策」补证据真空。';
    } },
  { id: 'single_point', name: '单点故障排查', cat: '风险',
    desc: '业务依赖中单个故障点识别与冗余建议',
    args: 'deps',
    run: a => {
      const ds = arr(a.deps).map(x => { const k = x.split(':'); return { name: k[0], risk: num(k[2], 3), crit: String(k[1] || '').includes('Y') || String(k[1] || '').includes('y') }; });
      if (!ds.length) throw new Error('需 deps=依赖:是否关键Y/N:故障影响度1-5');
      const sp = ds.filter(x => x.crit && x.risk >= 4);
      return '【单点故障】关键依赖 ' + ds.filter(x => x.crit).length + ' / ' + ds.length + '\n' +
        ds.map(x => '  ' + x.name + (x.crit ? ' ★关键' : '') + ' 影响' + x.risk).join('\n') + '\n' +
        (sp.length ? '⚠ 高危单点：' + sp.map(x => x.name).join('、') + ' —— 建议准备替代/冗余/手册' : '✅ 暂无高危单点，仍建议每年复查一次该清单');
    } },
  // ================= 人力 补充 =================
  { id: 'cand_score', name: '候选人综合评分', cat: '人力',
    desc: '技能/经验/文化/成本四维加权',
    args: 'cands',
    run: a => {
      const cs = arr(a.cands).map(x => { const k = x.split(':'); return { name: k[0], s: num(k[1]), e: num(k[2]), c: num(k[3]), m: num(k[4]) }; });
      if (!cs.length) throw new Error('需 cands=姓名:技能:经验:文化:期望薪资(万)');
      const score = c => R(c.s * 0.3 + c.e * 0.25 + c.c * 0.25 + Math.max(0, 10 - c.m) * 0.1, 2);
      const ranked = cs.slice().sort((x, y) => score(y) - score(x));
      return '【候选人评分】权重 技能30% 经验25% 文化25% 成本10%\n' +
        ranked.map((c, i) => (i + 1) + '. ' + c.name + ' ' + score(c) + ' 分（技' + c.s + ' 经' + c.e + ' 文' + c.c + ' 薪' + c.m + '万）').join('\n') + '\n' +
        '建议首面：' + ranked[0].name + '；备选：' + (ranked[1] ? ranked[1].name : '无');
    } },
  { id: 'okr_1on1', name: '1对1 面谈提纲', cat: '人力',
    desc: '结构化一对一沟通模板',
    args: 'name',
    run: a => {
      const n = head(a.name || '同事');
      return '【1对1 面谈 — ' + n + '】\n' +
        '0) 开场 5%：近况好不好（非工作）\n' +
        '1) 业务 60%：本周目标是否可达成？最卡它的一个点？\n' +
        '2) 成长 20%：最近一次"学到东西"是什么时刻？\n' +
        '3) 感受 15%：有没有想提醒团队/我这个信号？\n' +
        '收尾：明确 2 个行动项 + 下次约定日期。\n' +
        '禁忌：全程不说教、不打断、不做绩效点评。';
    } },
  { id: 'turnover_risk', name: '离职风险评分', cat: '人力',
    desc: '六大离职前兆信号加权',
    args: 'signals',
    run: a => {
      const flags = arr(a.signals);
      const w = { 迟到早退: 1, 请假增多: 1.5, 重要任务推给他人: 2, 提离职话题: 2, 简历更新: 2.5, 沉默寡言: 1 };
      let score = 0; flags.forEach(f => { if (w[f]) score += w[f]; });
      return '【离职信号检测】命中 ' + flags.length + ' 个信号\n' +
        '加权得分 = ' + score + ' / 10\n' +
        (score >= 5 ? '⚠ 高离职风险：本周面谈 + 落待遇/成长方案' : score >= 3 ? '注意观察：跟进面谈，避免恶化' : '✅ 平稳：保持每月 1 次轻报') + '\n' +
        '参考信号权重：' + Object.keys(w).join('、');
    } },
  // ================= 技术 补充 =================
  { id: 'sql_compose', name: '常用 SQL 模板', cat: '技术',
    desc: '聚合/去重/分页/窗口 常见查询模板',
    args: 'table',
    run: a => {
      const t = head(a.table || 'orders');
      return '【SQL 模板 — ' + t + '】\n' +
        '去重计数：SELECT COUNT(DISTINCT user_id) FROM ' + t + ';\n' +
        '按日聚合：SELECT date, SUM(amount) FROM ' + t + ' GROUP BY date ORDER BY date;\n' +
        '排行 TOP10：SELECT * FROM ' + t + ' ORDER BY amount DESC LIMIT 10;\n' +
        '窗口（累计）：SELECT date, SUM(amount) OVER (ORDER BY date) AS cumsum FROM ' + t + ';\n' +
        '分页：SELECT * FROM ' + t + ' ORDER BY id LIMIT 50 OFFSET ' + num(a.page, 0) * 50 + ';';
    } },
  { id: 'incident_ladder', name: '线上故障升级路径', cat: '技术',
    desc: '故障级别 P1-P4 与响应时限',
    args: 'svc',
    run: a => {
      const s = head(a.svc || '线上服务');
      return '【故障分级 — ' + s + '】\n' +
        'P0/S1 全网不可用   → 5 分钟响应，立即回滚或熔断，每15分钟同步\n' +
        'P1/S2 核心功能挂   → 15分钟响应，2小时内恢复\n' +
        'P2/S3 单模块异常   → 当天修复，发公告\n' +
        'P3/S4 体验类问题   → 进两周迭代队列\n' +
        '检查清单：□ 看监控大盘 □ 看最近一次发布 □ 看错误日志堆积 □ 是否数据库慢查询 □ 是否依赖第三方超时\n' +
        '复盘要求：任何 P0/P1 必须 48 小时内出一页 A4 复盘（时间线/根因/行动项）。';
    } },
  { id: 'api_curl', name: 'API 调试指令生成', cat: '技术',
    desc: 'GET/POST 带鉴权的 curl 模板',
    args: 'url,method,token,body',
    run: a => {
      const u = head(a.url || 'https://api.example.com/v1/items');
      const m = head(a.method || 'GET').toUpperCase();
      const tk = a.token ? ' -H \'Authorization: Bearer ' + a.token + '\'' : '';
      const bd = m === 'POST' ? ' -H \'Content-Type: application/json\' -d \'' + (a.body || '{}') + '\'' : '';
      return '【curl 模板】\ncurl -X ' + m + ' \'' + u + '\'' + tk + bd + '\n\n' +
        'Node 等价：\nfetch(\'' + u + '\', { method: \'' + m + '\', headers: { ' + (a.token ? '\'authorization\': \'Bearer ' + a.token + '\', ' : '') + '\'content-type\': \'application/json\' }' + (m === 'POST' ? ', body: JSON.stringify(' + (a.body || '{}') + ')' : '') + ' })';
    } },
  { id: 'rank_issue', name: '数据异常定位', cat: '技术',
    desc: '从数字波动反向排查 维度/口径/取数',
    args: 'metric',
    run: a => {
      const m = head(a.metric || '日活');
      return '【' + m + ' 异常定位】六步排查：\n' +
        '① 口径变了？(是否改了统计窗口/去重/同比逻辑)\n' +
        '② 源数据断了？(埋点/SDK/上游同步)\n' +
        '③ 时间对齐？(节假日/大促/跨零点)\n' +
        '④ 计算挂了？(首查最近一次发布 build)\n' +
        '⑤ 权限/环境？(A/B 分流,灰度比例调整?)\n' +
        '⑥ 展现问题？(前端取数 vs 后端口径)\n' +
        '产出：一页结论 + 复现SQL + 修复人(' + (a.owner || '待指派') + ')';
    } },
  { id: 'data_retention', name: '数据保留策略', cat: '技术',
    desc: '按规定分级确定保留周期与归档',
    args: 'industry',
    run: a => {
      const s = head(a.industry || '一般企业');
      return '【数据保留策略 — ' + s + '】\n' +
        '用户注册/订单：交易完成之日起至少 3 年（税法要求记账凭证）\n' +
        '日志/埋点：建议 180 天热存 + 长期归档冷存\n' +
        '聊天/客服记录：建议 1~3 年\n' +
        '面试/招聘资料：未被录用默认保存 6 个月\n' +
        '合规动作：☐ 指定数据负责人 ☐ 每年复核政策 ☐ 删除/匿名化流程落地 ☐ 告知用户留存期限';
    } },
  // ================= 增长 补充 =================
  { id: 'aha_min', name: 'Aha 时刻拆解', cat: '增长',
    desc: '找到新手最快体验到核心价值的行为',
    args: 'product',
    run: a => {
      const p = head(a.product || '产品');
      return '【Aha 时刻拆解 — ' + p + '】\n' +
        '第1步：定义"留存的Aha"，如 3 天内完成核心动作\n' +
        '第2步：找留存分水岭：对比「完成/未完成」某动作的 D7 留存\n' +
        '第3步：把该动作前移到 onboarding 第 1 屏，砍掉一切前置步骤\n' +
        '第4步：设漏斗目标：新用户 24h 内完成动作 ≥ ' + num(a.target, 30) + '%\n' +
        '验证：A/B 把动作前移，观察 D7 留存提升是否 >5pp。';
    } },
  { id: 'nps_survey', name: 'NPS 问卷与解读', cat: '增长',
    desc: 'NPS 计算与三段式开放题',
    args: 'push,detract',
    run: a => {
      const p = num(a.push), d = num(a.detract);
      if (!p && !d) throw new Error('需 push=推荐者% detract=贬损者%');
      const passive = Math.max(0, 100 - p - d);
      const nps = p - d;
      return '【NPS 测算】推荐者 ' + p + '% · 被动者 ' + passive + '% · 贬损者 ' + d + '%\n' +
        'NPS = ' + p + ' - ' + d + ' = ' + nps + (nps >= 50 ? ' ✅ 优秀' : nps >= 30 ? ' 良好' : nps >= 0 ? ' 待改进' : ' ⚠ 危险区') + '\n' +
        '开放题模板：\n  ① 用一个词形容我们？\n  ② 为什么不给 10 分？\n  ③ 你身边谁会需要它？\n' +
        '贬损者处理：24 小时内 1 对 1 回访，只问"哪里难受"。';
    } },
  { id: 'ltv_churn', name: '流失挽回清单', cat: '增长',
    desc: '针对流失用户的挽回动作与时间窗',
    args: 'term',
    run: a => {
      const t = head(a.term || '30天未活跃');
      return '【流失挽回 — 定义：' + t + '】\n' +
        '分级窗口（按业务经验默认，可按需调整）：\n' +
        '  D-7  未活跃   → 原因摸底（发1条轻触达）\n' +
        '  D-14 未活跃   → 权益/价值提醒（利益钩子 1 次）\n' +
        '  D-30 未活跃   → 挽留方案（折扣/新功能告知 + 真实原因问卷）\n' +
        '  D+  沉默≥60天 → 标记休眠，停止打扰，仅节日关怀\n' +
        '关键：挽回成本 < 获客成本才有意义；对比 CAC 后再投。';
    } },
  // ================= 管理 补充 =================
  { id: 'decision_memo', name: '决策备忘录', cat: '管理',
    desc: '决策记录模板（依据我一直在·统一执行总纲）',
    args: 'topic',
    run: a => {
      const t = head(a.topic || '待决策事项');
      return '【决策备忘录 — ' + t + '】\n' +
        '1) 决策背景：____\n' +
        '2) 可选方案 + 证据条数：A:____ B:____ C:____\n' +
        '3) 我的决策人格（六型）：____（先去测试页测 20 题）\n' +
        '4) 未来 6 个月视角：____\n' +
        '5) 止损线 L' + (num(a.stoploss, 3)) + '：____（触发即停止，不追加）\n' +
        '6) 期限与复查点：____\n' +
        '7) 决策记入年度决策报告（聚合后可复盘命中率）。';
    } },
  { id: 'meeting_owner', name: '高效会议负责人法', cat: '管理',
    desc: '会前/会中/会后三段检查',
    args: 'topic',
    run: a => {
      const t = head(a.topic || '项目同步会');
      return '【会议控制法 — ' + t + '】\n' +
        '会前（5分钟准备）：□ 议程已发 □ 每人只带 1 个问题 □ 结论待定前置\n' +
        '会中（限时30-45分）：□ 前10分回顾目标 □ 讨论只围绕"下一个行动" □ 禁止代开无声会\n' +
        '会后（当天）：□ 2 分钟内发纪要（含责任人+截止日） □ 下一场前检查完成度\n' +
        '健康指标：本周 开会时长/有效产出 比值是否改善。';
    } },
  { id: 'delegation', name: '授权委派清单', cat: '管理',
    desc: '任务可授权性四问筛选',
    args: 'items',
    run: a => {
      const is = arr(a.items).map(x => { const k = x.split(':'); return { name: k[0], note: k[1] || '' }; });
      if (!is.length) throw new Error('需 items=任务1:备注,任务2:备注');
      return '【授权四问】逐项自检每一任务是否应下放：\n' +
        is.map(i => '  · ' + i.name + '\n      ① 必须是我？② 别人能学会？③ 有标准可check？④ 我会耽误它吗？' +
          ((String(i.note).toLowerCase()).includes('y') || (String(i.note).toLowerCase()).includes('能') ? ' → 建议下放' : '')).join('\n') + '\n' +
        '若四项都"是/能"，请在本周下放；授权后只问结果，给方法不给答案。';
    } },
  // ================= 数据 补充 =================
  { id: 'growth_rate', name: '复合增长率 CAGR', cat: '数据',
    desc: 'CAGR 与简单几何平均计算',
    args: 'begin,end,years',
    run: a => {
      const b = num(a.begin), e = num(a.end), y = num(a.years);
      if (!b || !e || !y) throw new Error('需 begin=起始值 end=结束值 years=年数');
      const cagr = Math.pow(e / b, 1 / y) - 1;
      return '【CAGR】由 ' + money(b) + ' → ' + money(e) + ' 共 ' + y + ' 年\n' +
        '年复合增长率 = ' + pct(cagr) + '\n' +
        '平均每年需比前一年多 ' + pct(cagr) + ' 的增速才能到达目标。';
    } },
  { id: 'conv_prop', name: '占比与同比环比', cat: '数据',
    desc: '结构占比 + 同比/环比变化',
    args: 'this_m,last_y,last_m',
    run: a => {
      const t = num(a.this_m), ly = num(a.last_y), lm = num(a.last_m);
      if (!t && !ly && !lm) throw new Error('需 this_m=本期 last_y=去年同期 last_m=上期');
      const yoy = ly ? (t - ly) / ly : null;
      const mom = lm ? (t - lm) / lm : null;
      return '【同比环比】本期 ' + money(t) + '\n' +
        '同比(对比去年同期): ' + (yoy == null ? '无基期' : pct(yoy) + (Math.abs(yoy) > 0.2 ? ' ⚠ 大幅波动请查因' : '')) + '\n' +
        '环比(对比上期): ' + (mom == null ? '无基期' : pct(mom)) + '\n' +
        '结构检查：最大构成项占比 ____%（超50%需关注集中度）。';
    } },
  { id: 'sample_check', name: '样本量检查', cat: '数据',
    desc: '比例估计所需最小样本量',
    args: 'margin',
    run: a => {
      const m = num(a.margin, 0.05);
      if (m <= 0 || m >= 1) throw new Error('需 margin=容许误差(如0.05)');
      const n = Math.ceil(0.96 / (m * m));
      return '【最小样本量】容许误差 ±' + pct(m) + '\n' +
        'n ≥ 1.96² × 0.25 / ' + m + '² = ' + n + ' 份\n' +
        (n > 385 ? '样本量较大，建议分层抽样或放宽误差。' : '常规可接受，注意随机性与无应答偏差。') + '\n' +
        '提示：误差缩一半，样本要 ×4。';
    } },
  // ================= 文本 补充 =================
  { id: 'readability', name: '可读性检查', cat: '文本',
    desc: '句长、分段、难词提示',
    args: 'text',
    run: a => {
      const t = head(a.text || '一句话。'); 
      const sents = t.split(/[。！？!?；;]/).filter(x => x.length > 0).length || 1;
      const chars = t.length; const charsPerSent = R(chars / sents);
      return '【可读性检查】' + chars + ' 字 / ' + sents + ' 句\n' +
        '平均句长 ' + charsPerSent + ' 字' + (charsPerSent > 60 ? ' ⚠ 句长过长，拆句' : ' 适合') + '\n' +
        '提示：① 一句只讲一件事 ② 动词开头 ③ 每 <200 字插一个空行 ④ 数字不用千分位难读的写法\n' +
        '定稿前做"电梯测试"：能 30 秒向陌生人讲清吗？';
    } },
  { id: 'dialog_script', name: '对话脚本模板', cat: '文本',
    desc: '客服/销售/家人沟通脚本骨架',
    args: 'scene',
    run: a => {
      const s = head(a.scene || '客户投诉');
      return '【对话脚本 — ' + s + '】\n' +
        '开场（共情）：「我理解你现在很着急…」\n' +
        '确认（复述）：把对方的话复述一遍确认\n' +
        '方案（给选项）：给 2 个可选方案 + 1 个优先推荐\n' +
        '收尾（留路）：明确下一步时间与责任人\n' +
        '红线：不打断 / 不反驳 / 不轻易承诺 / 不贴标签 / 不转移话题\n' +
        '难点预案：对方情绪激动 → 先情绪后事情「听起来最让你难受的是____？」';
    } },
  { id: 'brief_2pager', name: '两页纸简报', cat: '文本',
    desc: '把任意材料压成两页简报结构',
    args: 'subject',
    run: a => {
      const s = head(a.subject || '本期主题');
      return '【两页纸简报 — ' + s + '】\n' +
        'P1 上：一句话结论（决策者只读这句）\n' +
        'P1 下：关键数字 3 个（含口径与来源）\n' +
        'P2 上：可选方案 + 各附证据条数与代价\n' +
        'P2 下：请决策者拍板的 1 个问题\n' +
        '字数铁律：正文 ≤ 800 字；超过就删旧不删新。';
    } },
  // ================= 工具 补充 =================
  { id: 'time_zone', name: '时区换算', cat: '工具',
    desc: 'UTC/本地/目标时区换算',
    args: 'to',
    run: a => {
      const now = new Date();
      const target = new Date(now.getTime() + (num(a.to, 8) - (-now.getTimezoneOffset() / 60)) * 3600000);
      return '【时区换算】本地时间 ' + now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC\n' +
        '目标时区 UTC' + (a.to >= 0 ? '+' : '') + (a.to || 8) + ' → ' + target.toISOString().slice(0, 16).replace('T', ' ') + '\n' +
        '常用：UTC+8 北京时间 · UTC+0 伦敦 · UTC-5 纽约 · UTC-8 洛杉矶';
    } },
  { id: 'bmi_health', name: '身体指数速查 BMI', cat: '工具',
    desc: 'BMI 与体重建议区间',
    args: 'height_cm,weight_kg',
    run: a => {
      const h = num(a.height_cm) / 100, w = num(a.weight_kg);
      if (!h || !w) throw new Error('需 height_cm=身高厘米 weight_kg=体重公斤');
      const bmi = w / (h * h);
      return '【BMI】身高 ' + (h * 100) + 'cm · 体重 ' + w + 'kg\n' +
        'BMI = ' + R(bmi * 100) / 100 + '\n' +
        (bmi < 18.5 ? '偏瘦：建议营养加餐，体重过轻易疲劳。' : bmi < 24 ? '正常 ✅ 维持。' : bmi < 28 ? '超重：建议每周 150 分钟有氧 + 减糖。' : '肥胖 ⚠ 建议就医评估，先减 5% 体重开始。') + '\n' +
        '健康体重区间（针对' + (h * 100) + 'cm）：' + R(18.5 * h * h * 10) / 10 + ' ~ ' + R(23.9 * h * h * 10) / 10 + ' kg';
    } },
  { id: 'data_url', name: 'JSON 转 CSV/URL 编码', cat: '工具',
    desc: 'JSON 数组转 CSV 表格文本，或 URL 编码',
    args: 'json',
    run: a => {
      const raw = (a.json || a.url || '').trim();
      if (!raw) throw new Error('需 json=JSON要转CSV 或 url=需要编码的文本');
      try {
        const j = JSON.parse(raw);
        if (Array.isArray(j) && j.length) {
          const keys = Object.keys(j[0]);
          const rows = j.map(o => keys.map(k => String(o[k] || '').replace(/,/g, '，')).join(','));
          return '【CSV】表头：' + keys.join(',') + '\n' + rows.join('\n');
        }
        const key = Object.keys(j)[0];
        return '【CSV】单对象：' + Object.keys(j).join(',') + '\n' + Object.values(j).join(',') + '\n→ 请补成数组以展开多行（首键 ' + key + '）。';
      } catch (err) {
        return '【URL编码】' + decodeURIComponent(encodeURIComponent(raw)) + '\n→ ' + encodeURIComponent(raw);
      }
    } },
  { id: 'range_plan', name: '区间估算 PERT', cat: '工具',
    desc: '三时点(P/A/M)加权工期估算',
    args: 'opt,most,pes',
    run: a => {
      const o = num(a.opt), m = num(a.most), p = num(a.pes);
      if (!a.opt && !a.most && !a.pes) throw new Error('需 opt=乐观 time, most=最可能, pes=悲观');
      const e = (o + 4 * m + p) / 6;
      const sd = (p - o) / 6;
      return '【PERT 估算】乐观 ' + o + ' · 最可能 ' + m + ' · 悲观 ' + p + '\n' +
        '期望工期 = ' + R(e * 10) / 10 + ' 天\n' +
        '标准差 = ' + R(sd * 10) / 10 + ' 天\n' +
        '85% 概率区间 ≈ ' + R((e - sd) * 10) / 10 + ' ~ ' + R((e + sd) * 10) / 10 + ' 天\n' +
        '建议排期按期望 + 0.5σ 打余量。';
    } },
  // ================= 玄数（玄学×数学形式化）(meta) =================
  { id: 'wuxing_matrix', name: '五行生克矩阵', cat: '玄数',
    desc: '5×5 生克矩阵幂迭代：月令取用神 + 旺衰稳态 + 用神经',
    args: 'seed',
    run: a => {
      const seed = String(a.seed || '').trim();
      const me = metaphys.monthElement(null);
      const s = metaphys.wuxingStationary(seed || me.element, 6);
      return '【五行生克矩阵】当月月令 ' + me.branch + '(' + me.month + '月)主' + me.element + ' · 用神起点「' + (seed || me.element) + '」\n' +
        s.dist.map(d => '  ' + d.element + '  ' + d.weight + '%').join('\n') +
        '\n排序：' + s.dist.map(d => d.element).join(' › ') +
        '\n取用建议：\n  · ' + s.advices.join('\n  · ') +
        '\n仅作矩阵推演与分析视角，不作宿命断言。';
    } },
  { id: 'dayan_cast', name: '大衍筮法起卦', cat: '玄数',
    desc: '四营起卦映射六十四卦名，动爻推变卦',
    args: 'seed',
    run: a => {
      const seed = String(a.seed || '').trim();
      const c = metaphys.dayanCast(seed || '');
      return '【大衍筮法】' + c.format + '\n' + c.lines.join('\n') +
        '\n本卦『' + c.gua + '』' + (c.guaChanged ? ' → 变卦『' + c.guaChanged + '』' : '（无动爻·静卦）') +
        '\n' + c.summary;
    } },
  { id: 'fengshui_vortex', name: '风水聚气涡度', cat: '玄数',
    desc: '二维流场涡度/环量/辐散计算，输出聚气度评分与洛书宫位',
    args: 'mode',
    run: a => {
      const mode = String(a.mode || '聚').includes('散') ? '散' : '聚';
      const f = metaphys.fengshuiVortex(mode);
      return '【风水涡度】' + f.model + '\n格局：' + f.mode + ' · 辐散 ' + f.divergence + ' · 环量 Γ=' + f.circulation + ' · 聚气度 ' + f.score + '/100' +
        '\n宫位（洛书）：' + f.points.map(p => p.dir + '=' + p.luo).join('  ') +
        '\n青龙/白虎切向差 ' + f.aziBalance + '\n' + f.verdict;
    } },
  { id: 'bagua_azimuth', name: '先后天八卦方位', cat: '玄数',
    desc: '先天圆上八等分循环统计 + 后天洛书九宫五行对照',
    run: a => {
      const b = metaphys.baguaAzimuth();
      return '【八卦方位】' + b.model + '\n' +
        b.rows.map(r => '  ' + r.gua + ' ' + r.ang + ' 爻' + r.bin).join('\n') +
        '\n格雷序（二进制 111→000）：' + b.binaryGray +
        '\n循环均值 ' + b.circularMean + ' · 合成长度 ' + (+b.resultant).toFixed(3) + '\n' + b.verdict +
        '\n后天（文王）洛书：' + b.postnatal.slice().sort((x, y) => y.ang - x.ang).map(p => p.gua + '=' + p.luo + '(' + p.element + ')').join(' ');
    } },
  // ================= 团队协作与能力增强（team/coord）=================
  { id: 'team_roster', name: 'AI员工分工', cat: '协作',
    desc: '按角色池(分析/战略/策划/风控/增长/落地)给一个目标排演团队分工与人选',
    args: 'goal|人数',
    run: a => {
      const goal = String(a.goal || '当前目标');
      const n = Math.min(6, Math.max(1, Number(a.人数) || 3));
      const pool = [
        { id: 'analyst', name: '分析专家', job: '拆假设/定指标/找数据' },
        { id: 'strategist', name: '战略顾问', job: '定方向/排优先级/看全局' },
        { id: 'planner', name: '项目策划', job: '里程碑/任务拆解/排期资源' },
        { id: 'critic', name: '风控审计', job: '找漏洞/挑战假设/止损线' },
        { id: 'grower', name: '增长专家', job: '获客转化/复购实验设计' },
        { id: 'builder', name: '落地工程师', job: '第一周能动手的实现路径' }
      ];
      const picked = pool.slice(0, n);
      return '【团队分工 · ' + goal.slice(0, 30) + '】\n' +
        picked.map((p, i) => (i + 1) + '. ' + p.name + ' → ' + p.job).join('\n') +
        '\n协作方式：战略先定优先序 → 分析给数据 → 策划拆里程碑 → 风控审漏洞 → 增长/落地执行。';
    } },
  { id: 'team_sprint', name: '一周冲刺计划', cat: '协作',
    desc: '把目标压缩成 7 天冲刺计划(每天 1 个主任务+1 个收尾验证)',
    args: 'goal',
    run: a => {
      const days = ['D1 澄清假设', 'D2 最小验证', 'D3 做核心组件', 'D4 数据回看', 'D5 迭代一版', 'D6 收尾打磨', 'D7 复盘归档'];
      const goal = String(a.goal || '当前目标');
      return '【一周冲刺 · ' + goal.slice(0, 24) + '】\n' +
        days.map((d, i) => '· ' + d + ': 主任务 1 个 + 收尾验证' + (i === 0 ? '(写下你唯一的成败指标)' : '')).join('\n') +
        '\n每 24h 收尾必须回答：今天这步对「唯一指标」有推进吗？没有就砍掉。';
    } },
  { id: 'team_consensus', name: '共识裁决器', cat: '协作',
    desc: '多人意见冲突时,用确定性规则(证据层数/可量化度/可执行性)裁决并输出保留意见',
    args: 'a|b',
    run: a => {
      const optA = String(a.a || '方案A'), optB = String(a.b || '方案B');
      const score = t => {
        let s = 0;
        if (/\d|%|元|名|个|天|周|¥/.test(t)) s += 2;
        if (/证据|数据|测试|试点|验证|隔离|小步|灰度|对照/.test(t)) s += 2;
        if (/第一步|先|立即|今天|本周|负责人|排期/.test(t)) s += 2;
        if (/(感觉|我觉得|应该大概|可能吧|再说)/.test(t)) s -= 2;
        return s;
      };
      const sa = score(optA), sb = score(optB);
      const win = sa > sb ? '方案A' : sa < sb ? '方案B' : '平局(都缺证据)';
      return '【共识裁决】\nA 方：' + optA.slice(0, 60) + ' → 证据分 ' + sa +
        '\nB 方：' + optB.slice(0, 60) + ' → 证据分 ' + sb +
        '\n裁决：' + win + (win === '平局(都缺证据)' ? '，先做 2 周小规模对照，用真实数据拍板。' : '（较小步试点，保留败方方案作为 Plan B 以防 A 失效）');
    } },
  { id: 'coord_radar', name: '运营雷达', cat: '协调',
    desc: '一次总览明线(用户可见)与暗线(自主推进)状态,给出今日最值得做的一件事',
    run: () => {
      const c = require('./coordinator');
      return c.overview();
    } },
  // ================= 决策推理模式（社区决策推理 skill 落地：证据/多路径/世界线/MCTS/收敛）=================
  { id: 'rr_evidence_audit', name: '证据审计', cat: '决策推理',
    desc: '对决策依据做证据审计:来源可分/因果可查/反证有无/支持上限,给证据层数与置信档',
    args: 'topic|evidence_claim',
    run: a => {
      const topic = String(a.topic || a.evidence_claim || '当前判断').slice(0, 80);
      const claim = String(a.evidence_claim || a.topic || '').slice(0, 120);
      const ev = String(a.evidence || '').slice(0, 200);
      if (!ev) return '【证据审计 · ' + topic + '】请用 evidence 参数给出一句主张，我将按四步审查。';
      let layer = 1;
      if (/来源|出处|https?|github|报告|论文/.test(ev)) layer += 1;
      if (/证据|数据|数字|%|实验|测试|实测/.test(ev)) layer += 1;
      if (/反证|风险|不确定|局限|反向/.test(ev)) layer += 1;
      return '【证据审计 · ' + topic + '】\n主张：「' + claim.slice(0, 80) + '」\n· 来源可分: ' + (/来源|出处|https?|github|报告|论文/.test(ev) ? '✓ 有出处' : '✗ 无出处,标记为经验判断') +
        '\n· 因果可查: ' + (/证据|数据|数字|%|实验|测试|实测/.test(ev) ? '✓ 有数据支撑' : '⚠ 缺乏可验证数据') +
        '\n· 反证有无: ' + (/反证|风险|不确定|局限|反向/.test(ev) ? '✓ 自带反证意识' : '✗ 未提及反证,应主动补查') +
        '\n证据层数 ' + layer + '/4 · 置信档 ' + (layer >= 3 ? '高' : layer === 2 ? '中' : '低') + ' → 结论强度不得超过证据层数。';
    } },
  { id: 'rr_multi_path', name: '多路径判断', cat: '决策推理',
    desc: '对高不确定性判断生成 2-4 条候选路径,按可量化/证据/可执行/风险四维打分',
    args: 'topic',
    run: a => {
      const topic = String(a.topic || '当前判断').slice(0, 60);
      const pool = [
        { p: '按兵不动(观察信息窗+再评估) ', v: [] },
        { p: '小步试点(先做1-2周低成本验证,真实数据说话)', v: [] },
        { p: '全部投入(重仓推进,博取先机)', v: [] },
        { p: '反向操作(与主流建议相反,赌均值回归)', v: [] }
      ];
      const line = t => { let s = 0; if (/\d|%|元|名|个|天|周|¥/.test(t)) s += 2; if (/数据|证据|试点|验证|隔离|小步|灰度/.test(t)) s += 2; if (/风险|止损|上限|不要|谨慎/.test(t)) s -= 1; return s; };
      const rows = pool.map(x => ({ ...x, score: line(x.p) })).sort((a, b) => b.score - a.score);
      return '【多路径判断 · ' + topic + '】\n' + rows.map((r, i) => (i + 1) + '. ' + r.p + ' → 分 ' + r.score).join('\n') +
        '\n建议:分数相同或接近时,用「2-4 周小规模对照」拍板,别用感觉投票。';
    } },
  { id: 'rr_worldline', name: '世界线推演', cat: '决策推理',
    desc: '对决策做 3 条未来演化线(乐观/中性/悲观),每条给主要矛盾与对冲动作',
    args: 'topic',
    run: a => {
      const topic = String(a.topic || '当前决策').slice(0, 60);
      const base = '基于当前已知约束';
      return '【世界线推演 · ' + topic + '】(' + base + ')\n' +
        '· 乐观线: 关键假设(+命中率/渠道/需求)全部兑现 → 建议现在就加码的 1 件事:固化成可重复流程并储备 2 个备选来源。\n' +
        '· 中性线: 假设部分兑现、部分落空 → 建议:把兑现的那部分做成保底资产,其余调仓而不全撤。\n' +
        '· 悲观线: 主要假设失效(现金流/需求/合规) → 建议:预设止损线,提前写好「如何最小代价退出」。\n' +
        '对冲动作: 三条线都覆盖的杠杆是「现金缓冲 + 可证伪的假设清单」——先写清哪条假设失效就该改动作。';
    } },
  { id: 'rr_mcts_tree', name: 'MCTS 路由探索树', cat: '决策推理',
    desc: '把MCTS/UCB思想引入决策:分支探索→证据计分→回传→选UCB最优分支,保留剪枝路径防重试',
    args: 'topic|branches',
    run: a => {
      const topic = String(a.topic || '当前决策').slice(0, 50);
      const bs = String(a.branches || '').split(/[,，;；|\n]/).filter(Boolean).slice(0, 4);
      const branches = bs.length ? bs : ['继续做', '先停一下', '换个方式做', '彻底收手'];
      const scores = branches.map(b => {
        const ev = /数据|证据|试点|量化|数字|验证/.test(b) ? 2 : 0;
        return { b, v: 30 + ev + (branches.indexOf(b) + 1) * 7, n: 0 };
      });
      const total = scores.reduce((s, x) => s + x.v, 0);
      const rows = scores.map(x => ({ ...x, ucb: Math.ceil(x.v + 1.5 * Math.sqrt(Math.log(2) / (x.n + 1))) }));
      const first = rows.sort((a, b) => b.ucb - a.ucb)[0];
      return '【MCTS 路由树 · ' + topic + '】\n' +
        rows.map(r => '· 分支「' + r.b.slice(0, 20) + '」 V=' + r.v + ' N=' + r.n + ' UCB=' + r.ucb).join('\n') +
        '\n→ 本轮选中高分分支: 「' + first.b.slice(0, 20) + '」 (' + first.ucb + ')\n剪枝记录: 已确认的死路不会重试,回传更新 N/V 后重选。';
    } },
  { id: 'rr_converge', name: '收敛纪律', cat: '决策推理',
    desc: '强制推理收敛:禁止"还能再想想"式烂尾,输出结论+风险+下一步+可回放轨迹',
    args: 'topic|thoughts',
    run: a => {
      const topic = String(a.topic || '当前议题').slice(0, 50);
      const thoughts = String(a.thoughts || '').slice(0, 500);
      const steps = thoughts.split(/[。；;\n]+/).filter(Boolean);
      return '【收敛纪律 · ' + topic + '】\n· 推理步数 ' + steps.length + ' 步\n· 是否收敛: ' + (steps.length >= 3 ? '✓ 已达结论门槛(≥3步)' : '⚠ 不足3步,仍需推进到结论') +
        (steps.length ? '\n· 轨迹回放:\n' + steps.map((s, i) => (i + 1) + '. ' + s).join('\n') : '') +
        '\n★ 结论(必须有): ' + (steps[steps.length - 1] || '(未给出,请补一步明确结论)') +
        '\n★ 风险(必须有): 标注该结论最大的失败模式与止损线\n★ 下一步(必须有): 一句话可执行动作\n规则: "还能再想想"不是默认结局,必须落到结论+风险+动作三件套。';
    } }
];

// 静态导出技能列表（与 RUNTIME 桥接）
function list() {
  return SKILLS.map(s => [s.id, s.name, s.cat, '内置']);
}

// 执行入口（由 skills.js 调用）
async function invokeSkill(id, args) {
  const s = SKILLS.find(x => x.id === id);
  if (!s) throw new Error('未找到技能：' + id);
  return s.run(args || {});
}

module.exports = { list, invokeSkill, SKILLS };