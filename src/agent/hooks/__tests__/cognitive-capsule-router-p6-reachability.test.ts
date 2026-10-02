import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCcrHook, resolveReadOnlyStreak, type CcrTriggerEvent } from '../cognitive-capsule-router.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { EvidenceState } from '../../evidence.js'
import type { RuntimeHookContext, RuntimeHookSnapshot } from '../../runtime-hooks.js'
import type { Sensorium } from '../../sensorium.js'
import type { VigorState } from '../../vigor.js'

// S2（CCR 可达性）：P6 的只读阈值是 6（build）/10（diagnostic），而
// `recentToolHistory` 是 5 条滑动窗口（tool-history-recorder 的 shift 上限）——
// 窗口派生值恒 ≤5，P6 在生产里不可达。旧固件喂 8-10 条历史才绿，属
// "测试绿而生产死"。本文件用**真实产出形状（≤5 条窗口）**+ recorder 侧累计
// 计数钉住可达性，并钉住缺数据语义（缺事实不判停滞）。
//
// 跨分片契约：recorder/buildRuntimeSnapshot 侧需把独立累计的连续只读次数
// 填进 snapshot.readOnlyStreak（见 resolveReadOnlyStreak 的读取面）。

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    confidence: 1.0,
    complexity: 0.3,
    momentum: 0.5,
    stability: 0.8,
    freshness: 0.9,
    pressure: 0.1,
    ...overrides,
  }
}

function makeVigor(overrides: Partial<VigorState> = {}): VigorState {
  return {
    tonic: 0.7,
    phasic: 0.0,
    curiosity: 0.5,
    vigor: 0.8,
    variability: 0.1,
    history: [0.8],
    ...overrides,
  }
}

function makeEvidence(overrides: Partial<EvidenceState> = {}): EvidenceState {
  return {
    filesModified: new Set<string>(),
    filesRead: new Set<string>(),
    deliveryStatus: 'unverified',
    ...overrides,
  } as EvidenceState
}

/** snapshot 固件：额外允许 S2 的累计只读事实（字段未接线时缺席）。 */
type SnapshotOverrides = Partial<RuntimeHookSnapshot> & { readOnlyStreak?: number }

function makeSnapshot(overrides: SnapshotOverrides = {}): RuntimeHookSnapshot {
  return {
    cwd: '/test',
    turn: 5,
    recentToolHistory: [],
    sensorium: makeSensorium(),
    strategy: null,
    vigor: makeVigor(),
    gitChangeRate: 0,
    season: null,
    ...overrides,
  } as RuntimeHookSnapshot
}

/** 生产产出形状：窗口上限 5 条。 */
function productionWindow(n = 5) {
  return Array.from({ length: n }, (_, i) => ({
    tool: 'read_file',
    status: 'success' as const,
    target: `src/f${i}.ts`,
  }))
}

interface TestHarness {
  submitted: AdvisoryEntry[]
  triggerEvents: CcrTriggerEvent[]
  run: (snapshot: RuntimeHookSnapshot) => void
}

function createHarness(evidenceOverrides: Partial<EvidenceState> = {}): TestHarness {
  const submitted: AdvisoryEntry[] = []
  const triggerEvents: CcrTriggerEvent[] = []
  const evidence = makeEvidence(evidenceOverrides)

  const hook = createCcrHook({
    advisoryBus: { submit(entry: AdvisoryEntry) { submitted.push(entry) } },
    wasConvergenceTriggered: () => false,
    getEvidenceState: () => evidence,
    onTrigger: event => { triggerEvents.push(event) },
  })

  return {
    submitted,
    triggerEvents,
    run(snapshot: RuntimeHookSnapshot) {
      const ctx: RuntimeHookContext = {
        snapshot,
        effects: {
          setSensorium() {},
          setStrategy() {},
          setVigor() {},
          setGitChangeRate() {},
          injectUserMessage() {},
          requestThetaCheck() {},
          emitPhaseChange() {},
          emitDecisionShift() {},
          markClaimStale() {},
        },
      }
      hook.run(ctx)
    },
  }
}

const p6 = (h: TestHarness) => h.submitted.filter(e => e.key.includes('P6'))

describe('resolveReadOnlyStreak（S2 事实来源）', () => {
  it('累计事实在场时以其为准（窗口只是末尾子集）', () => {
    const fact = resolveReadOnlyStreak({ recentToolHistory: productionWindow(5), readOnlyStreak: 12 })
    assert.deepEqual(fact, { value: 12, source: 'cumulative' })
  })

  it('事实缺席时回退窗口派生值，标记来源为 window', () => {
    const fact = resolveReadOnlyStreak({ recentToolHistory: productionWindow(5) })
    assert.deepEqual(fact, { value: 5, source: 'window' })
  })

  it('非法值（负数 / NaN / Infinity）不当作事实', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fact = resolveReadOnlyStreak({ recentToolHistory: productionWindow(2), readOnlyStreak: bad })
      assert.equal(fact.source, 'window')
      assert.equal(fact.value, 2)
    }
  })
})

describe('CCR P6 可达性（生产窗口 5 条 + recorder 累计事实）', () => {
  it('连续只读 10 次（窗口只装下 5 条）即可触发——阈值不再高于窗口上限', () => {
    const h = createHarness()
    h.run(makeSnapshot({
      turn: 8,
      sensorium: makeSensorium({ momentum: 0.2 }),
      recentToolHistory: productionWindow(5),
      readOnlyStreak: 10,
    }))

    assert.equal(p6(h).length, 1, '累计 10 连只读必须能触发 P6（旧接线恒 false）')
    assert.match(h.submitted[0]!.key, /ccr-天璇-P6/)
    // 取证：dimValues.readOnlyStreakCumulative = 1（事实来源是累计计数）
    assert.equal(h.triggerEvents[0]!.dimValues['readOnlyStreakCumulative'], 1)
    assert.equal(h.triggerEvents[0]!.dimValues['readOnlyStreak'], 10)
  })

  it('累计事实缺席时不判停滞（回退窗口派生 ≤5 < 阈值，缺数据不开火）', () => {
    const h = createHarness()
    h.run(makeSnapshot({
      turn: 8,
      sensorium: makeSensorium({ momentum: 0.2 }),
      recentToolHistory: productionWindow(5),
    }))

    assert.equal(p6(h).length, 0)
    assert.equal(h.submitted.length, 0, '缺事实时不得因窗口证据指控停滞')
  })

  it('累计计数低于阈值时不触发（9 次只读不达诊断态阈值 10）', () => {
    const h = createHarness()
    h.run(makeSnapshot({
      turn: 8,
      sensorium: makeSensorium({ momentum: 0.2 }),
      recentToolHistory: productionWindow(5),
      readOnlyStreak: 9,
    }))

    assert.equal(p6(h).length, 0)
  })

  it('累计事实是唯一权威：产出工具/新用户任务重置后，陈旧窗口不得判停滞', () => {
    const h = createHarness()
    h.run(makeSnapshot({
      turn: 8,
      sensorium: makeSensorium({ momentum: 0.2 }),
      // 陈旧长窗口（非生产形状）：窗口里全是旧只读条目
      recentToolHistory: productionWindow(10),
      readOnlyStreak: 0,
    }))

    assert.equal(p6(h).length, 0, '计数已重置 ⇒ 窗口残留只读条目不得单独定罪')
    assert.equal(h.triggerEvents.length, 0)
  })
})
