import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RequestContextController } from '../request-context-controller.js'
import { buildContextBudget } from '../../context/request-budget.js'
import type { AgentLoop } from '../loop.js'
import type { OaiMessage } from '../../api/oai-types.js'

const budget = buildContextBudget({ model: 'deepseek-flash', messages: [], max_tokens: 256_000 },
  { windowTokens: 1_000_000, maxOutputTokens: 393_216 }, { requestId: 'r', revision: 1 })

test('a failed small reclaim does not resummarize on every tool round', async () => {
  let calls = 0
  const messages: OaiMessage[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'x'.repeat(1_800_000) },
    { role: 'user', content: 'active' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: '<system-reminder>note</system-reminder>' }, { role: 'assistant', content: 'answer' }]
  const fake = {
    persist: {}, artifactStore: {}, config: { client: { stream: async () => { calls++ } }, promptEngine: { getModel: () => 'deepseek-flash' } },
    session: { getMessages: () => messages }, drainPersistWrites: async () => {}, recordSidePathUsage: () => {},
  } as unknown as AgentLoop
  const controller = new RequestContextController(fake)
  controller.record({ ...budget, inputTokens: 600_000 })
  assert.equal(await controller.compact(), false)
  controller.record({ ...budget, inputTokens: 600_010 })
  assert.equal(await controller.compact(), false)
  assert.equal(calls, 1)
  await controller.compact(true)
  assert.equal(calls, 2, 'explicit server rejection can override the cooldown once')
})

test('late measured observations cannot replace a newer request budget', () => {
  const controller = new RequestContextController({} as AgentLoop)
  controller.record({ ...budget, requestId: 'new' })
  assert.equal(controller.record({ ...budget, requestId: 'old', source: 'measured', inputTokens: 900_000 }).requestId, 'new')
  assert.equal(controller.record({ ...budget, requestId: 'old', source: 'estimate', inputTokens: 900_000 }).requestId, 'new')
  assert.equal(controller.record({ ...budget, requestId: 'next' }, true).requestId, 'next')
})

test('headless/TUI preparation records the budget even without a UI callback', async () => {
  const controller = new RequestContextController({ config: { promptEngine: { getRequestBudgetPolicy: () => ({ windowTokens: 1_000_000, maxOutputTokens: 393_216 }) } } } as unknown as AgentLoop)
  await controller.prepare(() => ({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }], max_tokens: 256_000 }), {} as any)
  assert.equal(controller.snapshot?.inputBudget, 694_000)
  assert.equal(controller.snapshot?.state, 'ready')
  const previousId = controller.snapshot?.requestId
  await controller.prepare(() => ({ model: 'deepseek-flash', messages: [], max_tokens: 384_000 }), {} as any)
  assert.notEqual(controller.snapshot?.requestId, previousId)
  assert.equal(controller.snapshot?.inputBudget, 566_000)
})
