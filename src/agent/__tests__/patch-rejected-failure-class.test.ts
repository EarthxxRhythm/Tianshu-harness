/**
 * patch_rejected 失败类别测试。
 *
 * git apply 拒绝补丁（corrupt patch / context drift / not-in-index）此前落到
 * unknown——error-diagnosis 跳过、vigor 全额罚、无重试引导。现在：
 * 结构通道（apply_patch 自报 errorKind，confidence 1）+ 文本兜底（bash 手跑
 * git apply 的场景）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, classifyToolFailure, isTransient } from '../failure-classifier.js'

describe('patch_rejected', () => {
  it('corrupt patch（hunk 计数错误）→ patch_rejected', () => {
    const result = classifyFailure('error: corrupt patch at /tmp/rivet-patch-1.patch:7')
    assert.equal(result.class, 'patch_rejected')
    assert.equal(result.retryable, false)
  })

  it('上下文漂移 / 索引不一致 / 不在索引 → patch_rejected', () => {
    assert.equal(classifyFailure('error: file.txt: patch does not apply').class, 'patch_rejected')
    assert.equal(classifyFailure('error: file.txt: does not match index').class, 'patch_rejected')
    assert.equal(classifyFailure('error: newfile.txt: does not exist in index').class, 'patch_rejected')
    assert.equal(classifyFailure('error: patch failed: file.txt:10').class, 'patch_rejected')
  })

  it('结构通道 errorKind 直读（confidence 1，不依赖文案）', () => {
    const result = classifyToolFailure({ errorKind: 'patch_rejected' }, '补丁应用失败：任意文案')
    assert.equal(result.class, 'patch_rejected')
    assert.equal(result.confidence, 1)
  })

  it('非 transient——不可自动重试（原样重发必然再失败）', () => {
    assert.equal(isTransient('patch_rejected'), false)
  })

  it('建议语指向重新生成而非重发', () => {
    const result = classifyFailure('error: file.txt: patch does not apply')
    assert.match(result.suggestion, /read_file/)
    assert.match(result.suggestion, /勿原样重发/)
  })
})
