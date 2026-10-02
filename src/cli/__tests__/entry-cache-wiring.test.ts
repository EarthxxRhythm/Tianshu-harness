/**
 * CLI 入口接线契约：单元函数测了不等于 entry.ts 真的调用了它们。
 *
 * 失效形态：把 entry.ts 改回不分版本的旧目录、删掉 pruneStaleCliCompileCaches
 * 调用、或删掉 markCliCompileCacheUsed 调用——函数单测照样绿（和 flush 接线第一轮
 * 没人守是同一种形状）。这里用临时 RIVET_HOME 真跑 `entry.ts --version`：
 * - 新目录：断言版本目录被创建、旧布局 `v*` 被清、真正的旧版本目录保留；
 * - 已存在目录：断言每次启动 mtime 前进（目录存在时不触发清理，和上一条前提不同）；
 * - NODE_COMPILE_CACHE 注入（桌面 sidecar 路径）时不创建 CLI 缓存目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentInstallVersion } from '../version.js'

const ENTRY = fileURLToPath(new URL('../entry.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function runEntry(rivetHome: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_COMPILE_CACHE
  Object.assign(env, { RIVET_HOME: rivetHome, HOME: rivetHome }, extraEnv)
  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY, '--version'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
}

test('entry.ts --version：创建版本目录、清旧布局 v* 目录、保留真正的旧版本目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-entry-cache-'))
  try {
    const root = join(home, 'cli', 'compile-cache')
    const legacy = join(root, 'v24.18.0-arm64-deadbeef-501')
    const oldVersion = join(root, '1.0.0-old')
    mkdirSync(legacy, { recursive: true })
    mkdirSync(oldVersion, { recursive: true })
    const version = currentInstallVersion(ENTRY)
    const current = join(root, version)

    const result = runEntry(home)
    assert.equal(result.status, 0, `entry --version 失败：${result.stderr}`)
    assert.match(result.stdout, /^tianshu-harness v/)
    assert.equal(existsSync(current), true, `entry.ts 必须创建版本目录 ${current}`)
    assert.equal(existsSync(legacy), false, 'entry.ts 必须真正调用清理（旧布局 v* 目录无条件删除）')
    assert.equal(existsSync(oldVersion), true, '真正的旧版本目录应占用保留名额')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('entry.ts --version：注入 NODE_COMPILE_CACHE 时不创建 CLI 缓存目录（桌面路径）', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-entry-nocache-'))
  try {
    const result = runEntry(home, { NODE_COMPILE_CACHE: join(home, 'desktop-cache') })
    assert.equal(result.status, 0, `entry --version 失败：${result.stderr}`)
    assert.equal(
      existsSync(join(home, 'cli', 'compile-cache')),
      false,
      '注入 NODE_COMPILE_CACHE 时 entry.ts 不应创建 CLI 目录',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('entry.ts --version：已存在的版本目录每次启动刷新 mtime（markCliCompileCacheUsed 接线）', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-entry-touch-'))
  try {
    const version = currentInstallVersion(ENTRY)
    const current = join(home, 'cli', 'compile-cache', version)
    // 先正常跑一次：让 Node 建好内层 v24… 子目录，此后父目录 mtime 不会再被
    // Node 自己的写入改动（条目都落在内层）。不先跑这一步，Node 首次创建内层
    // 子目录就会顺带刷新父目录 mtime，测不出 markCliCompileCacheUsed 是否被调用。
    const first = runEntry(home)
    assert.equal(first.status, 0, `entry --version 首次运行失败：${first.stderr}`)
    assert.equal(existsSync(current), true, `首次运行必须创建版本目录 ${current}`)

    const stale = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(current, stale, stale)
    const before = statSync(current).mtimeMs

    const second = runEntry(home)
    assert.equal(second.status, 0, `entry --version 二次运行失败：${second.stderr}`)
    assert.ok(
      statSync(current).mtimeMs > before,
      '目录已存在（不触发清理、Node 也只写内层）时，仍必须调用 markCliCompileCacheUsed 刷新 mtime',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
