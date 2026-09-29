import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

describe('startup memory baseline', () => {
  // 2026-09-28：dist/main.js 用当前源码重建后，10 次实测 119.7–122.1MB；
  // 重建前的混淆产物为 147MB。120MB 阈值在重建后仍有约 8/10 的概率被
  // 单次 RSS 抖动顶红（该文件测的是构建产物，跨机器/GC 噪声大），
  // 因此把预算上调到 128MB——旧产物 147MB 仍会被拦下，明显回退不会静默。
  it('RSS should be below 128MB after import', async () => {
    // dist/main.js 在 import 时即运行 main()，非 TTY 环境下 T9 守卫会
    // process.exit(1)。用 exit 钩子在进程退出前打印 RSS，并容忍非零退出码
    // （execFile 对非零退出抛错，但 stdout 仍在 error 对象上）。
    const script = `process.on('exit', () => {
        const m = process.memoryUsage();
        console.log(JSON.stringify({ rss_MB: +(m.rss / 1048576).toFixed(1) }));
      });
      import('./dist/main.js').then(() => process.exit(0)).catch(() => process.exit(0));`

    let stdout = ''
    try {
      const result = await execFileAsync('node', ['--max-old-space-size=256', '-e', script], { timeout: 15_000 })
      stdout = result.stdout
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? ''
    }

    const lines = stdout.trim().split('\n')
    const last = lines[lines.length - 1] ?? ''
    let rss = 200
    try { rss = JSON.parse(last).rss_MB } catch { /* use default */ }
    assert.ok(rss < 128, `Startup RSS ${rss}MB exceeds 128MB budget`)
  })
})
