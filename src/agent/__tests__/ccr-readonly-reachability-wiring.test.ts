import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { recordToolHistory } from '../tool-history-recorder.js'
import { buildRuntimeSnapshot } from '../loop-factory.js'
import { createCcrHook } from '../hooks/cognitive-capsule-router.js'
import type { AdvisoryEntry } from '../advisory-bus.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * S2 CCR 可达性——**边界集成**回归（生产链，非 mock）。
 *
 * 判据不是"P6 的函数能触发"，而是"真实生产容量下 P6 能触发"：
 *   recordToolHistory（唯一记录点，容量 5）→ buildRuntimeSnapshot
 *   → createCcrHook.run → P6 advisory
 *
 * 缺陷形态（修复前）：snapshot 只有 5 条 recentToolHistory，P6 从窗口派生
 * streak → 上限 5 < 诊断态阈值 10 → 规则恒 false。单测喂 10 条历史能绿，
 * 生产形状永远到不了（"测试绿而生产死"）。
 *
 * 边界断裂证据：把 loop-factory 的 `readOnlyStreak: self.readOnlyStreak` 接线
 * 摘掉（或 loop 的累计计数停更），本文件用例 1 立刻红——那正是修复前的形态。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-ccr-reach-'))

function idleClient(): StreamClient {
  return {
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    },
  } as unknown as StreamClient
}

function makeAgent(): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: idleClient(),
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, new SessionContext(), TEST_CWD)
}

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return { confidence: 1.0, complexity: 0.3, momentum: 0.5, stability: 0.8, freshness: 0.9, pressure: 0.1, ...overrides }
}

function makeVigor(): VigorState {
  return { tonic: 0.7, phasic: 0.0, curiosity: 0.5, vigor: 0.8, variability: 0.1, history: [0.8] }
}

/** 真实生产链：N 次连续只读工具调用 → snapshot → CCR hook。 */
function runP6Scenario(readOnlyCalls: number): { submitted: AdvisoryEntry[] } {
  const agent = makeAgent()
  for (let i = 0; i < readOnlyCalls; i++) {
    recordToolHistory(agent, 'read_file', { path: `src/f${i}.ts` }, false, 'file body')
  }

  const snapshot = buildRuntimeSnapshot(agent, {
    turn: 8, // > P6 的 turn > 5 门
    sensorium: makeSensorium({ momentum: 0.2 }), // < 0.35，且 quality 非 no-data
    vigor: makeVigor(),
    season: null,
  })

  const submitted: AdvisoryEntry[] = []
  const hook = createCcrHook({
    advisoryBus: { submit(entry: AdvisoryEntry) { submitted.push(entry) } },
    wasConvergenceTriggered: () => false,
    getEvidenceState: () => agent.evidence.getState(),
    cwd: TEST_CWD,
  })
  hook.run({
    snapshot,
    effects: {
      setSensorium() {}, setStrategy() {}, setVigor() {}, setGitChangeRate() {},
      injectUserMessage() {}, requestThetaCheck() {}, emitPhaseChange() {},
      emitDecisionShift() {}, markClaimStale() {},
    },
  } as unknown as RuntimeHookContext)

  return { submitted }
}

describe('S2 CCR 可达性：P6 在真实 5 条历史容量下可达', () => {
  it('连续 10 次只读（诊断态阈值）→ P6 触发（接线断裂则必红）', () => {
    const { submitted } = runP6Scenario(10)
    assert.ok(
      submitted.some(e => e.key.includes('P6')),
      '真实记录链下连续 10 次只读必须能触发 P6——不触发说明 streak 仍从 5 条窗口反算（上限 5 < 10）',
    )
  })

  it('连续 9 次只读 → 不触发（阈值不被接线放宽）', () => {
    const { submitted } = runP6Scenario(9)
    assert.equal(
      submitted.filter(e => e.key.includes('P6')).length,
      0,
      '诊断态阈值 10 必须保持——9 次就触发等于把 A1 阈值分级改回去了',
    )
  })

  it('窗口容量保持 5 条（可达性不能靠扩大共享历史换取）', () => {
    const agent = makeAgent()
    for (let i = 0; i < 12; i++) recordToolHistory(agent, 'read_file', { path: `src/f${i}.ts` }, false, 'file body')
    assert.equal(agent.recentToolHistory.length, 5, '共享 history 容量契约不变')
  })
})
