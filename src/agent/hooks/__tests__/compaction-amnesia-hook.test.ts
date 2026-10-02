import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCompactionAmnesiaHook, summarizeAmnesiaRows, type AmnesiaCompactEvent, type AmnesiaShadowRow } from '../compaction-amnesia-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

// W3-C1: shadow-only amnesia ledger. The hook records unchanged-hash full
// re-reads within the post-compact window and never touches the prompt.

function ctx(turn: number): RuntimeHookContext {
  return { snapshot: { turn } } as unknown as RuntimeHookContext
}

function readEvent(target: string, content: string, input: Record<string, unknown> = {}): RuntimeToolEvent {
  return { name: 'read_file', success: true, target, resultContent: content, input }
}

function makeHarness() {
  // 事件形状与生产一致（CompactEvent）：身份含 tier/createdAt。
  const compactEvents: AmnesiaCompactEvent[] = []
  const rows: AmnesiaShadowRow[] = []
  const hook = createCompactionAmnesiaHook({
    getCompactEvents: () => compactEvents,
    record: r => rows.push(r),
  })
  return { hook, compactEvents, rows }
}

describe('compaction-amnesia shadow hook', () => {
  it('records an unchanged-hash full re-read shortly after a compact', () => {
    const { hook, compactEvents, rows } = makeHarness()

    hook.run(ctx(1), readEvent('src/a.ts', 'stable content'))
    compactEvents.push({ turn: 3 })
    hook.run(ctx(4), readEvent('src/a.ts', 'stable content'))

    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.kind, 'full-reread')
    assert.equal(rows[0]!.target, 'src/a.ts')
    assert.equal(rows[0]!.turnsSinceCompact, 1)
    assert.equal(rows[0]!.exclusion, undefined)
  })

  it('does not record when the content hash changed (legitimate re-read)', () => {
    const { hook, compactEvents, rows } = makeHarness()
    hook.run(ctx(1), readEvent('src/a.ts', 'v1 content'))
    compactEvents.push({ turn: 2 })
    hook.run(ctx(3), readEvent('src/a.ts', 'v2 content — edited meanwhile'))
    assert.equal(rows.length, 0)
  })

  it('marks the row excluded when the prior observation was lossy', () => {
    const { hook, compactEvents, rows } = makeHarness()
    const lossyBody = '<microcompacted tool_result original_chars="90000">\npreview\n</microcompacted tool_result>'
    hook.run(ctx(1), readEvent('src/big.ts', lossyBody))
    compactEvents.push({ turn: 2 })
    hook.run(ctx(3), readEvent('src/big.ts', lossyBody))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.exclusion, 'prior-lossy')
  })

  it('ignores narrowed reads (offset/limit) and reads outside the window', () => {
    const { hook, compactEvents, rows } = makeHarness()
    hook.run(ctx(1), readEvent('src/a.ts', 'stable'))
    compactEvents.push({ turn: 2 })
    // Narrowed read: not a full re-read.
    hook.run(ctx(3), readEvent('src/a.ts', 'stable', { offset: 10, limit: 50 }))
    // Outside the 10-turn window.
    hook.run(ctx(20), readEvent('src/a.ts', 'stable'))
    assert.equal(rows.length, 0)
  })

  it('records nothing before any compact has happened', () => {
    const { hook, rows } = makeHarness()
    hook.run(ctx(1), readEvent('src/a.ts', 'stable'))
    hook.run(ctx(2), readEvent('src/a.ts', 'stable'))
    assert.equal(rows.length, 0)
  })

  // ─── S3：压缩事件持久化 / 恢复回种的边界语义 ──────────────────────
  // 压缩台账落盘后，resume 路径会把历史压缩事件回种进数组（recordCompactEvent
  // 走 [...state, event] + 上限裁剪，回种则是整数组替换）。边界判定必须按事件
  // 身份而不是数组长度，且历史回种不是"新压缩"：本进程没有它的 pre-compact
  // 观测，据此开行必然是误报。

  it('恢复回种不是新事件：晚到的历史批次不开边界，压缩后的重读不记为失忆', () => {
    const { hook, compactEvents, rows } = makeHarness()
    // 本进程先观测到一次读取（回种尚未落地/晚到）
    hook.run(ctx(45), readEvent('src/a.ts', 'stable content'))
    // 历史压缩事件（turn 40 < 本进程观测起点）此刻才进入数组
    compactEvents.push({ turn: 40, tier: 1, createdAt: 1000 })
    hook.run(ctx(46), readEvent('src/a.ts', 'stable content'))
    assert.equal(rows.length, 0, '历史回种把压缩后的重读当成 pre-compact 基线 = 误报')
  })

  it('历史回种之后，本进程内的真实压缩仍然开边界（修复不能靠静音）', () => {
    const { hook, compactEvents, rows } = makeHarness()
    compactEvents.push({ turn: 40, tier: 1, createdAt: 1000 })
    hook.run(ctx(45), readEvent('src/a.ts', 'stable content'))
    hook.run(ctx(46), readEvent('src/a.ts', 'stable content'))
    assert.equal(rows.length, 0, '仅历史回种时不开行')

    compactEvents.push({ turn: 47, tier: 1, createdAt: 2000 })
    hook.run(ctx(47), readEvent('src/a.ts', 'stable content'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.turnsSinceCompact, 0)
    assert.equal(rows[0]!.generation, 2, '回种基线 + 本次边界 = 第 2 代')
  })

  it('数组被回种/裁剪替换（长度不增）时新压缩事件仍可检出', () => {
    const { hook, compactEvents, rows } = makeHarness()
    compactEvents.push({ turn: 45, tier: 1, createdAt: 1000 })
    hook.run(ctx(46), readEvent('src/a.ts', 'stable content'))

    // 回种替换语义：数组被换成长度相同的另一份（旧事件被裁掉）
    compactEvents.length = 0
    compactEvents.push({ turn: 47, tier: 2, createdAt: 2000 })
    hook.run(ctx(47), readEvent('src/a.ts', 'stable content'))

    assert.equal(rows.length, 1, '长度不增不得让新压缩事件失明')
    assert.equal(rows[0]!.turnsSinceCompact, 0)
  })

  it('同一轮内两次合法压缩是不同事件（身份不得按 turn+tier 合并）', () => {
    const { hook, compactEvents, rows } = makeHarness()
    compactEvents.push({ turn: 47, tier: 1, createdAt: 1000 })
    hook.run(ctx(48), readEvent('src/a.ts', 'stable content'))

    compactEvents.push({ turn: 48, tier: 1, createdAt: 3000 })
    hook.run(ctx(48), readEvent('src/a.ts', 'stable content'))

    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.turn, 48)
  })

  it('只有历史回种时，压缩窗口内的重读不开行（本进程没有 pre-compact 快照）', () => {
    const { hook, compactEvents, rows } = makeHarness()
    compactEvents.push({ turn: 40, tier: 1, createdAt: 1000 })
    hook.run(ctx(41), readEvent('src/a.ts', 'stable content'))
    hook.run(ctx(42), readEvent('src/a.ts', 'stable content'))
    hook.run(ctx(43), readEvent('src/a.ts', 'stable content'))
    assert.equal(rows.length, 0)
  })

  it('summarizeAmnesiaRows separates strong signals from exclusions', () => {
    const rows: AmnesiaShadowRow[] = [
      { event: 'amnesia_shadow', kind: 'full-reread', generation: 1, turn: 4, turnsSinceCompact: 1, target: 'a.ts', contentHash: 'h1' },
      { event: 'amnesia_shadow', kind: 'full-reread', generation: 1, turn: 5, turnsSinceCompact: 2, target: 'a.ts', contentHash: 'h1' },
      { event: 'amnesia_shadow', kind: 'full-reread', generation: 1, turn: 6, turnsSinceCompact: 3, target: 'b.ts', contentHash: 'h2', exclusion: 'prior-lossy' },
    ]
    const summary = summarizeAmnesiaRows(rows)
    assert.equal(summary.total, 3)
    assert.equal(summary.strongSignals, 2)
    assert.equal(summary.excluded, 1)
    assert.equal(summary.byTarget['a.ts'], 2)
  })
})
