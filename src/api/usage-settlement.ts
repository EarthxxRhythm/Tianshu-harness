import type { Usage } from './types.js'

export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Usage frames are cumulative observations of ONE attempt, never increments. */
export class UsageSettlement {
  private values: Partial<Usage> = {}
  private source: Record<string, string> = {}
  reason?: string
  private settled = false

  observe(usage?: WireUsage, reason?: string | null): void {
    if (this.settled) return
    if (reason) this.reason = reason
    if (!usage) return
    const fields = [
      ['input_tokens', usage.prompt_tokens, 'prompt_tokens'],
      ['output_tokens', usage.completion_tokens, 'completion_tokens'],
      ['cache_read_input_tokens', usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens,
        usage.prompt_cache_hit_tokens !== undefined ? 'prompt_cache_hit_tokens' : 'prompt_tokens_details.cached_tokens'],
      ['cache_creation_input_tokens', usage.prompt_cache_miss_tokens, 'prompt_cache_miss_tokens'],
      ['reasoning_tokens', usage.completion_tokens_details?.reasoning_tokens, 'completion_tokens_details.reasoning_tokens'],
    ] as const
    for (const [field, value, source] of fields) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
      this.values[field] = value
      this.source[field] = source
    }
  }

  finish(identity: Omit<NonNullable<Usage['observation']>, 'status' | 'fields'>, status: 'complete' | 'aborted'): Partial<Usage> | undefined {
    if (this.settled) return undefined
    this.settled = true
    return { ...this.values, observation: { ...identity, status, fields: { ...this.source } } }
  }
}
