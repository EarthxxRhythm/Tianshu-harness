/**
 * 运行时形态标记（RIVET_RUNTIME_FORM）——与宽限参数解耦后的单一真源。
 *
 * 背景（2026-09-21 拆分）：此前形态判定借用 `RIVET_SERVE_GRACE_SECS` 是否已设
 * （parent-watchdog.ts 的 graceEnvSet）——一物二用：既当宽限数值，又当「这是
 * WSL attach 形态」的标记。两个职责生命周期不同：
 *   - 形态：进程一生不变（谁起的我）
 *   - 宽限：可调数值，且 attach 主路径已由租约制覆盖（宽限只剩"从未租约"的
 *     极短窗口兜底）
 * 混用的代价：想把宽限从 60s 调成默认值时，形态判定会跟着失效——本地 sidecar
 * 的孤儿 node.exe 自退会从 ~9s 退回 ~120s（正是 386287ef0 要修的 bug）。
 *
 * 拆分后：
 *   RIVET_RUNTIME_FORM=wsl-attach  → 形态标记（本文件钉住的契约）
 *   RIVET_SERVE_GRACE_SECS=<secs>  → 纯宽限数值（不设 = 默认 3 miss ≈ 9s）
 *
 * 反证测试表（把判定回滚成 graceEnvSet 时哪条会红）：
 *   - 「只设 RUNTIME_FORM、不设 GRACE → 终局生效」→ 回滚后红（旧判据不看 FORM）
 *   - 「只设 GRACE、不设 FORM → 终局不生效」→ 回滚后红（旧判据看 GRACE）
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isWslAttachForm } from '../parent-watchdog.js'

describe('isWslAttachForm — 形态判定的单一真源', () => {
  test('RIVET_RUNTIME_FORM=wsl-attach → true', () => {
    assert.equal(isWslAttachForm({ RIVET_RUNTIME_FORM: 'wsl-attach' }), true)
  })

  test('未设 RIVET_RUNTIME_FORM → false（本地 sidecar / CLI serve 形态）', () => {
    assert.equal(isWslAttachForm({}), false)
  })

  test('空串视为未设 → false（与既有 env 判定惯例一致）', () => {
    assert.equal(isWslAttachForm({ RIVET_RUNTIME_FORM: '' }), false)
  })

  test('值不匹配（拼写错误 / 未来其他形态）→ false，不 fail-open', () => {
    assert.equal(isWslAttachForm({ RIVET_RUNTIME_FORM: 'wsl' }), false)
    assert.equal(isWslAttachForm({ RIVET_RUNTIME_FORM: 'WSL-ATTACH' }), false, '大小写敏感——不做模糊匹配')
  })

  test('RIVET_SERVE_GRACE_SECS 不再影响形态判定（解耦契约）', () => {
    // 这是拆分的核心不变量：宽限数值的存在与否不得改变形态判定
    assert.equal(
      isWslAttachForm({ RIVET_SERVE_GRACE_SECS: '60' }),
      false,
      '仅设宽限 env 不得被当成 attach 形态（旧 graceEnvSet 行为即此，已废弃）',
    )
    assert.equal(
      isWslAttachForm({ RIVET_RUNTIME_FORM: 'wsl-attach', RIVET_SERVE_GRACE_SECS: '60' }),
      true,
      '设了形态标记即为 attach，无论宽限是多少',
    )
  })
})