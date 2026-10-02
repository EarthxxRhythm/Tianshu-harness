import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeSessionManager, type ManagedAgent, type SessionEvent, type SessionRecord } from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * 冷启动归一对照的服务端一半：夹具的 expected 必须就是服务端对这份磁盘数据冷启动后的真实结果。
 * 桌面端的本地快照与占位层照抄了这套规则，它那一半用同一份夹具比对——规则两边各写一份，
 * 靠这对用例发现漂移。
 */
interface Fixture {
  now: number
  sessions: Array<{ dir: string; index?: string; events?: string[] }>
  expected: {
    list: Array<Record<string, unknown>>
    coldStartEvents: Record<string, SessionEvent[]>
  }
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/cold-start-normalization.json', import.meta.url)), 'utf8'),
) as Fixture

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** 线上与落盘都是 JSON：比对前走一遍，去掉值为 undefined 的键。 */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 列表里参与对照的字段。lastSeq / updatedAt 不比：崩溃会话的重启标记会推进它们。 */
function listFields(r: SessionRecord): Record<string, unknown> {
  const { id, status, pendingApprovals, title, model, domain, resolvedDomain, domainGlyph, domainAccent } = r
  return wire({ id, status, pendingApprovals, title, model, domain, resolvedDomain, domainGlyph, domainAccent })
}

function diskEvents(dir: string): SessionEvent[] {
  return (fixture.sessions.find((s) => s.dir === dir)?.events ?? []).map((line) => JSON.parse(line) as SessionEvent)
}

function coldStart(): { manager: RuntimeSessionManager; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'rivet-cold-start-'))
  for (const s of fixture.sessions) {
    const d = join(root, s.dir)
    mkdirSync(d, { recursive: true })
    if (s.index !== undefined) writeFileSync(join(d, 'index.json'), s.index)
    if (s.events) writeFileSync(join(d, 'events.jsonl'), s.events.map((line) => `${line}\n`).join(''))
  }
  const persistence = new FileSessionPersistence(root)
  const manager = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence,
    now: () => fixture.now,
    externalScanMs: 0,
    idleAgentTtlMs: 0,
  })
  return {
    manager,
    done: () => {
      persistence.flushSync()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('冷启动后的会话列表（参与对照的字段）与夹具 expected.list 一致', () => {
  const { manager, done } = coldStart()
  try {
    const list = manager.listSessions().map(listFields).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    assert.deepEqual(list, fixture.expected.list)
  } finally {
    done()
  }
})

test('首开时补发的冷启动事件（重启标记、委派终态）与夹具一致；磁盘历史原样、后台任务注册表为空', () => {
  const { manager, done } = coldStart()
  try {
    for (const record of manager.listSessions()) {
      const disk = diskEvents(record.id)
      const diskMax = disk.reduce((max, e) => Math.max(max, e.seq), 0)
      const events = wire(manager.getEvents(record.id, 0)?.events ?? [])
      assert.deepEqual(events.filter((e) => e.seq <= diskMax), disk, `${record.id}：冷启动不改写磁盘历史`)
      assert.deepEqual(events.filter((e) => e.seq > diskMax), fixture.expected.coldStartEvents[record.id] ?? [], `${record.id}：冷启动补发的事件`)
      assert.deepEqual(manager.listJobs(record.id), [], `${record.id}：建连快照会发空的后台任务集`)
    }
  } finally {
    done()
  }
})
