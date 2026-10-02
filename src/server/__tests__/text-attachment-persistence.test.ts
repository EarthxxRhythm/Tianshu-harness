import './disable-cpu-pool.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'

test('text attachments survive disk reopen with readable MIME and original filename, including empty files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'text-attachment-'))
  const createAgent = (): ManagedAgent => ({
    run: async () => {}, abort() {}, listArtifacts: () => [], readArtifact: async () => null,
    getMessages: () => [], replaceMessages() {}, rewindToMessages() {},
  })
  try {
    const persistence = new FileSessionPersistence(dir)
    const manager = new RuntimeSessionManager({ persistence, defaultCwd: dir, createAgent })
    const session = manager.createSession({ cwd: dir })
    const documents = [
      { name: '需求.md', dataUrl: `data:text/plain;base64,${Buffer.from('中文内容').toString('base64')}` },
      { name: 'empty.sh', dataUrl: 'data:text/plain;base64,' },
    ]
    const router = createRouter(buildSessionRoutes(manager, 'attachment-test'))
    const response = await router('POST', `/sessions/${session.id}/prompt`, { prompt: 'read', documents }, { authorization: 'Bearer attachment-test' })
    assert.equal(response.status, 200)
    const refs = manager.getEvents(session.id)!.events.find(event => event.type === 'user')!.data.documents as Array<{ id: string; name: string }>
    assert.equal(refs.length, 2)
    assert.deepEqual(refs.map(ref => ref.name), ['需求.md', 'empty.sh'])
    await persistence.flushAllAsync()
    const reopened = new FileSessionPersistence(dir)
    const restored = new RuntimeSessionManager({ persistence: reopened, defaultCwd: dir, createAgent })
    assert.deepEqual(restored.getEvents(session.id)!.events.find(event => event.type === 'user')!.data.documents, refs)
    for (let i = 0; i < refs.length; i++) {
      const saved = reopened.readDocument(session.id, refs[i]!.id)!
      assert.equal(saved.mime, 'text/plain; charset=utf-8')
      assert.equal(saved.ext, 'txt')
      assert.equal(saved.bytes.toString('utf8'), i === 0 ? '中文内容' : '')
    }
    await manager.shutdownAll()
    await restored.shutdownAll()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
