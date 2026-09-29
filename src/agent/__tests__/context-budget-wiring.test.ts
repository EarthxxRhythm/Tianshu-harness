import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('budget reaches the real request builder, transport callbacks and desktop wrapper', () => {
  assert.match(source('../request-context-controller.ts'), /preview: request => .*previewContextRequest/ )
  assert.match(source('../turn-step-producer.ts'), /await this\.self\.prepareBudgetedRequest\(/)
  assert.match(source('../loop-factory.ts'), /recordContextBudget: budget => self\.recordContextBudget\(budget\)/)
  assert.match(source('../loop-factory.ts'), /preserveUserOnError: \(\) => !!self\.config\.promptEngine\.getRequestBudgetPolicy\(\)/)
  assert.match(source('../turn-orchestrator.ts'), /onContextBudget: callbacks\.onContextBudget/)
  assert.match(source('../../server/serve-agent.ts'), /getContextBudget: \(\) => agent\.getContextBudget\(\)/)
  assert.match(source('../../server/session-manager.ts'), /this\.append\(session, 'context_budget'/)
  assert.match(source('../create-agent-config.ts'), /requestBudgetPolicy: primaryClient\.previewContextRequest \? deepSeekBudgetPolicy\(provider\.baseUrl, model\.id, model\.contextWindow\)/)
  assert.match(source('../../api/factory.ts'), /contextWindow: provider\.models\?\.find\(m => m\.id === params\.model\)\?\.contextWindow/)
})

test('manual and isolated entry points use the same budget contract', () => {
  assert.match(source('../../server/serve-agent.ts'), /compactContext: \(\) => agent\.compactContext\(\)/)
  assert.match(source('../../pro/runtime/protocol.ts'), /'getContextBudget'/)
  assert.match(source('../../pro/runtime/protocol.ts'), /'compactContext'/)
  assert.match(source('../../pro/runtime/backend.ts'), /method === 'switchModel' \|\| method === 'compactContext'/)
  assert.match(source('../../pro/runtime/engine.ts'), /'rewindToMessages', 'compactContext'\]\.includes\(method\)/)
  assert.match(source('../../tui/slash-commands.ts'), /ctx\.agent\.compactContext\(\)/)
  assert.match(source('../../../desktop/src/surfaces/ThreadView.tsx'), /await compactSession\(session\.id\)/)
  assert.doesNotMatch(source('../../../desktop/src/surfaces/ThreadView.tsx'), /onSend\('Context is getting long/)
})
