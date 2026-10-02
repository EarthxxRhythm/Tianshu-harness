/**
 * serve-agent-loader 门禁：flush 落盘接线必须有测试守着。
 *
 * 失效形态是静默的：删掉 loadServeAgent 成功分支里的 flush 调用，启动只是又变慢，
 * 没有红色信号——正是仓库反复强调要避免的静默降级。这里两头都钉：
 * - 行为：flush 包装被调用一次；抛错不冒泡、只记一行；
 * - 源码契约：成功分支先定格 import 耗时、再 flush、日志用定格值（flush 时间
 *   不算进 import 耗时）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { flushCompileCacheBestEffort } from '../serve-agent-loader.js'

const loaderSrc = readFileSync(fileURLToPath(new URL('../serve-agent-loader.ts', import.meta.url)), 'utf8')

/** 去注释（保留代码）：源码契约必须看真实语句，`// flushCompileCacheBestEffort()` 不算。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
const loaderCode = stripComments(loaderSrc)

test('flush 包装：注入函数被调用恰好一次', () => {
  let calls = 0
  flushCompileCacheBestEffort(() => { calls++ })
  assert.equal(calls, 1)
})

test('flush 包装：抛错不冒泡，只记一行 compile-cache-flush failed', () => {
  const logged: string[] = []
  const original = console.error
  console.error = ((...args: unknown[]) => {
    logged.push(args.map(a => String(a)).join(' '))
  }) as typeof console.error
  try {
    assert.doesNotThrow(() => flushCompileCacheBestEffort(() => { throw new Error('boom') }))
  } finally {
    console.error = original
  }
  assert.equal(logged.length, 1, `flush 失败应只记一行，实际 ${logged.length} 行`)
  assert.match(logged[0]!, /compile-cache-flush failed.*boom/)
})

test('源码契约：成功分支定格 import 耗时 → flush → 日志用定格值', () => {
  const thenBlock = loaderCode.slice(
    loaderCode.indexOf("import('./serve-agent.js').then"),
    loaderCode.indexOf('.catch((err)'),
  )
  assert.ok(thenBlock.length > 0, '定位 loadServeAgent 成功分支失败')
  const setMod = thenBlock.indexOf('serveAgentMod = m')
  const captureImportMs = thenBlock.indexOf('const importMs = Math.round(performance.now() - t0)')
  const flushCall = thenBlock.indexOf('flushCompileCacheBestEffort()')
  const log = thenBlock.indexOf('serve-agent import ${importMs}ms')
  assert.ok(
    setMod >= 0 && captureImportMs >= 0 && flushCall >= 0 && log >= 0,
    '成功分支缺少 serveAgentMod 赋值 / importMs 定格 / flush 调用 / import 日志之一——flush 接线被删时这里会红',
  )
  assert.ok(
    setMod < captureImportMs && captureImportMs < flushCall && flushCall < log,
    `顺序应为 serveAgentMod = m → 定格 importMs → flush → 日志（实际 index ${setMod}/${captureImportMs}/${flushCall}/${log}）`,
  )
  // import 耗时只能在 flush 前现算一次；日志若再读 t0，就把 flush 时间也算进去了。
  assert.equal(
    thenBlock.match(/performance\.now\(\) - t0/g)?.length,
    1,
    '成功分支只允许一处 t0 计时（importMs 定格）',
  )
})

test('源码契约：node:module flushCompileCache 默认注入 + typeof 守卫', () => {
  assert.match(loaderSrc, /import \{ flushCompileCache \} from 'node:module'/)
  assert.match(loaderSrc, /export function flushCompileCacheBestEffort\(flush: \(\) => void = flushCompileCache\)/)
  assert.match(loaderSrc, /typeof flush !== 'function'/)
})
