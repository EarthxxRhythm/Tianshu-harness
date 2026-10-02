import './disable-cpu-pool.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSessionPersistence } from '../session-persistence.js'
import { auditEventsSummary } from '../../workers/events-summary.js'
import { parseEventsTailRaw } from '../../workers/cpu-tasks.js'
import type { SessionEvent } from '../session-manager.js'

test('the real persistence consumer extends after sync/async flush and survives actual trim and torn/duplicate appends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-summary-persistence-'))
  const file = join(dir, 's1', 'events.jsonl')
  const event = (seq: number): SessionEvent => ({ seq, ts: seq, type: 'text_delta', data: { text: 'x'.repeat(600) } })
  const p = new FileSessionPersistence(dir)
  try {
    mkdirSync(join(dir, 's1'))
    writeFileSync(file, Array.from({ length: 900 }, (_, i) => JSON.stringify(event(i + 1))).join('\n') + '\n')
    const assertTail = async (): Promise<void> => {
      const tail = await p.loadEventsTailAsync('s1', 8)
      assert.deepEqual(tail, parseEventsTailRaw(readFileSync(file, 'utf8'), 8))
      assert.ok((await auditEventsSummary(file)).valid)
    }
    await assertTail()
    p.appendEvent('s1', event(901)); p.flushSync()
    await assertTail()
    p.appendEvent('s1', event(902)); await p.flushSessionAsync('s1')
    await assertTail()
    // A partial append and a retried whole batch: index counts actual disk lines.
    appendFileSync(file, '{"seq":903')
    p.appendEvent('s1', event(903)); p.appendEvent('s1', event(903)); await p.flushSessionAsync('s1')
    await assertTail()
    const trimming = new FileSessionPersistence(dir, { maxEventsDiskBytes: 50 * 1024 })
    trimming.trimEventsFileIfNeeded('s1')
    assert.match(readFileSync(file, 'utf8'), /events_trimmed/)
    await assertTail()
  } finally { p.flushSync(); rmSync(dir, { recursive: true, force: true }) }
})

test('a failed summary publication never retries or loses successfully appended events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-summary-write-failure-'))
  const file = join(dir, 's1', 'events.jsonl')
  const p = new FileSessionPersistence(dir)
  try {
    mkdirSync(join(dir, 's1'))
    writeFileSync(join(dir, 's1', 'events.summary-blocks'), 'not a directory')
    for (let seq = 1; seq <= 600; seq++) p.appendEvent('s1', { seq, ts: seq, type: 'text_delta', data: { text: 'x' } })
    await p.flushSessionAsync('s1')
    const tail = await p.loadEventsTailAsync('s1', 8)
    assert.equal(tail.total, 600)
    assert.deepEqual(tail.events.map(e => e.seq), [593, 594, 595, 596, 597, 598, 599, 600])
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 600)
    assert.equal(await p.flushThrough('s1', 600), 600)
  } finally { p.flushSync(); rmSync(dir, { recursive: true, force: true }) }
})
