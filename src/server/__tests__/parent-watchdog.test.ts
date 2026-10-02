import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { installParentWatchdog, probeParentAlive, parentAliveFromErrno, renewLeaseForTest, resetLeaseForTest, maxMissesFromGraceEnv } from '../parent-watchdog.js'

const INTERVAL = 1000

// ── 租期终局（2026-09-19 拍板：跟着租期走）─────────────────────────────
// 语义：连接方曾续租（leaseUntil>0）且租约已过期 + 父死 → 立即自退——
// 租期就是 serve 的生命周期，不再等 miss 累积满宽限。从未租约
// （leaseUntil=0：本地 sidecar / CLI serve）不受影响，维持 miss 防误报。
// 必须放独立 describe：mock.timers 与真时钟租约互斥（leaseUntil 是
// Date.now()+ms 的绝对时间戳，mock 域里永不过期）。
describe('parent watchdog lease 终局（真时钟）', () => {
  it('父死 + 租约曾存在但已过期 → 首次探测即自退（不等宽限 miss）', async () => {
    const saved = process.env.RIVET_PARENT_PID
    const savedForm = process.env.RIVET_RUNTIME_FORM
    process.env.RIVET_PARENT_PID = 'PPID'
    process.env.RIVET_RUNTIME_FORM = 'wsl-attach' // 形态标记（2026-09-21 起与宽限解耦）
    try {
      resetLeaseForTest()
      renewLeaseForTest(150) // 租约 150ms 后过期
      await new Promise((r) => setTimeout(r, 250)) // 等过租约
      let gone = 0
      installParentWatchdog(() => { gone++ }, {
        intervalMs: 100,
        maxMisses: 20, // 显式 20 次 miss 兜底——若租期终局分支未生效，gone 恒 0
        probe: () => false, // 父已死
      })
      await new Promise((r) => setTimeout(r, 350)) // 3.5 个探测周期
      assert.ok(gone >= 1, '租约过期 + 父死 → 立即自退（租期即生命周期）')
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
      if (savedForm === undefined) delete process.env.RIVET_RUNTIME_FORM
      else process.env.RIVET_RUNTIME_FORM = savedForm
      resetLeaseForTest()
    }
  })

  it('租约过期但父活着 → 不自退（终局分支只在父死时生效）', async () => {
    const saved = process.env.RIVET_PARENT_PID
    process.env.RIVET_PARENT_PID = 'PPID'
    try {
      resetLeaseForTest()
      renewLeaseForTest(100)
      await new Promise((r) => setTimeout(r, 200))
      let gone = 0
      installParentWatchdog(() => { gone++ }, { intervalMs: 100, probe: () => true })
      await new Promise((r) => setTimeout(r, 350))
      assert.equal(gone, 0, '父活 → 一切照旧')
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
      resetLeaseForTest()
    }
  })

  it('从未租约（leaseUntil=0）→ 维持 miss 累积语义不回归', async () => {
    const saved = process.env.RIVET_PARENT_PID
    process.env.RIVET_PARENT_PID = 'PPID'
    try {
      resetLeaseForTest()
      let gone = 0
      installParentWatchdog(() => { gone++ }, { intervalMs: 100, maxMisses: 3, probe: () => false })
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(gone, 0, 'miss 未满不自退（防误报语义不变）')
      await new Promise((r) => setTimeout(r, 250))
      assert.ok(gone >= 1, 'miss 满自退（默认宽限路径不变）')
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
      resetLeaseForTest()
    }
  })

  it('本地 sidecar：父死且租约仍新鲜 → 不冻结 miss，第三次探测自退', async () => {
    const savedPpid = process.env.RIVET_PARENT_PID
    const savedForm = process.env.RIVET_RUNTIME_FORM
    process.env.RIVET_PARENT_PID = 'PPID'
    delete process.env.RIVET_RUNTIME_FORM
    try {
      resetLeaseForTest()
      renewLeaseForTest(5_000) // 测试结束前一直新鲜；旧实现会一直冻结
      let gone = 0
      installParentWatchdog(() => { gone++ }, { intervalMs: 100, maxMisses: 3, probe: () => false })
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(gone, 0, '首次 miss 不能误杀')
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(gone, 1, '即使仍有新鲜租约，本地孤儿也在第三次 miss 后退出')
    } finally {
      if (savedPpid === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = savedPpid
      if (savedForm === undefined) delete process.env.RIVET_RUNTIME_FORM
      else process.env.RIVET_RUNTIME_FORM = savedForm
      resetLeaseForTest()
    }
  })

  it('WSL attach：父死且租约新鲜 → 冻结 miss，租约过期后自退', async () => {
    const savedPpid = process.env.RIVET_PARENT_PID
    const savedForm = process.env.RIVET_RUNTIME_FORM
    process.env.RIVET_PARENT_PID = 'PPID'
    process.env.RIVET_RUNTIME_FORM = 'wsl-attach'
    try {
      resetLeaseForTest()
      renewLeaseForTest(800)
      let gone = 0
      installParentWatchdog(() => { gone++ }, { intervalMs: 100, maxMisses: 3, probe: () => false })
      await new Promise((r) => setTimeout(r, 450))
      assert.equal(gone, 0, '租约新鲜时不得按三次 miss 自退')
      await new Promise((r) => setTimeout(r, 550))
      assert.equal(gone, 1, '租约过期后只退出一次')
    } finally {
      if (savedPpid === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = savedPpid
      if (savedForm === undefined) delete process.env.RIVET_RUNTIME_FORM
      else process.env.RIVET_RUNTIME_FORM = savedForm
      resetLeaseForTest()
    }
  })

  it('非 attach 形态（无 RUNTIME_FORM）+ 租约过期 + 父死 → 不走终局，仍按 miss 累积（本地 sidecar 防孤儿路径）', async () => {
    const saved = process.env.RIVET_PARENT_PID
    const savedForm = process.env.RIVET_RUNTIME_FORM
    process.env.RIVET_PARENT_PID = 'PPID'
    delete process.env.RIVET_RUNTIME_FORM // 本地 sidecar / CLI serve 形态
    try {
      resetLeaseForTest()
      renewLeaseForTest(100) // 前端曾连通 → 有租约（withAuth 流量续租不分形态）
      await new Promise((r) => setTimeout(r, 200)) // 等过租约
      let gone = 0
      // 若无形态门槛（cad4a48ad 版本），此场景会立即自退——本测试即红
      installParentWatchdog(() => { gone++ }, { intervalMs: 100, maxMisses: 3, probe: () => false })
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(gone, 0, '租约过期但非 attach 形态——不走终局立即自退')
      await new Promise((r) => setTimeout(r, 250))
      assert.ok(gone >= 1, '仍按 miss 累积自退（孤儿 node.exe 尽快让出端口）')
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
      if (savedForm === undefined) delete process.env.RIVET_RUNTIME_FORM
      else process.env.RIVET_RUNTIME_FORM = savedForm
      resetLeaseForTest()
    }
  })
})

describe('parent watchdog grace（连续 miss 才自杀）', () => {
  let savedPpid: string | undefined

  beforeEach(() => {
    savedPpid = process.env.RIVET_PARENT_PID
    process.env.RIVET_PARENT_PID = '4242'
    mock.timers.enable({ apis: ['setInterval'] })
  })

  afterEach(() => {
    mock.timers.reset()
    if (savedPpid === undefined) delete process.env.RIVET_PARENT_PID
    else process.env.RIVET_PARENT_PID = savedPpid
  })

  it('单次瞬时探测失败不触发退出', () => {
    const probes = [false, true, true, true]
    let gone = 0
    installParentWatchdog(() => { gone++ }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => probes.shift() ?? true,
    })

    mock.timers.tick(INTERVAL * 4)
    assert.equal(gone, 0, '一次误报后恢复，不得自杀')
  })

  it('连续 3 次失败触发退出，并带上 ppid 与 miss 数', () => {
    let captured: { ppid: number; misses: number } | null = null
    installParentWatchdog(info => { captured = info }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => false,
    })

    mock.timers.tick(INTERVAL * 2)
    assert.equal(captured, null, '前 2 次 miss 还在宽限期内')
    mock.timers.tick(INTERVAL)
    assert.deepEqual(captured, { ppid: 4242, misses: 3 })
  })

  it('失败后恢复会清零计数——间歇性 miss 永不累积到退出', () => {
    // 模式：失败、失败、成功 循环 —— 永远到不了连续 3 次
    let call = 0
    let gone = 0
    installParentWatchdog(() => { gone++ }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => (call++ % 3) === 2,
    })

    mock.timers.tick(INTERVAL * 30)
    assert.equal(gone, 0)
  })

  it('触发退出后定时器停止——回调只会触发一次', () => {
    let gone = 0
    installParentWatchdog(() => { gone++ }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => false,
    })

    for (let i = 0; i < 10; i++) mock.timers.tick(INTERVAL)
    assert.equal(gone, 1)
  })

  it('RIVET_PARENT_PID 缺失或非法时是 no-op', () => {
    delete process.env.RIVET_PARENT_PID
    let gone = 0
    installParentWatchdog(() => { gone++ }, { intervalMs: INTERVAL, maxMisses: 1, probe: () => false })
    mock.timers.tick(INTERVAL * 5)
    assert.equal(gone, 0)

    process.env.RIVET_PARENT_PID = 'not-a-pid'
    installParentWatchdog(() => { gone++ }, { intervalMs: INTERVAL, maxMisses: 1, probe: () => false })
    mock.timers.tick(INTERVAL * 5)
    assert.equal(gone, 0)
  })

  // ── RIVET_SERVE_GRACE_SECS（宽限数值换算）──
  //
  // 注意（2026-09-21 拆分解耦后）：此 env 现在只管**数值**，不再兼作形态标记
  // （形态判定见 RIVET_RUNTIME_FORM / runtime-form.test.ts）。attach 链已不再注入
  // 它——主路径由租约制覆盖，宽限只剩「从未租约」路径的兜底。下面两条钉的是换算
  // 契约本身（数值→miss 次数），与谁在用无关。

  it('RIVET_SERVE_GRACE_SECS=60：宽限换算为 60 次 miss（intervalMs=1000）', () => {
    const savedGrace = process.env.RIVET_SERVE_GRACE_SECS
    process.env.RIVET_SERVE_GRACE_SECS = '60'
    try {
      let gone = 0
      // 全程父进程「死」——宽限 60s = 60 次 miss（1s 间隔）后才允许退
      installParentWatchdog(() => { gone++ }, {
        intervalMs: 1000,
        probe: () => false,
      })
      mock.timers.tick(1000 * 59)
      assert.equal(gone, 0, '59s 仍在宽限期内，不得退出')
      mock.timers.tick(1000 * 2)
      assert.equal(gone, 1, '超过 60s 宽限，自退')
    } finally {
      if (savedGrace === undefined) delete process.env.RIVET_SERVE_GRACE_SECS
      else process.env.RIVET_SERVE_GRACE_SECS = savedGrace
    }
  })

  it('RIVET_SERVE_GRACE_SECS 未设或非法时保持默认 3 次 miss（≈9s 现行为）', () => {
    const savedGrace = process.env.RIVET_SERVE_GRACE_SECS
    delete process.env.RIVET_SERVE_GRACE_SECS
    try {
      let gone = 0
      installParentWatchdog(() => { gone++ }, { intervalMs: 1000, probe: () => false })
      mock.timers.tick(1000 * 2)
      assert.equal(gone, 0)
      mock.timers.tick(1000)
      assert.equal(gone, 1, '默认仍是 3 次连续 miss 触发')

      gone = 0
      process.env.RIVET_SERVE_GRACE_SECS = 'bogus'
      installParentWatchdog(() => { gone++ }, { intervalMs: 1000, probe: () => false })
      mock.timers.tick(1000 * 2)
      assert.equal(gone, 0)
      mock.timers.tick(1000)
      assert.equal(gone, 1, '非法值回落默认，不放大也不缩小')
    } finally {
      if (savedGrace === undefined) delete process.env.RIVET_SERVE_GRACE_SECS
      else process.env.RIVET_SERVE_GRACE_SECS = savedGrace
    }
  })

  it('显式 maxMisses 优先于 RIVET_SERVE_GRACE_SECS（调用方契约不被 env 劫持）', () => {
    const savedGrace = process.env.RIVET_SERVE_GRACE_SECS
    process.env.RIVET_SERVE_GRACE_SECS = '60'
    try {
      let gone = 0
      installParentWatchdog(() => { gone++ }, {
        intervalMs: 1000,
        maxMisses: 3, // 显式给 3——env 的 60 不得覆盖
        probe: () => false,
      })
      mock.timers.tick(1000 * 3)
      assert.equal(gone, 1, '显式 maxMisses=3 在第 3 次 miss 即触发')
    } finally {
      if (savedGrace === undefined) delete process.env.RIVET_SERVE_GRACE_SECS
      else process.env.RIVET_SERVE_GRACE_SECS = savedGrace
    }
  })

  // ── PPID 哨兵（attach 模式的父进程探测）──

  it('RIVET_PARENT_PID=PPID 哨兵：probe 收到 process.ppid 而非字面解析值', () => {
    const saved = process.env.RIVET_PARENT_PID
    process.env.RIVET_PARENT_PID = 'PPID'
    try {
      let probed: number[] = []
      let gone = 0
      installParentWatchdog(() => { gone++ }, {
        intervalMs: 1000,
        maxMisses: 2,
        probe: (pid) => { probed.push(pid); return false },
      })
      mock.timers.tick(1000 * 3)
      // probe 必须拿到真实 ppid（供测试注入模拟 attach relay 存活）
      assert.ok(probed.length >= 2, 'probe 被调用')
      assert.ok(probed.every((p) => p === process.ppid), '全部 probe 目标都是 process.ppid')
      assert.equal(gone, 1)
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
    }
  })

  it('PPID 哨兵 + 显式 grace：父进程死后按配置的宽限窗口自退', () => {
    const saved = process.env.RIVET_PARENT_PID
    const savedGrace = process.env.RIVET_SERVE_GRACE_SECS
    process.env.RIVET_PARENT_PID = 'PPID'
    process.env.RIVET_SERVE_GRACE_SECS = '3'
    try {
      let alive = false // 模拟 wsl.exe relay：前 2 次探测活、之后被 WSL 回收
      let calls = 0
      let gone = 0
      installParentWatchdog(() => { gone++ }, {
        intervalMs: 1000,
        probe: () => (calls++ < 2 ? true : false) && alive === false,
      })
      mock.timers.tick(1000 * 2)
      assert.equal(gone, 0, '父进程活——不计 miss')
      mock.timers.tick(1000 * 4) // 父死后：grace 3s = 3 次 miss 才退
      assert.equal(gone, 1, '超过宽限窗口，自退')
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
      if (savedGrace === undefined) delete process.env.RIVET_SERVE_GRACE_SECS
      else process.env.RIVET_SERVE_GRACE_SECS = savedGrace
    }
  })

  // ── 租约续期（重连热附着的关键：父死后宽限窗口内续租则不清零自退）──


  it('父活着时租约无副作用（判定为 父活 OR 租约）', () => {
    const saved = process.env.RIVET_PARENT_PID
    process.env.RIVET_PARENT_PID = 'PPID'
    try {
      resetLeaseForTest()
      let gone = 0
      installParentWatchdog(() => { gone++ }, { intervalMs: 1000, probe: () => true })
      mock.timers.tick(1000 * 30)
      assert.equal(gone, 0)
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
    }
  })
})

