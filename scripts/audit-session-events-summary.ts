/** Full semantic verification of one session's advisory index; never modifies the log. */
import { resolve } from 'node:path'
import { auditEventsSummary } from '../src/workers/events-summary.js'

const file = process.argv[2]
if (!file) {
  console.error('Usage: npx tsx scripts/audit-session-events-summary.ts <path/to/events.jsonl>')
  process.exitCode = 2
} else {
  const report = await auditEventsSummary(resolve(file))
  console.log(JSON.stringify(report))
  if (!report.valid) process.exitCode = 1
}
