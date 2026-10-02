/**
 * 工具条目呈现决策：把 turn-events 的事件数据翻译为原生工具 part 的字段值。
 *
 * 纯模块（零运行时依赖，可被 node --test 直载）；vscode 类
 * （ChatToolInvocationPart）的实例化留在 participant——本模块只产出「该填什么值」。
 *
 * 与 fork 渲染链的约定（静态核实，fork 仓）：
 *  - toolSpecificData {input, output} → 渲染为 simpleToolInvocation 折叠卡
 *    （input/output 各一块可折叠代码区，展开态由宿主记忆）。
 *  - 错误态以 pastTenseMessage 文案呈现；errorMessage 赋值留待 fork 转换器
 *    补传（externalToolInvocationUpdate 分支暂未传递——见计划记录）。
 * @module
 */

/** 工具开始（运行态）的 part 字段值。 */
export interface ToolStartSpec {
  invocationMessage: string
  toolSpecificData: { input: string; output: string }
}

/** 工具完成/更新的 part 字段值。 */
export interface ToolDoneSpec {
  pastTenseMessage: string
  errorMessage?: string
  toolSpecificData: { input: string; output: string }
}

/**
 * 运行态条目：一行「正在运行 `name` · detail」+ 折叠卡（input 已可展开，output 留空）。
 * @param e - turn-events 的 tool 事件（name/detail/inputText）。
 */
export function toolStartPart(e: { name: string; detail: string; inputText: string }): ToolStartSpec {
  const detail = e.detail !== '' ? ` · ${e.detail}` : ''
  return {
    invocationMessage: `正在运行 \`${e.name}\`${detail}`,
    toolSpecificData: { input: e.inputText, output: '' },
  }
}

/**
 * 完成态更新：pastTense 一行 + 折叠卡（input 自启动事件回填、output 为结果文本）。
 * @param e - turn-events 的 tool-result 事件（name/isError/output）。
 * @param inputText - 启动事件存下的参数全文；缺失时为空串（仅展示 output）。
 */
export function toolDonePart(e: { name: string; isError: boolean; output: string }, inputText: string): ToolDoneSpec {
  return {
    pastTenseMessage: e.isError ? `运行 \`${e.name}\` 失败` : `已运行 \`${e.name}\``,
    ...(e.isError ? { errorMessage: '运行失败' } : {}),
    toolSpecificData: { input: inputText, output: e.output },
  }
}