describe('probeParentAlive', () => {
  it('自身 PID 存活', () => {
    assert.equal(probeParentAlive(process.pid), true)
  })

  it('不存在的 PID 判死', () => {
    // PID 2^22 以上在常见平台都不会被分配
    assert.equal(probeParentAlive(2 ** 24), false)
  })
})

// 判据直测（合并 origin/main 时补）：上面两条对两种判据**都绿**——`process.pid`
// 走 try 分支、`2**24` 走 catch 且恰为 ESRCH，判据本身无从观察。真机只走
// ESRCH/EPERM 两条分支，中间态无法构造，故把判据抽成纯函数直测：
// 若把 parentAliveFromErrno 回退成 `code === 'EPERM'`（PR 侧原判据），
// 第三条必须变红。
describe('parentAliveFromErrno（判据：非 ESRCH 即活）', () => {
  it('ESRCH → 父已死', () => {
    assert.equal(parentAliveFromErrno('ESRCH'), false)
  })

  it('EPERM → 父活着（存在但非本进程所属）', () => {
    assert.equal(parentAliveFromErrno('EPERM'), true)
  })

  it('罕见/缺失错误码 → 按活着处理（fail-alive：宁漏杀不误杀）', () => {
    assert.equal(parentAliveFromErrno('EINVAL'), true)
    assert.equal(parentAliveFromErrno(undefined), true)
  })
})

