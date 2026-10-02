/**
 * Parent-death watchdog——从 serve.ts 拆出（2026-09-19 行数棘轮：巨石只降
 * 不升，watchdog 是自洽单元，无 serve 内部依赖）。
 *
 * 桌面壳 spawn sidecar 时注入 RIVET_PARENT_PID；本模块轮询父进程存活，
 * 消失即触发 onParentGone（serve 侧优雅关停）。单次探测失败可能是瞬时
 * 误报——连续 maxMisses 次（默认 3 ≈ 9s）失败才触发，任一次成功清零。
 *
 * RIVET_SERVE_GRACE_SECS（断开宽限**数值**）：env 指定宽限秒数，按探测间隔换算
 * 成 maxMisses；不设 = 默认 3 次（≈9s）。**与运行时形态无关**（形态判定见
 * RIVET_RUNTIME_FORM / isWslAttachForm）——此值只是「从未租约」路径的兜底时长，
 * attach 主路径由租约制覆盖（见下方租约段）。显式 maxMisses 参数优先，不被 env 劫持。
 */
export interface ParentWatchdogOptions {
  /** Probe interval. Default 3000ms. */
  intervalMs?: number
  /** Consecutive failed probes required before onParentGone fires. Default 3
   *  (≈9s at the default interval). When omitted, RIVET_SERVE_GRACE_SECS can
   *  extend it — a numeric grace window, no longer a form marker (form is
   *  RIVET_RUNTIME_FORM / isWslAttachForm since 2026-09-21). An explicit
   *  maxMisses always wins over the env (caller contract is not
   *  hijackable by environment). */
  maxMisses?: number
  /** Injectable liveness probe (tests). Returns true when the parent is alive. */
  probe?: (ppid: number) => boolean
}

/** True when `ppid` still exists (signal-0 probe; EPERM = alive but not ours). */
/**
 * 探测抛错时的判据（抽成纯函数以便直测——`process.kill` 的错误码在生产里
 * 无法注入，真机只走 ESRCH/EPERM 两条分支，判据本身无从观察）。
 *
 * 仅 ESRCH（进程不存在）判死，其余错误码一律按「活着」处理。失效方向刻意
 * 朝「少做」那一侧：漏判活父只让孤儿多活一会儿（租约/宽限兜底），误判父死
 * 却会当场杀掉正在服务的 sidecar。故不写成「恰为 EPERM」的反向枚举——
 * EINVAL/ENOSYS 等罕见码会从缝里漏掉。
 */
export function parentAliveFromErrno(code: string | undefined): boolean {
  return code !== 'ESRCH'
}

export function probeParentAlive(ppid: number): boolean {
  try {
    // signal 0 probes existence/permission without actually signalling.
    process.kill(ppid, 0)
    return true
  } catch (err) {
    // ESRCH = parent gone. EPERM = alive but not ours → still alive.
    return parentAliveFromErrno((err as NodeJS.ErrnoException).code)
  }
}

/**
 * RIVET_SERVE_GRACE_SECS → maxMisses（按探测间隔换算，向上取整、最少 1）。
 * 非法/未设置返回默认 3（≈9s @3s 间隔，历史行为）。导出供单测直测换算契约。
 */
export function maxMissesFromGraceEnv(intervalMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RIVET_SERVE_GRACE_SECS
  if (!raw) return 3
  const secs = Number(raw)
  if (!Number.isFinite(secs) || secs <= 0) return 3
  return Math.max(1, Math.ceil((secs * 1000) / Math.max(1, intervalMs)))
}

/** WSL attach 形态标记（2026-09-21 拆分后的单一真源）：`RIVET_RUNTIME_FORM=wsl-attach`
 *  由 attach 链（wsl_attach.rs `handshake_command`）注入，本地 sidecar / CLI serve
 *  都不设。租期终局分支的形态门槛。
 *
 *  为何独立成 env（原借用 RIVET_SERVE_GRACE_SECS 是否已设）：那是**一物二用**——
 *  既当宽限数值，又当形态标记。两个职责生命周期不同：形态是「谁起的我」（进程一生
 *  不变），宽限是可调时长（且 attach 主路径已由租约制覆盖，宽限只剩「从未租约」的
 *  极短窗口兜底）。混用的代价：想把宽限调回默认值时形态判定会跟着失效——本地
 *  sidecar 的孤儿 node.exe 自退会从 ~9s 退回 ~120s。解耦后各自独立演进。
 *  导出供单测直测判定契约（与 maxMissesFromGraceEnv 同惯例）。 */
