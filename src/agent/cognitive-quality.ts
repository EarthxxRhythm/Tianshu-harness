export type CognitiveFactQuality = 'measured' | 'partial' | 'missing' | 'vacuous' | 'not_applicable'
export const QUALITY_ORDER = ['efe', 'sensorium', 'flow', 'pal', 'evidence', 'user', 'plan', 'progress'] as const
export type CognitiveFactSource = typeof QUALITY_ORDER[number]
export const QUALITY_CODE: Record<CognitiveFactQuality, string> = {
  measured: 'm', partial: 'p', missing: 'x', vacuous: 'v', not_applicable: 'n',
}
