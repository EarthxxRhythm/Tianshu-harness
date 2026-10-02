/**
 * 原生对话框的纯逻辑面（不依赖 vscode，可单测）：
 *  - 审批选项 → ApprovalAnswer 契约映射（与座舱 ApprovalCard / REST interventions/answer 对齐）；
 *  - 提问答案 → 普通用户消息组装（与座舱 QuestionCard 逐字同款约定：server 侧
 *    ask_user_question 只回占位符 + endTurn，答案作为普通消息回传）。
 * @module
 */
import type { ChatQuestion } from './turn-events.js'

/** 提问的对外别名（对话框层消费）。 */
export type Question = ChatQuestion

/** 审批对话框的三个选项（顺序即按钮顺序）。 */
export const APPROVAL_CHOICES = ['允许一次', '始终允许', '拒绝'] as const

/** 本模块产出的审批回答：不带 editedInput（改参数批准留座舱卡片）。 */
export interface ApprovalDecision {
  decision: 'approve' | 'deny'
  remember?: true
}

/**
 * 选项 → 回答契约映射。
 * @param choice - 用户点选的按钮文本；对话框被 dismiss 时为 undefined。
 * @returns 回答载荷；dismiss 或未知输入返回 undefined（审批保持 pending）。
 */
export function approvalAnswerFrom(choice: string | undefined): ApprovalDecision | undefined {
  if (choice === '允许一次') return { decision: 'approve' }
  if (choice === '始终允许') return { decision: 'approve', remember: true }
  if (choice === '拒绝') return { decision: 'deny' }
  return undefined
}

/**
 * 把逐题答案组装成普通用户消息（座舱 QuestionCard 同款约定）。
 * @param questions - 题目列表（顺序即行序）。
 * @param picked - 每题的已选项（多选为多项）；缺省或空数组视为未作答。
 * @returns 单问题裸答案 / 多问题每行「问: 答」；多选以「、」连接，未作答「（未选择）」。
 */
export function composeQuestionAnswer(questions: Question[], picked: Record<string, string[]>): string {
  const lines = questions.map((q) => {
    const ans = picked[q.id]?.join('、') || '（未选择）'
    return questions.length > 1 ? `${q.prompt}: ${ans}` : ans
  })
  return lines.join('\n')
}
