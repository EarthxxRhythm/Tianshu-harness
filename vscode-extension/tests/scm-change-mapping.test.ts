import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapWorkingTreeFile } from '../src/scm/change-mapping.ts'
import type { WorkingTreeFile } from '../src/sidecar/protocol.ts'

// L2-5 SCM 资源映射（纯函数，无 vscode 依赖——node --test 直接加载）：
//  - 五态 M/A/D/R/U 与 codicon 图标（diff-* 系列，fork 注册表已核）
//  - tooltip 文本与 changes-view 的 TreeItem description 同格式：
//    `${label}  +${additions} −${deletions}`（两空格分隔，减号为 U+2212）
//  - 未知态（server 版本漂移）兜底：不抛错、保守默认

const file = (
  status: WorkingTreeFile['status'],
  additions = 3,
  deletions = 1,
): WorkingTreeFile => ({ path: 'src/a.ts', status, additions, deletions })

test('modified → M / diff-modified', () => {
  const r = mapWorkingTreeFile(file('modified'))
  assert.equal(r.iconId, 'diff-modified')
  assert.equal(r.tooltip, 'M  +3 −1')
  assert.equal(r.contextValue, 'session-change')
})

test('added → A / diff-added', () => {
  const r = mapWorkingTreeFile(file('added'))
  assert.equal(r.iconId, 'diff-added')
  assert.equal(r.tooltip, 'A  +3 −1')
})

test('deleted → D / diff-removed（+0 显式保留）', () => {
  const r = mapWorkingTreeFile(file('deleted', 0, 12))
  assert.equal(r.iconId, 'diff-removed')
  assert.equal(r.tooltip, 'D  +0 −12')
})

test('renamed → R / diff-renamed', () => {
  const r = mapWorkingTreeFile(file('renamed'))
  assert.equal(r.iconId, 'diff-renamed')
  assert.equal(r.tooltip, 'R  +3 −1')
})

test('untracked → U / diff-added（新文件语义）', () => {
  const r = mapWorkingTreeFile(file('untracked'))
  assert.equal(r.iconId, 'diff-added')
  assert.equal(r.tooltip, 'U  +3 −1')
})

test('未知态兜底：保守默认（? / diff-modified），不抛错', () => {
  const r = mapWorkingTreeFile(file('conflicted' as WorkingTreeFile['status']))
  assert.equal(r.iconId, 'diff-modified')
  assert.equal(r.tooltip, '?  +3 −1')
  assert.equal(r.contextValue, 'session-change')
})
