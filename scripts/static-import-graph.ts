/**
 * 源码级静态 import 可达性分析（serve 启动模块图瘦身的量尺）。
 *
 * 计入：静态 `import ... from`、`import '...'`（副作用）、`export ... from`。
 * 不计：`import type`、成员全为 type 的命名导入/再导出、动态 `import()`、
 *      `require()`（后者不是本次口径内的启动静态边；dist 闭包量尺兜底）。
 *
 * 正则级扫描，刻意偏保守：会把「只当类型用但没写 type」的导入也算成边
 * （假红可接受，假绿不可接受）。无法解析的 specifier 记入 `unresolved` 供排查。
 *
 * CLI:
 *   npx tsx scripts/static-import-graph.ts [--entry src/server/serve.ts] [--root .]
 *     [--why <path>] [--top <n>] [--json]
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { builtinModules } from 'node:module'

const CANDIDATE_EXTS = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx'] as const

export interface StaticImportGraph {
  root: string
  /** 入口绝对路径。 */
  entry: string
  /** 可达模块：绝对路径 → 文件字节数（含入口自身）。 */
  modules: Map<string, number>
  /** BFS 父边：绝对路径 → 首次到达它的父模块（入口为 null）。 */
  parentOf: Map<string, string | null>
  /** 可达模块总字节数。 */
  bytes: number
  /** 解析不到项目文件的 specifier（`from <spec>` 原文，去重）。 */
  unresolved: string[]
  /** 静态图里出现的 bare 包 → 引入方（相对 root，去重）。node 内置不记。 */
  packages: Map<string, string[]>
  /** 入口 → 目标的最短链（相对 root 的路径数组）；不可达返回空数组。 */
  why(target: string): string[]
}

export interface AnalyzeOptions {
  /** 仓库根目录，默认 process.cwd()。 */
  root?: string
  /** 入口，相对 root 或绝对路径，默认 src/server/serve.ts。 */
  entry?: string
}

/** 去掉注释（字符串原样保留——import specifier 本身就在字符串里）。 */
function stripComments(src: string): string {
  let out = ''
  let state: 'code' | 'line' | 'block' | 'string' = 'code'
  let quote = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i++; continue }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i++; continue }
      if (c === "'" || c === '"' || c === '`') { state = 'string'; quote = c; out += c; continue }
      out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else out += ' '
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i++ } else out += c === '\n' ? '\n' : ' '
      continue
    }
    // string：原样复制；转义符后一位一并跳过，避免把 \" 误判为字符串结束
    out += c
    if (c === '\\') { out += n ?? ''; i++; continue }
    if (c === quote) state = 'code'
  }
  return out
}

/** `import { a, type B } from 'x'` / `export type { A } from 'x'` 的成员是否全为 type。 */
function allSpecifiersAreTypes(clause: string): boolean {
  const trimmed = clause.trim()
  if (!trimmed.startsWith('{')) return false
  const inner = trimmed.slice(1, trimmed.lastIndexOf('}'))
  const parts = inner.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length === 0) return false
  return parts.every(p => /^type\s+/.test(p))
}

/** 提取一个源码文件里的静态 specifier（相对路径 + bare 包；不含动态 import / require / type-only）。 */
export function extractStaticSpecifiers(source: string): string[] {
  const code = stripComments(source)
  const specs: string[] = []
  // import <clause> from '<spec>'（clause 内可含换行；不含引号/分号，避免跨语句）
  const importFrom = /(?:^|\n)[ \t]*import\s+(?!\()([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g
  for (const m of code.matchAll(importFrom)) {
    const clause = m[1]!
    const spec = m[2]!
    if (/^type\s/.test(clause.trim())) continue
    if (allSpecifiersAreTypes(clause)) continue
    specs.push(spec)
  }
  // import '<spec>'（副作用）
  const sideEffect = /(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g
  for (const m of code.matchAll(sideEffect)) {
    specs.push(m[1]!)
  }
  // export <clause> from '<spec>'（含 export * / export * as ns）
  const exportFrom = /(?:^|\n)[ \t]*export\s+(type\s+)?(\*|\{[^}]*\})[^'";]*?\s+from\s+['"]([^'"]+)['"]/g
  for (const m of code.matchAll(exportFrom)) {
    if (m[1]) continue
    const clause = m[2]!
    if (allSpecifiersAreTypes(clause)) continue
    const spec = m[3]!
    specs.push(spec)
  }
  return [...new Set(specs)]
}

function isProjectSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
}

/** bare specifier → 包名（scoped 取 @scope/name；`#internal` 原样）；非 bare 返回 null。 */
function packageNameOf(spec: string): string | null {
  if (isProjectSpecifier(spec)) return null
  if (spec.startsWith('#')) return spec
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? null
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)])
function isBuiltinSpecifier(spec: string): boolean {
  if (spec.startsWith('node:')) return true
  if (NODE_BUILTINS.has(spec)) return true
  return NODE_BUILTINS.has(spec.split('/')[0] ?? '')
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 把 TS 习惯的 `./x.js` 解析回 `./x.ts`，并尝试扩展名省略与目录 index。 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  const candidates: string[] = [base]
  const jsExt = /\.([cm]?js|jsx)$/.exec(base)
  if (jsExt) {
    const stem = base.slice(0, -jsExt[0].length)
    for (const ext of CANDIDATE_EXTS) candidates.push(stem + ext)
  } else if (!/\.[a-z0-9]+$/i.test(base)) {
    for (const ext of CANDIDATE_EXTS) candidates.push(base + ext)
  }
  for (const ext of CANDIDATE_EXTS) candidates.push(join(base, `index${ext}`))
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate)
  }
  return null
}