// 真时钟测试：不与 mock.timers 共用 describe（beforeEach 的 enable 会
// 替换真 setTimeout，async 等待永远不醒）。
describe('parent watchdog lease（真时钟）', () => {
  it('父死后宽限窗口内 renewLease：存活；租约过期后按剩余宽限自退（真时钟小步实测）', async () => {
    const saved = process.env.RIVET_PARENT_PID
    const savedGrace = process.env.RIVET_SERVE_GRACE_SECS
    process.env.RIVET_PARENT_PID = 'PPID'
    process.env.RIVET_SERVE_GRACE_SECS = '4'
    try {
      resetLeaseForTest()
      let gone = 0
      let calls = 0
      installParentWatchdog(() => { gone++ }, {
        intervalMs: 100,
        probe: () => calls++ < 3, // 前 3 次活（relay 在），之后死
      })
      await new Promise((r) => setTimeout(r, 350)) // 父活 ≈3.5 个探测
      assert.equal(gone, 0)
      // 断开（probe 开始全 false）。t≈+0.3s 时续租 400ms（覆盖部分宽限）
      await new Promise((r) => setTimeout(r, 300))
      renewLeaseForTest(400) // 真时钟——租约 400ms
      await new Promise((r) => setTimeout(r, 300)) // 租约窗口内（0.3s 后仍有 ~0.1s 余量）
      assert.equal(gone, 0, '租约窗口内父死不自退（热附着存活）')
      // 租约过期后走租期终局（立即自退）或 miss 兜底——等满验证必退
      await new Promise((r) => setTimeout(r, 4600))
      assert.ok(gone >= 1, '租约过期且父死 → 自退')
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
      if (savedGrace === undefined) delete process.env.RIVET_SERVE_GRACE_SECS
      else process.env.RIVET_SERVE_GRACE_SECS = savedGrace
    }
  })
})

