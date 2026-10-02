/**
 * serve-agent 延迟加载器 + V8 编译缓存落盘（从 serve.ts 迁出）。
 *
 * 背景：serve-agent（agent 内核装配图）要到 listen 之后才延迟加载；
 * 桌面壳为 sidecar 设了 `NODE_COMPILE_CACHE`，但 Node 只在进程正常退出时
 * 写盘，而壳在退出/重启/更新时走 `kill_child_tree` 硬杀。于是每次运行新编译
 * 的内容常常没落盘。这里的做法：agent 图一旦加载成功，立刻 best-effort
 * `flushCompileCache()`——之后无论进程怎么死，下一次启动都能命中热缓存。
 *
 * 纪律：
 * - flush 失败绝不影响启动（只记一行日志）；
 * - flush 耗时只在 RIVET_SERVE_TIMING=1 时打印；
 * - `loadServeAgent` 失败不缓存 rejected promise（瞬态构建/加载失败不能
 *   永久打断后续会话创建）。
 */
import { flushCompileCache } from 'node:module'

type ServeAgentModule = typeof import('./serve-agent.js')

let serveAgentMod: ServeAgentModule | null = null
let serveAgentPromise: Promise<ServeAgentModule> | null = null

/** Load heavy agent assembly (deferred from cold /health path). */
export function loadServeAgent(): Promise<ServeAgentModule> {
  if (!serveAgentPromise) {
    const t0 = performance.now()
    serveAgentPromise = import('./serve-agent.js').then((m) => {
      serveAgentMod = m
      // import 耗时必须在 flush 前定格：同步写盘可能几十 ms，不能算进加载成本。
      const importMs = Math.round(performance.now() - t0)
      flushCompileCacheBestEffort()
      if (process.env.RIVET_SERVE_TIMING === '1') {
        console.error(`[serve-timing] serve-agent import ${importMs}ms`)
      }
      return m
    }).catch((err) => {
      // Don't cache a rejected promise — transient build/load failures would
      // permanently break session creation otherwise.
      serveAgentPromise = null
      throw err
    })
  }
  return serveAgentPromise
}

/**
 * agent 图已加载后立刻把 V8 编译缓存写盘（硬杀前）。失败只记一行，不影响启动。
 * `flush` 是单测注入缝（默认 node:module 的 `flushCompileCache`）。
 */
export function flushCompileCacheBestEffort(flush: () => void = flushCompileCache): void {
  if (typeof flush !== 'function') return
  try {
    const t0 = performance.now()
    flush()
    if (process.env.RIVET_SERVE_TIMING === '1') {
      console.error(`[serve-timing] compile-cache-flush ${Math.round(performance.now() - t0)}ms`)
    }
  } catch (err) {
    console.error(`[serve-timing] compile-cache-flush failed: ${(err as Error)?.message ?? err}`)
  }
}

/** serve-agent chunk 是否已开始 import（在飞或已完成）——测试观察 listen 后延迟预热用。 */
export function isServeAgentLoadStarted(): boolean {
  return serveAgentPromise !== null || serveAgentMod !== null
}

/** 已加载的 serve-agent 模块（未加载为 null）——关停链读 disposeSharedCwdResources 用。 */
export function getLoadedServeAgentModule(): ServeAgentModule | null {
  return serveAgentMod
}

export function _resetServeAgentForTests(): void {
  serveAgentMod = null
  serveAgentPromise = null
}
