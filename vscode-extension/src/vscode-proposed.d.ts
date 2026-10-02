/**
 * fork 提案 API 的类型面补充（对应 package.json enabledApiProposals）。
 *
 * `@types/vscode` 只含稳定 API；提案字段在 fork 运行时存在，类型面由本文件
 * 以 module augmentation 增补。仅补本扩展实际消费的字段——保持面最小。
 */

import 'vscode'

declare module 'vscode' {
  interface ChatRequest {
    /**
     * 本请求的权限档位（工具自动批准策略，`chatParticipantPrivate` 提案）：
     * `'default'` / `'assisted'` / `'autoApprove'` / `'autopilot'` 或 undefined。
     * 消费见 chat/permission-bridge.ts。
     */
    readonly permissionLevel?: string
  }

  /** chat 请求的 token 用量（`chatParticipantAdditions` 提案，对齐 fork 的 ChatResultUsage）。 */
  interface ChatResultUsage {
    readonly promptTokens: number
    readonly completionTokens: number
  }

  /**
   * 工具条目的折叠数据（`chatParticipantAdditions` 提案的 ChatSimpleToolResultData）：
   * input/output 渲染为可折叠代码区（fork chatSimpleToolProgressPart）。
   */
  interface ChatSimpleToolResultData {
    input: string
    output: string
  }

  /**
   * 工具调用条目（`chatParticipantAdditions` 提案）。
   *
   * `enablePartialUpdate: true` 时走实时更新语义（fork 转换器 →
   * externalToolInvocationUpdate → 聊天模型的 _handleExternalToolInvocationUpdate）：
   * 首推建立「运行中」条目、同 toolCallId 再推即更新、isComplete 收束。
   * 仅声明本扩展消费的字段面（构造器的 errorMessage 在 fork 转换器的
   * externalToolInvocationUpdate 分支暂未传递——错误态以 pastTenseMessage 文案呈现）。
   */
  class ChatToolInvocationPart {
    toolName: string
    toolCallId: string
    invocationMessage?: string
    pastTenseMessage?: string
    isComplete?: boolean
    toolSpecificData?: ChatSimpleToolResultData
    enablePartialUpdate?: boolean
    constructor(toolName: string, toolCallId: string, errorMessage?: string)
  }

  interface ChatResponseStream {
    /**
     * 上报本请求的 token 用量（chat 上下文占用圆环的数据源，`chatParticipantAdditions` 提案）。
     * fork 运行时已实现；声明为可选以便在无此实现的宿主上静默跳过。
     * 消费见 chat/participant.ts 的 turn_complete 上报。
     */
    usage?(usage: ChatResultUsage): void

    /**
     * 推一个工具调用条目到回复流（`chatParticipantAdditions` 提案）。
     * 消费见 chat/participant.ts 的两段式工具更新（运行态→完成态）。
     */
    push(part: ChatToolInvocationPart): void

    /**
     * 上报一段思考增量（`chatParticipantAdditions` 提案）——连续非空增量由宿主
     * 合并为思考块（fork 模型层合并判据不依赖 id）。消费见 chat/participant.ts。
     */
    thinkingProgress(delta: { text: string }): void
  }
}
