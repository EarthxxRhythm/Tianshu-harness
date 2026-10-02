import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInstallPlan,
  resolveBundledPlaywrightCli,
  runBrowserCLI,
  runBrowserStatus,
  PLAYWRIGHT_MIRROR_HOST,
} from '../browser-cli.js'

test('buildInstallPlan 优先用自带 node + playwright-core CLI（#303，绝对路径不依赖外部 npx）', () => {
  const plan = buildInstallPlan([], 'linux', null, '/app/rivet-runtime/node_modules/playwright-core/cli.js')
  assert.equal(plan.command, process.execPath)
  assert.deepEqual(plan.args, ['/app/rivet-runtime/node_modules/playwright-core/cli.js', 'install', 'chromium'])
  assert.equal(plan.env.PLAYWRIGHT_DOWNLOAD_HOST, PLAYWRIGHT_MIRROR_HOST)
})

test('buildInstallPlan --no-mirror 同样作用于自带 CLI 分支', () => {
  const plan = buildInstallPlan(['--no-mirror'], 'linux', null, '/x/cli.js')
  assert.equal('PLAYWRIGHT_DOWNLOAD_HOST' in plan.env, false)
})

test('buildInstallPlan 镜像 env 注入与自带 CLI 无关（默认带镜像）', () => {
  const plan = buildInstallPlan([], 'linux', null, null)
  assert.equal(plan.env.PLAYWRIGHT_DOWNLOAD_HOST, PLAYWRIGHT_MIRROR_HOST)
  assert.equal(plan.command, 'npx')
  assert.deepEqual(plan.args, ['playwright', 'install', 'chromium'])
})

test('buildInstallPlan pins playwright to the given version (#102)', () => {
  // 就绪检测按内嵌 playwright-core 的 browsers.json 找 revision；不钉版本的 npx
  // 会装最新 playwright 的另一个 revision，装完仍报未安装。
  const plan = buildInstallPlan([], 'darwin', '1.62.0', null)
  assert.deepEqual(plan.args, ['playwright@1.62.0', 'install', 'chromium'])
})

test('buildInstallPlan defaults to the embedded playwright-core version (npx 兜底)', () => {
  const embedded = createRequire(import.meta.url)('playwright-core/package.json') as { version: string }
  const plan = buildInstallPlan([], 'darwin', undefined, null)
  assert.deepEqual(plan.args, [`playwright@${embedded.version}`, 'install', 'chromium'])
})

test('buildInstallPlan uses npx.cmd on Windows (npx 兜底)', () => {
  assert.equal(buildInstallPlan([], 'win32', null, null).command, 'npx.cmd')
  assert.equal(buildInstallPlan([], 'linux', null, null).command, 'npx')
})

test('resolveBundledPlaywrightCli 在本仓库解析到真实 cli.js', () => {
  const cli = resolveBundledPlaywrightCli()
  assert.ok(cli, '仓库内 node_modules 有 playwright-core，应解析到 cli.js')
  assert.match(cli, /playwright-core[\\/]cli\.js$/)
})

test('runBrowserStatus returns 0/1 matching install state and writes something', async () => {
  let out = ''
  const code = await runBrowserStatus((s) => { out += s })
  assert.ok(out.length > 0)
  assert.ok(code === 0 || code === 1)
  // on this machine chromium is installed → expect ready
  if (code === 0) assert.match(out, /就绪/)
  else assert.match(out, /rivet browser install|playwright-core/)
})

test('runBrowserCLI prints usage for no subcommand (exit 0) and unknown (exit 1)', async () => {
  let out = ''
  const help = await runBrowserCLI([], (s) => { out += s })
  assert.equal(help, 0)
  assert.match(out, /rivet browser/)

  out = ''
  const unknown = await runBrowserCLI(['frobnicate'], (s) => { out += s })
  assert.equal(unknown, 1)
})

test('runBrowserCLI routes status/check to the probe', async () => {
  let out = ''
  const code = await runBrowserCLI(['status'], (s) => { out += s })
  assert.ok(code === 0 || code === 1)
  assert.ok(out.length > 0)
})
