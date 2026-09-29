#!/usr/bin/env tsx
/**
 * restore-appimage-integrity.ts — 按签名清单复原「被打包链改写过的运行时字节」。
 *
 * ## 为什么需要它
 *
 * 完整性清单（`rivet-runtime/integrity.json`）在 Tauri 的 `beforeBuildCommand`
 * 末尾对 `dist/` 生成并签名。但 Tauri 的 Linux AppImage 打包链会在**组装 AppDir
 * 之后**用 linuxdeploy 对包里缺 rpath 的 ELF 统一注入 `$ORIGIN`，改写字节——
 * `native/better_sqlite3.node` 与 `node_modules/**` 里的几个 `.node`/`.so` 都被
 * 动过（2026-09-28 实测：am64 2122416→2140888 字节）。清单里的哈希是改写**前**
 * 的，于是壳重算摘要必然 `digest_mismatch`：Strict 策略下拒绝拉起 sidecar，
 * 否则静默降级 Basic。issue #286 报的正是这个。
 *
 * ## 它做什么
 *
 * 对解包出来的 bundle 目录（`squashfs-root/usr/lib/Tianshu/rivet-runtime`）：
 *   1. 验签 + 重算摘要（`verifyIntegrityManifest`）；
 *   2. 有差异时，**只**把「清单里有、构建源里也有、且构建源字节的哈希恰好等于
 *      清单期望值」的文件从构建源（`dist/`）拷回去，并保住权限位；
 *   3. 复验，仍然不一致就让调用方失败（退出码 1）。
 *
 * ## 失效方向（fail-closed）
 *
 * - 构建源缺该文件 / 构建源字节与清单不符 → **拒绝覆盖**（绝不用不可信字节去
 *   覆盖包内文件），报 `source-missing` / `source-digest-mismatch` 并失败；
 * - 包内多出清单之外的文件（`+`）→ 不自动删，报 `extra-file` 失败；
 * - 清单缺文件（`-`）→ 报 `missing-file` 失败；
 * - 清单验签失败 → 直接失败，不进恢复流程（清单是攻击者可写的文件，摘要字段
 *   必须来自可信签名才有资格当判据）；
 * - 清单条目里的相对路径逃出 bundle（`..` / 绝对路径）→ 报 `unsafe-path` 失败。
 *
 * 用法：
 *   tsx scripts/restore-appimage-integrity.ts --bundle <rivet-runtime 目录> --source <dist 目录> [--dry-run]
 * 退出码：0 = 一致或已复原；1 = 阻断（构建应随之失败）。
 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LICENSE_PUBLIC_KEY_B64 } from '../src/config/license-keys.js'
import {
  computeBundle,
  diffFiles,
  verifyIntegrityManifest,
  type IntegrityManifest,
  type IntegrityMode,
} from '../src/config/runtime-integrity.js'

export interface RestoreAction {
  /** bundle 内的相对路径（posix 分隔）。 */
  rel: string
  /** 拷回来源的绝对路径。 */
  from: string
}

export interface BlockedRestore {
  rel: string
  why: string
}

export interface RestorePlan {
  restorable: RestoreAction[]
  blocked: BlockedRestore[]
}

export interface RestoreOutcome {
  status: 'ok' | 'restored' | 'blocked'
  /** ok=清单一致；would-restore=仅演练；restored=已复原；否则为阻断原因。 */
  reason: string
  restored: string[]
  blocked: BlockedRestore[]
  dryRun: boolean
}

/** 清单条目必须是 bundle 内的普通相对路径——越界一律拒绝（纵深防御）。 */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel || isAbsolute(rel)) return false
  const normalized = normalize(rel.replace(/\\/g, '/'))
  if (normalized === '.' || normalized.startsWith('..')) return false
  if (normalized.split(sep).includes('..')) return false
  return true
}

export function planRestore(opts: {
  bundle: string
  source: string
  manifest: IntegrityManifest
  mode: IntegrityMode
}): RestorePlan {
  const actual = computeBundle(opts.bundle, opts.mode)
  const diff = diffFiles(opts.manifest.files, actual.files)

  const restorable: RestoreAction[] = []
  const blocked: BlockedRestore[] = []

  for (const entry of diff) {
    const kind = entry.slice(0, 1)
    const rel = entry.slice(1)
    // 路径安全检查对每条差异都前置——越界条目不管落在哪个分支都先被拦下。
    if (!isSafeRelativePath(rel)) {
      blocked.push({ rel, why: 'unsafe-path: manifest entry escapes the bundle' })
      continue
    }
    if (kind === '+') {
      blocked.push({ rel, why: 'extra-file: package has a file the signed manifest does not know（不自动删除）' })
      continue
    }
    if (kind === '-') {
      blocked.push({ rel, why: 'missing-file: manifest lists it but the package lacks it' })
      continue
    }
    const expected = opts.manifest.files[rel]
    if (expected === undefined) {
      blocked.push({ rel, why: 'manifest-entry-missing: diff 提到的文件不在清单里' })
      continue
    }
    const from = join(opts.source, rel)
    if (!existsSync(from)) {
      blocked.push({ rel, why: `source-missing: build source lacks ${from}` })
      continue
    }
    const actualHash = createHash('sha256').update(readFileSync(from)).digest('hex')
    if (actualHash !== expected) {
      blocked.push({ rel, why: `source-digest-mismatch: build source bytes ≠ manifest (${actualHash})` })
      continue
    }
    restorable.push({ rel, from })
  }

  return { restorable, blocked }
}

