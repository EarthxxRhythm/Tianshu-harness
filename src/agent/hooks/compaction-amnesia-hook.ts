import { createHash } from 'node:crypto'
import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import { isLossyObservation } from '../lossy-markers.js'

/**
 * W3-C1: compaction amnesia SHADOW ledger.
 *
 * After a history rewrite, the model may "forget" content it had already
 * observed and burn turns re-reading it. This hook detects the strongest
 * signal — a full re-read of a file whose content hash is UNCHANGED since it
 * was read before the compact — and records it as a shadow row.
 *
 * Shadow-only discipline: this hook NEVER injects anything into the prompt
 * and NEVER changes behavior. Rows feed offline analysis first; any future
 * gate/advisory must be justified by sampled precision (see plan Wave 3).
 *
 * Exclusions built into the signal:
 *   - content hash changed since the pre-compact read → legitimate re-read,
 *     not recorded;
 *   - prior observation was lossy (truncated/collapsed) → recorded with
 *     `exclusion: 'prior-lossy'` so offline analysis can discount it;
 *   - reads more than WINDOW_TURNS after the compact → out of scope.
 */

export interface AmnesiaShadowRow {
  event: 'amnesia_shadow'
  kind: 'full-reread'
  /** Compact generation — count of compact events accounted when the row was
   *  recorded. Monotonic: restore re-seeds / array trimming cannot lower it. */
  generation: number
  turn: number
  turnsSinceCompact: number
  target: string
  contentHash: string
  /** Set when the signal is probably legitimate — offline analysis discounts it. */
  exclusion?: 'prior-lossy'
}

/**
 * 压缩事件的最小结构面（与 `CompactEvent` 结构兼容）。
 * tier/createdAt 是**身份**的一部分：同一轮内可能发生多次合法压缩
 * （自动 + 手动 /compact 或 rewind），按 turn（甚至 turn+tier）判定"同一事件"
 * 会把它们合并，从而漏掉后一次的边界。
 */
export interface AmnesiaCompactEvent {
  turn: number
  tier?: number
  createdAt?: number
  reason?: string
}

export interface CompactionAmnesiaHookDeps {
  getCompactEvents: () => Array<AmnesiaCompactEvent>
  record: (row: AmnesiaShadowRow) => void
}

/** Re-reads more than this many turns after a compact are out of scope. */
const WINDOW_TURNS = 10

/**
 * 压缩事件身份（完整身份，不做 turn+tier 合并）。
 * 缺 tier/createdAt 时退化为轮次身份——旧固件仍可用，只是同轮多压缩不可分。
 */
