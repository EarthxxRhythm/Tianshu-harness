/**
 * #302 launch 层——playwright 自管 chromium 缺失时回退系统浏览器。
 *
 * deps 注入假的 playwright 模块与假系统探测：不启动任何真实浏览器，
 * 断言「失败 → 回退 → 重试」的编排与错误语义。真实 launch 行为由
 * 集成层真机探针验证（playwright-core 驱动系统 Chrome）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchHeadlessChromium, launchWithSystemFallback, type PwBrowser } from '../playwright-driver.js'

const MISSING = "browserType.launch: Executable doesn't exist at /pw/chromium-1234/chrome-linux64/chrome"

/** 假系统探测：只认 /usr/bin/chromium。 */
const SYS_LINUX = {
  platform: 'linux' as const,
  exists: (p: string) => p === '/usr/bin/chromium',
  which: () => undefined,
}

function makeFakeBrowser(): PwBrowser {
  return {
    newPage: async () => ({}) as never,
    newContext: async () => ({ newPage: async () => ({}) as never, close: async () => {} }),
    close: async () => {},
    on: () => {},
    isConnected: () => true,
  }
}

test('#302: registry 缺浏览器 → 回退系统 Chromium 重试（第二次 launch 带 executablePath）', async () => {
  const calls: Array<Record<string, unknown>> = []
  const fake = makeFakeBrowser()
  const browser = await launchHeadlessChromium({
    deps: {
      loadModule: async () => ({
        chromium: {
          launch: async (o: Record<string, unknown>) => {
            calls.push(o)
            if (!o.executablePath) throw new Error(MISSING)
            return fake
          },
        },
      }),
      ...SYS_LINUX,
    },
  })
  assert.equal(browser, fake)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.executablePath, undefined)
  assert.equal(calls[1]!.executablePath, '/usr/bin/chromium')
})

test('#302: 两边都没有 → 抛原错误并附安装提示（既有语义不变）', async () => {
  await assert.rejects(
    launchHeadlessChromium({
      deps: {
        loadModule: async () => ({
          chromium: {
            launch: async () => {
              throw new Error(MISSING)
            },
          },
        }),
        platform: 'linux',
        exists: () => false,
        which: () => undefined,
      },
    }),
    (err: Error) =>
      err.message.includes("Executable doesn't exist")
      && err.message.includes('chromium')
      && err.message.includes('install'),
  )
})

test('#302: 非浏览器缺失错误不触发回退（一次调用、原错误上抛）', async () => {
  let calls = 0
  await assert.rejects(
    launchHeadlessChromium({
      deps: {
        loadModule: async () => ({
          chromium: {
            launch: async () => {
              calls += 1
              throw new Error('boom: target crashed')
            },
          },
        }),
        ...SYS_LINUX,
      },
    }),
    /boom: target crashed/,
  )
  assert.equal(calls, 1)
})

test('#302: launchWithSystemFallback 编排语义——失败→回退；无回退目标时抛原错误', async () => {
  const seen: Array<string | undefined> = []
  const v = await launchWithSystemFallback(async (exe) => {
    seen.push(exe)
    if (!exe) throw new Error(MISSING)
    return 'ok'
  }, SYS_LINUX)
  assert.equal(v, 'ok')
  assert.deepEqual(seen, [undefined, '/usr/bin/chromium'])

  await assert.rejects(
    launchWithSystemFallback(
      async () => {
        throw new Error(MISSING)
      },
      { platform: 'linux', exists: () => false, which: () => undefined },
    ),
    /Executable doesn't exist/,
  )
})
