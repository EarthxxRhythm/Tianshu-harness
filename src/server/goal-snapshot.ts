import type { GoalTracker } from '../agent/goal-tracker.js'
import type { GoalSnapshot } from './session-manager.js'

export function snapshotGoal(t: GoalTracker): GoalSnapshot
export function snapshotGoal(t: GoalTracker | null): GoalSnapshot | null
export function snapshotGoal(t: GoalTracker | null): GoalSnapshot | null {
  if (!t) return null
  const terminalReason = t.getTerminalReason()
  return {
    goalId: t.getGoalId(),
    goal: t.getGoal(),
    status: t.getStatus(),
    iteration: t.getIteration(),
    maxIterations: t.getMaxIterations(),
    wallClockElapsedMs: t.getWallClockElapsedMs(),
    ...(t.getWallClockBudgetMs() !== undefined ? { wallClockBudgetMs: t.getWallClockBudgetMs() } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    successCriteria: t.getSuccessCriteria(),
    ...(t.getRollover() ? { rollover: t.getRollover() } : {}),
    ...(t.getLastVerdict() ? { lastVerdict: t.getLastVerdict()! } : {}),
  }
}

export function baselineGoalSnapshot(): GoalSnapshot {
  return { goalId: '', goal: '', status: 'active', iteration: 0, maxIterations: 0, wallClockElapsedMs: 0, successCriteria: [] }
}
