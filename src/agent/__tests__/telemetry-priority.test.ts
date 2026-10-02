import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { budget, facts } from './advice-facts-fixture.js'
import { currentAdviceBudget, sessionStateAdvice } from '../runtime-advice-facts.js'
import { createWrapupAnxietyGuardHook } from '../hooks/wrapup-anxiety-guard-hook.js'
import { createContextPressureHook } from '../hooks/context-pressure-hook.js'
import { createTodoReminderHook } from '../hooks/todo-reminder-hook.js'
import { AdvisoryBus, type AdvisoryEntry } from '../advisory-bus.js'
import { AdvisoryReadback } from '../advisory-readback.js'
import { createAdvisoryReadbackHooks } from '../hooks/advisory-readback-hook.js'
import { AdvisoryEfficacyStore } from '../../context/advisory-efficacy-store.js'
import { verificationAttempted, recentVerification } from '../verification-activity.js'
import { buildStarPhaseContext } from '../perception.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'

const ctx = (modelTurn: number) => ({ snapshot: { turn: 1, modelTurn, recentToolHistory: [{ tool: 'read_file' }, { tool: 'read_file' }] }, effects: {} }) as unknown as RuntimeHookContext
const advice = (shadow = false) => ({ key: 'verify', category: 'discipline' as const, shadow, expect: { kind: 'verify_attempted' as const, withinTurns: 3 } })

test('budget authority: mismatched, stale and missing snapshots cannot refute; blocked states stay silent', () => {
  for (const patch of [{ model: 'other' }, { sampledAt: Date.now() - 31_000 }, { state: 'blocked' as const }, { state: 'warning' as const }, { state: 'compacting' as const }]) {
    const rows: AdvisoryEntry[] = []
    createWrapupAnxietyGuardHook({ adviceFacts: facts(() => budget(patch)), getEstimatedTokens: () => 1, getContextWindow: () => 1e6,
      getStreamedText: () => '上下文快满了，我建议开新会话继续剩下的所有任务。', advisoryBus: { submit: e => rows.push(e) } }).run(ctx(1))
    assert.equal(rows.length, 0, JSON.stringify(patch))
  }
  assert.equal(currentAdviceBudget(facts(() => undefined)), undefined)
  assert.match(sessionStateAdvice(facts(() => undefined, [])), /暂无法确认/)
})

test('estimate is labelled neutral and input budget, not model window, determines pressure', () => {
  const rows: AdvisoryEntry[] = []
  const deps = { adviceFacts: facts(() => budget({ source: 'estimate' }), []), getEstimatedTokens: () => 1, getContextWindow: () => 1e6, advisoryBus: { submit: (e: AdvisoryEntry) => rows.push(e) } }
  createWrapupAnxietyGuardHook({ ...deps, getStreamedText: () => '上下文快满了，我建议开新会话继续剩下的所有任务。' }).run(ctx(1))
  assert.match(rows[0]!.content, /本地估算.*不能据此保证余量充足/)
  assert.doesNotMatch(rows[0]!.content, /session_vitals/)
  createContextPressureHook({ ...deps, adviceFacts: facts(() => budget({ inputTokens: 720_000, inputBudget: 800_000, state: 'blocked' })) }).run(ctx(1))
  assert.match(rows[1]!.content, /90%/)
  assert.match(rows[1]!.content, /blocked/)
})

test('verification classifier accepts actual invocations and rejects quoted prose and file inspection', () => {
  for (const command of ['npm test', 'pnpm run test:unit', 'yarn typecheck', 'node --import tsx --test a.ts', 'pytest -q', 'python3 -m pytest', 'npx tsc --noEmit', 'CI=1 npm run test', 'cd app && npm test']) {
    assert.equal(verificationAttempted('bash', { command }), true, command)
  }
  for (const command of ['echo "npm test"', 'echo "ok; npm test"', 'echo "ok; npm test; done"', 'cat test.ts', 'rg npm test.ts', 'node app.js --test', 'node -e "npm test"', 'pytest --help', 'printf \'npm test\'', 'echo $(npm test)']) {
    assert.equal(verificationAttempted('bash', { command }), false, command)
  }
  assert.equal(verificationAttempted('read_file', { path: 'test.ts' }), false)
  assert.equal(verificationAttempted('run_tests'), true)
})