// ── 信号面归属与退出路径收敛（2026-09-20 SIGHUP 修复的独立性断言）─────────
//
// 背景：serve.ts 新增 SIGHUP 处理器后，serve 有两条独立的自退触发源——
// ① 信号（SIGINT/SIGTERM/SIGHUP）② watchdog（ppid 消失 / 租期终局）。
// 两者都收敛到 serve.ts 的同一个 shutdownServer()，该函数有幂等守卫：
// 二次进入 = process.exit(1) 强退，会砍断正在跑的优雅链。
// 本组断言钉住让两条路径互不遮蔽的三个不变量。
describe('watchdog 与信号面的职责边界', () => {
  it('installParentWatchdog 不注册任何进程信号处理器（信号面单一真源在 serve.ts）', () => {
    const before = {
      SIGHUP: process.listenerCount('SIGHUP'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
    }
    const saved = process.env.RIVET_PARENT_PID
    process.env.RIVET_PARENT_PID = '999999'
    try {
      installParentWatchdog(() => { /* no-op */ }, {
        intervalMs: INTERVAL,
        maxMisses: 3,
        probe: () => true, // 父一直活——watchdog 永不触发
      })
      assert.deepEqual(
        {
          SIGHUP: process.listenerCount('SIGHUP'),
          SIGTERM: process.listenerCount('SIGTERM'),
          SIGINT: process.listenerCount('SIGINT'),
        },
        before,
        'watchdog 不得挂信号处理器——否则信号面出现第二个真源，' +
        'SIGHUP 的优雅退出语义会被 watchdog 侧遮蔽或重复触发',
      )
    } finally {
      if (saved === undefined) delete process.env.RIVET_PARENT_PID
      else process.env.RIVET_PARENT_PID = saved
    }
  })

  it('parent-watchdog.ts 源码不含 process.on / process.exit（只探测、只回调，退出决策留给调用方）', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../parent-watchdog.ts', import.meta.url), 'utf8')
    assert.ok(
      !/process\.on\s*\(/.test(source),
      'watchdog 模块不得注册进程事件——它只用 setInterval 探测 + 回调',
    )
    assert.ok(
      !/process\.exit\s*\(/.test(source),
      'watchdog 不得自行 process.exit——退出必须经 onParentGone 回调收敛到 ' +
      'serve.ts 的 shutdownServer()，否则两条退出路径各自为政、清理链可能被跳过',
    )
  })

})

