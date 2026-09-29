/**
 * issue #290 — 多个 sidecar 指向同一 desktop 目录时，非锁主的 schedule 写路径
 * 必须 fail closed。
 *
 * 根因：非锁主从未 start()/loadSchedule()，内存表恒空；但 /schedule 写路由与
 * schedule_create/delete 工具在所有进程都可用。一次 add/remove/update 的
 * persist 就是「空表 + 本次改动 = 整表覆写」，静默删掉锁主已落盘的任务；锁主
 * 下一次写盘又反向抹回（乒乓）。
 *
 * 本文件锁三件事：
 * 1. CronScheduler 写门（CronWiring 注入）拒绝所有 mutator 且不动磁盘；
 * 2. 非锁主 HTTP 写路由 503 + scheduler_not_owner，盘上任务原样保留；
 * 3. 非锁主 schedule_create/delete 工具拒绝且不覆写；owner 路径 T1+T2 共存。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildScheduleRoutes } from '../schedule-routes.js'
import {
  CronScheduler,
  createScheduledTask,
  setActiveScheduler,
  setScheduleWriteGuard,
  type ScheduleTable,
} from '../cron-scheduler.js'
import { CronLock } from '../cron-lock.js'
import { CronWiring } from '../cron-wiring.js'
import { TaskRegistry } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'
import { SCHEDULE_CREATE_TOOL, SCHEDULE_DELETE_TOOL, SCHEDULE_LIST_TOOL } from '../../tools/schedule/tool.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function makeTemp(): { dir: string; schedulePath: string; lockPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sched-owner-'))
  return {
    dir,
    schedulePath: join(dir, 'scheduled_tasks.json'),
    lockPath: join(dir, 'scheduled_tasks.lock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function readTable(path: string): ScheduleTable {
  return JSON.parse(readFileSync(path, 'utf-8')) as ScheduleTable
}

/** Persist one owner task the way the lock-owning sidecar would. */
function seedOwnerTask(schedulePath: string, prompt: string) {
  const owner = new CronScheduler({ schedulePath })
  const task = createScheduledTask(prompt, { type: 'interval', spec: '3600000' })
  owner.add(task)
  assert.equal(readTable(schedulePath).length, 1, 'precondition: owner task on disk')
  return { owner, task }
}

test('#290 CronScheduler write gate rejects every mutator and leaves disk untouched', () => {
  const { schedulePath, cleanup } = makeTemp()
  try {
    const { owner, task: t1 } = seedOwnerTask(schedulePath, 'owner task')
    const t2 = createScheduledTask('non-owner task', { type: 'interval', spec: '3600000' })
    let allowed = false
    owner.setWriteGate({
      canWrite: () => allowed,
      deniedReason: () => '当前 sidecar 未持有调度器锁（锁主 PID 1）',
    })

    assert.equal(owner.isWritable(), false)
    assert.match(owner.writeDeniedReason()!, /锁主 PID 1/)
    const before = readFileSync(schedulePath, 'utf-8')
    const denied = [
      () => owner.add(t2),
      () => owner.remove(t1.id),
      () => owner.setEnabled(t1.id, false),
      () => owner.update(t1.id, { prompt: 'hijack' }),
      () => owner.runNow(t1.id),
    ]
    for (const mutate of denied) {
      assert.throws(mutate, (err: unknown) => (err as { code?: string }).code === 'scheduler_not_owner')
    }
    // 事件触发不改定义：非锁主恒 fired=0（PR #295 口径），而不是抛进 watcher。
    assert.equal(owner.fireByEvent('startup'), 0)
    assert.equal(readFileSync(schedulePath, 'utf-8'), before, 'denied mutators must not write the table')

    // 锁主恢复（例如锁切换）后，同一实例重新可写。
    allowed = true
    owner.add(t2)
    assert.deepEqual(readTable(schedulePath).map(t => t.id), [t1.id, t2.id])
  } finally {
    cleanup()
  }
})

