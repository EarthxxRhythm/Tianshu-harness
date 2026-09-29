import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextBudget, deepSeekBudgetPolicy, DEEPSEEK_WINDOW, estimateBudgetInput } from '../request-budget.js'
import { estimateOaiMessageTokens } from '../../compact/micro.js'

test('multimodal CJK uses the same text accounting as plain text', () => {
  const text = '中'.repeat(120_000)
  const plain = estimateOaiMessageTokens({ role: 'user', content: text })
  assert.equal(estimateOaiMessageTokens({ role: 'user', content: [{ type: 'text', text }] }), plain)
  assert.ok(estimateOaiMessageTokens({ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'https://example.invalid/image.jpg' } }] }) > plain)
})

test('60 percent of the full window is already over the reserved input budget', () => {
  const policy = deepSeekBudgetPolicy('https://api.deepseek.com/v1', 'deepseek-flash')!
  const budget = buildContextBudget({ model: 'deepseek-flash', max_tokens: 384_000, messages: [{ role: 'user', content: 'x'.repeat(Math.ceil(DEEPSEEK_WINDOW * 0.6) * 4) }] }, policy, { requestId: 'test', revision: 1 })
  assert.equal(budget.inputBudget, 612_147)
  assert.equal(budget.state, 'blocked')
  assert.equal(budget.outputReserve, 384_000)
})

test('unknown relays do not inherit official budgets and smaller configured windows survive', () => {
  assert.equal(deepSeekBudgetPolicy('https://relay.example/v1', 'deepseek-flash'), undefined)
  assert.equal(deepSeekBudgetPolicy('https://api.deepseek.com', 'unknown-model'), undefined)
  assert.equal(deepSeekBudgetPolicy('https://api.deepseek.com', 'deepseek-flash', 500_000)?.windowTokens, 500_000)
})

test('wire accounting includes tools, reasoning and native image budget exactly once', () => {
  const counts = estimateBudgetInput([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'a'.repeat(10_000) } }] },
    { role: 'assistant', content: 'done', reasoning_content: 'r'.repeat(4000) },
  ], [{ description: 't'.repeat(4000) }])
  assert.equal(counts.imageTokens, 1024)
  assert.equal(counts.reasoningTokens, 1000)
  assert.ok(counts.toolTokens >= 1000)
  assert.equal(counts.inputTokens, 1024 + 1001 + 16 + counts.toolTokens)
})

test('native image count and per-image bytes fail visibly without discarding input', async () => {
  const { deepSeekImageLimitError } = await import('../image-input-limits.js')
  const image = { type: 'image_url' as const, image_url: { url: 'https://example.com/picture.png' } }
  assert.equal(deepSeekImageLimitError([{ role: 'user', content: Array(600).fill(image) }]), undefined)
  assert.equal(deepSeekImageLimitError([{ role: 'user', content: Array(601).fill(image) }])?.name, 'ImageInputRejectedError')
  const huge = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(32 * 1024 * 1024 / 3) * 4 + 4) } }
  assert.equal(deepSeekImageLimitError([{ role: 'user', content: [huge] }])?.name, 'ImageInputRejectedError')
})
