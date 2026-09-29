import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { parseUsageRows, aggregateUsageRows } from '../usage-aggregator.js'
import { computeBilledHitRate } from '../billed-hit-rate.js'

const here = dirname(fileURLToPath(import.meta.url))
// fixture 与测试同目录（main 惯例 `__tests__/__fixtures__/`，先例 src/tools/__tests__/__fixtures__/）；
// alpha 侧原放 `src/cache/__fixtures__/`，仅为对齐本仓布局改路径，内容逐字一致。
const fixture = readFileSync(join(here, '__fixtures__', 'regression-session.cache-log.jsonl'), 'utf8')

/**
 * Regression gate for the exact blind spot documented in this file's own
 * header comment (see usage-aggregator.ts): side-path requests are real
 * billing that the self-reported `hitRate` excludes by design. This fixture
 * is a fixed, checked-in multi-turn session — 6 main rows at a 90% hit rate,
 * 3 side-path rows (speculation + compaction) at a 10% hit rate — so the
 * self-reported/billed gap it should produce is known and stable. If a
 * future change to parsing or aggregation silently stops accounting for
 * side-path consumption (or starts folding it into the main-row quotient,
 * or drops it from `input`/`cacheRead` sums), one of the two assertions
 * below goes red, instead of the drift being invisible until a bill shows up.
 */
describe('billed vs self-reported hit rate regression', () => {
  it('self-reported hitRate (main rows only) matches this fixture\'s known baseline', () => {
    const rows = parseUsageRows(fixture)
    const { totals } = aggregateUsageRows(rows, { days: 36500 })
    assert.equal(totals.hitRate, 90)
    assert.equal(totals.requests, 6)
    assert.equal(totals.sidePathRequests, 3)
  })

  it('billed hitRate (every row) is measurably lower than self-reported, not silently equal to it', () => {
    const rows = parseUsageRows(fixture)
    const billed = computeBilledHitRate(rows)
    assert.equal(billed.hitRate, 67.1)
    assert.equal(billed.requests, 6)
    assert.equal(billed.sidePathRequests, 3)

    const { totals } = aggregateUsageRows(rows, { days: 36500 })
    const selfReported = totals.hitRate ?? 0
    const gap = selfReported - (billed.hitRate ?? 0)
    // The known gap for this fixture is ~22.9 points. Assert it stays large
    // rather than pinning the exact float, so harmless rounding changes
    // elsewhere don't make this test flaky for no reason.
    assert.ok(gap > 15, `expected self-reported to exceed billed by >15pp on this fixture, got ${gap.toFixed(1)}pp`)
  })

  it('UsageTotals.billedHitRate reconciles with computeBilledHitRate on the same rows', () => {
    // 两处实现（聚合器内的字段 / 独立函数）必须始终同义——注释写「同义」不算数，
    // 这条把等价变成门禁：任一侧口径漂移（例如 retry 行在一侧被剔除）即转红。
    const rows = parseUsageRows(fixture)
    const { totals } = aggregateUsageRows(rows, { days: 36500 })
    assert.equal(totals.billedHitRate, computeBilledHitRate(rows).hitRate)
    assert.equal(totals.billedHitRate, 67.1)
  })

  it('两处账单口径实现在 retry / 用量未报告行上也不分家', () => {
    // fixture 只含 side_path；retry（stream_attempt_aborted）与主轮用量未报告行
    // 是另外两类只进 billed 分母的行，用合成行补上，防「一处收窄、另一处没收」。
    const rows = parseUsageRows([
      { t: 1, input: 100, cacheRead: 60, output: 5, usageFields: { input_tokens: 'prompt_tokens', cache_read_input_tokens: 'cached_tokens' } },
      { t: 2, input: 100, cacheRead: 0, output: 5, usageFields: {} },
      { t: 3, event: 'stream_attempt_aborted', input: 20, cacheRead: 0, output: 2, usageFields: { input_tokens: 'prompt_tokens' } },
      { t: 4, event: 'side_path', kind: 'speculation', input: 1000, cacheRead: 100, output: 10 },
    ].map(x => JSON.stringify(x)).join('\n'))
    const { totals } = aggregateUsageRows(rows, { days: 36500 })
    assert.equal(totals.hitRate, 60) // 主轮分母只有第一行
    assert.equal(totals.billedHitRate, computeBilledHitRate(rows).hitRate)
  })

  it('the non-usage reclaim_decision row in this fixture is ignored, not counted as a request', () => {
    const rows = parseUsageRows(fixture)
    assert.equal(rows.length, 9) // 6 main + 3 side_path; the reclaim_decision row carries no usage and is dropped
  })
})
