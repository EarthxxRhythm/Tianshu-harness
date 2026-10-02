/**
 * ADVICE_TOOL_REFERENCES 守卫（T5，2026-10-02）。
 *
 * 背景：runtime advice 文案会点名工具（「用 session_vitals 取证」「用 todo
 * 跟踪」），但工具池按档位裁剪——被排除的工具若仍出现在建议里，模型会被
 * 指引去调用一个不可见的工具（建议与工具池失配）。A1 修复把门控落在渲染点
 * （sessionStateAdvice / todo-reminder-hook），而声明表 ADVICE_TOOL_REFERENCES
 * （runtime-advice-facts.ts:11）此前无任何消费方——「档位一致性对账」的用途
 * 没有接上，属未兑现的守卫位（本套件把它接上）。
 *
 * 本套件以声明表为唯一清单驱动：
 *  - GATED_RENDERERS 给每个条目挂「工具在场/缺席」双态渲染探针；
 *  - 「声明表 ⇔ 探针表」键集一致性是结构性断言——新增条目漏挂探针即红。
 *
 * **扩展点**：往 ADVICE_TOOL_REFERENCES 加条目时，在 GATED_RENDERERS 同步
 * 加双态探针（工具在场渲染出建议、缺席时文案必须变化）。若条目确无渲染路径
 * （纯登记用途），在 UNGATED 里显式登记并写明理由——漏登记由键集断言拦截。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADVICE_TOOL_REFERENCES, sessionStateAdvice } from '../runtime-advice-facts.js'
import { createTodoReminderHook } from '../hooks/todo-reminder-hook.js'
import { budget, facts } from './advice-facts-fixture.js'
import type { AdvisoryEntry } from '../advisory-bus.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'

/** 确无渲染路径、只作登记用途的条目（当前为空）。 */
const UNGATED: ReadonlySet<string> = new Set([])

const ctx = { snapshot: { turn: 100, modelTurn: 100, recentToolHistory: [{ tool: 'read_file' }, { tool: 'read_file' }] }, effects: {} } as unknown as RuntimeHookContext

/** 声明表条目的工具名——探针必须用**声明表的值**而非硬编码，否则把值改掉
 *  （如 sessionState → ['foo']）测试仍绿：守卫只锁「键」不锁「值」（提交后
 *  审查发现 2026-10-02，这里修正）。 */
const SESSION_STATE_TOOL = ADVICE_TOOL_REFERENCES.sessionState[0]
const TODO_TOOL = ADVICE_TOOL_REFERENCES.todo[0]

/** todo 条目的双态渲染探针：复用 todo-reminder-hook 的真实门控路径。 */
function renderTodoAdvice(available: boolean, tool: string): string {
  const rows: AdvisoryEntry[] = []
  createTodoReminderHook({
    getTask: () => ({ key: 1, multiStep: true, startTurn: 1 }),
    getActiveToolNames: () => (available ? [tool] : []),
    getTodos: () => [],
    advisoryBus: { submit: e => rows.push(e) },
  }).run(ctx)
  return rows.map(r => r.content).join('\n')
}

/** 声明表每个条目的双态渲染探针（键集必须与 ADVICE_TOOL_REFERENCES 一致）。 */
const GATED_RENDERERS: Record<keyof typeof ADVICE_TOOL_REFERENCES, (available: boolean) => string> = {
  sessionState: available => sessionStateAdvice(facts(() => undefined, available ? [SESSION_STATE_TOOL] : [])),
  todo: available => renderTodoAdvice(available, TODO_TOOL),
}

test('sessionStateAdvice 双态：工具在场指向声明表工具名，缺席改走预算/降级文案', () => {
  const on = sessionStateAdvice(facts(() => undefined, [SESSION_STATE_TOOL]))
  assert.match(on, /session_vitals/)
  assert.ok(on.includes(SESSION_STATE_TOOL), '渲染文案必须点名声明表登记的工具——值漂移即红')
  const off = sessionStateAdvice(facts(() => undefined, []))
  assert.doesNotMatch(off, /session_vitals/)
  assert.match(off, /暂无法确认/)
  // 预算在场但工具缺席：走预算文案，仍不得点名工具。
  const offWithBudget = sessionStateAdvice(facts(() => budget(), []))
  assert.doesNotMatch(offWithBudget, /session_vitals/)
  assert.match(offWithBudget, /预算占用/)
})

test('声明表驱动：ADVICE_TOOL_REFERENCES 每个条目的 advice 渲染均经可用性门控', () => {
  const declared = (Object.keys(ADVICE_TOOL_REFERENCES) as (keyof typeof ADVICE_TOOL_REFERENCES)[]).sort()
  const probed = (Object.keys(GATED_RENDERERS) as (keyof typeof ADVICE_TOOL_REFERENCES)[]).sort()
  assert.deepEqual(
    probed, declared,
    '声明表新增条目必须挂双态探针（扩展点见本文件头注释）——漏挂即失守',
  )
  for (const key of declared) {
    if (UNGATED.has(key)) continue
    const on = GATED_RENDERERS[key](true)
    const off = GATED_RENDERERS[key](false)
    assert.ok(on.length > 0, `${key}: 工具在场时应渲染出建议`)
    assert.notEqual(on, off, `${key}: 工具缺席时 advice 必须换文案——否则建议会指向不可见工具`)
    // 值绑定：工具在场时渲染出的建议必须点名**声明表的工具名**——把声明值
    // 改成任意工具名后，探针以新值启用工具、实现仍检查旧名 → on 落回替代
    // 文案 → 此断言红（「只锁键不锁值」的缺口由此闭合，2026-10-02 审查修正）。
    for (const tool of ADVICE_TOOL_REFERENCES[key]) {
      assert.ok(on.includes(tool), `${key}: 工具在场时渲染必须点名声明表值 "${tool}"——值漂移即红`)
    }
  }
})
