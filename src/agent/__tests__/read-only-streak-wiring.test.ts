import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { recordToolHistory } from '../tool-history-recorder.js'
import { buildRuntimeSnapshot } from '../loop-factory.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * S2 CCR 可达性——生产接线回归（2026-10-02 修复判据）。
 *
 * 缺陷：CCR 的 P6（排查停滞）要求 readOnlyStreak ≥ 6（build）/ 10（diagnostic），
 * 而 streak 由 `computeReadOnlyStreak(ctx.snapshot.recentToolHistory)` 从**容量
 * 5 条**的共享历史算出 → streak 上限 5 → P6 在真实生产容量下永不可达。
 *
 * 修复方向（不扩大共享 history 容量）：由工具记录点维护**独立累计**的连续只读
 * 计数，经 buildRuntimeSnapshot 传给 CCR 的真正消费者。
 *
 * 本测试钉的就是这条装配链：recordToolHistory（唯一记录点）→ AgentLoop 计数
 * → buildRuntimeSnapshot.readOnlyStreak。
 *
 * 修改前：snapshot.readOnlyStreak === undefined（字段不存在）→ 用例 1 红。
 * 修改后：累计计数越过 5 条窗口仍然增长 → 用例 1 绿。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-ro-streak-'))

function idleClient(): StreamClient {
  return {
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    },
  } as unknown as StreamClient
}

function makeAgent(): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: idleClient(),
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

function readOnlyCall(agent: AgentLoop, i: number): void {
  recordToolHistory(agent, 'read_file', { path: `src/f${i}.ts` }, false, 'body')
}

function streak(agent: AgentLoop): number | undefined {
  return buildRuntimeSnapshot(agent).readOnlyStreak
}

describe('S2 CCR 可达性：连续只读计数不受 5 条共享历史窗口限制', () => {
  it('10 次连续只读 → snapshot 计数 10（越过窗口容量，P6 阈值可达）', () => {
    const agent = makeAgent()
    for (let i = 0; i < 10; i++) readOnlyCall(agent, i)

    assert.equal(agent.recentToolHistory.length, 5, '共享历史容量必须保持 5 条不被扩大')
    assert.equal(
      streak(agent),
      10,
      'readOnlyStreak 必须是独立累计计数——仍取 5 条窗口最大值说明 P6 在生产容量下不可达',
    )
  })

  it('产出类工具打断连续只读 → 归零', () => {
    const agent = makeAgent()
    for (let i = 0; i < 7; i++) readOnlyCall(agent, i)
    assert.equal(streak(agent), 7)

    recordToolHistory(agent, 'edit_file', { path: 'src/a.ts' }, false, 'ok')
    assert.equal(streak(agent), 0, '产出工具必须打断只读流水')

    readOnlyCall(agent, 99)
    assert.equal(streak(agent), 1)
  })

  it('只读 bash 计入流水，产出 bash 打断（与 classifyActivityMode 同源判据）', () => {
    const agent = makeAgent()
    recordToolHistory(agent, 'bash', { command: 'grep -rn foo src' }, false, 'hit')
    assert.equal(streak(agent), 1, '只读 bash（bashActivity=readonly）算只读取证')

    recordToolHistory(agent, 'bash', { command: 'npm run typecheck' }, false, 'ok')
    assert.equal(streak(agent), 0, '产出类 bash 必须打断只读流水')
  })

  it('新用户任务边界 → 计数重置（用户干预不是旧流水的延续）', () => {
    const agent = makeAgent()
    for (let i = 0; i < 9; i++) readOnlyCall(agent, i)
    assert.equal(streak(agent), 9)

    // 生产入口：turn-step-producer 的 user 消息边界
    agent.resetReadOnlyStreak()
    assert.equal(streak(agent), 0, '用户新任务/干预后不得沿用上一段的只读流水')
  })
})
