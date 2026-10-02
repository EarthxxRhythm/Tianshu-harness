/**
 * playwright-driver — playwright-core 共享加载与 headless chromium 启动。
 *
 * 浏览器依赖统一为 playwright-core（不含浏览器下载逻辑）；chromium 可执行
 * 文件完全交给 playwright-core 内建 registry 解析：
 *   1. PLAYWRIGHT_BROWSERS_PATH env（桌面端 sidecar 指向打包资源目录）
 *   2. 默认缓存目录（CLI：`npx playwright install chromium` 的落地处）
 * 浏览器缺失时抛带国内镜像安装提示的友好错误。
 *
 * 本模块只定义最小结构化接口（Pw*），调用方按需收窄——与
 * browser-debug/driver.ts 的 `as never` 动态加载同风格，避免构建期
 * 解析 playwright-core 的类型。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/** playwright-core 模块缺失时的安装引导——区分 CLI 安装用户 / 仓库内开发 / 桌面端。 */
export const PLAYWRIGHT_CORE_INSTALL_HINT = [
  'CLI 安装用户：npm install -g tianshu-harness（重新安装以补齐依赖），',
  '  或当前项目内：npm i playwright-core',
  '  仓库内开发：npm i playwright-core',
  '  桌面端：检查 dist/node_modules/playwright-core 是否完整',
].join('\n')

/** 手动安装命令（含国内镜像 env）——banner 的兜底行复用它，避免文案漂移。 */
/**
 * 内嵌 playwright-core 的版本。就绪检测按这个版本的 browsers.json 推 chromium
 * revision，所以安装也必须钉在同一版本：不带版本的 `npx playwright install`
 * 会拉 registry 最新的 playwright，装出另一个 revision，检测永远报未安装（#102）。
 * 模块缺失时返回 undefined（此时提示的是装 playwright-core，不是装浏览器）。
 */
export function resolvePlaywrightCoreVersion(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)('playwright-core/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** `npx` 的包 spec：能解析到内嵌版本就钉版本，否则（或显式传 null）退回裸包名。 */
export function playwrightInstallSpec(version: string | null | undefined = resolvePlaywrightCoreVersion()): string {
  return version ? `playwright@${version}` : 'playwright'
}

export const PLAYWRIGHT_MANUAL_INSTALL_HINT =
  `npx ${playwrightInstallSpec()} install chromium` +
  `（国内网络：PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright npx ${playwrightInstallSpec()} install chromium）`

// 两条入口都要给：只装了桌面端的用户没有 `rivet` 命令可敲，只报 CLI 命令等于把他
// 们指向一条走不通的路。
export const PLAYWRIGHT_INSTALL_HINT =
  'chromium 未安装。一键安装：终端 `rivet browser install`（自动带国内镜像），' +
  '或桌面端 设置 → 集成 → 浏览器（截图）里点安装。' +
  `手动：${PLAYWRIGHT_MANUAL_INSTALL_HINT}`

/**
 * 动态 specifier（变量形式），避免 tsc/tsup 构建期静态解析。
 * 返回 unknown——各调用方（render-pool / browser / browser-debug）按自己的
 * Pw* 接口收窄，互不耦合。
 */
export async function loadPlaywrightCore(): Promise<unknown> {
  const specifier = 'playwright-core'
  try {
    return await import(specifier)
  } catch (err) {
    // 模块解析失败 ≠ 浏览器没装。别在这条路径上给 `playwright install` 提示——
    // 打包运行时最常见的成因是 dist/node_modules 暂存残缺（空目录反而遮蔽了仓库
    // 里完整的包），提示装浏览器只会把排查引向错误方向。排查命令留给 CLI banner
    //（formatBrowserMissingBanner），这里只报事实 + 原始错误。
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      '无法加载 playwright-core 模块（不是浏览器缺失）。' +
        `\n（原始错误：${msg.split('\n')[0]}）`,
    )
  }
}

/** 启动错误是否由浏览器可执行文件缺失引起（此时才附安装提示）。 */
export function isBrowserMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('Executable') && msg.includes("doesn't exist")
}

// ── 系统浏览器定位（#303：发行版包管理器装的 chromium 不在 playwright 缓存里）──

/** PATH 查找 + 常见安装位的候选名（chromium 系优先；playwright 经 CDP 驱动它们）。 */
const SYSTEM_BROWSER_CANDIDATES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'microsoft-edge',
  'msedge',
  'brave-browser',
] as const

/** 各平台常用安装位（PATH 找不到时的补充；存在的才被采用）。 */
const SYSTEM_BROWSER_ABSOLUTE: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
    '/var/lib/flatpak/exports/bin/com.github.Eloston.UngoogledChromium',
  ],
}

/**
 * 在系统里找可用的 chromium 系浏览器（纯函数，可注入 platform/PATH/存在性判定）。
 * 先查 PATH 各目录，再查平台常用安装位；命中第一个存在的可执行文件即返回。
 * 找不到返回 undefined——调用方回落到 browser-missing 提示。
 */
