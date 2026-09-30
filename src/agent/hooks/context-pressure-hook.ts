import { currentAdviceBudget, type RuntimeAdviceFacts } from '../runtime-advice-facts.js'
import type { AfterPerceptionRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/** Runtime input-budget notice, emitted only at threshold crossings.
 * Compaction remains the budget coordinator's decision. */

export interface ContextPressureHookDeps {
  adviceFacts?: RuntimeAdviceFacts
  getEstimatedTokens: () => number
  getContextWindow: () => number
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** A4（信号互扰治理 H2）：活跃 goal continuation / 未核销 high 义务在场。
   *  true 时收束文案合并为"先核销再收束"——不再与续轮机制的"目标尚未达成，
   *  继续执行"同轮对打。缺省视为无活跃续轮（保持原文案）。 */
  hasActiveContinuation?: () => boolean
}

/** Ratio above which the advisory fires. Below 86% split but high enough
 *  to give the agent time to wrap up. */
const PRESSURE_WARN_RATIO = 0.7
/** Second notice threshold; not a promise of automatic session splitting. */
const PRESSURE_SPLIT_RATIO = 0.86
/** Hysteresis: a threshold re-arms only after the ratio drops this far below it. */
const REARM_HYSTERESIS = 0.05

export function createContextPressureHook(deps: ContextPressureHookDeps): AfterPerceptionRuntimeHook {
  // W2-B3 阈值跨越语义：fill% 每轮 appendix 被明确否决——同一阈值只在
  // 「首次跨越」时产生一条提醒，数字只出现在跨越那一轮；持续高于阈值不重复
  //（旧行为每轮带变化百分比重发，等价于每轮翻转 advisory appendix 字节）。
  // 比率回落到阈值-滞回以下后重新武装，再次跨越可再报。
  const firedThresholds = new Set<number>()

  return {
    phase: 'afterPerception',
    name: 'context-pressure',
    run(ctx: RuntimeHookContext): void {
      void ctx
      const budget = currentAdviceBudget(deps.adviceFacts)
      if (!budget) return
      const estimated = budget.inputTokens, window = budget.inputBudget
      const ratio = estimated / window

      // Re-arm thresholds the ratio has dropped safely below (compact/split).
      for (const t of firedThresholds) {
        if (ratio < t - REARM_HYSTERESIS) firedThresholds.delete(t)
      }

      // Highest newly-crossed threshold wins this turn.
      const crossed = [PRESSURE_SPLIT_RATIO, PRESSURE_WARN_RATIO]
        .find(t => ratio >= t && !firedThresholds.has(t))
      if (crossed === undefined) return

      firedThresholds.add(crossed)
      // Crossing 86% implies 70% is also spent — don't fire a stale lower tier later.
      if (crossed === PRESSURE_SPLIT_RATIO) firedThresholds.add(PRESSURE_WARN_RATIO)

      const continuationActive = deps.hasActiveContinuation?.() ?? false
      const escalation = `运行时预算状态为 ${budget.state}；由预算协调器决定是否压缩，不能据此断言必然分拆会话。`
        + (continuationActive ? '先核对当前目标和未完成义务，避免开启无关支线。' : '核对剩余工作，必要时保留交接记录。')
      deps.advisoryBus.submit({
        key: 'context-pressure',
        priority: crossed === PRESSURE_SPLIT_RATIO ? 0.6 : 0.5,
        category: 'cerebellar',
        // W3-C2 分类审计：状态解释类信号（“窗口快满了”），采纳无唯一可观察
        // 动作（收束子任务不是工具签名）→ informational tier、无 expect。
        // 硬填“任意工具出现”会制造伪采纳率，禁止。
        tier: 'informational',
        content: `${budget.source === 'measured' ? '最近请求测量' : '本地估算'}的输入预算占用已跨越 ${Math.round(crossed * 100)}% 阈值（当前 ${Math.round(ratio * 100)}%，${estimated}/${window} tokens）。${escalation}`,
        ttl: 1,
      })
    },
  }
}
