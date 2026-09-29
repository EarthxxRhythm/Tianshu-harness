import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import { attachSessionPersistListener } from '../session-persist-listener.js'
import type { SessionPersist } from '../session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'

for (const situation of ['success', 'late-hook', 'post-rename-failure']) {
  test(`compaction shares the persistence queue: ${situation}`, async () => {
    const session = new SessionContext()
    session.addUserMessage('original')
    const source = session.getMessages().slice()
    const candidate: OaiMessage[] = [{ role: 'user', content: 'summary' }]
    let disk = source.slice(), writes = 0
    const persist = {
      flushSessionBuffer: async () => {},
      compactOaiAsync: async (messages: OaiMessage[], durable?: boolean) => {
        assert.equal(durable, true)
        writes++; disk = messages.slice()
        if (writes === 1 && situation === 'late-hook') session.appendSystemReminder('late', 'functional')
        if (writes === 1 && situation === 'post-rename-failure') throw new Error('directory sync failed')
      },
    } as unknown as SessionPersist
    const listener = attachSessionPersistListener({ session, persist })
    if (situation === 'success') {
      await listener.commitCompaction(source, candidate)
      await listener.drain()
      assert.deepEqual(disk, candidate)
      assert.deepEqual(session.getMessages(), candidate)
      assert.equal(writes, 1, 'already-persisted replacement must not enqueue another rewrite')
    } else {
      await assert.rejects(listener.commitCompaction(source, candidate))
      await listener.drain()
      assert.deepEqual(disk, session.getMessages())
      assert.ok(JSON.stringify(disk).includes('original'))
      assert.equal(JSON.stringify(disk).includes('late'), situation === 'late-hook')
      assert.ok(writes >= 2)
    }
  })
}