test('verification activity expires after the adjacent model turn and does not require success', () => {
  const history = [{ verificationAttempted: true, modelTurn: 12, status: 'failed' as const, tool: 'bash', target: 'test' }]
  for (const turn of [12, 13]) assert.ok(recentVerification(history, turn))
  for (const turn of [11, 14, 90]) assert.equal(recentVerification(history, turn), undefined)
  const input = { turn: 1, modelTurn: 13, maxTurns: 100, recentTools: ['bash'], recentToolHistory: history, hasEnteredHighComplexity: false }
  assert.equal(buildStarPhaseContext(input).isRunningTests, true)
  assert.equal(buildStarPhaseContext({ ...input, modelTurn: 14 }).isRunningTests, false)
})

test('pending/short/cancelled worker and undecided holdout never inflate ignores or lift', () => {
  const rb = new AdvisoryReadback(); rb.configure('worker')
  rb.track([advice()], 1)
  rb.observeTool({ turn: 1, name: 'run_tests', target: '', isError: true })
  assert.equal(rb.evaluate(1), 1, 'positive evidence settles immediately, even a failed test')
  assert.equal(rb.drainOutcomes()[0]!.profile, 'worker')
  rb.track([advice(true)], 2)
  rb.markResponseComplete(2)
  assert.equal(rb.evaluate(200), 0, 'elapsed turn labels are not response opportunities')
  assert.equal(rb.getLift('verify'), null)
  const end = rb.flushAtSessionEnd(200)
  assert.equal(end.unresolved.length, 1)
  assert.equal(end.unresolved[0]!.reason, 'session_ended')
  assert.equal(rb.getStats().get('verify')!.shadowDecided, 0)
  assert.equal(rb.getLift('verify'), null)
})

test('superseded windows have separate delivery identities and do not disappear', () => {
  const rb = new AdvisoryReadback(); rb.configure('main')
  rb.track([advice()], 1); rb.track([advice()], 2)
  const unresolved = rb.flushAtSessionEnd(2).unresolved
  assert.deepEqual(unresolved.map(e => e.reason), ['superseded', 'session_ended'])
  assert.equal(new Set(unresolved.map(e => e.deliveryId)).size, 2)
  assert.equal(rb.getTotals().ignored, 0)
})

test('real postTool hook uses full command and model clock, not user-turn clock', () => {
  const rb = new AdvisoryReadback(); rb.configure('main'); rb.track([advice()], 10)
  const [observe, evaluate] = createAdvisoryReadbackHooks({ readback: rb })
  observe.run(ctx(10), { name: 'bash', success: true, input: { command: 'echo "npm test"' } })
  evaluate.run(ctx(10)); assert.equal(rb.getTotals().adopted, 0)
  observe.run(ctx(11), { name: 'bash', success: false, input: { command: 'npm test' } })
  evaluate.run(ctx(11)); assert.equal(rb.getTotals().adopted, 1)
})

test('six decided ignores mute ten renders then one probation; pending probation cannot repeat', () => {
  const rb = new AdvisoryReadback(); rb.configure('main')
  for (let i = 1; i <= 6; i++) {
    rb.track([{ ...advice(), expect: { kind: 'verify_attempted', withinTurns: 1 } }], i)
    rb.markResponseComplete(i); rb.evaluate(i)
  }
  const bus = new AdvisoryBus()
  bus.setEfficacyStatsProvider(k => { const s = rb.getStats().get(k); return s ? { ...s, decided: s.adopted + s.ignored, pending: rb.hasPending(k) } : null })
  bus.setHabituationPolicy({ getIgnoredStreak: k => rb.getIgnoredStreak(k) })
  bus.setLiftProvider(() => -1)
  const render = (turn: number) => {
    bus.submit({ ...advice(), priority: 0.5, content: 'please verify' })
    const out = bus.render(undefined, turn)
    rb.track(bus.drainDelivered(), turn)
    return out
  }
  for (let t = 7; t < 17; t++) assert.equal(render(t), '', `muted render ${t}`)
  assert.match(render(17), /please verify/)
  for (let t = 18; t <= 22; t++) assert.equal(render(t), '', 'pending trial waits for evidence')
  rb.observeTool({ turn: 22, name: 'run_tests', target: '', isError: false }); rb.evaluate(22)
  assert.equal(rb.getStats().get('verify')!.adopted, 1)
})

