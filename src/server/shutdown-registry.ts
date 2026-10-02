/**
 * 关停请求注册表——把 serve 的优雅关停入口暴露给路由层。
 *
 * 为何需要这一层（2026-09-21）：`shutdownServer` 是 `serveCommand` 的闭包局部
 * 函数（serve.ts:1320），而路由表在 `runServe` 内构造——两者不是同一个函数，
 * 路由层够不到它。本模块用模块级单例做注册通道，与 `setActiveScheduler`
 * （cron-scheduler.ts:703）同款模式：serve 装配时登记，路由调用时取出。
 *
 * 用途：`POST /shutdown`（壳在杀 relay 前主动请 serve 优雅退）。时机关键——
 * WSL 发行版在最后一个客户端消失后 ~17s 被平台回收，serve 的宽限还没计满就被
 * 断电带走，close 链一行不跑；而在杀 relay 前调本端点时 relay 还活着、REST 走
 * localhost 转发，是唯一能拿到完整清理的窗口。
 *
 * 单例语义：一个 serve 进程只有一个关停入口，重复注册即覆盖（对齐
 * setActiveScheduler）。
 */
import { formatLog } from './logger.js'

type ShutdownHandler = () => void

let handler: ShutdownHandler | undefined

/** serve 装配时登记关停入口；传 undefined 注销（测试/关闭链用）。 */
export function setShutdownHandler(fn: ShutdownHandler | undefined): void {
  handler = fn
}

/** 读当前登记的 handler（诊断/测试用）。 */
export function getShutdownHandler(): ShutdownHandler | undefined {
  return handler
}

/**
 * 请求优雅关停。返回是否**已受理**（有 handler 即 true——不代表关停已完成：
 * 实际退出是异步的，调用方（壳）需自行等待/探测）。
 *
 * handler 抛异常不外传：关停请求已受理，handler 内部的失败属其自身问题
 * （serve 侧会走 exit 保险丝），路由层不该因此回 500——否则壳会误判为
 * 「端点不可用」而降级成直接杀 relay，反而丢掉清理机会。
 */
export function requestShutdown(): boolean {
  if (!handler) return false
  try {
    handler()
  } catch (err) {
    // 不走 setServerLogger（那会替换全局 logger 实例，副作用外溢）；直接按
    // 既有格式打一行 error——warn/error 本就走 stderr，不污染 jsonMode stdout 纯度。
    console.error(formatLog('ERROR', `shutdown handler threw (request already accepted): ${err instanceof Error ? err.message : String(err)}`))
  }
  return true
}

/** 测试注入口：清空登记（避免用例间串扰）。 */
export function resetShutdownHandlerForTest(): void {
  handler = undefined
}