/** 按计划把构建源字节拷回 bundle，返回恢复的文件数（保住权限位）。 */
export function applyRestore(bundle: string, actions: RestoreAction[]): number {
  let restored = 0
  for (const action of actions) {
    if (!isSafeRelativePath(action.rel)) throw new Error(`拒绝越界恢复路径：${action.rel}`)
    const dest = join(bundle, action.rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(action.from, dest)
    chmodSync(dest, statSync(action.from).mode & 0o777)
    restored++
  }
  return restored
}

/**
 * 收口：一致即返回；有差异则（可选地）复原并复验；任何不确定情形一律 `blocked`。
 * 调用方只需判 `status === 'blocked'` 就让构建失败。
 */
export function restoreBundleIfNeeded(opts: {
  bundle: string
  source: string
  publicKeyB64: string
  mode: IntegrityMode
  dryRun?: boolean
}): RestoreOutcome {
  const dryRun = opts.dryRun ?? false
  const before = verifyIntegrityManifest(opts.bundle, { mode: opts.mode, publicKeyB64: opts.publicKeyB64 })
  if (before.ok) return { status: 'ok', reason: 'ok', restored: [], blocked: [], dryRun }
  if (before.reason !== 'digest_mismatch' && before.reason !== 'file_count_mismatch') {
    return { status: 'blocked', reason: before.reason, restored: [], blocked: [], dryRun }
  }
  const manifest = before.manifest
  if (!manifest) return { status: 'blocked', reason: 'manifest_unavailable', restored: [], blocked: [], dryRun }

  const plan = planRestore({ bundle: opts.bundle, source: opts.source, manifest, mode: opts.mode })
  if (plan.blocked.length > 0) {
    return { status: 'blocked', reason: 'restore-blocked', restored: [], blocked: plan.blocked, dryRun }
  }
  if (plan.restorable.length === 0) {
    return { status: 'blocked', reason: 'diff-without-action', restored: [], blocked: [], dryRun }
  }
  if (dryRun) {
    return {
      status: 'restored',
      reason: 'would-restore',
      restored: plan.restorable.map((a) => a.rel),
      blocked: [],
      dryRun,
    }
  }

  applyRestore(opts.bundle, plan.restorable)
  const after = verifyIntegrityManifest(opts.bundle, { mode: opts.mode, publicKeyB64: opts.publicKeyB64 })
  if (!after.ok) {
    return {
      status: 'blocked',
      reason: `post-restore-verify-failed:${after.reason}`,
      restored: [],
      blocked: plan.blocked,
      dryRun,
    }
  }
  return { status: 'restored', reason: 'restored', restored: plan.restorable.map((a) => a.rel), blocked: [], dryRun }
}

interface Args {
  bundle?: string
  source?: string
  mode: IntegrityMode
  publicKeyB64: string
  dryRun: boolean
  /** 只校验不发散：一致退出 0，有差异退出 1——给「终验」用，避免把该报的红修成绿。 */
  checkOnly: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'code', publicKeyB64: LICENSE_PUBLIC_KEY_B64, dryRun: false, checkOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`缺少参数值：${a}`)
      return v
    }
    switch (a) {
      case '--bundle':
        args.bundle = resolve(next())
        break
      case '--source':
        args.source = resolve(next())
        break
      case '--mode': {
        const m = next()
        if (m !== 'code' && m !== 'full') throw new Error(`--mode 只能是 code|full，收到 ${m}`)
        args.mode = m
        break
      }
      case '--public-key':
        args.publicKeyB64 = next()
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--check-only':
        args.checkOnly = true
        break
      case '--help':
      case '-h':
        console.log(
          [
            '用法: tsx scripts/restore-appimage-integrity.ts --bundle <rivet-runtime> --source <dist>',
            '                                            [--mode code|full] [--public-key <raw-b64>]',
            '                                            [--dry-run | --check-only]',
            '',
            '--dry-run   只出恢复计划不写盘；--check-only 只校验（有差异即退出 1）。',
            '退出码 0 = 一致或已复原；1 = 阻断（构建应随之失败）。',
          ].join('\n')
        )
        process.exit(0)
        break
      default:
        throw new Error(`未知参数：${a}`)
    }
  }
  if (!args.bundle) throw new Error('缺少 --bundle <rivet-runtime 目录>')
  if (!args.source) throw new Error('缺少 --source <构建源 dist 目录>')
  return args
}

// 直接在命令行运行时才执行 CLI；被测试 import 时保持纯模块。
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  const args = parseArgs(process.argv.slice(2))

  if (args.checkOnly) {
    const result = verifyIntegrityManifest(args.bundle!, { mode: args.mode, publicKeyB64: args.publicKeyB64 })
    if (result.ok) {
      console.log(`[integrity] ✓ 与签名清单一致（${result.manifest?.fileCount ?? '?'} 个文件）`)
      process.exit(0)
    }
    console.error(`[integrity] ✗ ${result.reason}：${(result.changed ?? []).join(', ')}`)
    process.exit(1)
  }

  const outcome = restoreBundleIfNeeded({
    bundle: args.bundle!,
    source: args.source!,
    publicKeyB64: args.publicKeyB64,
    mode: args.mode,
    dryRun: args.dryRun,
  })

  if (outcome.status === 'ok') {
    console.log(`[integrity] bundle 与签名清单一致（${args.bundle}）`)
    process.exit(0)
  }
  if (outcome.status === 'restored') {
    const verb = outcome.dryRun ? '将复原' : '已复原'
    console.log(`[integrity] ${verb} ${outcome.restored.length} 个被打包链改写的文件：`)
    for (const rel of outcome.restored) console.log(`   · ${rel}`)
    process.exit(0)
  }
  console.error(`[integrity] ✗ 阻断：${outcome.reason}`)
  for (const b of outcome.blocked) console.error(`   · ${b.rel} — ${b.why}`)
  console.error('[integrity] 不猜测、不静默放行——请人工核对后重跑构建。')
  process.exit(1)
}
