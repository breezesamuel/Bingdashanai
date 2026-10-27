// core/market-evidence.js — 商业化证据状态（给决策 / 面板 / 门禁读的诚实数据源）
//
// 不生成证据，只如实聚合 evidence-pipeline 的数据。
// 没有就是 0，绝不用模板填充。

const pipe = require('./evidence-pipeline');

function currentStatus() { return pipe.status(); }

// 门禁用：返回每个维度是否 >=1 条已确认证据
function gateCheck() {
  const s = pipe.status();
  const missing = s.dims.filter(d => d.confirmed < 1).map(d => d.dim);
  return {
    pass: missing.length === 0,
    missing,
    summary: { total: s.total, confirmed: s.confirmed, dims: s.dims }
  };
}

module.exports = { currentStatus, gateCheck };