export function analyzeStaticImportGraph(options: AnalyzeOptions = {}): StaticImportGraph {
  const root = resolve(options.root ?? process.cwd())
  const entry = resolve(root, options.entry ?? 'src/server/serve.ts')
  const modules = new Map<string, number>()
  const parentOf = new Map<string, string | null>()
  const unresolved = new Set<string>()

  const packages = new Map<string, string[]>()
  const rel = (abs: string): string => relative(root, abs).split('\\').join('/')
  modules.set(entry, fileSize(entry))
  parentOf.set(entry, null)
  const queue: string[] = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const spec of extractStaticSpecifiers(source)) {
      if (!isProjectSpecifier(spec)) {
        const pkg = packageNameOf(spec)
        if (!pkg || isBuiltinSpecifier(spec)) continue
        const importers = packages.get(pkg) ?? []
        if (!importers.includes(rel(file))) importers.push(rel(file))
        packages.set(pkg, importers)
        continue
      }
      const target = resolveSpecifier(file, spec)
      if (!target) {
        unresolved.add(spec)
        continue
      }
      if (modules.has(target)) continue
      modules.set(target, fileSize(target))
      parentOf.set(target, file)
      queue.push(target)
    }
  }

  let bytes = 0
  for (const size of modules.values()) bytes += size

  const why = (target: string): string[] => {
    let abs = isAbsolute(target) ? resolve(target) : resolve(root, target)
    if (!modules.has(abs)) {
      const needle = target.split('\\').join('/')
      for (const candidate of modules.keys()) {
        if (rel(candidate) === needle || candidate.endsWith(`/${needle}`)) { abs = candidate; break }
      }
    }
    if (!modules.has(abs)) return []
    const chain: string[] = []
    let cursor: string | null | undefined = abs
    while (cursor) {
      chain.push(rel(cursor))
      cursor = parentOf.get(cursor) ?? null
    }
    return chain.reverse()
  }

  return { root, entry, modules, parentOf, bytes, unresolved: [...unresolved].sort(), packages, why }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mib = bytes / 1024 / 1024
  if (mib >= 1) return `${mib.toFixed(2)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function main(): void {
  const argv = process.argv.slice(2)
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: tsx scripts/static-import-graph.ts [--entry <path>] [--root <dir>] [--why <path>] [--packages] [--top <n>] [--json]')
    return
  }
  const root = arg('--root') ?? process.cwd()
  const entry = arg('--entry') ?? 'src/server/serve.ts'
  const graph = analyzeStaticImportGraph({ root, entry })
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      entry: relative(graph.root, graph.entry),
      modules: graph.modules.size,
      bytes: graph.bytes,
      unresolved: graph.unresolved,
      packages: Object.fromEntries([...graph.packages.entries()].sort()),
      reachable: [...graph.modules.keys()].map(p => relative(graph.root, p).split('\\').join('/')).sort(),
    }, null, 2))
    return
  }
  console.log(`entry=${relative(graph.root, graph.entry)} modules=${graph.modules.size} packages=${graph.packages.size} bytes=${graph.bytes} (${formatBytes(graph.bytes)})`)
  if (graph.unresolved.length > 0) {
    console.log(`unresolved (${graph.unresolved.length}): ${graph.unresolved.slice(0, 10).join(', ')}${graph.unresolved.length > 10 ? ' …' : ''}`)
  }
  const why = arg('--why')
  if (why) {
    const chain = graph.why(why)
    console.log(chain.length > 0 ? chain.join('\n  → ') : `${why} 不可达`)
  }
  if (argv.includes('--packages')) {
    for (const [pkg, importers] of [...graph.packages.entries()].sort()) {
      console.log(`  ${pkg}  ← ${importers.join(', ')}`)
    }
  }
  const top = Number(arg('--top') ?? '0')
  if (top > 0) {
    const rows = [...graph.modules.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
    for (const [path, size] of rows) console.log(`  ${formatBytes(size).padStart(10)}  ${relative(graph.root, path)}`)
  }
}

const invokedAsCli = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (invokedAsCli) main()