test('#290 non-owner /schedule writes return 503 and never clobber the owner table', async () => {
  const { schedulePath, cleanup } = makeTemp()
  try {
    const { task: t1 } = seedOwnerTask(schedulePath, 'owner task')
    const nonOwner = new CronScheduler({ schedulePath })
    nonOwner.setWriteGate({
      canWrite: () => false,
      deniedReason: () => '当前 sidecar 未持有调度器锁（锁主 PID 1）：定时任务写入由锁主受理。',
    })
    const router = createRouter(buildScheduleRoutes(nonOwner, TOKEN))
    const writes: Array<['POST' | 'PATCH' | 'DELETE', string, Record<string, unknown>]> = [
      ['POST', '/schedule', { prompt: 'B task', trigger: { type: 'interval', spec: '60000' } }],
      ['PATCH', `/schedule/${t1.id}`, { prompt: 'hijack' }],
      ['DELETE', `/schedule/${t1.id}`, {}],
      ['POST', `/schedule/${t1.id}/pause`, { enabled: false }],
      ['POST', `/schedule/${t1.id}/stop`, {}],
      ['POST', `/schedule/${t1.id}/run-now`, {}],
    ]
    for (const [method, path, body] of writes) {
      const res = await router(method, path, body, AUTH)
      assert.equal(res.status, 503, `${method} ${path} must fail closed on a non-owner`)
      const error = (res.body as { error?: string }).error ?? ''
      assert.match(error, /scheduler_not_owner/, `${method} ${path}`)
      assert.match(error, /lock/, `${method} ${path} (PR #295 503 断言口径)`)
    }
    // focus 触发无覆写面：不守卫，非锁主 200 fired=0（公开仓 PR #295 口径）。
    const focus = await router('POST', '/schedule/trigger-focus', {}, AUTH)
    assert.equal(focus.status, 200)
    assert.equal((focus.body as { fired: number }).fired, 0)
    assert.deepEqual(readTable(schedulePath).map(t => t.id), [t1.id], 'owner task must survive every denied non-owner write')
    // 读路径不需要锁：列表仍可访问；非锁主内存表为空（不冒充有数据）。
    const list = await router('GET', '/schedule', {}, AUTH)
    assert.equal(list.status, 200)
  } finally {
    cleanup()
  }
})

test('#290 公开仓 PR #295 口径：isWriteAllowed 路由选项 + setScheduleWriteGuard 工具全局门', async () => {
  const { dir, schedulePath, cleanup } = makeTemp()
  try {
    const { task: t1 } = seedOwnerTask(schedulePath, 'owner task')
    const before = readFileSync(schedulePath, 'utf-8')
    const scheduler = new CronScheduler({ schedulePath })
    scheduler.load() // 锁主语义：路由放行前已经载入磁盘表（否则放行本身就会覆写）

    // 路由侧：宿主显式注入 isWriteAllowed（不依赖 scheduler 实例写门）。
    const deniedRouter = createRouter(buildScheduleRoutes(scheduler, TOKEN, { isWriteAllowed: () => false }))
    const denied = await deniedRouter('POST', '/schedule', {
      prompt: 'B task', trigger: { type: 'interval', spec: '60000' },
    }, AUTH)
    assert.equal(denied.status, 503)
    assert.match((denied.body as { error: string }).error, /lock/)
    assert.equal(readFileSync(schedulePath, 'utf-8'), before)

    // 工具侧：PR #295 的全局写门（serve.ts 注入 lock.isOwner()）。
    setActiveScheduler(scheduler)
    setScheduleWriteGuard(() => false)
    const toolDenied = await SCHEDULE_CREATE_TOOL.execute({
      input: { prompt: 'B task', trigger: { type: 'interval', spec: '60000' } },
      toolUseId: 'toolu_pr295',
      cwd: dir,
    })
    assert.equal(toolDenied.isError, true)
    assert.match(toolDenied.content, /未持有调度锁/)
    assert.deepEqual(readTable(schedulePath).map(t => t.id), [t1.id])
    setScheduleWriteGuard(undefined)

    // 锁主放行：isWriteAllowed true 时同一路由正常落盘。
    const ownerRouter = createRouter(buildScheduleRoutes(scheduler, TOKEN, { isWriteAllowed: () => true }))
    const created = await ownerRouter('POST', '/schedule', {
      prompt: 'owner task 2', trigger: { type: 'interval', spec: '60000' },
    }, AUTH)
    assert.equal(created.status, 201)
    assert.deepEqual(readTable(schedulePath).map(t => t.id).length, 2)
  } finally {
    setScheduleWriteGuard(undefined)
    setActiveScheduler(undefined)
    cleanup()
  }
})

