/**
 * analyze-compact-events — reclaim_decision 聚合回归（2026-10-02）。
 *
 * 背景：`reclaim_decision` 事件（loop-factory.ts:124 recorder）已落盘 committed
 * 与 rejected 两类候选，但**无任何自动消费方**——相邻的成功压缩归因器
 * （本脚本）只读 historyRewritten / compactPreRatio，`self-audit-report.ts` 只把
 * 事件行计数，`PressureMonitor` 只看 compactionTurns。于是「反复压缩」的另一半
 * ——想改写但被 reclaim gate 拒的候选——落盘后即沉默。
 *
 * 本补观测把 reclaim_decision 拉进同一归因器：区分 no-op 拒绝（unchanged，
 * 代码已清 pending 不 spin）与改写级拒绝（below-reclaim-floor / no-reclaim，
 * 即真正的抖动候选），暴露 forced 占比（历史遗留的未核查行动项），并支持
 * 真实数据的 slug/sessionId 两层布局发现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function reclaimRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    event: 'reclaim_decision',
    t: 1,
    turn: 1,
    action: 'micro',
    commit: false,
    reason: 'unchanged',
    force: false,
    windowBand: 'small',
    billing: 'per-token',
    cache: 'exact-prefix',
    beforeTokens: 100_000,
    afterTokens: 100_000,
    reclaimedTokens: 0,
    reclaimRatio: 0,
    ...over,
  }
}

/** 任意会话目录布局：key 为相对 root 的目录路径，值是该会话的 cache-log 行。 */
function runLayout(layout: Record<string, Array<Record<string, unknown>>>): string {
  const root = mkdtempSync(join(tmpdir(), 'compact-events-'))
  try {
    for (const [rel, rows] of Object.entries(layout)) {
      const dir = join(root, rel)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'cache-log.jsonl'),
        rows.map(r => JSON.stringify(r)).join('\n') + '\n',
      )
    }
    return execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/analyze-compact-events.ts'],
      {
        encoding: 'utf-8',
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RIVET_SESSION_DIR: root },
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 旧单层布局的简写：root/<sid>/cache-log.jsonl。 */
function runScript(rows: Array<Record<string, unknown>>): string {
  return runLayout({ 'sess-1': rows })
}

test('全部拒绝为 unchanged（no-op）时判无改写级抖动，不改写缓存', () => {
  const out = runScript([
    reclaimRow({ turn: 1, reason: 'unchanged' }),
    reclaimRow({ turn: 2, reason: 'unchanged' }),
    reclaimRow({ turn: 3, action: 'micro', commit: true, reason: 'reclaim-above-floor', reclaimedTokens: 9000, reclaimRatio: 0.09, force: false }),
  ])
  assert.match(out, /reclaim_decision/, '输出必须含 reclaim_decision 归因段')
  assert.match(out, /changed-but-rejected\s*:\s*0/, 'no-op 拒绝不计入抖动候选')
  assert.match(out, /no rewrite-level churn/i, '无改写级抖动时应给出明确判词')
})

test('被 gate 拒的改写候选（below-reclaim-floor）计入抖动并逐条列出', () => {
  const out = runScript([
    reclaimRow({ turn: 7, reason: 'below-reclaim-floor', reclaimedTokens: 1_200, reclaimRatio: 0.005 }),
    reclaimRow({ turn: 8, reason: 'below-reclaim-floor', reclaimedTokens: 1_100, reclaimRatio: 0.004 }),
  ])
  assert.match(out, /changed-but-rejected\s*:\s*2/, '改写级拒绝必须计数')
  assert.match(out, /! turn 7: below-reclaim-floor/, '抖动候选必须逐条可追溯（turn + reason）')
})

test('forced 占比在输出中可见；越过 60% 时给出告警', () => {
  const out = runScript([
    reclaimRow({ turn: 1, action: 'checkpoint', commit: true, reason: 'forced', force: true, reclaimedTokens: 50_000, reclaimRatio: 0.5 }),
    reclaimRow({ turn: 2, action: 'checkpoint', commit: true, reason: 'forced', force: true, reclaimedTokens: 50_000, reclaimRatio: 0.5 }),
    reclaimRow({ turn: 3, commit: true, reason: 'reclaim-above-floor', reclaimedTokens: 9_000, reclaimRatio: 0.09 }),
  ])
  assert.match(out, /forced\s*:\s*2/, 'forced 计数必须可见')
  assert.match(out, /67%/, 'forced 占比必须可见（2/3 ≈ 67%）')
  assert.match(out, /committed\s*:\s*3 \(forced 2 · gated 1\)/, '提交须分解为强制/经济筛选，暴露 gate 实际筛选比例')
  assert.match(out, /forced share 67% ≥ 60%/, '越过 60% 阈值必须告警')
})

test('真实数据的 slug/sessionId 两层布局也能被发现', () => {
  const out = runLayout({
    'myproj/20261002abcdef': [
      reclaimRow({ turn: 7, reason: 'below-reclaim-floor', reclaimedTokens: 1_200, reclaimRatio: 0.005 }),
    ],
  })
  assert.match(out, /20261002abcd/, '两层布局下的会话（sessionId）必须被发现并归因')
  assert.match(out, /reclaim_decision\s*:\s*1/, '该会话的 reclaim 行必须计入')
  assert.match(out, /changed-but-rejected\s*:\s*1/, '抖动候选必须跨层可见')
})

test('单层与两层布局混存时都能发现', () => {
  const out = runLayout({
    'flat-sess': [reclaimRow({ turn: 1, commit: true, reason: 'reclaim-above-floor', reclaimedTokens: 9_000, reclaimRatio: 0.09 })],
    'proj/nested-sess': [reclaimRow({ turn: 2, reason: 'unchanged' })],
  })
  assert.match(out, /reclaim_decision\s*:\s*2/, '混存时应分别发现两条会话')
})
