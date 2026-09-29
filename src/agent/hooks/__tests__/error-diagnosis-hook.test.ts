/**
 * error-diagnosis-hook 去重 RED 测试。
 *
 * 覆盖：编辑工具同文件 ≥2 次连续失败时跳过（去重），非编辑工具不跳，
 * 成功重置计数，计数独立于 edit-failure-recovery 的注册顺序。
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createErrorDiagnosisHook } from '../error-diagnosis-hook.js'
import type { AdvisoryEntry, AdvisoryBus } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

interface AdvisorySubmit {
  key: string
  content: string
}

function mockBus(): AdvisoryBus & { _submissions: AdvisorySubmit[] } {
  const submissions: AdvisorySubmit[] = []
  return {
    _submissions: submissions,
    submit(e: AdvisoryEntry): void {
      submissions.push({ key: e.key, content: e.content })
    },
    peekPendingKeys(): string[] {
      return submissions.map(e => e.key)
    },
    // minimal stubs
    drain(_render: unknown) { return [] as any },
    registerHook(_hook: unknown) {},
    getStats() { return { total: 0, alive: 0, drained: 0, expired: 0, constitutional: 0 } },
  } as unknown as AdvisoryBus & { _submissions: AdvisorySubmit[] }
}

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: { cwd: '/test', turn, phase: 'attack', lastAction: 'edit_file' },
    effects: { markClaimStale: () => {} },
  } as unknown as RuntimeHookContext
}

function makeTool(name: string, isError: boolean, filePath?: string): RuntimeToolEvent {
  return {
    name,
    isError,
    success: !isError,
    input: filePath ? { file_path: filePath } : {},
    target: filePath ?? 'unknown',
    failureClass: isError ? ('type_error' as const) : undefined,
    rawOutput: '',
    parsedOutput: null,
    durationMs: 100,
  } as unknown as RuntimeToolEvent
}

describe('createErrorDiagnosisHook — 去重', () => {
  let bus: ReturnType<typeof mockBus>
  let submitted: AdvisorySubmit[]

  beforeEach(() => {
    bus = mockBus()
    submitted = bus._submissions
  })

  it('编辑工具同文件首次失败 → 正常发射 error-diagnosis', () => {
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/foo.ts'))
    assert.equal(submitted.length, 1)
    assert.ok(submitted[0]!.key.startsWith('error-diagnosis:'))
  })

  it('编辑工具同文件第 2 次连续失败 → 跳过（去重）', () => {
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/foo.ts'))
    assert.equal(submitted.length, 1, 'first failure should fire')
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/foo.ts'))
    assert.equal(submitted.length, 1, 'second failure should be skipped (dedup)')
  })

  it('编辑工具成功 → 重置计数 → 下次失败重新发射', () => {
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    // fail twice → first fires, second skipped
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/foo.ts'))
    assert.equal(submitted.length, 1)
    // success resets
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    // fail again → should fire again
    hook.run(makeCtx(2), makeTool('edit_file', true, 'src/foo.ts'))
    assert.equal(submitted.length, 2)
  })

  it('不同文件各自独立计数', () => {
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/a.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/a.ts'))
    assert.equal(submitted.length, 1, 'a.ts second skip (dedup)')
    // b.ts first failure in next turn — should fire (different file, fresh turn)
    hook.run(makeCtx(2), makeTool('edit_file', true, 'src/b.ts'))
    assert.equal(submitted.length, 2, 'b.ts first should fire')
  })

  it('非编辑工具错误不受编辑去重影响', () => {
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    hook.run(makeCtx(1), makeTool('bash', true, 'src/run.sh'))
    assert.equal(submitted.length, 1)
    // bash 不是编辑工具，不受编辑去重影响（但受 turn cooldown 限制）
    hook.run(makeCtx(2), makeTool('bash', true, 'src/run.sh'))
    assert.equal(submitted.length, 2, 'non-edit tool should fire in next turn')
  })

  it('去重不依赖 hook 注册顺序——自维护计数独立于 edit-failure-recovery', () => {
    // 此测试不创建 edit-failure-recovery-hook，直接验证
    // error-diagnosis-hook 的去重逻辑完全自给。
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    // 模拟 3 次连续 edit_file 失败
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/x.ts'))
    assert.equal(submitted.length, 1)
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/x.ts'))
    assert.equal(submitted.length, 1) // dedup
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/x.ts'))
    assert.equal(submitted.length, 1) // still dedup
  })

  it('write_file / hash_edit / ast_edit 也被视为编辑工具去重', () => {
    const editTools = ['write_file', 'hash_edit', 'ast_edit']
    for (const t of editTools) {
      const b = mockBus()
      const hook = createErrorDiagnosisHook({ advisoryBus: b })
      hook.run(makeCtx(1), makeTool(t, true, 'src/z.ts'))
      hook.run(makeCtx(1), makeTool(t, true, 'src/z.ts'))
      assert.equal(b._submissions.length, 1, `${t} should dedup on second failure`)
    }
  })
})

describe('createErrorDiagnosisHook — patch_rejected', () => {
  const PATCH_DIFF = 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n'

  function makePatchTool(failureClass?: string): RuntimeToolEvent {
    return {
      name: 'apply_patch',
      isError: true,
      success: false,
      input: { diff: PATCH_DIFF },
      target: 'unknown',
      failureClass,
      rawOutput: '',
      parsedOutput: null,
      durationMs: 5,
    } as unknown as RuntimeToolEvent
  }

  it('patch_rejected → 发射 git apply 诊断', () => {
    const bus = mockBus()
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    hook.run(makeCtx(1), makePatchTool('patch_rejected'))
    assert.equal(bus._submissions.length, 1)
    assert.match(bus._submissions[0]!.content, /git apply/)
    assert.match(bus._submissions[0]!.content, /read_file/)
  })

  it('apply_patch 同目标第 2 次连续失败 → 去重跳过（让位 edit-failure-recovery）', () => {
    const bus = mockBus()
    const hook = createErrorDiagnosisHook({ advisoryBus: bus })
    hook.run(makeCtx(1), makePatchTool('patch_rejected'))
    assert.equal(bus._submissions.length, 1, 'first failure should fire')
    hook.run(makeCtx(1), makePatchTool('patch_rejected'))
    assert.equal(bus._submissions.length, 1, 'second failure on same target should dedup')
  })
})
