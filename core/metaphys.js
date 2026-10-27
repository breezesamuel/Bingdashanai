// core/metaphys.js — 玄学概念的数学形式化建模（形式化视角，不宣称科学有效性）
// 设计：把风水/八字/奇门/八卦等概念用矩阵、概率、微分方程、几何做量化分析——
// 仅供探索内部逻辑与决策启发，结论不等于实证规律。全部纯计算，零 LLM。
//
// 模块：
//   五行生克 → 生克关系矩阵 × 幂迭代求稳态分布（矩阵乘法模拟气运流转）
//   大衍筮法 → 四象概率分布（古典蓍草占的策数模型）+ 随机起卦模拟
//   风水涡度 → 气场的二维涡度方程离散解（速度场的环量/聚散指标）
//   八卦方位 → 先天八卦方位角的循环统计（正圆八等分 + 二进制编码/圆均值）

const R = x => Math.round(x * 100) / 100;

// ============ 1. 五行生克关系矩阵 ============
// 五行序：木 火 土 金 水（相生链 木→火→土→金→水→木，相克链 木→土→水→火→金→木）
const WUXING = ['木', '火', '土', '金', '水'];
const SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' }; // 我生
const KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };    // 我克

// 生克关系矩阵：5×5，A[i][j] = +1 生、-1 克、0 无关
function shengKeMatrix() {
  const n = WUXING.length;
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    const me = WUXING[i];
    M[i][WUXING.indexOf(SHENG[me])] = 1;   // 我生
    M[i][WUXING.indexOf(KE[me])] = -1;     // 我克
  }
  return M;
}

// 稳态气运：把生(+1)视为增益流入、克(-1)视为损耗流出，做固定步数的流动迭代。
// 初态(月令/用神)注入后，每步沿“生我者旺我、我克者损”规则流转 K 步，
// 得到非均匀的旺衰分布——这正是五行“流转而不均衡”的矩阵化表达。
function wuxingStationary(seed, steps) {
  const M = shengKeMatrix();
  const n = WUXING.length;
  const K = steps || 6;
  // 流动矩阵 F[i][j]：i 得 j 的影响（+1 生我，-1 克我，0 无关）
  let p = new Array(n).fill(1 / n);
  if (seed && WUXING.includes(seed)) {
    const k = WUXING.indexOf(seed);
    p = p.map((v, i) => (i === k ? v + 0.5 : v));
    const ps = p.reduce((a, b) => a + b, 0);
    p = p.map(v => v / ps);
  }
  for (let it = 0; it < K; it++) {
    const nxt = p.map((v, i) =>
      v + 0.4 * M.reduce((s, row, j) => s + (row[i] === 1 ? p[j] : row[i] === -1 ? -p[j] : 0), 0)
    ).map(v => Math.max(0, v));
    const norm = nxt.reduce((a, b) => a + b, 0) || 1;
    p = nxt.map(v => v / norm);
  }
  const order = WUXING.map((w, i) => ({ el: w, val: p[i] })).sort((a, b) => b.val - a.val);
  // 用神取用：起强（榜首）抑泄、起弱（末位）生扶 —— 源于“旺者宜泄、弱者宜生”的古典用神经。
  const top = order[0], bot = order[order.length - 1];
  const tw = R(top.val * 100), bw = R(bot.val * 100);
  const advices = [
    '『' + top.el + '』当令最旺（' + tw + '%）→ 用神宜『泄』：' + SHENG[top.el] + '（顺势而为，当前重心放在' + SHENG[top.el] + '布局）',
    '『' + bot.el + '』受制最弱（' + bw + '%）→ 用神宜『生扶』：先补' + Object.keys(SHENG).find(k => SHENG[k] === bot.el) + '，忌硬碰' + bot.el + '之克神'
  ];
  return { matrix: shengKeMatrix(), dist: order.map(o => ({ element: o.el, weight: R(o.val * 100) })), steps: K, advices };
}

