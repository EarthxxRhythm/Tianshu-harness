import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalAnswerFrom, APPROVAL_CHOICES, composeQuestionAnswer, type Question } from '../src/chat/human-forms.ts'

// 原生对话框的纯逻辑面：
//  - 审批选项 → ApprovalAnswer（与座舱 ApprovalCard / REST interventions/answer 同一契约：
//    {decision, remember}；「始终允许」= approve + remember:true）。
//  - 提问答案 → 普通用户消息（与座舱 QuestionCard 同一组装约定：多问题「问: 答」每行、
//    多选「、」连接、未作答「（未选择）」；server 侧 ask_user_question 只回占位符 + endTurn）。

test('审批三选项与契约映射：允许一次 / 始终允许(remember) / 拒绝', () => {
  assert.deepEqual(APPROVAL_CHOICES, ['允许一次', '始终允许', '拒绝'])
  assert.deepEqual(approvalAnswerFrom('允许一次'), { decision: 'approve' })
  assert.deepEqual(approvalAnswerFrom('始终允许'), { decision: 'approve', remember: true })
  assert.deepEqual(approvalAnswerFrom('拒绝'), { decision: 'deny' })
})

test('对话框被 dismiss（undefined）或其他输入不产答案（审批保持 pending）', () => {
  assert.equal(approvalAnswerFrom(undefined), undefined)
  assert.equal(approvalAnswerFrom('随便什么'), undefined)
})

test('单问题：裸答案直出', () => {
  const qs: Question[] = [{ id: 'q1', prompt: '晚餐吃什么', options: ['面', '饭'], allowMultiple: false }]
  assert.equal(composeQuestionAnswer(qs, { q1: ['面'] }), '面')
})

test('多问题：每行「问: 答」', () => {
  const qs: Question[] = [
    { id: 'q1', prompt: '风格', options: ['简洁'], allowMultiple: false },
    { id: 'q2', prompt: '范围', options: ['全部'], allowMultiple: false },
  ]
  assert.equal(composeQuestionAnswer(qs, { q1: ['简洁'], q2: ['全部'] }), '风格: 简洁\n范围: 全部')
})

test('多选：「、」连接；未作答：（未选择）', () => {
  const qs: Question[] = [{ id: 'q1', prompt: '要哪些', options: ['A', 'B', 'C'], allowMultiple: true }]
  assert.equal(composeQuestionAnswer(qs, { q1: ['A', 'C'] }), 'A、C')
  assert.equal(composeQuestionAnswer(qs, {}), '（未选择）')
  assert.equal(composeQuestionAnswer(qs, { q1: [] }), '（未选择）')
})
