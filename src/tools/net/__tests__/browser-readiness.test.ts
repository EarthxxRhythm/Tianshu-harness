import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBrowserMissingBanner, probeChromium, type ChromiumProbe } from '../browser-readiness.js'

test('banner is empty when chromium is installed', () => {
  assert.equal(formatBrowserMissingBanner({ state: 'ready', installed: true, executablePath: '/x' }), '')
})

test('browser-missing banner points to the one-shot command + manual fallback', () => {
  const b = formatBrowserMissingBanner({ state: 'browser-missing', installed: false })
  assert.match(b, /rivet browser install/)
  assert.match(b, /chromium/)
  // manual fallback carries the mirror env for CN users
  // 收编迭代（PR #109 审查①）：钉版硬断言替代可选正则——manual 命令必须钉在
  // 内嵌 playwright-core 版本上，否则装出别的 revision、检测仍报未安装（#102）。
  const embedded = createRequire(import.meta.url)('playwright-core/package.json') as { version: string }
  assert.ok(
    b.includes(`npx playwright@${embedded.version} install chromium`),
    `banner 应含钉版手动命令 playwright@${embedded.version}：${b}`,
  )
})

test('module-missing banner does NOT tell the user to install a browser', () => {
  const b = formatBrowserMissingBanner({ state: 'module-missing', installed: false, reason: 'Cannot find module' })
  assert.match(b, /playwright-core/)
  assert.doesNotMatch(b, /rivet browser install/)
  // 引导安装 playwright-core 而非 chromium
  assert.match(b, /npm i playwright-core/)
  // 覆盖 CLI 安装用户
  assert.match(b, /CLI 安装用户/)
  assert.match(b, /原始错误/)
})

test('probeChromium returns a well-formed three-state result on this machine', async () => {
  const p: ChromiumProbe = await probeChromium()
  assert.ok(['ready', 'browser-missing', 'module-missing'].includes(p.state))
  assert.equal(typeof p.installed, 'boolean')
  // installed ⟺ state==='ready'
  assert.equal(p.installed, p.state === 'ready')
  if (p.installed) {
    assert.ok(p.executablePath, 'ready probe carries an executablePath')
    // #302：ready 必须带来源（playwright 自管缓存 / 系统安装）
    assert.ok(p.source === 'playwright' || p.source === 'system', 'ready probe carries a source')
  }
})

// NOTE: probeChromium 的 browser-missing 分支已用**子进程**（PLAYWRIGHT_BROWSERS_PATH
// 指向空目录，进程启动前注入）实测验证——playwright-core 在模块加载时读取该 env 并缓存，
// 同进程内运行时改 env 不生效，故这里不用 in-process env mutation 重测（会误判为 ready）。
// browser-missing 的**结构**（banner 文案、三态字段）由上面的纯函数测试覆盖。

// ==== #302：playwright 缓存缺失时回退系统浏览器（probeChromium 编排）====
//
// 修复前：probeChromium 只认 playwright 自管目录，系统装了 chromium/chrome 也报
// browser-missing（issue #302，发行版包管理器安装浏览器 Linux 用户全体命中）。
// 以 deps 注入驱动：loadPw 替代真实 playwright-core；platform/exists/which 喂给
// 系统探测——同进程内完全确定，不依赖宿主真实安装。

const PW_CACHE_MISSING = {
  chromium: { executablePath: () => '/nonexistent/pw-cache/chromium-1234/chrome-linux64/chrome' },
}

test('#302: playwright 缓存缺 + 系统 Chromium 在 → ready 且 source=system', async () => {
  const p = await probeChromium({
    loadPw: async () => PW_CACHE_MISSING,
    platform: 'linux',
    exists: (x) => x === '/usr/bin/chromium',
    which: () => undefined,
  })
  assert.equal(p.state, 'ready')
  assert.equal(p.installed, true)
  assert.equal(p.executablePath, '/usr/bin/chromium')
  assert.equal(p.source, 'system')
})

test('#302: playwright 缓存有 → 仍走 playwright（既有用户行为不变）', async () => {
  const p = await probeChromium({
    loadPw: async () => ({ chromium: { executablePath: () => '/pw-cache/chromium-1234/chrome' } }),
    platform: 'linux',
    exists: () => true,
    which: () => undefined,
  })
  assert.equal(p.state, 'ready')
  assert.equal(p.source, 'playwright')
  assert.equal(p.executablePath, '/pw-cache/chromium-1234/chrome')
})

test('#302: 两边都没有 → 维持 browser-missing（回归）', async () => {
  const p = await probeChromium({
    loadPw: async () => PW_CACHE_MISSING,
    platform: 'linux',
    exists: () => false,
    which: () => undefined,
  })
  assert.equal(p.state, 'browser-missing')
  assert.equal(p.installed, false)
})