function compactEventId(event: AmnesiaCompactEvent): string {
  return `${event.turn}|${event.tier ?? ''}|${event.createdAt ?? ''}`
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** Full read = no offset/limit narrowing in the input. */
function isFullRead(input: Record<string, unknown> | undefined): boolean {
  if (!input) return true
  return input['offset'] == null && input['limit'] == null
}

export function createCompactionAmnesiaHook(deps: CompactionAmnesiaHookDeps): PostToolRuntimeHook {
  /** Latest observation per file path. */
  const observed = new Map<string, { hash: string; lossy: boolean }>()
  /** Snapshot of `observed` taken at the last seen compact boundary. */
  let preCompact = new Map<string, { hash: string; lossy: boolean }>()
  /**
   * 已计入尾部的压缩事件身份 — 边界判定按身份，不按 `events.length`：
   * `recordCompactEvent` 走 `[...state, event]` + 上限裁剪（context.ts），
   * 恢复回种还会整数组替换——长度可能不增（新事件被旧的裁掉）或被历史批次
   * 拉高（历史被当成新边界）。
   */
  let accountedTailId: string | undefined
  /** 已计入的压缩事件数（回种基线 + 本进程检测到的边界），单调递增。 */
  let generation = 0
  let lastCompactTurn = -1
  /** 本进程开始观测的轮次：早于它的压缩事件都是恢复回种的历史，不是新边界。 */
  let observationStartTurn = -1
  /**
   * 本进程检测到的压缩边界数。只有 >0 才有可比的 pre-compact 观测——
   * 恢复回种的历史事件没有本进程的 pre-compact 快照，据此开行必然是误报。
   */
  let detectedCompacts = 0

  return {
    phase: 'postTool',
    name: 'compaction-amnesia',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // 压缩边界：按事件身份判定（见 accountedTailId 注释）。
      // 恢复回种（历史批次晚到 / 数组被替换）**不是**新事件——只补基线，
      // 不当作边界（否则会把压缩**之后**的读取当成"事后失忆重读"误报）。
      const events = deps.getCompactEvents()
      const tail = events.length > 0 ? events[events.length - 1]! : undefined
      if (observationStartTurn < 0) observationStartTurn = ctx.snapshot.turn
      if (tail) {
        const tailId = compactEventId(tail)
        if (tailId !== accountedTailId) {
          accountedTailId = tailId
          // 已计入事件数：至少 +1（本批至少带来一个新事件），且不低于数组当前
          // 长度（回种批次的长度是更强的下界）。单调递增，裁剪不回退。
          generation = Math.max(generation + 1, events.length)
          if (tail.turn < observationStartTurn || tail.turn < lastCompactTurn) {
            // 历史事件（回种/乱序重放）：锚点只前移，不开新边界。
            lastCompactTurn = Math.max(lastCompactTurn, tail.turn)
          } else {
            lastCompactTurn = tail.turn
            preCompact = new Map(observed)
            detectedCompacts++
          }
        }
      }

      if (tool.name !== 'read_file' || !tool.success || !tool.resultContent) return
      const target = tool.target ?? (typeof tool.input?.['path'] === 'string' ? tool.input['path'] as string : undefined)
      if (!target) return

      const hash = hashContent(tool.resultContent)
      const lossy = isLossyObservation(tool.resultContent)

      // Amnesia check BEFORE updating the map (compare against prior state).
      if (
        detectedCompacts > 0 &&
        isFullRead(tool.input) &&
        ctx.snapshot.turn - lastCompactTurn >= 0 &&
        ctx.snapshot.turn - lastCompactTurn <= WINDOW_TURNS
      ) {
        const prior = preCompact.get(target)
        if (prior && prior.hash === hash) {
          deps.record({
            event: 'amnesia_shadow',
            kind: 'full-reread',
            generation,
            turn: ctx.snapshot.turn,
            turnsSinceCompact: ctx.snapshot.turn - lastCompactTurn,
            target,
            contentHash: hash,
            ...(prior.lossy ? { exclusion: 'prior-lossy' as const } : {}),
          })
          // Wave 4 控制面：失忆事实只进 silent（shadow 记账，绝不进 prompt）。
          // effects 可缺省（旧测试固件手工构造 ctx）——控制面上报是 best-effort。
          ctx.effects?.emitControlSignal?.({
            key: `compaction:amnesia:${target}`,
            kind: 'compaction',
            severity: 'info',
            summary: `post-compact full re-read of unchanged file ${target}${prior.lossy ? ' (prior-lossy, discounted)' : ''}`,
            requiresDecision: false,
            ttlTurns: 1,
            cacheImpact: 'none',
          })
        }
      }

      observed.set(target, { hash, lossy })
    },
  }
}

/** Offline consumer: aggregate shadow rows into a per-session summary. */
export function summarizeAmnesiaRows(rows: AmnesiaShadowRow[]): {
  total: number
  strongSignals: number
  excluded: number
  byTarget: Record<string, number>
} {
  const byTarget: Record<string, number> = {}
  let excluded = 0
  for (const row of rows) {
    if (row.exclusion) { excluded++; continue }
    byTarget[row.target] = (byTarget[row.target] ?? 0) + 1
  }
  return {
    total: rows.length,
    strongSignals: rows.length - excluded,
    excluded,
    byTarget,
  }
}
