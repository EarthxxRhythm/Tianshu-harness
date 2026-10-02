/**
 * user 事件回写发送时的 requestId——桌面端据此把乐观回显精确对上这条消息，
 * 不再靠「新到几条 user 块」计数（别的窗口、手机端、排队归并发出的消息都会被数进去）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { RunLedger } from '../run-ledger.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks) { return new Promise<void>(() => {}) }
  abort() {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

async function withManager(fn: (ctx: { manager: RuntimeSessionManager; router: ReturnType<typeof createRouter> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rivet-user-request-id-'))
  try {
    const manager = new RuntimeSessionManager({
      createAgent: () => new FakeAgent(),
      defaultCwd: '/tmp/work',
      runLedger: new RunLedger(root),
    })
    await fn({ manager, router: createRouter(buildSessionRoutes(manager, TOKEN)) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('带 requestId 的 /prompt：user 事件回写同一个 requestId', async () => {
  await withManager(async ({ manager, router }) => {
    const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
    const res = await router('POST', `/sessions/${rec.id}/prompt`, { prompt: 'hi', requestId: 'req-echo-1' }, AUTH)
    assert.equal(res.status, 200)
    const users = manager.getEvents(rec.id, 0)!.events.filter((e) => e.type === 'user')
    assert.equal(users.length, 1)
    assert.equal(users[0]!.data.requestId, 'req-echo-1')
  })
})

test('不带 requestId 的 /prompt：user 事件没有这个字段（桌面端据此回落按 seq 计数）', async () => {
  await withManager(async ({ manager, router }) => {
    const rec = manager.createSession({ cwd: '/tmp/work' }) as { id: string }
    const res = await router('POST', `/sessions/${rec.id}/prompt`, { prompt: 'plain' }, AUTH)
    assert.equal(res.status, 200)
    const user = manager.getEvents(rec.id, 0)!.events.find((e) => e.type === 'user')!
    assert.ok(!('requestId' in user.data), JSON.stringify(user.data))
  })
})
