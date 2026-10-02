/**
 * audit-usage-ledgers 分类回归（2026-10-02，两轮）。
 *
 * in-progress 分类的背景与修正：
 * ① 未结束会话（meta.status='active'）的 meta 是中途刷盘快照，收尾 drain 才
 *   落终值——直接混入 anomaly 桶时「回归信号」被进行中会话淹没（本项目实测
 *   15 个里 13 个是 active）。首版据此引入 in-progress。
 * ② 但 status 是**代理真值**：主会话的 status 永不翻终态（session-persist
 *   initMetadata 固定写 active；全仓唯一写 completed 的是 worker-session），
 *   死掉未 drain 的主会话同样携带 status='active'——单靠 status 会把「永久
 *   欠账」静默吞掉（提交后审查发现，二轮修正）。现判据要求「active 且最近
 *   24h 内有活动」才归 in-progress；stale-active 回落 undercount-anomaly。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function writeSession(root: string, sid: string, meta: Record<string, unknown>, input: number): void {
  mkdirSync(join(root, sid), { recursive: true })
  writeFileSync(join(root, sid, 'cache-log.jsonl'), JSON.stringify({ t: 1, turn: 0, input }) + '\n')
  writeFileSync(join(root, `${sid}.meta.json`), JSON.stringify(meta))
}

/** 任意行写入（retry / 重复 attempt / 跨 slug 场景用）。slug 为空时落 root 布局。 */
function writeRawSession(root: string, slug: string | null, sid: string, meta: Record<string, unknown>, rows: Array<Record<string, unknown>>): void {
  const dir = slug ? join(root, slug, sid) : join(root, sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cache-log.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(slug ? join(root, slug) : root, `${sid}.meta.json`), JSON.stringify(meta))
}

interface AuditJson {
  verdicts: Record<string, number>
  overcounts?: Array<{ sid: string; slug: string; delta: number; dirCount: number }>
}

function runAudit(root: string): AuditJson {
  // 与项目测试命令同构：node --import tsx（不依赖 npx 环境）。
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/audit-usage-ledgers.ts', '--sessions', root, '--json'],
    { encoding: 'utf-8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] },
  )
  return JSON.parse(out) as AuditJson
}

test('未结束且近期有活动的会话归 in-progress；stale 或已结束的欠账暴露为 undercount-anomaly', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-ledgers-'))
  const HOUR = 3_600_000
  const now = Date.now()
  try {
    // active 且 1h 内有更新：会话可能仍在跑，收尾 drain 前的 meta 滞后属预期。
    writeSession(root, 'active-fresh', { status: 'active', updatedAt: now - HOUR, tokenUsage: { prompt: 1_000 } }, 10_000)
    // active 但 72h 无更新：进程已死、收尾 drain 永不发生（主会话 status 永不翻
    // 终态是已知现状）——永久欠账必须暴露，不能被 in-progress 吞掉。
    writeSession(root, 'active-stale', { status: 'active', updatedAt: now - 72 * HOUR, tokenUsage: { prompt: 1_000 } }, 10_000)
    writeSession(root, 'done-debt', { status: 'completed', updatedAt: now - HOUR, tokenUsage: { prompt: 1_000 } }, 10_000)
    writeSession(root, 'legacy-debt', { updatedAt: now - HOUR, tokenUsage: { prompt: 1_000 } }, 10_000) // 老 meta 无 status——保守视为已结束
    writeSession(root, 'aligned', { status: 'completed', updatedAt: now - HOUR, tokenUsage: { prompt: 10_000 } }, 10_000)

    const { verdicts } = runAudit(root)
    assert.equal(verdicts['in-progress'] ?? 0, 1, 'active 且近期有活动 → in-progress')
    assert.equal(verdicts['undercount-anomaly'] ?? 0, 3, 'stale-active / completed / 无 status 的欠账都暴露')
    assert.equal(verdicts['aligned'] ?? 0, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─── retry 行口径（2026-10-02 第三批）────────────────────────────
// 规范计费口径（usage-aggregator）包含 retry（stream_attempt_aborted，
// provider charged）；审计脚本曾漏掉它，把计入 retry 的 meta 误判 overcount。

test('retry 行（stream_attempt_aborted）计入计费——meta 含 retry 时判 aligned', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-ledgers-'))
  const now = Date.now()
  try {
    // meta = main(10000) + retry(3000)。漏计 retry 时 log=10000，
    // Δ=3000 > tol(2000) → overcount（旧行为）；计入后 aligned。
    writeRawSession(root, null, 'retry-completed', { status: 'completed', updatedAt: now - 3_600_000, tokenUsage: { prompt: 13_000 } }, [
      { t: 1, turn: 0, input: 10_000 },
      { t: 2, turn: 1, input: 3_000, event: 'stream_attempt_aborted' },
    ])

    const { verdicts } = runAudit(root)
    assert.equal(verdicts['overcount'] ?? 0, 0, 'retry 行计入后不得再判 overcount')
    assert.equal(verdicts['aligned'] ?? 0, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('同一尝试的重复落行只计一次（与 usage-aggregator 尝试级去重同口径）', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-ledgers-'))
  const now = Date.now()
  try {
    // 同一 (provider, model, requestId, attemptId) 落两行：去重前 log=20000、
    // meta=10000 → 反向误判 undercount；去重后 log=10000 → aligned。
    const dupRow = { t: 1, turn: 0, input: 10_000, provider: 'deepseek', model: 'deepseek-v4-flash', requestId: 'r1', attemptId: 'a1' }
    writeRawSession(root, null, 'dup-attempt', { status: 'completed', updatedAt: now - 3_600_000, tokenUsage: { prompt: 10_000 } }, [dupRow, { ...dupRow }])

    const { verdicts } = runAudit(root)
    assert.equal(verdicts['undercount-anomaly'] ?? 0, 0, '重复落行不得加倍计账')
    assert.equal(verdicts['aligned'] ?? 0, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('跨 slug 同名会话目录：overcount 条目附 dirCount（跨目录续跑可解释）', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-ledgers-'))
  const now = Date.now()
  try {
    // 同名 worker 换了 worktree 续跑：slug-a 的 meta 是累积账（含另一段），
    // 其自身 log 只含本段 → meta > log；slug-b 自洽。dirCount=2 标明成因。
    writeRawSession(root, 'slug-a', 'shared-sid', { status: 'completed', updatedAt: now - 3_600_000, tokenUsage: { prompt: 30_000 } }, [
      { t: 1, turn: 0, input: 10_000 },
    ])
    writeRawSession(root, 'slug-b', 'shared-sid', { status: 'completed', updatedAt: now - 3_600_000, tokenUsage: { prompt: 20_000 } }, [
      { t: 1, turn: 0, input: 20_000 },
    ])

    const out = runAudit(root)
    const over = out.overcounts ?? []
    assert.equal(over.length, 1, 'slug-a 一条 overcount')
    assert.equal(over[0]!.sid, 'shared-sid')
    assert.equal(over[0]!.dirCount, 2, '同名目录数必须随 overcount 输出——跨目录成因可自查')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
