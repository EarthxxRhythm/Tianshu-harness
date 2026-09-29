export interface AuditRow {
  t?: number; turn?: number; model?: string; provider?: string; event?: string
  input?: number; output?: number; cacheRead?: number
  requestId?: string; attemptId?: string
  [key: string]: unknown
}
export interface AuditEntry { row: AuditRow; lines: number[]; confidence: 'identity' | 'legacy-pair' | 'unmerged' }

/** One file/session per invocation. Legacy pairing is a proposed view, never a rewrite. */
export function auditCacheLog(text: string): { raw: AuditRow[]; entries: AuditEntry[]; invalidLines: number[] } {
  const raw: AuditRow[] = [], entries: AuditEntry[] = [], invalidLines: number[] = []
  const groups = new Map<string, AuditEntry[]>()
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    let row: AuditRow
    try { row = JSON.parse(line); if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error() }
    catch { invalidLines.push(index + 1); return }
    raw.push(row)
    const entry: AuditEntry = { row, lines: [index + 1], confidence: 'unmerged' }
    if (row.event || typeof row.input !== 'number' || typeof row.output !== 'number') { entries.push(entry); return }
    const key = row.requestId && row.attemptId
      ? JSON.stringify(['id', row.provider, row.model, row.requestId, row.attemptId])
      : JSON.stringify(['legacy', row.provider, row.model, row.turn, row.input, row.output])
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group)
  })
  for (const group of groups.values()) {
    if (group[0]!.row.requestId && group[0]!.row.attemptId) {
      entries.push({ row: group.at(-1)!.row, lines: group.flatMap(x => x.lines), confidence: 'identity' }); continue
    }
    group.sort((a, b) => (a.row.t ?? Infinity) - (b.row.t ?? Infinity))
    for (let i = 0; i < group.length;) {
      const cluster = [group[i++]!]
      while (i < group.length && typeof group[i]!.row.t === 'number' && typeof cluster[0]!.row.t === 'number'
        && group[i]!.row.t! - cluster.at(-1)!.row.t! <= 100) cluster.push(group[i++]!)
      const [a, b] = cluster
      const pair = cluster.length === 2 && [a!, b!].every(x => typeof x.row.cacheRead === 'number'
        && x.row.cacheRead! >= 0 && x.row.cacheRead! <= x.row.input!)
        && (a!.row.cacheRead === 0 || b!.row.cacheRead === 0)
      if (pair) {
        const winner = a!.row.cacheRead! > b!.row.cacheRead! ? a! : b!
        entries.push({ row: { ...a!.row, ...b!.row, cacheRead: winner.row.cacheRead }, lines: cluster.flatMap(x => x.lines).sort((x, y) => x - y), confidence: 'legacy-pair' })
      } else entries.push(...cluster)
    }
  }
  entries.sort((a, b) => a.lines[0]! - b.lines[0]!)
  return { raw, entries, invalidLines }
}

export function summarizeAuditRows(rows: AuditRow[]) {
  const main = rows.filter(x => !x.event && typeof x.input === 'number' && Number.isFinite(x.input) && x.input > 0 && typeof x.cacheRead === 'number' && Number.isFinite(x.cacheRead) && x.cacheRead >= 0 && x.cacheRead <= x.input
    && (!x.usageFields || ((x.usageFields as Record<string, unknown>).input_tokens && (x.usageFields as Record<string, unknown>).cache_read_input_tokens)))
  const input = main.reduce((s, x) => s + x.input!, 0), cacheRead = main.reduce((s, x) => s + x.cacheRead!, 0)
  return { records: main.length, unknown: rows.filter(x => !x.event).length - main.length, input, cacheRead, hitRate: input ? cacheRead / input : null, zeroHits: main.filter(x => x.cacheRead === 0).length }
}
