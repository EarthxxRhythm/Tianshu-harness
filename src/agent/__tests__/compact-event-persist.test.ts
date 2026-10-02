import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { SessionPersist, getSessionDir } from '../session-persist.js'
import type { CompactEvent } from '../../context/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * S3 压缩事件持久化——生产接线回归（2026-10-02 修复判据）。
 *
 * 缺陷：`SessionContext.recordCompactEvent()` 只写内存数组；meta 的
 * `compactEvents` 字段被 `initMetadata` 初始化为空后**从不落盘**（压缩后
 * meta.compactEvents 仍为 []）。会话关闭即失忆，压缩台账无法离线对账。
 *
 * 修复方向：在统一 recordCompactEvent 入口接单一持久化绑定（AgentLoop 装配
 * 时绑到 SessionPersist），按**完整事件身份**幂等，保留既有上限。
 *
 * 本测试钉真实磁盘：recordCompactEvent → `<id>.meta.json` → 重新初始化读回。
 * 修改前：meta.compactEvents 为空 → 用例 1 红。
 */

function idleClient(): StreamClient {
  return {
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    },
  } as unknown as StreamClient
}

function makeAgent(cwd: string, sessionId: string): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd },
  })
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: idleClient(),
    promptEngine: engine,
    toolRegistry: registry,
    sessionId,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, new SessionContext(), cwd)
}

function scenario(): { cwd: string; sessionId: string; agent: AgentLoop; metaPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-compact-persist-'))
  const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    cwd,
    sessionId,
    agent: makeAgent(cwd, sessionId),
    metaPath: join(getSessionDir(cwd), `${sessionId}.meta.json`),
  }
}

function readMeta(path: string): { compactEvents: Array<{ turn: number; tier: number; reason: string; createdAt: number }> } {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('S3 压缩事件持久化：recordCompactEvent → 真实 meta', () => {
  it('记录一次压缩 → meta.compactEvents 落盘（修改前必红）', () => {
    const { agent, metaPath } = scenario()
    agent.session.recordCompactEvent({
      turn: 4, tier: 2, reason: 'auto threshold', beforeTokens: 100_000, afterTokens: 20_000, createdAt: 1_700_000_000_000,
    })

    const meta = readMeta(metaPath)
    assert.equal(meta.compactEvents.length, 1, 'meta.compactEvents 必须收到压缩事件——空数组说明持久化绑定缺失')
    assert.equal(meta.compactEvents[0]!.turn, 4)
    assert.equal(meta.compactEvents[0]!.reason, 'auto threshold')
  })

  it('关闭后重新初始化 → 历史可查询（真实磁盘读回）', () => {
    const { cwd, sessionId, agent } = scenario()
    agent.session.recordCompactEvent({
      turn: 7, tier: 3, reason: 'manual /compact', beforeTokens: 90_000, afterTokens: 9_000, createdAt: 1_700_000_001_000,
    })

    const reopened = new SessionPersist(sessionId, cwd).loadMetadata()
    assert.equal(reopened?.compactEvents.length, 1, '新进程/新实例读回 meta 必须能查询历史压缩事件')
    assert.equal(reopened?.compactEvents[0]!.tier, 3)
  })

  it('同一事件重复投递 → 幂等（不追加）', () => {
    const { agent, metaPath } = scenario()
    const event: CompactEvent = { turn: 2, tier: 1, reason: 'micro', beforeTokens: 10, afterTokens: 5, createdAt: 1_700_000_002_000 }
    agent.session.recordCompactEvent(event)
    agent.session.recordCompactEvent({ ...event })

    assert.equal(readMeta(metaPath).compactEvents.length, 1, '同一事件身份必须幂等')
  })

  it('同一轮的不同压缩事件 → 均保留（不得按 turn+tier 合并）', () => {
    const { agent, metaPath } = scenario()
    agent.session.recordCompactEvent({ turn: 5, tier: 2, reason: 'auto', beforeTokens: 100, afterTokens: 40, createdAt: 1_700_000_003_000 })
    agent.session.recordCompactEvent({ turn: 5, tier: 2, reason: 'auto', beforeTokens: 120, afterTokens: 30, createdAt: 1_700_000_003_500 })

    const events = readMeta(metaPath).compactEvents
    assert.equal(events.length, 2, '合法多次压缩不得被 turn+tier 合并成一条')
  })

  it('内存账本与 meta 一致（同一事件身份，同序）', () => {
    const { agent, metaPath } = scenario()
    agent.session.recordCompactEvent({ turn: 1, tier: 1, reason: 'a', beforeTokens: 10, afterTokens: 5, createdAt: 1 })
    agent.session.recordCompactEvent({ turn: 3, tier: 2, reason: 'b', beforeTokens: 20, afterTokens: 6, createdAt: 2 })

    const memory = agent.session.getCompactEvents().map(e => e.createdAt)
    const disk = readMeta(metaPath).compactEvents.map(e => e.createdAt)
    assert.deepEqual(disk, memory, '磁盘台账必须与内存账本同序同内容')
  })
})
