import { spawnGit } from './spawn-git.js'
import { relative, resolve } from 'path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { validatePathSafe } from './path-validate.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { track } from './process-tracker.js'
import { gracefulKill } from '../platform.js'

const MAX_LINES_PER_FILE = 200
const MAX_TOTAL_CHARS = 8000

export const DIFF_TOOL: Tool = {
  definition: {
    name: 'diff',
    description: `显示工作树改动的 git diff。

### 用法
- 提交前用 diff 查看哪些文件有改动
- 编辑前用 diff 了解当前状态
- 编辑后用 diff 验证改动是否正确
- 结果按文件截断（每个文件最多 200 行）

### 示例
Good: diff() — 显示所有未暂存改动
Good: diff(staged=true) — 显示已暂存改动
Good: diff(path="src/api/client.ts") — 显示单个文件的 diff`,
    input_schema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: '显示已暂存改动（--cached）' },
        path: { type: 'string', description: '过滤到指定文件或目录' },
        context_lines: { type: 'integer', description: '上下文行数（默认 3）' },
        current_task_only: { type: 'boolean', description: '只显示当前任务拥有文件的 diff（B1 归属范围）' },
      },
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const staged = (params.input.staged as boolean) ?? false
    const path = params.input.path as string | undefined
    const contextLines = (params.input.context_lines as number) ?? 3
    const startTime = Date.now()
    const currentTaskOnly = params.input.current_task_only === true

    const args = ['diff']
    if (staged) args.push('--cached')
    args.push(`-U${contextLines}`)

    // B1: current_task_only restricts diff to owned files
    if (currentTaskOnly && params.ownedFiles?.length) {
      const ownedPaths = params.ownedFiles
        .map(f => relative(params.cwd, resolve(params.cwd, f)))
        .filter(f => !f.startsWith('..'))
      if (ownedPaths.length === 0) {
        return { content: '没有可 diff 的归属文件。' }
      }
      args.push('--', ...ownedPaths)
    } else if (path) {
      const validated = validatePathSafe(params.cwd, path)
      if (!validated.ok) {
        return { content: `错误：${validated.error}`, isError: true }
      }
      args.push('--', relative(params.cwd, validated.path))
    }

    return new Promise((resolve) => {
      const child = track(spawnGit(args, {
        cwd: params.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      }))

      let stdout = ''
      let stderr = ''

      child.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      const timer = setTimeout(async () => {
        gracefulKill(child)
        const rawPath = await persistRawOutput(params.toolUseId, 'git diff timed out')
        resolve({ content: '错误：git diff 超时', rawPath, isError: true, errorKind: 'timeout' })
      }, 30_000)

      // 用户中止：协作式取消，kill git diff 子进程。
      const signal = params.abortSignal
      const onAbort = () => {
        clearTimeout(timer)
        gracefulKill(child)
        resolve({ content: '用户已中止 diff。', isError: false })
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      child.on('close', async (code) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        // 以退出码为准，不看 stderr：git diff 成功时也会往 stderr 打 warning
        //（core.autocrlf=true 下每个 LF 文件一条 CRLF 提示——Windows 默认配置、
        // 不可读的 core.attributesFile 等），此前任何 stderr 都判错并丢弃
        // stdout 里的完整 diff，该场景下每次 diff 都误报。
        if (code !== 0) {
          const detail = stderr.trim() || `git diff 退出码 ${code ?? 'null'}`
          const rawPath = await persistRawOutput(params.toolUseId, detail)
          resolve({ content: `错误：${detail}`, rawPath, isError: true })
          return
        }
        if (!stdout.trim()) {
          resolve({ content: '无改动。' })
          return
        }
        const durationMs = Date.now() - startTime
        const meta = { command: 'git diff', exitCode: 0, durationMs }
        const rawPath = await persistRawOutput(params.toolUseId, stdout)
        resolve({
          content: buildModelOutput(truncateDiff(stdout), { ...meta, rawPath }),
          uiContent: buildUiOutput(stdout, meta),
          rawPath,
        })
      })

      child.on('error', async (err) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        const rawPath = await persistRawOutput(params.toolUseId, err.message)
        resolve({ content: `错误：${err.message}`, rawPath, isError: true })
      })
    })
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

function truncateDiff(output: string): string {
  const files = splitByFile(output)
  const truncated = files.map(file => {
    const lines = file.split('\n')
    if (lines.length <= MAX_LINES_PER_FILE) return file
    const head = lines.slice(0, MAX_LINES_PER_FILE).join('\n')
    return `${head}\n...（已截断，另有 ${lines.length - MAX_LINES_PER_FILE} 行）`
  })
  const result = truncated.join('\n')
  if (result.length <= MAX_TOTAL_CHARS) return result
  return result.slice(0, MAX_TOTAL_CHARS) + '\n...（已截断）'
}

function splitByFile(output: string): string[] {
  const files: string[] = []
  let current = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git') && current) {
      files.push(current)
      current = line
    } else {
      current += (current ? '\n' : '') + line
    }
  }
  if (current) files.push(current)
  return files
}