export function findSystemChromium(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? '',
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const exe = platform === 'win32' ? (name: string) => `${name}.exe` : (name: string) => name
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const name of SYSTEM_BROWSER_CANDIDATES) {
      const p = `${dir}/${exe(name)}`
      try {
        if (exists(p)) return p
      } catch {
        // exists 注入器异常按不存在处理
      }
    }
  }
  for (const p of SYSTEM_BROWSER_ABSOLUTE[platform] ?? []) {
    try {
      if (exists(p)) return p
    } catch {
      // 同上
    }
  }
  return undefined
}

/** 浏览器可执行文件的来源：playwright 托管缓存 / 系统安装。 */
export type BrowserSource = 'playwright' | 'system'

export interface BrowserPathPick {
  executablePath?: string
  source?: BrowserSource
}

/**
 * launch 判据的共享内核（#302 check/use 一致性的**单一实现**）：
 *   1. 托管路径存在（existsSync）→ playwright；
 *   2. 系统路径命中 → system；
 *   3. 都没有 → 空（调用方回落 registry 默认解析 / browser-missing）。
 * 探测侧（browser-readiness.resolveChromiumProbe）与启动侧
 * （resolveLaunchExecutablePath，及经它的 launchHeadlessChromium / browser-debug）
 * 都经此收口——判据改一处即两侧生效，防再犯「探测与启动各算各的」双份实现漂移
 * （#302 的 C 类根因；2026-10-02 审查发现「声称共用、实为两份」后收口）。
 */
export function pickBrowserPath(
  managed: string | undefined,
  system: string | undefined,
): BrowserPathPick {
  if (managed && existsSync(managed)) return { executablePath: managed, source: 'playwright' }
  if (system) return { executablePath: system, source: 'system' }
  return {}
}

/**
 * 解析 launch 用的浏览器可执行文件路径——显式优先 + pickBrowserPath 判据。
 * 都没有返回 undefined——调用方回落 playwright registry 默认解析
 * （headless-shell 专属安装仍兼容）。
 */
export function resolveLaunchExecutablePath(
  chromium: { executablePath?(): string },
  explicit?: string,
  findSystem: () => string | undefined = findSystemChromium,
): string | undefined {
  if (explicit) return explicit
  let managed: string | undefined
  try {
    managed = chromium.executablePath?.()
  } catch {
    // registry 解析失败不致命——还有系统浏览器与默认解析两条路
  }
  return pickBrowserPath(managed, findSystem()).executablePath
}

export interface PwRoute {
  abort(errorCode?: string): Promise<void>
  continue(): Promise<void>
}
export interface PwRequest {
  url(): string
}
export type PwRouteHandler = (route: PwRoute, request: PwRequest) => Promise<void>
export interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  url(): string
  content(): Promise<string>
  route(url: string, handler: PwRouteHandler): Promise<void>
  close(): Promise<void>
  /** 以下为 actions 体系（B2）扩展——与真实 playwright Page 签名对齐。 */
  click(selector: string, opts?: Record<string, unknown>): Promise<void>
  fill(selector: string, text: string, opts?: Record<string, unknown>): Promise<void>
  press(selector: string, key: string, opts?: Record<string, unknown>): Promise<void>
  keyboard?: { press(key: string): Promise<void> }
  evaluate(script: string): Promise<unknown>
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>
}
export interface PwContext {
  newPage(): Promise<PwPage>
  close(): Promise<void>
}
export interface PwBrowser {
  newPage(): Promise<PwPage>
  newContext(opts: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
  isConnected?(): boolean
}
export interface PwChromium {
  launch(opts: Record<string, unknown>): Promise<PwBrowser>
}

export interface LaunchHeadlessOptions {
  proxy?: { server: string; bypass?: string }
  timeoutMs?: number
  /** 显式指定浏览器可执行文件（探测到的系统浏览器 / 调用方指定）。 */
  executablePath?: string
}

/**
 * 启动 headless chromium。可执行文件定位顺序（#303）：
 *   1. 显式 opts.executablePath（调用方指定优先）；
 *   2. playwright 托管的 full chromium（registry 解析 + PLAYWRIGHT_BROWSERS_PATH，
 *      桌面端打包浏览器零配置生效）——显式透传它同时绕开「检测按 full chromium、
 *      headless 启动却找 chromium-headless-shell」的 check/use 错位；
 *   3. 系统浏览器（chromium/chrome/edge/brave，PATH + 常用安装位）——发行版
 *      包管理器装的浏览器因此直接可用，不必再下 150MB。
 * 都没有才走 registry 默认解析（headless-shell 专属安装仍兼容）。缺失时抛带
 * 安装提示的友好错误；其余启动错误原样上抛。
 */
export async function launchHeadlessChromium(opts: LaunchHeadlessOptions = {}): Promise<PwBrowser> {
  const mod = (await loadPlaywrightCore()) as { chromium: PwChromium & { executablePath(): string } }
  const executablePath = resolveLaunchExecutablePath(mod.chromium, opts.executablePath)
  try {
    return await mod.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    })
  } catch (err) {
    if (isBrowserMissingError(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`${PLAYWRIGHT_INSTALL_HINT}\n（原始错误：${msg.split('\n')[0]}）`)
    }
    throw err
  }
}
