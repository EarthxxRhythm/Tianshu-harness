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
import type { AgentCallbacks } from '../loop-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * S1 效率时间尺度——生产接线回归（2026-10-02 修复判据）。
 *
 * 缺陷：loop.ts 把 `session.getTotalUsage().output_tokens`（**会话累计**输出）
 * 送进 detector 的 tokenEfficiency，而分母是**近期工具窗口**条数。
 * 两者时间尺度不同 → 长会话里 tokenEfficiency 被历史累计成本压成恒 0。
 *
 * 本测试钉的是真实装配链：AgentLoop 的 usage 账本 + recordToolHistory 记录点
 * → runConvergenceCheck → detector signals.tokenEfficiency。
 * 直接喂 ConvergenceInput 字面量（convergence-detector.test.ts 的 baseInput
 * 模式）抓不住这条接线——判据必须走 AgentLoop 的观测窗口。
 *
 * 修改前（累计口径）：同一近期工具/输出序列，从高累计 usage 起步的会话
 *   efficiency ≈ 0（exp(-20000/500)），从零起步的 ≈ 1 → 用例 1 红。
 * 修改后（窗口增量口径）：窗口内增量相同 → 两会话效率相同 → 用例 1 绿。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-eff-window-'))

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

/**
 * 生产形态的窗口构造：先按 base 抬高会话累计输出（模拟长历史/恢复回种），
 * 再逐次「本轮输出 → 工具调用」配对，写满 5 条窗口（= 共享历史容量）。
 */
function fillToolWindow(agent: AgentLoop, base: number, perTurnOutputs: number[]): void {
  if (base > 0) agent.session.addUsage({ output_tokens: base })
  for (const out of perTurnOutputs) {
    agent.session.addUsage({ output_tokens: out })
    recordToolHistory(agent, 'read_file', { path: 'src/a.ts' }, false, 'file body')
  }
}

async function tokenEfficiency(agent: AgentLoop): Promise<number> {
  // runConvergenceCheck 只经 optional 链读回调（onPhaseChange?/onDecisionShift?），
  // 本用例只关心 detector 的 signals，故传空的回调壳——显式 cast 表明"故意不提供"，
  // 而不是漏字段。
  await agent.runConvergenceCheck(6, 'explore', true, false, {} as unknown as AgentCallbacks)
  const result = agent.latestConvergenceResult
  assert.ok(result, 'runConvergenceCheck 必须装配 latestConvergenceResult')
  return result.signals.tokenEfficiency
}

describe('S1 效率时间尺度：tokenEfficiency 只吃近期窗口增量', () => {
  it('相同近期工具+输出序列：累计 usage 高低不影响效率（修改前必红）', async () => {
    const low = makeAgent()
    const high = makeAgent()
    const window = [200, 200, 200, 200, 200]

    fillToolWindow(low, 0, window)
    fillToolWindow(high, 400_000, window)

    const lowEff = await tokenEfficiency(low)
    const highEff = await tokenEfficiency(high)

    assert.ok(
      Math.abs(lowEff - highEff) < 1e-9,
      `累计 usage 不是效率信号：低累计=${lowEff} 高累计=${highEff}（差异 = 旧接线把会话累计当窗口增量）`,
    )
  })

  it('近期输出增加 → 效率严格下降（增量确实进信号）', async () => {
    const lean = makeAgent()
    const heavy = makeAgent()
    fillToolWindow(lean, 0, [100, 100, 100, 100, 100])
    fillToolWindow(heavy, 0, [100, 100, 100, 100, 4000])

    const leanEff = await tokenEfficiency(lean)
    const heavyEff = await tokenEfficiency(heavy)

    assert.ok(
      heavyEff < leanEff,
      `窗口内输出膨胀必须压低效率：lean=${leanEff} heavy=${heavyEff}`,
    )
  })

  it('无工具窗口 → 回落分类启发式（缺数据不冒充证据）', async () => {
    const agent = makeAgent()
    agent.session.addUsage({ output_tokens: 50_000 })

    const eff = await tokenEfficiency(agent)
    assert.ok(eff >= 0 && eff <= 1, `无窗口样本时效率仍在 [0,1]：${eff}`)
    assert.ok(eff >= 0.5, `无窗口样本不该被会话累计压成停滞信号：${eff}`)
  })

  it('同轮批量工具（非首个观测轮）：本轮输出必须计入窗口增量', async () => {
    const batch = makeAgent()
    // 第 1 轮：建立观测锚点（1 个工具，100 输出）
    batch.session.addUsage({ output_tokens: 100 })
    recordToolHistory(batch, 'read_file', { path: 'src/first.ts' }, false, 'file body')
    // 第 2 轮：一次 API 响应产出 5000 输出，随后同一轮并行发出 5 次只读工具。
    // 同轮 5 个记录点读到同一个累计值——锚点必须留在"本轮之前"，否则
    // 窗口最旧样本 = 当前累计 → 增量 0 → tokensPerTool=0 → 效率恒 1.0（漏计）。
    batch.session.addUsage({ output_tokens: 5000 })
    for (let i = 0; i < 5; i++) {
      recordToolHistory(batch, 'read_file', { path: `src/f${i}.ts` }, false, 'file body')
    }

    const eff = await tokenEfficiency(batch)
    assert.ok(
      eff < 0.5,
      `同轮批量工具的 5000 输出必须进窗口增量（期望 ≈exp(-1)=0.37）：实得 ${eff}——恒 1.0 说明本轮被整段漏计`,
    )
  })

  it('跨轮窗口：增量覆盖窗口内除锚点轮外的全部轮次（单调、不塌成 0）', async () => {
    const agent = makeAgent()
    // 每轮 1000 输出 + 1 个工具，共 5 轮。进程内首个观测轮没有更早锚点，
    // 其自身输出不计入（少算一轮，方向安全），故增量 = 后 4 轮 = 4000。
    fillToolWindow(agent, 0, [1000, 1000, 1000, 1000, 1000])
    await agent.runConvergenceCheck(6, 'explore', true, false, {} as unknown as AgentCallbacks)

    const eff = agent.latestConvergenceResult!.signals.tokenEfficiency
    const expected = Math.exp(-(4000 / 5) / 500) // ≈ 0.2019
    assert.ok(
      Math.abs(eff - expected) < 0.02,
      `5 轮×1000 输出的窗口增量应≈4000（锚点轮除外，期望效率≈${expected.toFixed(4)}），实得 ${eff.toFixed(4)}`,
    )
  })
})
