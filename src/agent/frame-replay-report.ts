/**
 * P3-D 观测报告：认知帧记录的六类反例分类 + 准入聚合（纯函数层）。
 *
 * CLI 壳见 `scripts/frame-replay-report.ts`；这里不做任何 IO，方便测试与
 * 未来在会话内复用。
 *
 * 六类反例映射（钉死，来自 P3-D 计划的审查修正 ④）：
 * - 「未知域 / 健康 flow」按 **P2 控制器语义**从 structureFlow 输出判定——
 *   quality missing 是 missing-data（另计入 degraded），不是未知域；
 *   degraded 不含某 turn 只证明数据全，不证明健康。
 * - 六类**非互斥**：同一 turn 可命中多类，逐类计数。
 */

import type { CognitiveFrameRecord, ReplayReport } from './cognitive-frame-replay.js'
import { replayCognitiveFrames } from './cognitive-frame-replay.js'

export const FRAME_CLASS_KEYS = [
  'healthyFlow',
  'unknownDomain',
  'palAttention',
  'verificationDebt',
  'userIntervention',
  'noTool',
] as const

export type FrameClassKey = typeof FRAME_CLASS_KEYS[number]

export const FRAME_CLASS_LABELS: Record<FrameClassKey, string> = {
  healthyFlow: '健康 flow',
  unknownDomain: '未知域',
  palAttention: 'PAL needs_user/stalled',
  verificationDebt: 'verification debt',
  userIntervention: 'user intervention',
  noTool: 'no-tool',
}

/** 单条记录的反例分类（非互斥）。 */
export function classifyFrameRecord(record: CognitiveFrameRecord): Set<FrameClassKey> {
  const classes = new Set<FrameClassKey>()
  if (record.structureFlow?.mode === 'flow') classes.add('healthyFlow')
  if (record.structureFlow?.reasons.includes('unknown-domain')) classes.add('unknownDomain')
  if (record.facts.pal?.anyNeedsUser || record.facts.pal?.anyStalled) classes.add('palAttention')
  if (record.facts.evidence.hasVerificationDebt) classes.add('verificationDebt')
  if (record.facts.user.intervened) classes.add('userIntervention')
  if (record.convergence?.abortCause === 'no-tool') classes.add('noTool')
  return classes
}

export interface SessionFrames {
  sessionId: string
  records: CognitiveFrameRecord[]
  /** JSONL parse 失败被跳过的行数（截断容错）。 */
  parseWarnings: number
}

export interface AdmissionThresholds {
  minSessions: number
  minRecords: number
}

/** P3-D 准入阈值（设计文档钉死）。 */
export const DEFAULT_ADMISSION: AdmissionThresholds = {
  minSessions: 15,
  minRecords: 300,
}

export interface AdmissionReport {
  sessionCount: number
  recordCount: number
  parseWarnings: number
  /** 关键 source（efe/sensorium）质量不足的记录数与占比。 */
  degradedCount: number
  degradedRatio: number
  replay: ReplayReport
  classCounts: Record<FrameClassKey, number>
  /** 准入判定：session/记录数达标 + 六类反例各 ≥1 + replay 零 violation。 */
  admitted: boolean
  /** 未满足的准入项（人话，报告直接打印）。 */
  missing: string[]
}

export function buildAdmissionReport(
  sessions: readonly SessionFrames[],
  thresholds: AdmissionThresholds = DEFAULT_ADMISSION,
): AdmissionReport {
  const allRecords = sessions.flatMap(s => s.records)
  const parseWarnings = sessions.reduce((sum, s) => sum + s.parseWarnings, 0)
  const replay = replayCognitiveFrames(allRecords)

  const classCounts = Object.fromEntries(
    FRAME_CLASS_KEYS.map(k => [k, 0]),
  ) as Record<FrameClassKey, number>
  for (const record of allRecords) {
    for (const key of classifyFrameRecord(record)) classCounts[key]++
  }

  const missing: string[] = []
  if (sessions.length < thresholds.minSessions) {
    missing.push(`session 数不足：${sessions.length}/${thresholds.minSessions}`)
  }
  if (allRecords.length < thresholds.minRecords) {
    missing.push(`记录数不足：${allRecords.length}/${thresholds.minRecords}`)
  }
  for (const key of FRAME_CLASS_KEYS) {
    if (classCounts[key] === 0) missing.push(`反例缺失：${FRAME_CLASS_LABELS[key]}`)
  }
  if (replay.violations.length > 0) {
    missing.push(`硬线违规 ${replay.violations.length} 条（准入要求为零）`)
  }

  return {
    sessionCount: sessions.length,
    recordCount: allRecords.length,
    parseWarnings,
    degradedCount: replay.degradedTurns.length,
    degradedRatio: allRecords.length === 0 ? 0 : replay.degradedTurns.length / allRecords.length,
    replay,
    classCounts,
    admitted: missing.length === 0,
    missing,
  }
}

/** JSONL 文本 → 记录数组（截断行容错：parse 失败/非 frame 记录跳过并计数）。 */
export function parseFrameLines(raw: string): { records: CognitiveFrameRecord[]; parseWarnings: number } {
  const records: CognitiveFrameRecord[] = []
  let parseWarnings = 0
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as CognitiveFrameRecord
      if (parsed && parsed.kind === 'cognitive-frame' && typeof parsed.turn === 'number') {
        records.push(parsed)
      } else {
        parseWarnings++
      }
    } catch {
      parseWarnings++
    }
  }
  return { records, parseWarnings }
}
