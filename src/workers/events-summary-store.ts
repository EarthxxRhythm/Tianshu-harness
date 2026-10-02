import { open, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
// @ts-ignore — source workers use native type stripping, without a .js resolver.
import { MANIFEST_LIMIT, SUMMARY_LIMIT, blockReference, sourceStamp, sameSource, validateBlock, validateManifest } from './events-summary-format.ts'
import type { BlockSummary, SourceStamp, SummaryManifest } from './events-summary-format.js'

export interface LoadedSummary { manifest: SummaryManifest; blocks: BlockSummary[]; bytes: number }
interface ValidatedSummary extends LoadedSummary { verifiedSource: SourceStamp }
const verified = new Map<string, ValidatedSummary>()
let cacheBytes = 0

export function clearEventsSummaryCache(file?: string): void {
  if (file === undefined) { verified.clear(); cacheBytes = 0; return }
  const old = verified.get(file)
  if (old) cacheBytes -= old.bytes
  verified.delete(file)
}
export function cachedSummary(file: string, source: SourceStamp, digest: string): LoadedSummary | undefined {
  const old = verified.get(file)
  if (!old || !sameSource(old.verifiedSource, source) || old.manifest.digest !== digest) return undefined
  verified.delete(file); verified.set(file, old)
  return old
}
export function cacheSummary(file: string, source: SourceStamp, summary: LoadedSummary): void {
  clearEventsSummaryCache(file)
  if (summary.bytes > SUMMARY_LIMIT) return
  while (verified.size >= 16 || cacheBytes + summary.bytes > SUMMARY_LIMIT) {
    const key = verified.keys().next().value
    if (key === undefined) break
    clearEventsSummaryCache(key)
  }
  verified.set(file, { ...summary, verifiedSource: source })
  cacheBytes += summary.bytes
}

const rootPath = (file: string): string => join(dirname(file), 'events.summary.json')
const blockPath = (file: string, digest: string): string => join(dirname(file), 'events.summary-blocks', digest + '.json')

/** Fixed-size read after stat: a concurrent append cannot bypass the size budget. */
async function boundedJson(file: string, limit: number): Promise<{ value: unknown; bytes: number }> {
  const handle = await open(file, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error('Summary exceeds size budget')
    const buffer = Buffer.alloc(Number(before.size))
    let position = 0
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position)
      if (!bytesRead) throw new Error('Summary truncated during read')
      position += bytesRead
    }
    if (!sameSource(sourceStamp(before), sourceStamp(await handle.stat({ bigint: true })))) throw new Error('Summary changed during read')
    return { value: JSON.parse(buffer.toString('utf8')), bytes: buffer.length }
  } finally { await handle.close() }
}

export async function readSummaryManifest(file: string): Promise<{ manifest: SummaryManifest; bytes: number }> {
  const result = await boundedJson(rootPath(file), MANIFEST_LIMIT)
  return { manifest: validateManifest(result.value), bytes: result.bytes }
}
export async function loadSummaryBlocks(file: string, manifest: SummaryManifest, rootBytes: number): Promise<LoadedSummary> {
  const blocks: BlockSummary[] = []
  let bytes = rootBytes
  for (const ref of manifest.blocks) {
    const result = await boundedJson(blockPath(file, ref.digest), SUMMARY_LIMIT - bytes)
    bytes += result.bytes
    blocks.push(validateBlock(result.value, ref))
  }
  return { manifest, blocks, bytes }
}

async function atomicJson(file: string, content: string): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp'
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, file)
  } finally { await unlink(tmp).catch(() => {}) }
}
export async function publishSummaryBlock(file: string, block: BlockSummary): Promise<{ bytes: number }> {
  const content = JSON.stringify(block)
  const bytes = Buffer.byteLength(content)
  if (bytes > SUMMARY_LIMIT) throw new Error('Summary block exceeds size budget')
  await atomicJson(blockPath(file, blockReference(block).digest), content)
  return { bytes }
}
export async function publishSummaryManifest(file: string, manifest: SummaryManifest): Promise<void> {
  const content = JSON.stringify(manifest)
  if (Buffer.byteLength(content) > MANIFEST_LIMIT) throw new Error('Manifest exceeds size budget')
  validateManifest(manifest)
  await atomicJson(rootPath(file), content)
}
