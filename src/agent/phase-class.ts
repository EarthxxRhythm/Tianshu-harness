import type { StarPhase } from './star-event.js'
export type PhaseClass = 'explore' | 'plan' | 'execute' | 'verify' | 'deliver'
export const PHASE_CLASS_MAP: Record<StarPhase, PhaseClass> = {
  'tianshu-planning': 'plan', 'tianxuan-locating': 'explore',
  'tianji-decomposing': 'plan', 'tianquan-contracting': 'plan',
  'yuheng-implementing': 'execute', 'kaiyang-testing': 'verify',
  'yaoguang-delivering': 'deliver', 'tianshu-encore': 'plan',
}