test('unknown legacy statistics and advice without a predicate cannot trigger zero-adoption muting', () => {
  for (const decided of [undefined, 100]) {
    const bus = new AdvisoryBus(); bus.setEfficacyStatsProvider(() => ({ delivered: 100, adopted: 0, decided }))
    bus.submit({ key: 'info', priority: 0.5, category: 'cerebellar', content: 'state' })
    assert.match(bus.render(), /state/)
  }
  const rb = new AdvisoryReadback(); rb.configure('main')
  rb.seedPriors([['verify', { delivered: 50, adopted: 50, ignored: 0, shadowHeld: 50, shadowSatisfied: 0 }]])
  assert.equal(rb.getMatureLift('verify'), null)
})

test('profiled priors preserve legacy rows but isolate main from worker and persist shadowDecided', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'telemetry-priors-'))
  const delta = { delivered: 6, adopted: 3, ignored: 3, shadowHeld: 9, shadowSatisfied: 1 }
  new AdvisoryEfficacyStore(cwd).mergeAndSave(new Map([['legacy', delta]]))
  const main = new AdvisoryEfficacyStore(cwd, 'main'), worker = new AdvisoryEfficacyStore(cwd, 'worker')
  assert.equal(main.load().size, 0)
  main.mergeAndSave(new Map([['verify', { ...delta, shadowDecided: 3 }]]))
  assert.equal(worker.load().size, 0)
  assert.ok(main.load().get('verify')!.shadowDecided! > 2.9)
  worker.mergeAndSave(new Map([['verify', { ...delta, shadowDecided: 5 }]]))
  assert.ok(main.load().get('verify')!.shadowDecided! < 3.1)
  assert.ok(new AdvisoryEfficacyStore(cwd).load().has('legacy'))
})

test('todo is task-scoped: unknown/simple, unavailable, old and completed lists stay quiet', () => {
  for (const multiStep of [true, false]) for (const available of [true, false]) {
    const rows: AdvisoryEntry[] = []
    const hook = createTodoReminderHook({ getTask: () => ({ key: 1, multiStep, startTurn: 1 }), getActiveToolNames: () => available ? ['todo'] : [], getTodos: () => [], advisoryBus: { submit: e => rows.push(e) } })
    hook.run(ctx(100)); assert.equal(rows.length, multiStep && available ? 1 : 0)
    if (rows.length) assert.equal(rows[0]!.priority, 0.5)
  }
  const rows: AdvisoryEntry[] = []
  let todos = [{ id: '1', content: 'old task', status: 'pending' as const }]
  let task = { key: 1, multiStep: true, startTurn: 1, initialSignature: JSON.stringify(todos) }
  const hook = createTodoReminderHook({ getTask: () => task, getActiveToolNames: () => ['todo'], getTodos: () => todos, advisoryBus: { submit: e => rows.push(e) } })
  hook.run(ctx(1)); hook.run(ctx(20)); assert.equal(rows.length, 0)
  todos = [{ id: '2', content: 'current task', status: 'pending' }]
  hook.run(ctx(21)); hook.run(ctx(31)); assert.equal(rows.length, 1)
  task = { ...task, key: 2, startTurn: 32, initialSignature: JSON.stringify(todos) }
  hook.run(ctx(32)); hook.run(ctx(60)); assert.equal(rows.length, 1)
})

test('safety, immediate and star-domain advice remain exempt with real predicates and zero adoption', () => {
  for (const patch of [{ tier: 'constitutional' as const }, { immediate: true }, { category: 'star_domain' as const }]) {
    const bus = new AdvisoryBus()
    bus.setEfficacyStatsProvider(() => ({ delivered: 50, decided: 50, adopted: 0, pending: true }))
    bus.setHabituationPolicy({ getIgnoredStreak: () => 50 }); bus.setLiftProvider(() => -1)
    bus.submit({ ...advice(), priority: 0.6, content: 'critical reminder', ...patch })
    assert.match(bus.render(), /critical reminder/)
  }
})

test('completed current-task todo never produces stale advice', () => {
  const rows: AdvisoryEntry[] = []
  const hook = createTodoReminderHook({ advisoryBus: { submit: e => rows.push(e) }, getActiveToolNames: () => ['todo'],
    getTask: () => ({ key: 1, multiStep: true, startTurn: 1, initialSignature: '[]' }),
    getTodos: () => [{ id: '1', content: 'done', status: 'completed' }] })
  hook.run(ctx(1)); hook.run(ctx(50)); assert.equal(rows.length, 0)
})
