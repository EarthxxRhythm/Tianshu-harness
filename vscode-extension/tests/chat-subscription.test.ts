import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SubscriptionGate } from '../src/chat/subscription-gate.ts'

// 订阅代际守卫：SidecarClient.subscribe 的取消只阻止重连，不中止在途流的回调
// （lsof 实测：turn 结束后遗留连接仍持续投递事件——同一事件被多个订阅各投一次，
// 聊天提示成倍重复）。因此订阅必须「单例 + 代际」：换会话即逻辑作废旧订阅，
// 回调凭旧代号丢弃；同会话多轮复用一条订阅。

test('首次 acquire：换代且非复用', () => {
  const gate = new SubscriptionGate()
  assert.deepEqual(gate.acquire('A'), { generation: 1, reuse: false })
  assert.equal(gate.isCurrent(1), true)
})

test('同会话再次 acquire：复用当前代号（不换代）', () => {
  const gate = new SubscriptionGate()
  gate.acquire('A')
  assert.deepEqual(gate.acquire('A'), { generation: 1, reuse: true })
})

test('换会话：换代，旧代号即刻失效（旧订阅在途回调据 isCurrent 丢弃）', () => {
  const gate = new SubscriptionGate()
  gate.acquire('A')
  assert.deepEqual(gate.acquire('B'), { generation: 2, reuse: false })
  assert.equal(gate.isCurrent(1), false)
  assert.equal(gate.isCurrent(2), true)
})

test('换回旧会话也换代（旧连接不能复活复用）', () => {
  const gate = new SubscriptionGate()
  gate.acquire('A')
  gate.acquire('B')
  assert.deepEqual(gate.acquire('A'), { generation: 3, reuse: false })
  assert.equal(gate.isCurrent(2), false)
  assert.equal(gate.isCurrent(3), true)
})

test('currentSession 反映当前归属', () => {
  const gate = new SubscriptionGate()
  assert.equal(gate.currentSession(), undefined)
  gate.acquire('A')
  assert.equal(gate.currentSession(), 'A')
  gate.acquire('B')
  assert.equal(gate.currentSession(), 'B')
})