// 十二地支月令的五行主气（寅卯木/巳午火/申酉金/亥子水/辰戌丑未土）
const MONTH_ELEMENT = {
  1: '寅', 2: '卯', 3: '辰', 4: '巳', 5: '午', 6: '未',
  7: '申', 8: '酉', 9: '戌', 10: '亥', 11: '子', 12: '丑'
};
const BRANCH_ELEMENT = { 寅: '木', 卯: '木', 辰: '土', 巳: '火', 午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水', 子: '水', 丑: '土' };

// 当前月令五行（无参=今天）
function monthElement(month) {
  const m = Number(month) || (new Date().getMonth() + 1);
  const branch = MONTH_ELEMENT[m] || '子';
  return { month: m, branch, element: BRANCH_ELEMENT[branch] };
}

// ============ 2. 大衍筮法四象概率 ============
// “大衍之数五十，其用四十有九”：分二、挂一、揲四、归奇，三变成一爻，十八变成一卦。
// 古典蓍草占的策数模型给出四象概率（组合计数，非臆测）：
//   老阳(9)  = 3/16，少阳(7) = 5/16，少阴(8) = 7/16，老阴(6) = 1/16
// 老阴老阳动（变爻），少阴少阳静。数学期望数与概率全部可检验。
const DAYAN_PROB = {
  laoyang: 3 / 16,   // 9  —— 动爻（阳变阴）
  shaoyang: 5 / 16,  // 7  —— 静阳
  shaoyin: 7 / 16,   // 8  —— 静阴
  laoyin: 1 / 16     // 6  —— 动爻（阴变阳）
};

// 八卦单卦：三爻自下而上（1=阳 0=阴），加上下方位与象
const TRI = {
  '111': { name: '乾', symbol: '☰', trigram: '天', gua: '乾为天' },
  '110': { name: '兑', symbol: '☱', trigram: '泽', gua: '兑为泽' },
  '101': { name: '离', symbol: '☲', trigram: '火', gua: '离为火' },
  '100': { name: '震', symbol: '☳', trigram: '雷', gua: '震为雷' },
  '011': { name: '巽', symbol: '☴', trigram: '风', gua: '巽为风' },
  '010': { name: '坎', symbol: '☵', trigram: '水', gua: '坎为水' },
  '001': { name: '艮', symbol: '☶', trigram: '山', gua: '艮为山' },
  '000': { name: '坤', symbol: '☷', trigram: '地', gua: '坤为地' }
};

// 六十四卦名：key = 上卦名+下卦名（如 '乾乾'='乾为天','坤艮'='山地剥'）
const HEXAGRAM = {
  '乾乾': '乾为天', '乾兑': '天泽履', '乾离': '天火同人', '乾震': '天雷无妄', '乾巽': '天风姤', '乾坎': '天水讼', '乾艮': '天山遁', '乾坤': '天地否',
  '兑乾': '泽天夬', '兑兑': '兑为泽', '兑离': '泽火革', '兑震': '泽雷随', '兑巽': '泽风大过', '兑坎': '泽水困', '兑艮': '泽山咸', '兑坤': '泽地萃',
  '离乾': '火天大有', '离兑': '火泽睽', '离离': '离为火', '离震': '火雷噬嗑', '离巽': '火风鼎', '离坎': '火水未济', '离艮': '火山旅', '离坤': '火地晋',
  '震乾': '雷天大壮', '震兑': '雷泽归妹', '震离': '雷火丰', '震震': '震为雷', '震巽': '雷风恒', '震坎': '雷水解', '震艮': '雷山小过', '震坤': '雷地豫',
  '巽乾': '风天小畜', '巽兑': '风泽中孚', '巽离': '风火家人', '巽震': '风雷益', '巽巽': '巽为风', '巽坎': '风水涣', '巽艮': '风山渐', '巽坤': '风地观',
  '坎乾': '水天需', '坎兑': '水泽节', '坎离': '水火既济', '坎震': '水雷屯', '坎巽': '水风井', '坎坎': '坎为水', '坎艮': '水山蹇', '坎坤': '水地比',
  '艮乾': '山天大畜', '艮兑': '山泽损', '艮离': '山火贲', '艮震': '山雷颐', '艮巽': '山风蛊', '艮坎': '山水蒙', '艮艮': '艮为山', '艮坤': '山地剥',
  '坤乾': '地天泰', '坤兑': '地泽临', '坤离': '地火明夷', '坤震': '地雷复', '坤巽': '地风升', '坤坎': '地水师', '坤艮': '地山谦', '坤坤': '坤为地'
};

// 6 爻(自下而上) → 上下卦名。三爻制数符：下卦 = 1/2/3 爻，上卦 = 4/5/6 爻
function trigramsFromLines(linesSix) {
  const lower = linesSix.slice(0, 3).map(x => Number(x) ? '1' : '0').join('');
  const upper = linesSix.slice(3, 6).map(x => Number(x) ? '1' : '0').join('');
  const L = TRI[lower], U = TRI[upper];
  return {
    lower: L ? L.name : '?' + lower, upper: U ? U.name : '?' + upper,
    lowerTri: L ? L.trigram : '', upperTri: U ? U.trigram : '',
    lowerSym: L ? L.symbol : '', upperSym: U ? U.symbol : ''
  };
}

function hexagramName(lowerN, upperN) {
  return HEXAGRAM[upperN + lowerN] || (upperN + lowerN);
}

function dayanCast(seed) {
  // 用古典概率精确抽样一根爻（每爻独立）：老阴(6)1/16、少阳(7)5/16、少阴(8)7/16、老阳(9)3/16
  let r = Math.random;
  if (seed) {
    let h = 2166136261;
    for (let i = 0; i < String(seed).length; i++) { h ^= String(seed).charCodeAt(i); h = Math.imul(h, 16777619); }
    r = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
  }
  const oneLine = () => {
    const x = r();
    if (x < 1 / 16) return { yao: 6, label: '老阴', move: true };    // 6 动
    if (x < 1 / 16 + 5 / 16) return { yao: 7, label: '少阳', move: false };
    if (x < 1 / 16 + 5 / 16 + 7 / 16) return { yao: 8, label: '少阴', move: false };
    return { yao: 9, label: '老阳', move: true };                    // 9 动
  };
  const lines = [0, 0, 0, 0, 0, 0].map(oneLine); // 自下而上 6 爻
  const hex = lines.map(l => l.yao).join('');
  const moves = lines.filter(l => l.move).length;
  const movesIdx = lines.map((l, i) => (l.move ? i + 1 : 0)).filter(Boolean); // 动爻位置(1-6, 自下)
  // 本卦：上下卦
  const g = trigramsFromLines(lines.map(l => l.yao >= 7 ? 1 : 0));
  const guaName = hexagramName(g.lower, g.upper);
  // 变卦：动爻阴阳反转 → 新卦
  const changed = lines.map(l => (l.move ? (l.yao >= 7 ? 0 : 1) : (l.yao >= 7 ? 1 : 0)));
  const gc = trigramsFromLines(changed);
  const guaChanged = hexagramName(gc.lower, gc.upper);
  const changedIfMoves = movesIdx.length ? (' → 变卦「' + guaChanged + '」（动爻' + movesIdx.join(',') + '爻转）') : ' → 六爻安静，无变卦';
  // 焦氏易林式解读：本卦主象 + 动爻位次
  const posNote = { 1: '初爻动主开端', 2: '二爻动主内部/同志', 3: '三爻动主中坚/转折', 4: '四爻动主近臣/外部助力', 5: '五爻动主中枢决策', 6: '上爻动主收束/外显' };
  const summary = guaName + changedIfMoves + (movesIdx.length
    ? '（' + movesIdx.map(p => '第' + p + '爻' + (posNote[p] || '')).join('、') + '）'
    : '（静卦，六爻皆不动，宜守）');
  return {
    format: '大衍筮法 · 四营成爻 · 十八变成卦',
    lines: lines.map((l, i) => '第' + (6 - i) + '爻 ' + l.label + '(' + l.yao + ')' + (l.move ? ' ·动' : ' ·静')),
    hex, movingCount: moves, movesIdx,
    trigrams: g, changedTrigrams: gc,
    gua: guaName, guaChanged: movesIdx.length ? guaChanged : null,
    summary,
    note: '本卦『' + guaName + '』：上' + g.upperTri + '下' + g.lowerTri + '（☱' + g.upperSym + '/' + g.lowerSym + '）' +
      (movesIdx.length ? '，动爻' + movesIdx.join(',') + '处即为“变之枢机”，先审动爻再看全局。' : '，无动爻宜守其常。') +
      '\n仅作概率与结构推演，非超验预言。'
  };
}

function dayanProbabilities() {
  const p = DAYAN_PROB;
  const sum = R((p.laoyang + p.shaoyin + p.shaoyang + p.laoyin) * 16);
  return {
    laoyang: R(p.laoyang * 100) + '%', shaoyin: R(p.shaoyin * 100) + '%',
    shaoyang: R(p.shaoyang * 100) + '%', laoyin: R(p.laoyin * 100) + '%',
    moveProb: R((p.laoyang + p.laoyin) * 100) + '%',
    invariant: '四象归一 ' + sum + '/16（概率完全性检验）'
  };
}

// ============ 3. 风水聚气涡度方程 ============
// 把“气”视作二维不可压流场,用流体力学涡度 ω = ∂v_y/∂x − ∂v_x/∂y 描述“聚气/散气”。
// 八卦八个方位布置速度场采样点（罗盘二十四山粗化为八宫），计算：
//   环量 Γ = ∮ v·dl（Stokes 定理：Γ = ∬ω dA）——环量正 = 气场回旋聚拢，负 = 外散。
//   青龙(东/震)白虎(西/兑)对衡：左旋右旋平衡指数。
// 注：传统二十四山由"十二地支+八天干+四维"构成，每宫 15°；这里粗化为八宫做数值采样。
const LUO_STAR = { '震': 3, '巽': 4, '离': 9, '坤': 2, '兑': 7, '乾': 6, '坎': 1, '艮': 8 }; // 洛书九宫数
const STAR_ELEMENT = { 1: '水', 2: '坤土', 3: '震木', 4: '巽木', 5: '中土', 6: '乾金', 7: '兑金', 8: '艮土', 9: '离火' };

function fengshuiVortex(mode) {
  // 八宫方位角（顺时针，0°=正东）：震90 兑270 坎180 离0/360 艮东北45 巽东南135 乾西北315 坤西南225
  const dirs = [
    { name: '震·青龙(东)', ang: 90 }, { name: '巽(东南)', ang: 135 }, { name: '离·朱雀(南)', ang: 180 },
    { name: '坤(西南)', ang: 225 }, { name: '兑·白虎(西)', ang: 270 }, { name: '乾(西北)', ang: 315 },
    { name: '坎·玄武(北)', ang: 0 / 360 }, { name: '艮(东北)', ang: 45 }
  ];
  const conv = mode === '散' ? -1 : 1; // 辐合为正
  // 每宫独立切向（青龙聚、白虎耗：模拟"山水交会"的左右不对称实际气场）
  const vtOf = {
    '震·青龙(东)': conv, '巽(东南)': conv, '离·朱雀(南)': conv,
    '坤(西南)': 0.5 * conv, '兑·白虎(西)': -0.5 * conv, '乾(西北)': 0.5 * conv,
    '坎·玄武(北)': conv, '艮(东北)': conv
  };
  const pts = dirs.map(d => {
    const th = (d.ang * Math.PI) / 180;
    const vr = -conv;                 // 径向速度（负=向内聚，正=向外散）
    const vt = vtOf[d.name];           // 切向（非对称：左护右泄更贴合堪舆"龙虎"位）
    return {
      name: d.name, ang: d.ang, vt, luo: LUO_STAR[d.name[0]],
      vx: vr * Math.cos(th) + vt * (-Math.sin(th)),
      vy: vr * Math.sin(th) + vt * Math.cos(th)
    };
  });
  // 数值环量：Σ v_t · Δs（八角形闭合路径，Δs=边长），单位长度下 |Γ|=8 表示八宫满环流
  const ds = 1;
  const gamma = pts.reduce((s, p) => s + p.vt * ds, 0);
  // 青龙(东) vs 白虎(西) 切向对比（左青龙右白虎的“护砂平衡”）
  const ql = pts.find(p => p.name.includes('青龙'));
  const bh = pts.find(p => p.name.includes('白虎'));
  const balance = R(Math.abs(ql.vt - bh.vt));
  const full = Math.abs(gamma) > 6;
  // 聚气评分（0-100）：辐合 + 环量 + 龙虎均衡 三方加权
  const score = Math.max(0, Math.min(100, Math.round(
    (conv > 0 ? 45 : 15) + (full ? 30 : 10) + balance * 20 + (conv < 0 ? 0 : 5)
  )));
  const verdict = conv > 0
    ? (full ? '气场向心辐合且全域环流：聚气格局（负辐散，气聚中宫），聚气度 ' + score + '/100' : '辐合弱，聚势偏薄，宜增回旋，聚气度 ' + score + '/100')
    : (full ? '气场离心辐散且带环流：散气格局（正辐散，气向外泄），聚气度 ' + score + '/100' : '辐散弱，接近平局，聚气度 ' + score + '/100');
  return {
    model: '二维不可压流 · 涡度 ω = ∂v_y/∂x − ∂v_x/∂y · Stokes: Γ = ∬ω dA',
    mode: conv > 0 ? '聚气' : '散气',
    divergence: R(-conv), circulation: R(gamma), fullCirculation: full, aziBalance: balance,
    score,
    points: pts.map(p => ({ dir: p.name, luo: p.luo, ang: R(p.ang), speed: R(Math.hypot(p.vx, p.vy)) })),
    verdict
  };
}

// ============ 4. 先天八卦方位角分布 ============
// 先天八卦（伏羲八卦）：乾南 兑东南 离东 震东北 巽西南 坎西 艮西北 坤北，正圆八等分。
// 数学刻画：①方位角为 45°×k（k=0..7）；②阴阳爻二进制编码（1=阳 0=阴）
//  乾111 兑110 离101 震100 巽011 坎010 艮001 坤000 → 0..7 Gray 序；
// ③循环统计：圆均值与合成长度 R，检验“八卦在圆上是否均匀八分”。
const BAGUA = {
  '乾': { ang: 180, bin: '111' }, '兑': { ang: 135, bin: '110' }, '离': { ang: 90, bin: '101' }, '震': { ang: 45, bin: '100' },
  '巽': { ang: 225, bin: '011' }, '坎': { ang: 270, bin: '010' }, '艮': { ang: 315, bin: '001' }, '坤': { ang: 0, bin: '000' }
};

function baguaAzimuth() {
  const keys = Object.keys(BAGUA);
  // 循环统计（每卦 1/8 质量）：圆均值方向
  const th = keys.map(k => (BAGUA[k].ang * Math.PI) / 180);
  let C = 0, S = 0;
  th.forEach(a => { C += Math.cos(a); S += Math.sin(a); });
  const n = th.length;
  const meanRaw = Math.atan2(S / n, C / n) * 180 / Math.PI;
  const Rlen = Math.hypot(C / n, S / n);          // 合成长度 ∈ [0,1]，1=完美聚集，0=均匀摊开
  const meanAng = R((meanRaw + 360) % 360);
  const rows = keys.map(k => ({ gua: k, ang: BAGUA[k].ang + '°', bin: BAGUA[k].bin }));
  const gray = keys.map(k => parseInt(BAGUA[k].bin, 2)).join(' · ');
  // 后天八卦（文王）+洛书九宫数
  const POST = {
    '坎': { ang: 0, luo: 1, el: '水' }, '坤': { ang: 45, luo: 2, el: '土' }, '震': { ang: 90, luo: 3, el: '木' }, '巽': { ang: 135, luo: 4, el: '木' },
    '乾': { ang: 315, luo: 6, el: '金' }, '兑': { ang: 270, luo: 7, el: '金' }, '艮': { ang: 315 + 45, luo: 8, el: '土' }, '离': { ang: 180, luo: 9, el: '火' }
  };
  const postnatal = keys.map(k => {
    const p = POST[k];
    return p ? { gua: k, ang: p.ang + '°', luo: p.luo, element: p.el } : { gua: k, luo: 5, element: '中' };
  });
  return {
    model: '先天八卦 · 正圆八等分 · 循环统计（圆均值 + 合成长度）',
    rows,
    binaryGray: gray,
    postnatal,     // 后天八卦（文王）方位 + 洛书九宫数 + 五行
    circularMean: meanAng + '°', resultant: Rlen,
    verdict: Rlen < 0.05 ? '合成长度≈0：八卦方位在圆上均匀八分，对称性完好（拓扑结论）' : '分布有偏向（合成长度 ' + Rlen.toFixed(3) + '），方位不成正圆'
  };
}

module.exports = {
  WUXING, SHENG, KE, shengKeMatrix, wuxingStationary,
  monthElement, MONTH_ELEMENT, BRANCH_ELEMENT,
  dayanProbabilities, dayanCast, HEXAGRAM, TRI, trigramsFromLines, hexagramName,
  fengshuiVortex, LUO_STAR, STAR_ELEMENT,
  baguaAzimuth, BAGUA
};