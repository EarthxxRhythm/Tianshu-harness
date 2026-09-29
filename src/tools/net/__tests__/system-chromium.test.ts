/**
 * #302 系统 Chromium 识别——findSystemChromium 的平台路径表与 PATH 兜底。
 *
 * 全部走依赖注入（platform / exists / which / env），不依赖宿主真实安装：
 * CI 与开发机上都不假设 /usr/bin/chromium 存在。默认实现（真实 platform /
 * statSync / PATH 扫描）由「本机真机探针」在集成层验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSystemChromium } from '../system-chromium.js'

const never = () => undefined
const only = (...paths: string[]) => (p: string) => paths.includes(p)

test('#302: linux 命中 /usr/bin/chromium 常见路径', () => {
  assert.equal(
    findSystemChromium({ platform: 'linux', exists: only('/usr/bin/chromium'), which: never }),
    '/usr/bin/chromium',
  )
})

test('#302: linux 常见路径全不在时，PATH 查找兜底（非常规安装位置）', () => {
  const custom = '/opt/weird/bin/chromium'
  assert.equal(
    findSystemChromium({
      platform: 'linux',
      exists: only(custom),
      which: (cmd) => (cmd === 'chromium' ? custom : undefined),
    }),
    custom,
  )
})

test('#302: 系统完全没有时返回 undefined（探针据此维持 browser-missing）', () => {
  assert.equal(
    findSystemChromium({ platform: 'linux', exists: () => false, which: never }),
    undefined,
  )
})

test('#302: 平台隔离——linux 探测不会命中 darwin 路径', () => {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  assert.equal(
    findSystemChromium({ platform: 'linux', exists: only(mac), which: never }),
    undefined,
  )
})

test('#302: darwin 命中 Chrome.app 可执行文件', () => {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  assert.equal(
    findSystemChromium({ platform: 'darwin', exists: only(mac), which: never }),
    mac,
  )
})

test('#302: win32 按 env 展开 Program Files 下的 chrome.exe', () => {
  const p = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  assert.equal(
    findSystemChromium({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: only(p),
      which: never,
    }),
    p,
  )
})
