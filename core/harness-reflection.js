const H = require('./harness');
const store = require('./store');
const lessons = require('./lessons');
const providers = require('./providers');
const brain = require('./brain');

// 供 autopilot 调用：在 H.runOnce() 后生成自然语言反思摘要并写入 lessons
async function generateReflectionAndPersist(result) {
  // 只有非 skipped 且有实质结果时才生成反思
  if (!result || !result.ok || !result.result || result.result === 'skipped') {
    return null;
  }

  const reflection = generateReflection(result);
  if (!reflection) return null;

  // 【可选 LLM 润色】若模型通道可用，用 LLM 将规则生成的反思润色为更自然的语言
  let enhanced = reflection;
  try {
    const providerId = brain.recommendedProvider(providers.list());
    if (providerId) {
      enhanced = await enhanceWithLLM(providerId, reflection, result);
    }
  } catch (e) {
    console.warn('[harness-reflection] LLM 润色失败，回退到规则版本:', e.message);
  }

  try {
    lessons.add({
      kind: result.result === 'adopted' ? 'win' : 'loss',
      topic: 'Harness 自我优化',
      context: `轮次 ${result.round} · 样本 ${result.evalSet} 对 · 基线 ${result.baseScore} → 候选 ${result.candScore}`,
      action: enhanced.action,
      why: enhanced.why,
      src: 'harness-reflection',
      ref: 'harness:' + result.at,
      confidence: result.result === 'adopted' ? 'high' : 'medium',
      evidence: ['trajectory:' + result.at]
    });
    console.log('[harness-reflection] 已入库:', enhanced.action.slice(0, 80));
  } catch (e) {
    console.warn('[harness-reflection] 入库失败:', e.message);
  }
  return enhanced;
}

async function enhanceWithLLM(providerId, reflection, result) {
  const prompt = `你是一个 AI 系统的自我进化记录员。请将以下结构化的技术反思润色为一段通顺、专业的自然语言摘要，保留所有关键技术细节（版本号、分数、引擎、diff 等），但用更流畅的中文表达。

【原始反思】
动作：${reflection.action}
原因：${reflection.why}

【上下文】
- 结果：${result.result}
- 基线分：${result.baseScore}
- 候选分：${result.candScore}
- 样本数：${result.evalSet}
- 引擎：${result.engine || 'rule-based'}
- 降级来源：${result.engineFallback || '无'}
- critic 审查：${result.critic?.pass ? '通过' : '未通过'} (leafChanged=${result.critic?.leafChanged}/${result.critic?.budget})
- 采纳判定：${result.selection?.adopt ? '采纳' : '拒绝'} (Δscore=${result.selection?.dS}, 成本增=${result.selection?.dC})

请输出 JSON：{"action": "润色后的动作描述", "why": "润色后的原因分析"}。只输出 JSON，不要额外文字。`;

  try {
    const out = await providers.chat({
      provider: providerId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    });
    const m = String(out.content || '').match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.action && parsed.why) {
        return { action: parsed.action, why: parsed.why };
      }
    }
  } catch (e) {
    // LLM 调用失败时静默回退
  }
  return reflection; // 回退到规则版本
}

function generateReflection(r) {
  if (r.result === 'adopted') {
    return {
      action: `采纳配置优化 v${r.adoptedVersion}：${summarizeDiff(r.diff)}。提升 Δscore=${r.selection?.dS?.toFixed?.(4) || r.selection?.dS}，通过成本闸与噪声地板。`,
      why: `基于 ${r.evalSet} 条真实对话评测，critic 审查通过（leafChanged=${r.critic?.leafChanged}/${r.critic?.budget}），引擎=${r.engine}${r.engineFallback ? '（降级自 ' + r.engineFallback + '）' : ''}。`
    };
  }
  if (r.result === 'not-adopted') {
    return {
      action: `拒绝采纳候选：${r.reason || r.selection?.reason}。保持现有配置 v${H.current().version}。`,
      why: `候选评分 ${r.candScore} 未超越基线 ${r.baseScore} 的噪声地板（Δ=${r.selection?.dS?.toFixed?.(4) || r.selection?.dS}）。critic 审查 ${r.critic?.pass ? '通过' : '未通过'}。`
    };
  }
  if (r.result === 'rejected-by-critic') {
    return {
      action: `critic 驳回提案：${r.reason}。变更键数 ${r.critic?.leafChanged}/${r.critic?.budget}。`,
      why: '提案存在过拟合/泄漏/超预算风险，critic 拦截。需改进提案器或放宽预算。'
    };
  }
  if (r.result === 'propose-failed') {
    return {
      action: `提案生成失败：${r.reason}。${r.engineFallback ? '已尝试规则降级但仍无可改。' : '未尝试降级。'}`,
      why: r.ruleReasons ? '规则提案器判定：' + r.ruleReasons.join('；') : 'LLM 不可用且规则降级亦无依据可改。'
    };
  }
  return null;
}

function summarizeDiff(diff) {
  if (!diff || !Object.keys(diff).length) return '无实质变更';
  return Object.entries(diff).map(([k, v]) => {
    if (typeof v.after === 'object') {
      return `${k}: ${Object.keys(v.after).join(', ')}`;
    }
    return `${k}: ${JSON.stringify(v.before)} → ${JSON.stringify(v.after)}`;
  }).join('; ');
}

module.exports = { generateReflectionAndPersist, generateReflection, summarizeDiff };
console.log('[harness-reflection] helper loaded');