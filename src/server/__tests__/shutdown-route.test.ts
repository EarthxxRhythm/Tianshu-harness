/**
 * POST /shutdown —— 断开 WSL 时的主动关停入口。
 *
 * 动机（2026-09-21）：`disconnect_wsl` 此前只杀 relay，然后**指望** serve 自己
 * 感知父进程消失、走 watchdog 宽限/租期终局自退。但 WSL 发行版在最后一个客户端
 * 消失后 ~16.8-19.2s 就被平台回收（实测 `.rivet/scratch/recycle-timing.txt`；
 * 源是 `.wslconfig` 的 instanceIdleTimeout=15000）——serve 的宽限还没计满就被
 * 断电带走，整条 close 链（clearServerInfo / writeExitBreadcrumb /
 * flushAllAsync）一行不跑（实测 `w3-v5-result.txt`：BREADCRUMB=ABSENT +
 * SERVERINFO=PRESENT）。
 *
 * 修法：壳在杀 relay **之前**先调本端点请 serve 自己优雅退——此时 relay 还活着、
 * REST 走 localhost 转发不经 relay，是唯一能拿到完整清理的窗口。
 *
 * 契约要点：
 *   - 认证必需（fail-closed：无 token 不触发关停，否则成任意本地进程可用的 DoS 面）
 *   - 未注册 handler → 503（不假装成功——壳据 response 决定是否降级为「直接杀 relay」）
 *   - 有 handler → 200 + shuttingDown:true，且 handler 恰好被调一次
 *
 * 反证测试表（哪条会红）：
 *   - 摘掉 withAuth 包装 → 「无 Bearer 401」红
 *   - 无 handler 时返回 200 → 「503」红
 *   - 每次请求调 handler 多次 / 零次 → 「恰好一次」红
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRoutes, type ServerState } from '../routes.js'
import { setShutdownHandler, requestShutdown, resetShutdownHandlerForTest } from '../shutdown-registry.js'

describe('POST /shutdown', () => {
  let state: ServerState

  beforeEach(() => {
    state = { running: false, apiToken: 'tok-shutdown' }
    resetShutdownHandlerForTest()
  })

  afterEach(() => {
    resetShutdownHandlerForTest()
  })

  it('无 Bearer → 401 且不触发 handler（fail-closed：防任意本地进程 DoS）', async () => {
    let called = 0
    setShutdownHandler(() => { called++ })
    const routes = createRoutes(state)
    const res = await routes['POST /shutdown']!({}, {}, {}, null as never)
    assert.equal(res.status, 401)
    assert.equal(called, 0, '未认证请求绝不能触发关停')
  })

  it('错误 token → 401 且不触发 handler', async () => {
    let called = 0
    setShutdownHandler(() => { called++ })
    const routes = createRoutes(state)
    const res = await routes['POST /shutdown']!({}, {}, { authorization: 'Bearer wrong' }, null as never)
    assert.equal(res.status, 401)
    assert.equal(called, 0)
  })

  it('正确 token + 已注册 handler → 200 + shuttingDown:true，handler 恰好一次', async () => {
    let called = 0
    setShutdownHandler(() => { called++ })
    const routes = createRoutes(state)
    const res = await routes['POST /shutdown']!({}, {}, { authorization: 'Bearer tok-shutdown' }, null as never)
    assert.equal(res.status, 200)
    assert.deepEqual((res as { body: { shuttingDown: boolean } }).body, { shuttingDown: true })
    assert.equal(called, 1, '恰好一次——重复调用会撞 shutdownServer 的幂等守卫（二次进入 = exit(1) 强退）')
  })

  it('未注册 handler → 503（不假装成功：壳据此降级为直接杀 relay）', async () => {
    const routes = createRoutes(state)
    const res = await routes['POST /shutdown']!({}, {}, { authorization: 'Bearer tok-shutdown' }, null as never)
    assert.equal(res.status, 503, '无 handler 时返回 200 会让壳误以为已优雅关停')
  })
})

describe('shutdown-registry —— 模块级注册通道', () => {
  afterEach(() => {
    resetShutdownHandlerForTest()
  })

  it('未注册 → requestShutdown() 返回 false', () => {
    resetShutdownHandlerForTest()
    assert.equal(requestShutdown(), false)
  })

  it('注册后 → requestShutdown() 返回 true 并调用 handler', () => {
    let called = 0
    setShutdownHandler(() => { called++ })
    assert.equal(requestShutdown(), true)
    assert.equal(called, 1)
  })

  it('重复注册覆盖旧 handler（单例语义：一个 serve 只有一个关停入口）', () => {
    let a = 0
    let b = 0
    setShutdownHandler(() => { a++ })
    setShutdownHandler(() => { b++ })
    requestShutdown()
    assert.equal(a, 0, '旧 handler 不应再被调')
    assert.equal(b, 1)
  })

  it('传 undefined 注销 → 之后 requestShutdown() 返回 false', () => {
    setShutdownHandler(() => { /* noop */ })
    setShutdownHandler(undefined)
    assert.equal(requestShutdown(), false)
  })

  it('handler 抛异常时 requestShutdown 不把异常外传（返回 true，错误只记日志）', () => {
    setShutdownHandler(() => { throw new Error('boom') })
    assert.equal(requestShutdown(), true, 'handler 已受理请求——异常属 handler 内部，路由层不该 500')
  })
})