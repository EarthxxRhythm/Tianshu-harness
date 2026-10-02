/**
 * SSE 心跳续租契约（2026-09-19 全链路推演缺口的最小化场景补丁）：
 * /events 连接在 L41 已过认证——心跳周期即续租周期。最小化场景
 * （refetchIntervalInBackground:false 前端轮询停摆）下 SSE 是唯一活跃
 * 信号；连接断开 → 心跳停 → 停止续租（空闲超时语义闭合）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerEventBus } from '../server-event-bus.js'
import { buildServerEventsRoute } from '../server-events-route.js'
import { leaseStateFreshForTest, resetLeaseForTest } from '../parent-watchdog.js'
import type { HealthBody } from '../health-route.js'
import { RUNTIME_CAPABILITIES } from '../protocol.js'

const TOKEN = 'lease-hb-token'

const healthBody = (): HealthBody => ({
  instanceId: 'lease-test-instance', readiness: 'ready',
  ok: true, version: '0.0.0-test', protocolVersion: 1, capabilities: RUNTIME_CAPABILITIES,
  uptimeMs: 1, sessionCount: 0, runningCount: 0,
  registryOk: true, configured: true,
})

test('SSE 心跳续租：认证连接的每次心跳刷新租约', async () => {
  resetLeaseForTest()
  assert.equal(leaseStateFreshForTest(), false, '前置：无租约')
  const bus = new ServerEventBus()
  const routes = buildServerEventsRoute(bus, TOKEN, {
    healthSnapshot: healthBody,
    heartbeatMs: 300, // 快心跳——测试不用真等 5s
  })
  // 模拟响应流：collect SseStream 写出的 chunk，close 回调记录
  const chunks: Uint8Array[] = []
  const res = {
    flushHeaders: () => {},
    writeHead: () => {},
    write: (chunk: Uint8Array) => { chunks.push(chunk); return true },
    end: () => {},
    on: (_ev: string, _fn: () => void) => {},
  }
  const out = await routes['GET /events']!({}, {}, { authorization: `Bearer ${TOKEN}` }, res as never)
  assert.equal(out.status, 200)
  // hello + health 首帧即刻；第一个心跳（300ms 后）应已续租
  assert.equal(leaseStateFreshForTest(), false, '首帧不续租（续租在心跳里）')
  await new Promise((r) => setTimeout(r, 450))
  assert.equal(leaseStateFreshForTest(), true, '心跳触发续租（最小化场景存活信号）')
  // 清理：测试进程直接退出即可（heartbeat unref，不阻塞）
})

test('SSE 401 不续租（未认证连接无存活信号）', async () => {
  resetLeaseForTest()
  const bus = new ServerEventBus()
  const routes = buildServerEventsRoute(bus, TOKEN, { healthSnapshot: healthBody })
  const res = {
    flushHeaders: () => {},
    writeHead: () => {},
    write: () => true,
    end: () => {},
    on: () => {},
  }
  const out = await routes['GET /events']!({}, {}, {}, res as never)
  assert.equal(out.status, 401)
  assert.equal(leaseStateFreshForTest(), false, '401 不续租')
})
