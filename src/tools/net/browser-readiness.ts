/**
 * browser-readiness — 不启动浏览器的 chromium 就绪探测 + 缺失提示横幅。
 *
 * chromium 被 browser_debug / browser / web-fetch(render) / computer-use 多处依赖，
 * 但下载体积大（~150MB），不随包分发。此模块提供**零副作用**的就绪检查（用
 * `chromium.executablePath()` 解析路径 + `existsSync`，绝不 launch），供：
 *   - 启动期主动体检（main.ts，仅浏览器 preset 时）
 *   - `rivet browser status` 命令
 * 缺失时的提示统一复用 net/playwright-driver 的 PLAYWRIGHT_MANUAL_INSTALL_HINT，
 * 并指向一键命令 `rivet browser install`，避免多处文案漂移。
 */
import { findSystemChromium, loadPlaywrightCore, pickBrowserPath, PLAYWRIGHT_MANUAL_INSTALL_HINT, PLAYWRIGHT_CORE_INSTALL_HINT } from './playwright-driver.js'

export type BrowserReadyState =
  | 'ready' // chromium 可执行文件就位
  | 'browser-missing' // playwright-core 在，但浏览器没下载
  | 'module-missing' // playwright-core 模块本身缺失（打包残缺 / 未 npm i）

export interface ChromiumProbe {
  state: BrowserReadyState
  installed: boolean
  executablePath?: string
  /** 可执行文件来源：playwright 托管缓存 vs 系统浏览器（#303）。ready 时有值。 */
  source?: 'playwright' | 'system'
  /** 人类可读的缺失原因（module-missing / browser-missing 时有值）。 */
  reason?: string
}

/** playwright-core chromium 的最小结构（只收窄本模块用到的 executablePath）。 */
interface PwChromiumProbe {
  executablePath(): string
}

/**
 * 就绪判定的纯函数核心：托管路径存在 → ready(playwright)；否则系统浏览器
 * 命中 → ready(system)；都没有 → browser-missing。判据经 pickBrowserPath
 * 与启动侧（launchHeadlessChromium / browser-debug）**共用同一实现**——
 * check/use 不再各算各的（#302 C 根因的收口；2026-10-02 审查发现后落实）。
 */
export function resolveChromiumProbe(
  managedExecutablePath: string | undefined,
  systemPath: string | undefined,
): ChromiumProbe {
  const pick = pickBrowserPath(managedExecutablePath, systemPath)
  if (pick.executablePath) {
    return { state: 'ready', installed: true, executablePath: pick.executablePath, source: pick.source }
  }
  return {
    state: 'browser-missing',
    installed: false,
    executablePath: managedExecutablePath || undefined,
    reason: 'chromium 可执行文件不存在（未下载，且未找到系统浏览器）',
  }
}

/**
 * 探测 chromium 是否就绪。**不启动浏览器**——只解析预期可执行路径并检查文件存在。
 * 三态区分让上层能给出精准提示（装浏览器 vs 修依赖）。
 * #303：playwright 托管缓存缺失时追加系统浏览器探测（PATH + 常用安装位），
 * 发行版包管理器装的 chromium 直接判 ready，不必下 150MB。
 */
export async function probeChromium(): Promise<ChromiumProbe> {
  let mod: { chromium: PwChromiumProbe }
  try {
    mod = (await loadPlaywrightCore()) as { chromium: PwChromiumProbe }
  } catch (err) {
    // playwright-core 模块本身加载不了（打包 dist/node_modules 残缺 / 未 npm i）——
    // 这不是"浏览器没下载"，别给 playwright install 提示（会把排查引向错误方向）。
    return {
      state: 'module-missing',
      installed: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    }
  }
  try {
    return resolveChromiumProbe(mod.chromium.executablePath(), findSystemChromium())
  } catch (err) {
    // executablePath() 在极少数配置下也会抛——托管路径放弃，系统浏览器探测仍跑一次。
    void err
    return resolveChromiumProbe(undefined, findSystemChromium())
  }
}

/**
 * chromium 缺失横幅——仿 formatGitMissingBanner（env-check.ts）。就绪时返回空串。
 * 指向一键命令 `rivet browser install`（自动带国内镜像），并保留手动 npx 兜底。
 */
export function formatBrowserMissingBanner(probe: ChromiumProbe): string {
  if (probe.installed) return ''
  if (probe.state === 'module-missing') {
    // 依赖残缺不是装浏览器能解决的，单独指路——覆盖 CLI 全局安装 / 仓库开发 / 桌面端。
    return [
      '⚠ 浏览器自动化不可用：playwright-core 模块缺失（不是浏览器没下载）。',
      PLAYWRIGHT_CORE_INSTALL_HINT,
      probe.reason ? `  （原始错误：${probe.reason}）` : '',
    ].filter(Boolean).join('\n')
  }
  // browser-missing：给一键命令 + 桌面入口 + 手动兜底（后者含国内镜像 env）。
  return [
    '⚠ 浏览器自动化需要 chromium，尚未安装。一键安装：',
    '  rivet browser install',
    '  桌面端：设置 → 集成 → 浏览器（截图）→ 安装',
    `  （或手动：${PLAYWRIGHT_MANUAL_INSTALL_HINT}）`,
  ].join('\n')
}
