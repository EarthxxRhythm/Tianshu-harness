import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { parseFrozenSnapshotData } from '../frozen-snapshot.js'
import { serializeOaiSessionMessage } from '../../agent/session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'

const engineConfig = (inheritFrozenFrom?: PromptEngine | ReturnType<PromptEngine['exportFrozenSnapshot']>) => ({
  model: 'step-5-preview', maxTokens: 4096, staticCtx: { tools: [] },
  volatileCtx: { cwd: '/test', gitStatus: 'main', rivetMd: '# Test' }, inheritFrozenFrom,
})
const make = (inheritFrozenFrom?: ReturnType<PromptEngine['exportFrozenSnapshot']>) => new PromptEngine(engineConfig(inheritFrozenFrom))
const image: OaiMessage = { role: 'user', content: [{ type: 'text', text: 'look' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(300000), detail: 'high' } }] }

test('image historical trailer and duplicate images keep their dispatched bytes', () => {
  const engine = make(); const history: OaiMessage[] = [image]
  engine.setCrossSessionMemoryBlock('first-appendix')
  const first = engine.buildOaiRequest(history)
  assert.ok(JSON.stringify(first.messages[1]).includes('first-appendix'))
  engine.setCrossSessionMemoryBlock('second-appendix')
  history.push({ role: 'assistant', content: 'one' }, image)
  const second = engine.buildOaiRequest(history)
  assert.deepEqual(second.messages[1], first.messages[1])
  history.push({ role: 'assistant', content: 'two' }, { role: 'user', content: 'continue' })
  const third = engine.buildOaiRequest(history)
  assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages)
  assert.equal(engine.consumePrefixDivergence(), null)
  const data = engine.exportFrozenSnapshot()
  assert.equal(data.v, 2)
  assert.ok(JSON.stringify(data).length < 100000, 'snapshot must not copy base64')
  const restored = make(parseFrozenSnapshotData(JSON.parse(JSON.stringify(data))))
  assert.deepEqual(restored.buildOaiRequest(history).messages[1], first.messages[1])
})

test('seventy retained user anchors never evict a live prefix', () => {
  const engine = make(); const history: OaiMessage[] = []
  for (let i = 0; i < 70; i++) {
    history.push({ role: 'user', content: `task ${i}` })
    engine.setCrossSessionMemoryBlock(`appendix ${i}`)
    engine.buildOaiRequest(history)
    assert.equal(engine.consumePrefixDivergence(), null, `prefix changed at user ${i}`)
    history.push({ role: 'assistant', content: `answer ${i}` })
  }
  assert.equal(engine.exportFrozenSnapshot().anchors?.length, 70)
  assert.equal(engine.getCacheEventStats().frozenFallbackRebuilds, 0)
})

test('multimodal persistence retains the complete image and part order', () => {
  assert.deepEqual(JSON.parse(serializeOaiSessionMessage(image)), image)
})

test('corrupt snapshot tuples are rejected before constructing maps', () => {
  assert.equal(parseFrozenSnapshotData({ v: 1, frozenUserMerged: [['x', [3]]], frozenPendingMerged: [], firstUserKey: 'x', collapseWatermark: 0, collapseTokenStep: 0 }), undefined)
})

test('restoring the active execution boundary reuses its frozen anchor (disk + live inherit)', () => {
  const source = make()
  source.setTaskProgress({ current: 'working', completed: ['step-1'], remaining: ['step-2'], decisions: [] })
  const history: OaiMessage[] = [{ role: 'user', content: 'continue the task' }]
  const first = source.buildOaiRequest(history)

  const diskData = parseFrozenSnapshotData(JSON.parse(JSON.stringify(source.exportFrozenSnapshot())))!
  const fromDisk = new PromptEngine(engineConfig(diskData))
  assert.deepEqual(fromDisk.buildOaiRequest(history).messages, first.messages,
    'resume must preserve the current boundary bytes instead of rebuilding the appendix')

  const fromLiveEngine = new PromptEngine(engineConfig(source))
  assert.deepEqual(fromLiveEngine.buildOaiRequest(history).messages, first.messages,
    'same-process inheritance must preserve the same boundary bytes')

  // Tool turns within the restored active boundary also reuse the same bytes.
  assert.deepEqual(fromDisk.buildOaiRequest(history).messages, first.messages)

  // Snapshots written before frozenBaseHash existed must also preserve a
  // same-config active boundary (prefix comparison fallback).
  const legacy = JSON.parse(JSON.stringify(source.exportFrozenSnapshot())) as Record<string, unknown>
  delete legacy['frozenBaseHash']
  const fromLegacy = new PromptEngine(engineConfig(parseFrozenSnapshotData(legacy)!))
  assert.deepEqual(fromLegacy.buildOaiRequest(history).messages, first.messages,
    'legacy snapshot missing frozenBaseHash must still preserve a byte-identical active boundary')
})

