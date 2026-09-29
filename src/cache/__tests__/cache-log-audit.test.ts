import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditCacheLog, summarizeAuditRows } from '../cache-log-audit.js'
const row = (t: number, cacheRead: number) => ({ t, model: 'step-5-preview', provider: 'stepfun', turn: 1, input: 100, output: 5, cacheRead })
test('legacy pairing tolerates millisecond jitter without exact timestamp grouping', () => {
  const a = auditCacheLog([row(100, 0), row(178, 90)].map(x => JSON.stringify(x)).join('\n'))
  assert.equal(a.entries.length, 1); assert.deepEqual(a.entries[0]!.lines, [1, 2])
  assert.equal(summarizeAuditRows(a.raw).hitRate, .45)
  assert.equal(summarizeAuditRows(a.entries.map(x => x.row)).hitRate, .9)
})
test('ambiguous clusters and separate later requests are not merged', () => {
  assert.equal(auditCacheLog([row(100, 0), row(101, 0), row(102, 90)].map(x => JSON.stringify(x)).join('\n')).entries.length, 3)
  assert.equal(auditCacheLog([row(100, 0), row(201, 90)].map(x => JSON.stringify(x)).join('\n')).entries.length, 2)
})
test('new identity joins repeated observations despite distant timestamps', () => {
  const rows = [row(100, 0), row(1000, 90)].map(r => ({ ...r, requestId: 'r', attemptId: 'r:1' }))
  assert.equal(auditCacheLog(rows.map(x => JSON.stringify(x)).join('\n')).entries[0]!.confidence, 'identity')
})
test('overlapping 100ms candidate pairs are ambiguous, not greedily merged', () => {
  assert.equal(auditCacheLog([row(100, 0), row(180, 90), row(260, 0)].map(x => JSON.stringify(x)).join('\n')).entries.length, 3)
})
