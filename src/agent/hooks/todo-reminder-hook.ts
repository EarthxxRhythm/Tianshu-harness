import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { TodoItem } from '../../tools/todo-store.js'
import { getTodos as defaultGetTodos } from '../../tools/todo.js'

/**
 * Todo-Reminder Hook — postTurn nudge that fills two blind spots:
 *
 *  1. "模型拿到多步任务却不建 todo"：模型连续多步推进却从未写过 todo 清单,
 *     进度无法被追踪/回灌,长任务后期容易丢步骤、重复劳动。
 *  2. "todo 建了却不更新"：清单写过但长时间未动(stale),与当前工作脱节。
 *
 * 只提示已确认的多步任务，不因轮数增加升级措辞。
 *   - 软提醒(SOFT_EMPTY_TURN)：温和建议建 todo,单步琐碎任务可忽略。
 *   - 陈旧提醒(STALE_TURNS)：清单 N 轮未更新,附当前清单快照回灌让模型对齐。
 *
 * 噪声控制：每条 ttl=1(仅本轮),category='todo' 受 advisoryBus 每 category 上限保护;
 * 触发后进入冷却(COOLDOWN)避免每轮重复。清单本轮刚写过则不提醒(写入即视为对齐)。
 *
 * 借鉴 claude-code-haha 的 TODO_REMINDER_CONFIG(10 轮门槛 + 轮间冷却 + 回灌快照),
 * 但走天枢既有 advisoryBus / system-reminder 通道,不重写 frozen 前缀。
 */
export interface TodoReminderHookDeps {
  getTask?: () => { key: number; multiStep: boolean; startTurn?: number; initialSignature?: string }
  getActiveToolNames?: () => string[]
  /** Only `submit` is used — narrowed for testability (interface segregation). */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** Canonical todo list accessor. Defaults to the process-wide TodoStore. */
  getTodos?: () => TodoItem[]
}

/** 多步任务但无 todo —— 软提醒触发的最小轮次。 */
const SOFT_EMPTY_TURN = 3
/** 清单写过但 N 轮未更新视为陈旧。对齐 claude code 的 10 轮门槛。 */
const STALE_TURNS = 10
/** 两次提醒之间的最小间隔(轮),抗每轮重复刷屏。 */
const COOLDOWN = 5
/** 至少有这么多工具调用才视为"实际多步推进"(过滤纯聊天轮)。 */
const MIN_ACTIVITY = 2
/** 快照里 pending 最多列举几项,保持单行。 */
const MAX_PENDING_IN_SNAPSHOT = 4

function snapshotLine(todos: TodoItem[]): string {
  const done = todos.filter(t => t.status === 'completed').length
  const inProgress = todos.filter(t => t.status === 'in_progress').map(t => t.content)
  const pending = todos.filter(t => t.status === 'pending').map(t => t.content)
  const parts: string[] = [`完成 ${done}/${todos.length}`]
  if (inProgress.length > 0) parts.push(`进行中: ${inProgress.join(' / ')}`)
  if (pending.length > 0) {
    const shown = pending.slice(0, MAX_PENDING_IN_SNAPSHOT).join(' / ')
    const extra = pending.length > MAX_PENDING_IN_SNAPSHOT ? ` 等${pending.length}项` : ''
    parts.push(`待办: ${shown}${extra}`)
  }
  return parts.join('｜')
}

export function createTodoReminderHook(deps: TodoReminderHookDeps): PostTurnRuntimeHook {
  const getTodos = deps.getTodos ?? defaultGetTodos

  // Closure state — task-level, survives the 5-entry recentToolHistory window.
  let taskKey: number | undefined
  let firstTurn = 0
  let lastSignature: string | null = null
  let lastTodoWriteTurn = 0
  let lastReminderTurn = Number.NEGATIVE_INFINITY

  return {
    phase: 'postTurn',
    name: 'todo-reminder',
    run(ctx: RuntimeHookContext) {
      const turn = ctx.snapshot.modelTurn ?? ctx.snapshot.turn
      const recentToolHistory = ctx.snapshot.recentToolHistory
      const task = deps.getTask?.()
      if (!task?.multiStep || !deps.getActiveToolNames?.().includes('todo')) return
      if (task.key !== taskKey) {
        taskKey = task.key; firstTurn = task.startTurn ?? turn; lastSignature = null
        lastTodoWriteTurn = turn; lastReminderTurn = -Infinity
      }
      const taskTurn = turn - firstTurn + 1
      const todos = getTodos()

      // Track freshness: a content change == the model just maintained the list.
      const signature = JSON.stringify(todos)
      if (signature !== lastSignature) {
        lastSignature = signature
        if (todos.length > 0) lastTodoWriteTurn = turn
      }

      // Only nudge when the model is actually doing multi-step work this task,
      // not on chat-only turns.
      if (recentToolHistory.length < MIN_ACTIVITY) return
      // Cooldown — never two reminders within COOLDOWN turns.
      if (turn - lastReminderTurn < COOLDOWN) return

      if (todos.length === 0) {
        if (taskTurn >= SOFT_EMPTY_TURN) {
          deps.advisoryBus.submit({
            key: 'todo-missing',
            priority: 0.5,
            category: 'todo',
            tier: 'operational',
            content: '【天枢】你已连续多步推进但还没建 todo。若任务有 3+ 步或多个子任务,先用 todo 工具列出有序步骤(建完把当前项标 in_progress),后续完成即时标 completed。单步琐碎任务可忽略本提醒。',
            ttl: 1,
            expect: { kind: 'tool_appears', tools: ['todo'] },
          })
          lastReminderTurn = turn
        }
        return
      }

      if (signature === task.initialSignature || todos.every(todo => todo.status === 'completed')) return
      // Non-empty list: nudge only when it has gone stale.
      const turnsSinceWrite = turn - lastTodoWriteTurn
      if (turnsSinceWrite >= STALE_TURNS) {
        deps.advisoryBus.submit({
          key: 'todo-stale',
          priority: 0.55,
          category: 'todo',
          tier: 'operational',
          content: `【天枢】todo 已 ${turnsSinceWrite} 轮未更新,可能与当前工作脱节。核对并更新清单(完成项标 completed、新发现的步骤补进去)。当前清单: ${snapshotLine(todos)}`,
          ttl: 1,
          expect: { kind: 'tool_appears', tools: ['todo'] },
        })
        lastReminderTurn = turn
      }
    },
  }
}
