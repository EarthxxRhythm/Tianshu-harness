import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'

function setup(compact: () => Promise<boolean>) {
  const agent = { run: async () => { assert.fail('compaction must not start a model task') }, abort: () => {},
    compactContext: compact, getMessages: () => [], listArtifacts: () => [], replaceMessages: () => {}, rewindToMessages: () => {},
    getContextBudget: () => ({ requestId: 'manual', revision: 1, sampledAt: 123, model: 'deepseek-flash', windowTokens: 1_000_000,
      inputBudget: 694_000, inputTokens: 1000, outputReserve: 256_000, safetyMargin: 50_000,
      imageTokens: 0, reasoningTokens: 0, toolTokens: 0, source: 'estimate', state: 'ready' }),
  } as unknown as ManagedAgent
  const manager = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: '/tmp' })
  const session = manager.createSession({ title: 'context-test' })
  const router = createRouter(buildSessionRoutes(manager, 'test-auth'))
  const request = () => router('POST', `/sessions/${session.id}/compact`, {}, { authorization: 'Bearer test-auth' })
  return { manager, session, router, request }
}

test('manual compaction is authenticated, exclusive, and produces no user message or run', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { manager, session, router, request } = setup(async () => { await gate; return true })
  assert.equal((await router('POST', `/sessions/${session.id}/compact`, {}, {})).status, 401)
  const operation = request()
  assert.equal((await request()).status, 409)
  assert.equal(manager.run(session.id, 'must not start'), false)
  release()
  assert.deepEqual((await operation).body, { changed: true })
  const events = manager.getEvents(session.id, 0)!.events
  assert.equal(events.some(e => e.type === 'user'), false)
  assert.equal(events.some(e => e.type === 'context_budget'), true)
  assert.equal(manager.getSession(session.id)?.contextBudget?.inputTokens, 1000)
  await manager.shutdownAll()
})

test('manual storage failure releases the command slot and does not claim success', async () => {
  let calls = 0
  const { manager, session, request } = setup(async () => { calls++; throw new Error('disk full') })
  assert.equal((await request()).status, 500)
  assert.equal((await request()).status, 500)
  assert.equal(calls, 2)
  assert.equal(manager.getEvents(session.id, 0)!.events.some(e => e.type === 'user'), false)
  await manager.shutdownAll()
})
