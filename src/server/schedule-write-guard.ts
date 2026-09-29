/**
 * issue #290 / 公开仓 PR #295 —— 调度表写权限的全局门。
 *
 * 多 sidecar 指向同一 desktop 目录时，只有 CronLock 锁主进程可以写
 * scheduled_tasks.json；非锁主内存表恒空，写路径整表覆写会静默删掉锁主任务。
 * serve.ts 在锁创建后注入 `() => lock.isOwner()`，工具侧在进入 add/remove 前
 * 动态判定；缺省未注入 = 允许（CLI/测试原语义）。
 *
 * 从 cron-scheduler.ts 拆出（该文件已逼近 800 行红线）：API 仍从
 * cron-scheduler.js re-export，既有消费方（serve / schedule 工具 / 测试）
 * 的 import 路径不变。
 */

let scheduleWriteGuard: (() => boolean) | undefined

export function setScheduleWriteGuard(guard: (() => boolean) | undefined): void {
  scheduleWriteGuard = guard
}

export function isScheduleWriteAllowed(): boolean {
  return scheduleWriteGuard === undefined || scheduleWriteGuard()
}
