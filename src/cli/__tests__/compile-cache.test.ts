/**
 * CLI 编译缓存目录的版本化与清理门禁。
 *
 * 失效形态：目录不分版本 → npm 升级越频繁增长越快（本机曾 504 文件 / 12MB 平铺）；
 * 版本号带 `/` 不过滤 → 缓存目录变两层，清理会把当前目录误删成冷启动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  CLI_COMPILE_CACHE_KEEP_RECENT,
  cliCompileCacheDir,
  cliCompileCacheRoot,
  isLegacyNodeCacheEntry,
  markCliCompileCacheUsed,
  pruneStaleCliCompileCaches,
  sanitizeCacheTag,
} from '../compile-cache.js'
import { currentInstallVersion } from '../version.js'

test('sanitizeCacheTag：过滤到单层安全字符，异常版本号不会造出子目录', () => {
  assert.equal(sanitizeCacheTag('3.27.0'), '3.27.0')
  assert.equal(sanitizeCacheTag('3.27.0+meta/build'), '3.27.0_meta_build')
  assert.equal(sanitizeCacheTag('../../evil'), '.._.._evil')
  assert.equal(sanitizeCacheTag(''), 'unknown')
})

test('cliCompileCacheDir：目录始终是 compile-cache 下的单个组件', () => {
  const dir = cliCompileCacheDir('/tmp/rivet-home', '3.27.0/../../evil')
  const rel = relative(cliCompileCacheRoot('/tmp/rivet-home'), dir)
  assert.equal(rel.includes('/'), false, `缓存目录不能出现层级：${rel}`)
  assert.equal(rel, '3.27.0_.._.._evil', `版本号只做字符替换，不产生路径语义：${rel}`)
  assert.equal(CLI_COMPILE_CACHE_KEEP_RECENT, 3)
})

test('pruneStaleCliCompileCaches：当前 + 最近 N 个保留，旧目录/平铺文件清理', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-cli-cache-'))
  try {
    const current = join(root, '3.27.0')
    const oldDir = join(root, '3.20.0')
    const legacy = join(root, 'legacy-flat-cache')
    mkdirSync(current)
    mkdirSync(oldDir)
    writeFileSync(legacy, 'stale')
    await new Promise(r => setTimeout(r, 40))
    const recent = join(root, '3.26.0')
    mkdirSync(recent)

    pruneStaleCliCompileCaches(root, current, 1)

    assert.equal(existsSync(current), true, '当前版本目录必须保留')
    assert.equal(existsSync(recent), true, '最近使用的旧版本目录必须保留')
    assert.equal(existsSync(oldDir), false, '第 N+1 近的旧目录必须清理')
    assert.equal(existsSync(legacy), false, '无版本号的平铺文件必须清理')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('markCliCompileCacheUsed：刷新目录 mtime（Node 内层写入不会更新父目录）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cli-cache-touch-'))
  try {
    const before = statSync(dir).mtimeMs
    await new Promise(r => setTimeout(r, 40))
    markCliCompileCacheUsed(dir)
    assert.ok(statSync(dir).mtimeMs > before, '标记后 mtime 必须前进')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prune：最近使用（mtime 被刷新）的旧目录必须保留，不能按创建时间淘汰', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-cli-cache-used-'))
  try {
    const current = join(root, '3.27.0')
    const release = join(root, '3.26.0-release')
    mkdirSync(release)
    for (let i = 0; i < CLI_COMPILE_CACHE_KEEP_RECENT; i++) {
      await new Promise(r => setTimeout(r, 40))
      mkdirSync(join(root, `3.27.0-dev${i}`))
    }
    // 正式版在这批 dev 构建之间启动过：刷新 mtime 代表最近使用。
    await new Promise(r => setTimeout(r, 40))
    markCliCompileCacheUsed(release)
    await new Promise(r => setTimeout(r, 40))
    mkdirSync(current)

    pruneStaleCliCompileCaches(root, current, CLI_COMPILE_CACHE_KEEP_RECENT)

    assert.equal(existsSync(current), true, '当前版本目录必须保留')
    assert.equal(existsSync(release), true, '最近使用过的正式版缓存必须保留（不能按创建时间淘汰）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isLegacyNodeCacheEntry：只认旧平铺 Node 子目录，不误伤新版本目录', () => {
  assert.equal(isLegacyNodeCacheEntry('v24.18.0-arm64-deadbeef-501'), true)
  assert.equal(isLegacyNodeCacheEntry('v24.21.0-x'), true)
  assert.equal(isLegacyNodeCacheEntry('3.27.0-abc'), false)
  assert.equal(isLegacyNodeCacheEntry('v24.18.0'), false)
  assert.equal(isLegacyNodeCacheEntry('vNext-1'), false)
})

test('prune：旧平铺 v* 目录无条件清理，不占最近 N 份名额', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-cli-cache-legacy-'))
  try {
    const current = join(root, '3.27.0')
    const oldVersion = join(root, '3.26.0')
    const legacy = join(root, 'v24.18.0-arm64-deadbeef-501')
    mkdirSync(oldVersion)
    await new Promise(r => setTimeout(r, 40))
    mkdirSync(legacy) // mtime 最新：按时间排序会被保留
    await new Promise(r => setTimeout(r, 40))
    mkdirSync(current)

    pruneStaleCliCompileCaches(root, current, CLI_COMPILE_CACHE_KEEP_RECENT)

    assert.equal(existsSync(current), true, '当前版本目录必须保留')
    assert.equal(existsSync(legacy), false, '旧布局 v* 目录必须无条件清理（哪怕 mtime 最新）')
    assert.equal(existsSync(oldVersion), true, '真正的旧版本目录应占用保留名额')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('currentInstallVersion：从安装根读版本；无安装根回退 unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-version-cli-'))
  const empty = mkdtempSync(join(tmpdir(), 'rivet-version-none-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tianshu-harness', version: '9.9.9' }))
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true })
    const script = join(root, 'dist', 'cli', 'entry.js')
    writeFileSync(script, '')
    assert.equal(currentInstallVersion(script), '9.9.9')
    assert.equal(currentInstallVersion(join(empty, 'nested', 'entry.js')), 'unknown')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})
