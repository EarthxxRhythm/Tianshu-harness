import type { ContextBudgetSnapshot } from '../server/protocol.js'

export interface RuntimeAdviceFacts {
  getActiveToolNames: () => string[]
  getContextBudget: () => ContextBudgetSnapshot | undefined
  getModel: () => string
  now?: () => number
}

/** Tool references made by runtime advice, distinct from the tool registry. */
export const ADVICE_TOOL_REFERENCES = { sessionState: ['session_vitals'], todo: ['todo'] } as const
export const ADVICE_SNAPSHOT_MAX_AGE_MS = 30_000
export function currentAdviceBudget(facts?: RuntimeAdviceFacts): ContextBudgetSnapshot | undefined {
  const b = facts?.getContextBudget()
  if (!b || b.model !== facts!.getModel() || !Number.isFinite(b.inputTokens) || b.inputTokens < 0
    || !Number.isFinite(b.inputBudget) || b.inputBudget <= 0 || !Number.isFinite(b.sampledAt)) return undefined
  const age = (facts!.now?.() ?? Date.now()) - b.sampledAt
  return age >= 0 && age <= ADVICE_SNAPSHOT_MAX_AGE_MS ? b : undefined
}
export function sessionStateAdvice(facts?: RuntimeAdviceFacts): string {
  if (facts?.getActiveToolNames().includes('session_vitals')) return '会话自身状态可用 session_vitals 取证。'
  const b = currentAdviceBudget(facts)
  return b ? `运行时${b.source === 'measured' ? '最近请求测量' : '本地估算'}：输入预算占用 ${Math.round(b.inputTokens / b.inputBudget * 100)}%，状态 ${b.state}；其他未提供的会话状态暂无法确认。`
    : '运行时暂无当前有效的会话状态观测，暂无法确认；不要凭感觉推断。'
}
