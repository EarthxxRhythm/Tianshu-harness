import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRoutes, type ServerState } from '../routes.js'
import { leaseStateFreshForTest, resetLeaseForTest } from '../parent-watchdog.js'

// POST /lease（WSL 热附着续租，2026-09-19 审查 ②）与流量续租
// （复审 ②补丁：withAuth 顺手续租——空闲超时语义）的路由契约。

describe('POST /lease', () => {
  let state: ServerState

  beforeEach(() => {
    state = { running: false, apiToken: 'tok-lease' }
  })

  it('无 Bearer → 401（fail-closed）', async () => {
    const routes = createRoutes(state)
    const res = await routes['POST /lease']!({}, {}, {}, null as never)
    assert.equal(res.status, 401)
  })

  it('带 token → 200 + leased:true（默认租期）', async () => {
    const routes = createRoutes(state)
    const res = await routes['POST /lease']!({}, {}, { authorization: 'Bearer tok-lease' }, null as never)
    assert.equal(res.status, 200)
    assert.deepEqual((res as { body: { leased: boolean } }).body, { leased: true })
  })

  it('显式 ms 透传（0 = 释放不炸）', async () => {
    const routes = createRoutes(state)
    const res = await routes['POST /lease']!({ ms: 0 }, {}, { authorization: 'Bearer tok-lease' }, null as never)
    assert.equal(res.status, 200)
  })

  // ── 流量续租（复审 ②补丁）：withAuth 顺手续租，空闲超时语义 ──

  it('任意认证请求顺手续租（GET /status 后租约新鲜）', async () => {
    resetLeaseForTest()
    assert.equal(leaseStateFreshForTest(), false, '前置：无租约')
    const routes = createRoutes(state)
    const res = await routes['GET /status']!({}, {}, { authorization: 'Bearer tok-lease' }, null as never)
    assert.equal(res.status, 200)
    assert.equal(leaseStateFreshForTest(), true, '认证流量顺手续租')
  })

  it('未认证请求不续租（fail-closed 边界一致）', async () => {
    resetLeaseForTest()
    const routes = createRoutes(state)
    const res = await routes['GET /status']!({}, {}, {}, null as never)
    assert.equal(res.status, 401)
    assert.equal(leaseStateFreshForTest(), false, '401 不续租')
  })
})
