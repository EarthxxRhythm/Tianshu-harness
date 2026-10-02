import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolStartPart, toolDonePart } from '../src/chat/chat-parts.ts'

// 工具条目呈现决策：事件数据 → 原生工具 part 的字段值（纯数据；vscode 类实例化在 participant）。
// 与 fork 渲染链的约定（静态核实）：
//  - toolSpecificData {input, output} → 渲染为 simpleToolInvocation 折叠卡（input/output 代码区）。
//  - 错误态以 pastTenseMessage 文案呈现（fork 转换器的 externalToolInvocationUpdate 分支
//    暂未传递 errorMessage——赋值留待其修复后自动生效）。

test('toolStartPart：一行「正在运行」+ input 折叠数据；detail 空则省略', () => {
  assert.deepEqual(
    toolStartPart({ name: 'bash', detail: 'mkdir -p /tmp/x', inputText: '{\n  "command": "mkdir -p /tmp/x"\n}' }),
    {
      invocationMessage: '正在运行 `bash` · mkdir -p /tmp/x',
      toolSpecificData: { input: '{\n  "command": "mkdir -p /tmp/x"\n}', output: '' },
    },
  )
  assert.deepEqual(
    toolStartPart({ name: 'bash', detail: '', inputText: '' }),
    { invocationMessage: '正在运行 `bash`', toolSpecificData: { input: '', output: '' } },
  )
})

test('toolDonePart：成功文案 + output 透传 + input 回填', () => {
  assert.deepEqual(
    toolDonePart({ name: 'bash', isError: false, output: 'done' }, '{\n  "command": "ls"\n}'),
    {
      pastTenseMessage: '已运行 `bash`',
      toolSpecificData: { input: '{\n  "command": "ls"\n}', output: 'done' },
    },
  )
})

test('toolDonePart：失败文案 + errorMessage + output 透传', () => {
  assert.deepEqual(
    toolDonePart({ name: 'bash', isError: true, output: 'boom' }, ''),
    {
      pastTenseMessage: '运行 `bash` 失败',
      errorMessage: '运行失败',
      toolSpecificData: { input: '', output: 'boom' },
    },
  )
})

test('toolDonePart：成功不携带 errorMessage 键；inputText 缺失回填空串', () => {
  const ok = toolDonePart({ name: 'x', isError: false, output: '' }, '')
  assert.equal(ok.errorMessage, undefined)
  assert.deepEqual(ok.toolSpecificData, { input: '', output: '' })
})
