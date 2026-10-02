import { currentAdviceBudget, sessionStateAdvice, type RuntimeAdviceFacts } from '../runtime-advice-facts.js'
import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { SrClass } from '../context.js'

/**
 * Correct context-based wrap-up claims using a fresh, model-matching input budget.
 * Only ready budgets below 50% qualify. Provider measurements support a factual
 * correction; local estimates only support a neutral notice, never a guarantee.
 * Existing phrase detection, five-turn cooldown and functional delivery remain.
 */

export interface WrapupAnxietyGuardHookDeps {
  adviceFacts?: RuntimeAdviceFacts
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 本 turn 的流式 assistant 文本（与 dedup-guard 同款 getter）。 */
  getStreamedText: () => string
  getEstimatedTokens: () => number
  getContextWindow: () => number
  /** 必达纠偏通道（functional 不限流）。缺席时退化为仅 advisory。 */
  addSystemReminder?: (content: string, cls?: SrClass) => void
  /** 反驳阈值：ratio 低于此值时话术视为不基于事实。默认 0.5。 */
  refuteBelowRatio?: number
  /** 触发冷却（轮），默认 5。 */
  cooldownTurns?: number
}

/** 收尾/新会话话术——直接措辞（中文）。 */
const DIRECT_PATTERNS: RegExp[] = [
  /上下文(紧张|快满|压力|不足|有限|吃紧|不多|快用完|即将用尽)/,
  /建议(开|开启|新建)?新会话/,
  /先交付这部分/,
  /受限于篇幅/,
]

/** 直接措辞（英文，2026-08-29 用户实锤后补——此前英文零覆盖，守卫不触发）。 */
const DIRECT_EN_PATTERNS: RegExp[] = [
  /context (window )?(is )?(running )?(low|limited|almost full|nearly full|running out|nearly exhausted)/i,
  /start(ing)? a (fresh|new) (session|chat|conversation)/i,
  /continue (this )?in a new (session|chat|conversation)/i,
  /due to (the )?context (limit|length|window|constraints?)/i,
  /(move|moving|hand|handing) (the )?(rest|remaining|this|it) (over )?to a new (session|chat|conversation)/i,
]

/** 间接措辞（天权补充，来自实际 session 证据"剩余 T3-T6 交给新会话"）。
 *  [^。]* 限制在单句内匹配，防跨句误配。 */
const INDIRECT_PATTERNS: RegExp[] = [
  /(剩余|余下|剩下)[^。\n]*新会话/,
  /新会话[^。\n]*(继续|实施|接手|完成)/,
  /交给新会话/,
  /留给新会话/,
  /(新开|另起|另开|重开)(一?个)?(新)?(会话|对话)/,
  /(对话|会话)(历史)?(太|过|比较)长(了)?/,
  /tokens?\s*(快)?(要)?(用完|耗尽|不够|不足)/i,
]

/** 检测收尾话术。返回命中的第一个片段（用于 advisory 引用），未命中返回 null。 */
export function detectWrapupPhrase(text: string): string | null {
  for (const re of [...DIRECT_PATTERNS, ...DIRECT_EN_PATTERNS, ...INDIRECT_PATTERNS]) {
    const m = re.exec(text)
    if (m) return m[0]
  }
  return null
}

export function createWrapupAnxietyGuardHook(deps: WrapupAnxietyGuardHookDeps): PostTurnRuntimeHook {
  const refuteBelow = deps.refuteBelowRatio ?? 0.5
  const cooldown = deps.cooldownTurns ?? 5
  let lastFiredTurn = -Infinity

  return {
    phase: 'postTurn',
    name: 'wrapup-anxiety-guard',
    run(ctx: RuntimeHookContext): void {
      const text = deps.getStreamedText()
      if (!text || text.length < 20) return

      const phrase = detectWrapupPhrase(text)
      if (!phrase) return

      const budget = currentAdviceBudget(deps.adviceFacts)
      if (!budget || budget.state !== 'ready') return
      const ratio = budget.inputTokens / budget.inputBudget
      if (ratio >= refuteBelow) return

      const turn = ctx.snapshot.turn
      if (turn - lastFiredTurn < cooldown) return
      lastFiredTurn = turn

      const pct = Math.round(ratio * 100)
      const refutation = budget.source === 'measured'
        ? `最近请求测量的输入预算占用为 ${pct}%；这不支持仅凭上下文不足而提前收尾。请按用户要求与任务证据决定下一步。${sessionStateAdvice(deps.adviceFacts)}`
        : `本地估算的输入预算占用为 ${pct}%，并非提供商实测；不能据此保证余量充足。请按当前任务边界处理，缺少依据的判断标注未核实。`
      deps.advisoryBus.submit({
        key: 'wrapup-anxiety-guard',
        priority: 0.65,
        tier: 'operational',
        category: 'discipline',
        content: refutation,
        ttl: 1,
      })
      // 必达通道（functional 不限流）：discipline 每轮限 1 条，反驳可能被同轮
      // 更高优先级条目挤掉而永不落地；cooldown 闩锁保证此路自身不刷屏。
      deps.addSystemReminder?.(`<system-reminder>${refutation}</system-reminder>`, 'functional')
    },
  }
}
