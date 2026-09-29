import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { auditCacheLog, summarizeAuditRows, type AuditRow } from '../src/cache/cache-log-audit.js'

const directory = process.argv[2]
if (!directory) throw new Error('Usage: node --import tsx scripts/audit-cache-log.ts <session-project-directory> [model]')
const model = process.argv[3]
const raw: AuditRow[] = [], corrected: AuditRow[] = [], proposedPairs: unknown[] = []
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  let content: string
  try { content = await readFile(join(directory, entry.name, 'cache-log.jsonl'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
  const audit = auditCacheLog(content), select = (row: AuditRow) => !model || row.model === model
  raw.push(...audit.raw.filter(select)); corrected.push(...audit.entries.map(x => x.row).filter(select))
  for (const result of audit.entries) if (result.confidence === 'legacy-pair' && select(result.row)) {
    proposedPairs.push({ session: entry.name, lines: result.lines, confidence: result.confidence })
  }
  if (audit.invalidLines.length) process.stderr.write(`${entry.name}: invalid lines ${audit.invalidLines.join(',')}\n`)
}
console.log(JSON.stringify({ raw: summarizeAuditRows(raw), proposed: summarizeAuditRows(corrected), proposedPairs,
  note: 'Read-only proposal; legacy pair identity is inferred, not an upstream billing reconciliation.' }, null, 2))