test('explicit config change or a genuinely new user message updates the active boundary', () => {
  const source = make()
  source.setCrossSessionMemoryBlock('old-appendix')
  const history: OaiMessage[] = [{ role: 'user', content: 'continue the task' }]
  const first = source.buildOaiRequest(history)
  const restoredData = parseFrozenSnapshotData(JSON.parse(JSON.stringify(source.exportFrozenSnapshot())))!
  const restored = new PromptEngine(engineConfig(restoredData))
  assert.deepEqual(restored.buildOaiRequest(history).messages, first.messages)

  restored.setIntentRetrievalRoute('<intent-retrieval-route advisory="true" scope="current-turn"><task-kinds>bug_fix</task-kinds></intent-retrieval-route>')
  const changed = restored.buildOaiRequest(history)
  assert.notDeepEqual(changed.messages, first.messages,
    'an explicit config change must invalidate the active anchor instead of reusing stale bytes')
  const changedLastUser = changed.messages.filter(m => m.role === 'user').at(-1)
  assert.match(typeof changedLastUser?.content === 'string' ? changedLastUser.content : '', /intent-retrieval-route/)

  const nextUser = restored.buildOaiRequest([
    ...history,
    { role: 'assistant', content: 'ack' },
    { role: 'user', content: 'next task' },
  ])
  const nextLastUser = nextUser.messages.filter(m => m.role === 'user').at(-1)
  assert.match(typeof nextLastUser?.content === 'string' ? nextLastUser.content : '', /next task/,
    'a new user message must rebuild the active boundary')
})

for (const kind of ['live', 'disk'] as const) {
  test(`active domain restored after construction preserves current boundary (${kind})`, () => {
    const source = make()
    const domain = { name: 'tianshu', volatileBlock: 'same domain block', motto: 'same motto' }
    source.setActiveDomain(domain)
    source.setCrossSessionMemoryBlock('original-boundary-appendix')
    const history: OaiMessage[] = [image]
    const before = source.buildOaiRequest(history)
    const inheritFrozenFrom = kind === 'live' ? source : source.exportFrozenSnapshot()
    const restored = new PromptEngine(engineConfig(inheritFrozenFrom))
    // A preview must not consume the deferred comparison before assembly.
    restored.buildOaiRequest([{ role: 'user', content: 'summary' }], undefined, undefined, { sidePath: true })
    restored.setActiveDomain(domain)
    assert.equal(JSON.stringify(restored.buildOaiRequest(history).messages), JSON.stringify(before.messages))
    const changed = new PromptEngine(engineConfig(inheritFrozenFrom))
    changed.setActiveDomain({ ...domain, volatileBlock: 'changed domain' })
    const after = JSON.stringify(changed.buildOaiRequest(history).messages)
    assert.ok(after.includes('changed domain'))
    assert.notEqual(after, JSON.stringify(before.messages))
  })
}

test('snapshot hashes the applied domain, not a pending domain change', () => {
  const source = make()
  const domain = { name: 'tianshu', volatileBlock: 'old domain', motto: 'motto' }
  source.setActiveDomain(domain)
  const history: OaiMessage[] = [{ role: 'user', content: 'continue' }]
  source.setCrossSessionMemoryBlock('keep original appendix')
  const before = source.buildOaiRequest(history)
  source.setActiveDomain({ ...domain, volatileBlock: 'pending domain' })
  const snapshot = source.exportFrozenSnapshot()
  const restored = new PromptEngine(engineConfig(snapshot))
  restored.setActiveDomain(domain)
  assert.deepEqual(restored.buildOaiRequest(history).messages, before.messages)
  const changed = new PromptEngine(engineConfig(snapshot))
  changed.setActiveDomain({ ...domain, volatileBlock: 'pending domain' })
  assert.ok(JSON.stringify(changed.buildOaiRequest(history).messages).includes('pending domain'))
})