export function isWslAttachForm(env: NodeJS.ProcessEnv): boolean {
  // 空串视为未设（与 maxMissesFromGraceEnv 的 `!raw` 判定惯例一致）；严格相等，
  // 不做大小写/前缀模糊匹配——形态判定 fail-closed，拼错即按本地处理。
  return env.RIVET_RUNTIME_FORM === 'wsl-attach'
}

// ── 租约（热附着续期，2026-09-19 审查报告 ②）─────────────────────────────
//
// 断开（杀 relay）后 serve 进入宽限倒计时；用户重连时，壳经认证 HTTP 调
// /lease 续租——WSL attach 形态的 watchdog 判定「父活 OR 租约新鲜」：
//   - 父活着：一切照旧（misses 清零）
//   - 父死了但租约新鲜：attach 形态不累积 miss（连接方还在线，relay 换代）；
//     本地 sidecar 仍按 miss 自退（无 relay 换代）
//   - 父死了且租约曾存在但已过期：租期终局——立即自退（2026-09-19 拍板
//     「跟着租期走」：租期就是 serve 的生命周期，断开自退 ≈ 最后一帧
//     心跳起的 120s 租期 + 最多一个探测间隔，不再叠加完整宽限窗口）
//   - 父死了且从未租约：miss 累积 → 宽限满 → 自退；本地 sidecar 即使
//     租约新鲜，也走相同的 miss 自退路径
// attachOrExit 的 attached:true 分支只打印握手就退出，serve 进程与
// watchdog 都不刷新——租约是热附着真正「热」的那一半。

/** 租约到期时刻（epoch ms）。0 = 无租约（未连接方续租）。模块级单例：
 *  一个 serve 进程只有一个 watchdog、一个租约面。 */
let leaseUntil = 0

/** 连接方续租（POST /lease 路由调用）。ms = 本次租约时长。
 *  传 0 表示显式释放（连接方主动告别）。 */
export function renewLease(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  leaseUntil = ms === 0 ? 0 : Date.now() + ms
}

/** 测试注入口：直接设租约窗口（绕过 Date.now 计算），并复位。 */
export function renewLeaseForTest(ms: number): void {
  leaseUntil = ms === 0 ? 0 : Date.now() + ms
}

export function resetLeaseForTest(): void {
  leaseUntil = 0
}

/** 测试注入口：读当前租约是否新鲜（route 契约测试用）。 */
export function leaseStateFreshForTest(): boolean {
  return leaseFresh()
}

/** 租约是否新鲜（未过期且非零）。watchdog 判定的第二分支。 */
function leaseFresh(now = Date.now()): boolean {
  return leaseUntil > 0 && now < leaseUntil
}

/** 租期终局：曾存在租约（leaseUntil>0）且已过期。区分「从未租约」——后者
 *  走 miss 累积防误报路径（本地 sidecar 冷启动的瞬时探测失败不应立即杀）。 */
function leaseExpired(now = Date.now()): boolean {
  return leaseUntil > 0 && now >= leaseUntil
}

/**
 * Parent-death watchdog. The desktop shell spawns the sidecar with
 * `RIVET_PARENT_PID` set to its own pid; we poll whether that process still
 * exists and self-terminate when it's gone. This is the cross-platform backstop
 * for the case the shell's `Child::kill()` can't cover — a crash, a SIGKILL, or
 * Windows "End task" — which would otherwise leave an orphaned `node.exe`
 * holding the port. No-op when the env var is absent (manual `rivet serve`).
 *
 * 宽限：单次探测失败可能是瞬时误报（父进程短暂无响应、电源状态切换等），
 * 立即自杀会造成「sidecar 半夜无故死亡」。改为连续 maxMisses 次（默认 3 次
 * ≈ 9s）失败才触发退出，期间任一次成功即清零；每次 miss 记日志留现场。
 */
