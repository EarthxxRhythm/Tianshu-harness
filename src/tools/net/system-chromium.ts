/**
 * system-chromium — 系统安装的 Chromium/Chrome 探测（#302）。
 *
 * playwright-core 的 `chromium.executablePath()` 只解析它自管缓存
 * （`~/.cache/ms-playwright` / PLAYWRIGHT_BROWSERS_PATH），**不感知**发行版包
 * 管理器装到 /usr/bin 的系统浏览器。issue #302：这类机器上 readiness 恒报
 * browser-missing、且「一键安装」路径常不可用（无 npx）——但系统 Chromium 完全
 * 可以被 playwright-core 直接驱动（`chromium.launch({ executablePath })`，报告
 * 者已实测）。
 *
 * 本模块只做「找路径」一件事：平台候选表 + PATH 查找。依赖全部可注入
 * （platform / exists / which / env），测试不依赖宿主真实安装。
 */
import { statSync } from 'node:fs'

/** 系统浏览器探测的依赖注入面（默认全部走真实实现）。 */
export interface SystemProbeDeps {
  /** 平台（默认 process.platform）。 */
  platform?: NodeJS.Platform
  /** 文件存在检查（默认 statSync.isFile——同名目录不算命中）。 */
  exists?: (p: string) => boolean
  /** PATH 命令查找（默认扫描 env.PATH）。 */
  which?: (cmd: string) => string | undefined
  /** 环境变量（默认 process.env；win32 候选路径展开用）。 */
  env?: NodeJS.ProcessEnv
}

/** 默认文件存在检查——statSync.isFile（目录同名时不算命中）。 */
export function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** linux 常见安装位置（顺序即优先级）。 */
const LINUX_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
]

/** darwin 常见安装位置。 */
const DARWIN_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

/** win32：从 env 展开 Program Files / LOCALAPPDATA 候选。 */
function win32Paths(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  const pf = env.ProgramFiles
  const pf86 = env['ProgramFiles(x86)']
  const local = env.LOCALAPPDATA
  if (pf) out.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`)
  if (pf86) out.push(`${pf86}\\Google\\Chrome\\Application\\chrome.exe`)
  if (local) out.push(`${local}\\Google\\Chrome\\Application\\chrome.exe`)
  return out
}

/** PATH 查找的候选命令名（覆盖非常规安装位置）。 */
const PATH_COMMANDS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  linux: ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'],
  darwin: ['chromium', 'google-chrome', 'google-chrome-stable'],
  win32: ['chrome.exe', 'chromium.exe'],
}

function defaultWhich(
  cmd: string,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
  env: NodeJS.ProcessEnv,
): string | undefined {
  // Windows 上 PATH 键的大小写不定（Path / PATH 都见过）。
  const raw = env.PATH ?? env.Path ?? ''
  const dirs = raw.split(platform === 'win32' ? ';' : ':')
  const sep = platform === 'win32' ? '\\' : '/'
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = dir.endsWith(sep) ? `${dir}${cmd}` : `${dir}${sep}${cmd}`
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * 找到系统安装的 Chromium/Chrome 可执行文件；没有则 undefined。
 * 先查平台常见路径，再按 PATH 兜底。
 */
export function findSystemChromium(deps: SystemProbeDeps = {}): string | undefined {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.exists ?? fileExists

  const candidates =
    platform === 'linux'
      ? LINUX_PATHS
      : platform === 'darwin'
        ? DARWIN_PATHS
        : platform === 'win32'
          ? win32Paths(env)
          : []
  for (const p of candidates) {
    if (exists(p)) return p
  }

  const commands = PATH_COMMANDS[platform] ?? []
  const which = deps.which ?? ((cmd: string) => defaultWhich(cmd, platform, exists, env))
  for (const cmd of commands) {
    const hit = which(cmd)
    if (hit) return hit
  }
  return undefined
}
