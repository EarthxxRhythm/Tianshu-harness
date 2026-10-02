import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEventsTailRaw } from '../events-tail.js'
import { parseEventsTailRaw, type RawSessionEvent } from '../cpu-tasks.js'

async function compareTail(events: RawSessionEvent[], capacities: number[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-stream-tail-'))
  try {
    const file = join(dir, 'events.jsonl')
    const text = '\ufeffbad\n' + events.map(e => JSON.stringify(e)).join('\r\n') + '\n{"type":"marker"}\n{"seq":'
    writeFileSync(file, text)
    for (const capacity of capacities) {
      assert.deepEqual(await readEventsTailRaw(file, capacity), parseEventsTailRaw(text, capacity))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('stream tail matches existing sort/trim for unordered seqs, ties, artifacts and delegation', async () => {
  const events: RawSessionEvent[] = []
  for (let i = 0; i < 120; i++) {
    const type = i % 7 === 0 ? 'delegation' : i % 9 === 0 ? 'artifact' : 'text_delta'
    events.push({ seq: (i * 37) % 113, ts: i, type, data: { id: 'art-' + (i % 3), text: '行🌌' + i } })
  }
  await compareTail(events, [0, 1, 10, 17, 18, 50, 120, 5000])
})

test('stream tail preserves UTF-8 split across chunks, long lines and a valid unterminated final line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-stream-tail-'))
  try {
    const file = join(dir, 'events.jsonl')
    const events: RawSessionEvent[] = [
      { seq: 1, ts: 1, type: 'artifact', data: { id: '早期🌌' } },
      { seq: 2, ts: 2, type: 'text_delta', data: { text: '🌌汉字'.repeat(20000) } },
      { seq: 3, ts: 3, type: 'delegation', data: { text: '结束🌌' } },
    ]
    const text = '\ufeff' + events.map(e => JSON.stringify(e)).join('\n')
    writeFileSync(file, text)
    assert.deepEqual(await readEventsTailRaw(file, 2), parseEventsTailRaw(text, 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stream tail returns zero metadata for missing, empty and wholly corrupt files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-stream-tail-'))
  try {
    const empty = { events: [], diskFirstSeq: 0, lastSeq: 0, artifactIds: [], total: 0 }
    const file = join(dir, 'events.jsonl')
    assert.deepEqual(await readEventsTailRaw(file, 5), empty)
    for (const text of ['', 'garbage\n{"type":"marker"}\n{"seq":']) {
      writeFileSync(file, text)
      assert.deepEqual(await readEventsTailRaw(file, 5), empty)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
