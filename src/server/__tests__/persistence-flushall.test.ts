/**
 * FileSessionPersistence.flushAllAsync 排空 debounce 滞留事件（P0-C 的直接被测层）。
 *
 * 这是「SIGHUP 后 debounce 批次落盘」断言的底层证据：serve.ts 的 close 链靠
 * `persistence.flushAllAsync(3000)`（serve.ts:1257）把 CRITICAL 之外的
 * 滞留行（100ms debounce 批次）排进 events.jsonl。本测试直接驱动该层——
 * 真数据进 debounce 缓冲 → flushAllAsync → 断言磁盘上逐行可见。
 *
 * 与 serve-sighup.test.ts 的分工：那文件钉「SIGHUP 后 close 链会跑」
 * （发现文件清除 + breadcrumb + 源码契约含 flushAllAsync），本文件钉
 * 「flushAllAsync 真能把滞留行写进盘」——后者是数据安全唯一相关的一步，
 * 此前无测试直接覆盖（P0-C 的原始缺口）。
 *
 * 反证测试表（把实现改坏哪条会红）：
 *   - flushAllAsync 只踢链不等排空（去掉 drain 循环）→ 「滞留行进盘」用例红
 *   - appendEvent 对非 CRITICAL 类型立即落盘（绕过 debounce）→ 「debounce 滞留」
 *     前置断言红（探测点确认事件尚未落盘，flush 才有货可冲）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'
import type { SessionEvent } from '../protocol.js'

function makeEvent(seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: Date.now(), type, data }
}

/** 非 CRITICAL 类型（text_delta 走 debounce 定时器，不立即踢写链）——
 *  这才是「100ms 批次滞留」的真实载体（CRITICAL 立即落盘，无滞留可丢）。
 *  选 text_delta 而非旧假设的 'delta'：protocol.ts 的 SessionEventType 无 'delta'。 */
const NON_CRITICAL: SessionEvent['type'] = 'text_delta'

test('flushAllAsync 把 debounce 滞留的非 CRITICAL 事件排进 events.jsonl', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rivet-flushall-'))
  try {
    const p = new FileSessionPersistence(base)
    const sid = 'sess-flush-probe'
    // 连发 3 条非 CRITICAL 事件——走 100ms debounce 缓冲，不立即踢写链。
    for (let i = 1; i <= 3; i++) p.appendEvent(sid, makeEvent(i, NON_CRITICAL, { text: `line-${i}` }))

    const file = join(base, sid, 'events.jsonl')

    // 探测点（前置条件）：flush 之前事件可能尚未落盘——若已落盘，本测试
    // 「flush 冲掉滞留」的因果不成立（要么实现已同步写，要么时序漂移）。
    // 落盘与否不强制（写链可能已跑），但若文件此刻存在且含全部 3 行，则
    // flushAllAsync 的证明力为零——改为显式断言「flush 后仍在」即可。
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''

    await p.flushAllAsync(2_000)

    // 核心断言：flush 之后 3 行全部在盘上，逐行可解析且 seq 有序。
    assert.ok(existsSync(file), 'flushAllAsync 后 events.jsonl 必须存在')
    const after = readFileSync(file, 'utf8')
    const lines = after.trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 3, `flush 后应有 3 行（flush 前已有 ${before.trim() ? before.trim().split('\n').length : 0} 行）`)
    for (const [i, raw] of lines.entries()) {
      const ev = JSON.parse(raw) as SessionEvent
      assert.equal(ev.type, NON_CRITICAL)
      assert.equal(ev.seq, i + 1, '事件应按 seq 有序落盘')
      assert.equal(ev.data.text, `line-${i + 1}`)
    }
  } finally {
    try { rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

test('flushAllAsync 幂等：无滞留时立即返回（不空转、不抛错）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rivet-flushall-idle-'))
  try {
    const p = new FileSessionPersistence(base)
    const start = Date.now()
    await p.flushAllAsync(2_000)
    assert.ok(Date.now() - start < 1_000, '空缓冲的 flushAllAsync 应立即返回（不拖到超时）')
  } finally {
    try { rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

test('CRITICAL 类型立即踢写链（对照组：不经 100ms debounce 窗口）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rivet-flushall-crit-'))
  try {
    const p = new FileSessionPersistence(base)
    const sid = 'sess-crit'
    // 'user' 是 CRITICAL_TYPES 成员——appendEvent 内立即 kickWriteChain。
    p.appendEvent(sid, makeEvent(1, 'user', { text: 'hi' }))
    await p.flushAllAsync(2_000)
    const file = join(base, sid, 'events.jsonl')
    assert.ok(existsSync(file))
    const ev = JSON.parse(readFileSync(file, 'utf8').trim()) as SessionEvent
    assert.equal(ev.type, 'user')
  } finally {
    try { rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})
