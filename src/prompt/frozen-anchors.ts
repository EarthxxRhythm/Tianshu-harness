import { createHash } from 'node:crypto'
import type { OaiContentPart, OaiMessage } from '../api/oai-types.js'

export interface FrozenAnchor {
  key: string
  type: 'text' | 'parts'
  prefix: string
  suffix: string
  legacyText?: string
}

/** Stores injection bytes, not another copy of the user's images. */
export class FrozenAnchors {
  revision = 0
  private fragments = new Map<string, string>()
  private intern(value: string): string {
    const found = this.fragments.get(value)
    if (found !== undefined) return found
    this.fragments.set(value, value)
    return value
  }
  private entries = new Map<string, FrozenAnchor>()
  constructor(entries: FrozenAnchor[] = []) {
    for (const entry of entries) this.entries.set(entry.key, { ...entry, prefix: this.intern(entry.prefix), suffix: this.intern(entry.suffix) })
  }
  static key(message: OaiMessage, occurrences: Map<string, number>): string {
    const hash = createHash('sha256').update(JSON.stringify(message.content)).digest('hex')
    const index = occurrences.get(hash) ?? 0
    occurrences.set(hash, index + 1)
    return `${hash}:${index}`
  }
  render(key: string, message: OaiMessage): string | OaiContentPart[] | undefined {
    const anchor = this.entries.get(key)
    if (!anchor) return undefined
    if (anchor.legacyText !== undefined) return anchor.legacyText
    if (Array.isArray(message.content)) return [
      { type: 'text', text: anchor.prefix }, ...message.content,
      ...(anchor.suffix ? [{ type: 'text' as const, text: anchor.suffix }] : []),
    ]
    return anchor.prefix + message.content + (anchor.suffix ? '\n\n' + anchor.suffix : '')
  }
  /** Trailer prefix bytes for a key — used by legacy snapshots that predate
   *  `frozenBaseHash`: same-config resume can still detect a stable-prefix match. */
  prefixOf(key: string): string | undefined { return this.entries.get(key)?.prefix }
  remember(key: string, message: OaiMessage, prefix: string, suffix: string, legacyText?: string, replace = false): void {
    const previous = this.entries.get(key)
    if (!previous || (replace && (previous.prefix !== prefix || previous.suffix !== suffix || previous.legacyText !== legacyText))) { this.revision++; this.entries.set(key, {
      key, type: Array.isArray(message.content) ? 'parts' : 'text', prefix: this.intern(prefix), suffix: this.intern(suffix),
      ...(legacyText !== undefined ? { legacyText } : {}),
    }) }
  }
  retain(keys: Set<string>): void {
    for (const key of this.entries.keys()) if (!keys.has(key)) { this.entries.delete(key); this.revision++ }
    const live = new Set([...this.entries.values()].flatMap(e => [e.prefix, e.suffix]))
    for (const value of this.fragments.keys()) if (!live.has(value)) this.fragments.delete(value)
  }
  forget(key: string): void { if (this.entries.delete(key)) this.revision++ }
  export(): FrozenAnchor[] { return [...this.entries.values()].map(entry => ({ ...entry })) }
}