test('#290 CronWiring injects the lock gate: non-owner cannot add; owner loads disk and keeps T1+T2', async () => {
  const { dir, schedulePath, lockPath, cleanup } = makeTemp()
  try {
    const { task: t1 } = seedOwnerTask(schedulePath, 'owner task')
    const registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(dir, 'tasks')) })

    // 伪造另一个主机/进程持有锁 → acquire() 判定 contended。
    writeFileSync(lockPath, JSON.stringify({
      pid: 1,
      acquiredAt: new Date().toISOString(),
      hostname: 'other-sidecar',
    }), 'utf-8')
    const nonOwnerScheduler = new CronScheduler({ schedulePath, tickIntervalMs: 60_000 })
    const nonOwnerWiring = new CronWiring({
      scheduler: nonOwnerScheduler,
      registry,
      lock: new CronLock({ lockPath, healthCheckIntervalMs: 999_999 }),
    })
    await nonOwnerWiring.start()
    assert.equal(nonOwnerScheduler.isWritable(), false)
    assert.match(nonOwnerScheduler.writeDeniedReason()!, /锁主 PID 1/)
    const t2 = createScheduledTask('B task', { type: 'interval', spec: '60000' })
    assert.throws(() => nonOwnerScheduler.add(t2), (err: unknown) => (err as { code?: string }).code === 'scheduler_not_owner')
    assert.deepEqual(readTable(schedulePath).map(t => t.id), [t1.id], 'non-owner add must not clobber')
    await nonOwnerWiring.stop()

    // owner 路径：锁空了以后重新起飞；start() 在 await 前同步载入磁盘上 T1。
    rmSync(lockPath, { force: true })
    const ownerScheduler = new CronScheduler({ schedulePath, tickIntervalMs: 60_000 })
    const ownerWiring = new CronWiring({
      scheduler: ownerScheduler,
      registry,
      lock: new CronLock({ lockPath, healthCheckIntervalMs: 999_999 }),
    })
    await ownerWiring.start()
    try {
      assert.equal(ownerScheduler.isWritable(), true)
      assert.ok(ownerScheduler.get(t1.id), 'owner must load the disk table before accepting writes')
      ownerScheduler.add(t2)
      assert.deepEqual(readTable(schedulePath).map(t => t.id).sort(), [t1.id, t2.id].sort())
    } finally {
      await ownerWiring.stop()
    }
  } finally {
    cleanup()
  }
})

test('#290 schedule_create/delete tools refuse on a non-owner sidecar', async () => {
  const { dir, schedulePath, cleanup } = makeTemp()
  try {
    const { task: t1 } = seedOwnerTask(schedulePath, 'owner task')
    const nonOwner = new CronScheduler({ schedulePath })
    nonOwner.setWriteGate({
      canWrite: () => false,
      deniedReason: () => '当前 sidecar 未持有调度器锁（锁主 PID 1）',
    })
    setActiveScheduler(nonOwner)
    const create = await SCHEDULE_CREATE_TOOL.execute({
      input: { prompt: 'B task', trigger: { type: 'interval', spec: '60000' } },
      toolUseId: 'toolu_create',
      cwd: dir,
    })
    assert.equal(create.isError, true)
    assert.match(create.content, /锁主/)
    assert.deepEqual(readTable(schedulePath).map(t => t.id), [t1.id], 'tool create must not clobber')

    const del = await SCHEDULE_DELETE_TOOL.execute({
      input: { id: t1.id },
      toolUseId: 'toolu_delete',
      cwd: dir,
    })
    assert.equal(del.isError, true)
    assert.match(del.content, /锁主/)
    assert.deepEqual(readTable(schedulePath).map(t => t.id), [t1.id], 'tool delete must not clobber')

    const list = await SCHEDULE_LIST_TOOL.execute({ input: {}, toolUseId: 'toolu_list', cwd: dir })
    assert.match(list.content, /锁主/, 'non-owner list must not pretend the missing tasks are the whole world')
  } finally {
    setActiveScheduler(undefined)
    cleanup()
  }
})
