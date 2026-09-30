import type { ContextBudgetSnapshot } from '../../server/protocol.js'
import type { RuntimeAdviceFacts } from '../runtime-advice-facts.js'
export function budget(overrides: Partial<ContextBudgetSnapshot> = {}): ContextBudgetSnapshot {
  return { requestId: 'request', revision: 1, sampledAt: Date.now(), model: 'test-model', windowTokens: 1_000_000,
    inputBudget: 900_000, inputTokens: 90_000, outputReserve: 90_000, safetyMargin: 10_000,
    imageTokens: 0, reasoningTokens: 0, toolTokens: 0, source: 'measured', state: 'ready', ...overrides }
}
export function facts(read: () => ContextBudgetSnapshot | undefined = () => budget(), tools: string[] = ['session_vitals']): RuntimeAdviceFacts {
  return { getContextBudget: read, getActiveToolNames: () => tools, getModel: () => 'test-model' }
}
