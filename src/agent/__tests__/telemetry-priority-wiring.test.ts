import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { presetIncludes, type ToolPreset } from '../../tools/tool-preset.js'
import { resolveZenConfig } from '../zen-mode.js'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { buildRuntimeSnapshot, createTurnOrchestrator } from '../loop-factory.js'
import { recordToolHistory } from '../tool-history-recorder.js'
import { buildStarPhaseContext } from '../perception.js'
import { budget } from './advice-facts-fixture.js'
import { observePal } from '../pal-observation.js'
import { assembleCognitiveFrame, projectStructureFlowInputs, type CognitiveFrame, type CognitiveFrameInput } from '../cognitive-frame.js'
import { computeStructureFlowControl } from '../structure-flow-controller.js'
import { buildCognitiveFrameRecord, buildCognitiveFrameLiteRecord, replayCognitiveFrames } from '../cognitive-frame-replay.js'
import { QUALITY_ORDER, QUALITY_CODE } from '../cognitive-quality.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { AdvisoryEntry } from '../advisory-bus.js'

function makeAgent(preset: ToolPreset = 'full', variant = 'normal') {
  const cwd = mkdtempSync(join(tmpdir(), 'telemetry-wiring-'))
  const registry = new ToolRegistry()
  for (const name of ['read_file', 'bash', 'session_vitals', 'todo', 'attack_case']) if (presetIncludes(preset, name)) registry.register({
    definition: { name, description: name, input_schema: { type: 'object', properties: {} } },
    isEnabled: () => true, execute: async () => ({ content: '' }),
  } as never)
  const engine = new PromptEngine({ model: 'test-model', maxTokens: 1024, staticCtx: { tools: registry.getDefinitions() }, volatileCtx: { cwd } })
  const agent = new AgentLoop({ client: { stream: async () => {} } as unknown as StreamClient, promptEngine: engine, toolRegistry: registry,
    sessionId: 'worker-test-priority', maxTurns: 3, contextWindow: 1_000_000,
    getTodos: () => [],
    toolGating: { enabled: true, disabledTools: variant === 'disabled' ? ['session_vitals', 'todo'] : [],
      ...(variant === 'domain' ? { coreOverride: ['read_file', 'bash'] } : {}) },
    zen: variant === 'zen' ? resolveZenConfig({ enabled: true, face: ['read_file'] }) : undefined,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, new SessionContext(), cwd)
  return { agent, engine }
}

for (const preset of ['minimal', 'frontend', 'full', 'taiyi'] as const) for (const variant of ['normal', 'disabled', 'domain', 'zen']) {
  test(`production reminders follow exposed tools: ${preset}/${variant}`, async () => {
    const { agent } = makeAgent(preset, variant)
    const allowed = new Set(['wrapup-anxiety-guard', 'todo-reminder', 'context-pressure'])
    agent.runtimeHooks.setDisabledHookIds(agent.runtimeHooks.getManifest().map(h => h.id).filter(n => !allowed.has(n)))
    const rows: AdvisoryEntry[] = []
    mock.method(agent.advisoryBus, 'submit', (e: AdvisoryEntry) => { rows.push(e) })
    mock.method(agent, 'getContextBudget', () => budget())
    agent.streamedText = '上下文快满了，我建议开新会话继续剩下的所有任务。'
    agent.modelObservationTurn = 8
    agent.todoTaskContext = { key: 1, multiStep: true, startTurn: 1, initialSignature: '[]' }
    agent.recentToolHistory = [{ tool: 'read_file', target: 'a', status: 'success' }, { tool: 'read_file', target: 'b', status: 'success' }]
    const snapshot = buildRuntimeSnapshot(agent)
    await agent.runtimeHooks.runPostTurn(createRuntimeHookContext(snapshot))
    const available = agent.getActiveToolNames()
    const wrap = rows.find(r => r.key === 'wrapup-anxiety-guard')
    assert.ok(wrap, 'real factory must pass budget facts to the hook')
    assert.equal(wrap.content.includes('session_vitals'), available.includes('session_vitals'))
    assert.equal(rows.some(r => r.key === 'todo-missing'), available.includes('todo'))
    assert.equal(snapshot.modelTurn, 8)
    // B2 uses the same live capability getter; changing Zen must not use a stale registry snapshot.
    const orchestrator = createTurnOrchestrator(agent) as unknown as { deps: { getRuntimeAdvice: () => string } }
    assert.equal(orchestrator.deps.getRuntimeAdvice().includes('session_vitals'), available.includes('session_vitals'))
  })
}

test('production tool recorder preserves full-command verification despite truncated display targets', () => {
  const { agent } = makeAgent()
  agent.modelObservationTurn = 42
  recordToolHistory(agent, 'bash', { command: 'A=' + 'x'.repeat(300) + ' npm test' }, true, 'test failed')
  const snapshot = buildRuntimeSnapshot(agent)
  const last = snapshot.recentToolHistory.at(-1)!
  assert.equal(last.verificationAttempted, true)
  assert.equal(last.modelTurn, 42)
  assert.equal(buildStarPhaseContext({ turn: 1, modelTurn: 43, recentTools: ['bash'], recentToolHistory: snapshot.recentToolHistory, maxTurns: 100, hasEnteredHighComplexity: false }).isRunningTests, true)
  assert.equal(buildStarPhaseContext({ turn: 1, modelTurn: 44, recentTools: ['bash'], recentToolHistory: snapshot.recentToolHistory, maxTurns: 100, hasEnteredHighComplexity: false }).isRunningTests, false)
})

const base: CognitiveFrameInput = { turn: 1, phaseClass: 'explore', efe: null, sensorium: null,
  flow: { score: null, sampleCount: 0, requiredSamples: 4 }, pal: null,
  evidence: { hasVerificationDebt: false, deliveryStatus: 'unverified', consecutiveFailures: 0 },
  user: { intervened: false }, plan: { activePlanFile: false, planModeState: 'off' }, progress: { todoCompletedDelta: 0 } }

test('PAL five states and closed entrance preserve active facts; v1/v2 replay and quality encoding agree', () => {
  const active = { activeCases: 1, anyNeedsUser: true, anyStalled: true, hasPlannedProbes: false }
  const cases = [observePal('off', true, () => null), observePal('shadow', false, () => null), observePal('shadow', true, () => null),
    observePal('active', true, () => active), observePal('active', true, () => { throw Error('read failure') }), observePal('off', false, () => active)]
  assert.deepEqual(cases.map(c => c.palStatus.state), ['disabled', 'unavailable', 'idle', 'active', 'error', 'active'])
  const frames = cases.map(c => assembleCognitiveFrame({ ...base, ...c }))
  assert.deepEqual(frames.map(f => f.quality.pal), ['not_applicable', 'not_applicable', 'measured', 'measured', 'missing', 'measured'])
  assert.equal(frames[5]!.facts.pal!.anyNeedsUser, true)
  assert.equal(frames[2]!.facts.pal!.activeCases, 0)
  assert.notEqual(frames[0]!.inputFingerprint, frames[1]!.inputFingerprint)
  const legacy = assembleCognitiveFrame(base, 1)
  assert.equal(legacy.facts.palStatus, undefined)
  assert.equal(legacy.quality.pal, 'missing')
  const records = [legacy, ...frames].map(f => {
    const inputs = projectStructureFlowInputs(f), sf = inputs ? computeStructureFlowControl(inputs) : null
    const lite = buildCognitiveFrameLiteRecord(f, sf, null)
    assert.equal(lite.q, QUALITY_ORDER.map(k => QUALITY_CODE[f.quality[k]]).join(''))
    assert.ok(Buffer.byteLength(JSON.stringify(lite)) < 200)
    return buildCognitiveFrameRecord(f, sf, null)
  })
  assert.deepEqual(replayCognitiveFrames(JSON.parse(JSON.stringify(records))).divergences, [])
})

test('actual boundary assembly emits v2 PAL status without adding observation fields to prompt history', () => {
  const { agent, engine } = makeAgent('minimal')
  const history = [{ role: 'user' as const, content: 'inspect current work' }, { role: 'user' as const, content: 'continue' }]
  const beforeWire = JSON.stringify(engine.buildOaiRequest(history))
  const before = engine.getFingerprint()
  const assemble = (agent as unknown as { assembleBoundaryFrame: (t: number, p: string, d: number, u: boolean) => CognitiveFrame }).assembleBoundaryFrame.bind(agent)
  const frame = assemble(1, 'explore', 0, false)
  assert.equal(frame.v, 2)
  assert.equal(frame.facts.palStatus?.toolAvailable, false)
  assert.equal(frame.quality.pal, 'not_applicable')
  assert.deepEqual(engine.getFingerprint(), before, 'telemetry must not rewrite the frozen prompt')
  assert.equal(JSON.stringify(engine.buildOaiRequest(history)), beforeWire, 'serialized model request stays byte-stable')
  mock.method(agent.problemAttack, 'snapshotForCvm', () => ({ activeCases: 1, anyNeedsUser: true, anyStalled: true, hasPlannedProbes: false }))
  assert.equal(assemble(2, 'explore', 0, false).facts.pal?.anyStalled, true)
})

test('production response observer counts completed responses only, including worker profile', async () => {
  for (const outcome of ['cancelled', 'error', 'rule', 'complete']) {
    const { agent } = makeAgent()
    agent.modelObservationTurn = 10
    agent.advisoryReadback.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 } }], 10)
    assert.equal(agent.advisoryReadback.evaluate(10), 0, 'factory must configure response-opportunity accounting')
    agent.abortController = new AbortController()
    if (outcome === 'cancelled') agent.abortController.abort()
    agent.turnStream = { streamTurn: async () => ({ streamError: outcome === 'error' ? Error('network') : null, triggeredRule: outcome === 'rule' ? {} : undefined }) } as never
    const deps = (createTurnOrchestrator(agent) as unknown as { deps: { streamTurn: (p: unknown) => Promise<unknown> } }).deps
    await deps.streamTurn({})
    const end = agent.advisoryReadback.flushAtSessionEnd(10)
    assert.equal(end.decided, outcome === 'complete' ? 1 : 0, outcome)
    if (outcome === 'complete') assert.equal(agent.advisoryReadback.drainOutcomes()[0]!.profile, 'worker')
    else assert.equal(end.unresolved[0]!.profile, 'worker')
  }
})