export function installParentWatchdog(
  onParentGone: (info: { ppid: number; misses: number }) => void,
  options: ParentWatchdogOptions = {},
): void {
  const raw = process.env.RIVET_PARENT_PID
  // PPID 哨兵（attach 模式）：桌面壳 spawn 的 wsl.exe relay 持有本进程，
  // ppid 即 relay 在 WSL 侧的真实 pid——断开（显式杀 relay）后 relay 死
  // → ppid 消失 → watchdog 按形态分流：attach 形态走租期终局（曾租约且
  // 过期即退），否则计宽限 miss。壳无法预知 WSL 侧 pid，只能传哨兵由 serve
  // 自取。非哨兵路径（显式数字）行为不变。
  // 注：宽限数值不再由 attach 链注入（2026-09-21 起走默认 9s）——形态判定
  // 已独立为 RIVET_RUNTIME_FORM。
  const ppid = raw === 'PPID' ? process.ppid : raw ? Number(raw) : NaN
  if (!Number.isInteger(ppid) || ppid <= 0) return
  const intervalMs = options.intervalMs ?? 3000
  const maxMisses = options.maxMisses ?? maxMissesFromGraceEnv(intervalMs)
  const probe = options.probe ?? probeParentAlive
  // 租期终局只在 WSL attach 形态生效：RIVET_RUNTIME_FORM=wsl-attach 由 attach 链
  // （wsl_attach.rs handshake_command）显式注入，本地 sidecar / CLI serve 都不设。
  // withAuth 的流量续租不分形态——本地 sidecar 前端连通后同样有租约，若终局不设
  // 门槛，壳强杀（crash / End task）后孤儿 node.exe 的自退会从 maxMisses（≈9s）
  // 拉长到整个租期（~120s），与 watchdog 防孤儿占端口的初衷相反。形态标记在
  // install 时快照（env 后续变化不影响已装配的判定）。
  const leaseEndgameForm = isWslAttachForm(process.env)
  let misses = 0
  let fired = false
  const timer = setInterval(() => {
    if (fired) return
    if (probe(ppid)) {
      misses = 0
      return
    }
    // 租期终局（2026-09-19 拍板：跟着租期走）：WSL attach 形态下，连接方曾
    // 续租（leaseUntil>0）且租约已过期——租期就是 serve 的生命周期，立即
    // 自退，不再等 miss 累积满宽限（断开自退 = 最后一帧心跳起的租期 + 最多
    // 一个探测间隔，而非租期 + 完整 60s 宽限）。非 attach 形态不走此分支。
    if (leaseEndgameForm && leaseExpired()) {
      fired = true
      clearInterval(timer)
      console.error(`[serve] lease expired (was leased) and parent gone — exiting now, grace window skipped`)
      onParentGone({ ppid, misses: Math.max(1, misses) })
      return
    }
    // 租约分支仅限 WSL attach：父死但租约新鲜时暂停 miss 累积、不清零。
    // 本地 sidecar 也会因认证流量获得租约，但壳强杀后必须按 miss 自退，
    // 否则孤儿 node.exe 会一直活到租约过期（通常约 120s）。
    if (leaseEndgameForm && leaseFresh()) {
      return
    }
    misses++
    if (misses < maxMisses) {
      console.error(`[serve] parent pid ${ppid} probe miss ${misses}/${maxMisses} — exiting after ${maxMisses} consecutive misses`)
      return
    }
    // fired guard: shutdown (process.exit) may take a beat; the interval must
    // not re-enter onParentGone in the meantime.
    fired = true
    clearInterval(timer)
    onParentGone({ ppid, misses })
  }, intervalMs)
  // Don't let the watchdog itself keep the event loop alive — the HTTP server
  // already does, and an unref'd timer won't block a clean exit.
  timer.unref()
}

