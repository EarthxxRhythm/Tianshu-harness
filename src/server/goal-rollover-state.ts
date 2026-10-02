import type { GoalStateRecord } from '../agent/goal-state.js'
import type { SessionRecord } from './protocol.js'
import type { WaveGateRecord } from '../agent/wave-gate.js'

import type { GoalRolloverView } from './protocol.js'
export type { GoalRolloverView } from './protocol.js'

export interface GoalRolloverState extends GoalRolloverView {
  goal: GoalStateRecord
  startedAt: number
  updatedAt: number
  resumePhase?: 'handoff' | 'ready' | 'prepared' | 'starting'
  waveGate?: WaveGateRecord
  invokedSkills?: string[]
  capabilities: { disabledSkills: string[]; reviewGateOverride?: 'auto' | 'off' }
  policy: Pick<SessionRecord, 'cwd' | 'model' | 'domain' | 'approvalMode' | 'planMode' | 'askMode' | 'allowedTools' | 'reasoningEffort'>
}
export const SAFE_ROLLOVER_ID = /^[a-zA-Z0-9_-]{1,128}$/

export function isGoalRolloverState(value: unknown, sourceId: string): value is GoalRolloverState {
  if (!value || typeof value !== 'object') return false
  const s = value as GoalRolloverState
  const g = s.goal
  return s.from === sourceId && SAFE_ROLLOVER_ID.test(s.id) && typeof s.to === 'string'
    && s.to !== s.from && SAFE_ROLLOVER_ID.test(s.to)
    && ['handoff', 'ready', 'prepared', 'starting', 'complete', 'paused', 'cancelled'].includes(s.phase)
    && !!g && typeof g.goalId === 'string' && typeof g.objective === 'string'
    && !!g.budgetLimits && Number.isFinite(g.budgetLimits.contextWindow) && g.budgetLimits.contextWindow > 0
    && Number.isSafeInteger(g.iterationsUsed) && g.iterationsUsed >= 0
    && Number.isSafeInteger(g.budgetLimits.maxIterations) && g.budgetLimits.maxIterations > 0
    && Number.isFinite(g.wallClockAccumMs) && g.wallClockAccumMs >= 0
    && !!g.rollover && Number.isFinite(g.rollover.ratio) && g.rollover.ratio >= 0.2 && g.rollover.ratio <= 0.9
    && Number.isSafeInteger(s.generation) && s.generation >= 2 && s.generation <= s.maxSessions && s.maxSessions <= 20
    && Number.isFinite(s.startedAt) && Number.isFinite(s.updatedAt)
    && !!s.capabilities && Array.isArray(s.capabilities.disabledSkills) && s.capabilities.disabledSkills.every(k => typeof k === 'string')
    && (s.capabilities.reviewGateOverride === undefined || ['auto', 'off'].includes(s.capabilities.reviewGateOverride))
    && (s.waveGate === undefined || (typeof s.waveGate.passed === 'boolean' && Array.isArray(s.waveGate.checks)
      && Array.isArray(s.waveGate.changedFiles) && s.waveGate.changedFiles.every(f => typeof f === 'string')
      && Array.isArray(s.waveGate.commands) && s.waveGate.commands.every(c => typeof c === 'string')))
    && (s.invokedSkills === undefined || (Array.isArray(s.invokedSkills) && s.invokedSkills.every(k => typeof k === 'string')))
    && !!s.policy && typeof s.policy.cwd === 'string'
}
