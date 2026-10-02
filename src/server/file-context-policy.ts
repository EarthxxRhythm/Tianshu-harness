/** Zero-dependency policy shared by the desktop picker and sidecar. */
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024
export const FILE_CONTEXT_CACHE_MS = 30_000

export const CONTEXT_DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
}
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const TEXT = new Set(('txt md markdown mdx rst tex csv tsv json jsonc jsonl yaml yml toml xml svg html htm css scss sass less styl js jsx mjs cjs ts tsx mts cts vue svelte py pyi ipynb go rs java kt kts scala groovy c cc cpp cxx h hpp hh cs fs fsx vb swift m mm rb erb haml slim php phtml sh bash zsh fish ps1 bat cmd sql log ini cfg conf config lua r dart ex exs erl hrl clj cljs diff patch graphql gql').split(' '))
const NAMES = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'license', 'readme', 'changelog', '.gitignore', '.editorconfig', '.npmrc'])
const BINARY = new Set(('exe dll so dylib bin mp3 mp4 mov avi mkv wav flac aac zip rar 7z tar gz tgz bz2 xz dmg pkg iso jar war ear zipx ppt woff woff2 ttf otf ico icns db sqlite sqlite3').split(' '))
export type ContextFileKind = 'image' | 'text' | 'document' | 'candidate' | 'unsupported'

export function contextBasename(path: string): string { return path.split(/[/\\]/).pop() ?? path }
export function contextExtension(path: string): string {
  const name = contextBasename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}
export function isPrivateContextPath(path: string): boolean {
  const name = contextBasename(path).toLowerCase()
  return name === '.env' || name.startsWith('.env.') || /^(credentials|secrets?)(\.|$)/.test(name)
    || /private.*key|(?:^|[._-])(token|secret)(?:[._-]|$)/.test(name)
    || /\.(pem|key|p12|pfx)$/.test(name) || /^id_(rsa|ed25519|ecdsa)(\.|$)/.test(name)
}
export function contextFileKind(path: string): ContextFileKind {
  if (isPrivateContextPath(path)) return 'unsupported'
  const ext = contextExtension(path)
  if (IMAGES.has(ext)) return 'image'
  if (CONTEXT_DOCUMENT_MIME[ext]) return 'document'
  if (BINARY.has(ext)) return 'unsupported'
  if (TEXT.has(ext) || NAMES.has(contextBasename(path).toLowerCase())) return 'text'
  return 'candidate'
}
/** Preferences affect ranking, never permission or decoding decisions. */
export function contextFilePriority(path: string): number {
  const name = contextBasename(path).toLowerCase()
  const ext = contextExtension(path)
  if (/\.(min\.[a-z]+|map)$/.test(name) || /(^|[.-])lock($|\.)/.test(name)) return 4
  if (CONTEXT_DOCUMENT_MIME[ext] || ['md', 'markdown', 'mdx', 'txt', 'rst', 'tex', 'csv', 'tsv'].includes(ext)) return 0
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'py', 'sql'].includes(ext)) return 1
  return contextFileKind(path) === 'text' ? 2 : 3
}
export function isSuggestedContextFile(path: string, query = ''): boolean {
  const kind = contextFileKind(path)
  if (kind === 'unsupported') return false
  const q = query.trim().replace(/\\/g, '/').toLowerCase()
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const exact = q !== '' && (normalized === q || contextBasename(normalized) === q)
  if (exact) return true
  return kind !== 'candidate' && contextFilePriority(path) < 4
}
export function decodeContextText(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) throw new Error('text-too-large')
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { throw new Error('text-encoding') }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error('text-binary')
  return text
}
export function contextDataUrlBytes(dataUrl: string): Uint8Array {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
  if (!match || match[2]!.length % 4 !== 0) throw new Error('attachment-data')
  try { return Uint8Array.from(atob(match[2]!), c => c.charCodeAt(0)) }
  catch { throw new Error('attachment-data') }
}
