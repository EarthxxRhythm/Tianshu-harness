import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { renderRouteAnnotation, STALL_ROUTE_TABLE } from '../failure-taxonomy.js'
import { extractPatchTargetPaths } from '../../tools/apply-patch.js'

/** edit-failure 的恢复路由标注——统一从 STALL_ROUTE_TABLE 取值，单源不漂移。 */
const EDIT_FAILURE_ANNOTATION = renderRouteAnnotation(STALL_ROUTE_TABLE['edit-stuck'])

/**
 * Edit-Failure Recovery Hook — postTool detection of consecutive edit failures
 * on the same file across turns.
 *
 * When edit_file / hash_edit / write_file / ast_edit / apply_patch fails ≥2
 * times on the same file, the agent's mental model is almost certainly stale.
 * Instead of retrying the same edit pattern (which leads to debris and undo
 * loops), we inject a repair advisory that tells the agent to:
 *   1. undo the last write to get back to a known-good state
 *   2. read_file to refresh its view of the file
 *   3. switch to a different edit tool for the remaining changes
 *
 * apply_patch 的恢复方向相反：它的失败（hunk 计数错 / 上下文漂移 / 目标不在
 * 索引）靠重发同一补丁永远修不好，建议退回 edit_file/hash_edit 单点编辑。
 *
 * The failure counter is session-scoped and reset on success for that file.
 */

export interface EditFailureRecoveryHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

const EDIT_TOOLS = new Set(['edit_file', 'hash_edit', 'write_file', 'ast_edit', 'apply_patch'])

export function createEditFailureRecoveryHook(deps: EditFailureRecoveryHookDeps): PostToolRuntimeHook {
  const failCounts = new Map<string, number>()

  return {
    phase: 'postTool',
    name: 'edit-failure-recovery',
    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      if (!EDIT_TOOLS.has(tool.name)) return

      const filePath = extractFilePath(tool)
      if (!filePath) return

      if (tool.success) {
        failCounts.delete(filePath)
        return
      }

      const count = (failCounts.get(filePath) ?? 0) + 1
      failCounts.set(filePath, count)

      if (count >= 2) {
        const isPatch = tool.name === 'apply_patch'
        deps.advisoryBus.submit({
          key: `edit-failure-recovery:${filePath}`,
          priority: 0.62,
          category: 'repair',
          tier: 'operational',
          content: isPatch
            ? `已连续 ${count} 次用 apply_patch 修改 ${filePath} 失败。自动恢复建议：1) 用 read_file 重新读取目标当前内容；2) 核对 diff 格式（hunk 头 @@ 行数计数必须与 hunk 体一致）与上下文是否匹配真值；3) 改用 edit_file/hash_edit 做单点编辑，或 write_file 全量覆写——不要原样重发同一补丁。 ${EDIT_FAILURE_ANNOTATION}`
            : `已连续 ${count} 次编辑 ${filePath} 失败。自动恢复建议：1) 调用 undo 撤销最近一次写入；2) 用 read_file 重新读取当前内容；3) 改用 apply_patch（统一 diff）或 write_file（全量覆写）完成修改，避免继续用 edit_file/hash_edit 原地修补。 ${EDIT_FAILURE_ANNOTATION}`,
          ttl: 1,
          expect: {
            kind: 'tool_appears',
            tools: isPatch
              ? ['read_file', 'edit_file', 'hash_edit', 'write_file']
              : ['undo', 'read_file', 'apply_patch', 'write_file'],
            targetIncludes: filePath,
            withinTurns: 2,
          },
        })
      }
    },
  }
}

function extractFilePath(tool: RuntimeToolEvent): string | undefined {
  if (tool.name === 'apply_patch') {
    // apply_patch 没有 file_path 字段——目标文件埋在 diff 的 +++ 头里。
    const diff = typeof tool.input?.diff === 'string' ? tool.input.diff : undefined
    if (!diff) return undefined
    const targets = extractPatchTargetPaths(diff)
    return targets.length > 0 ? targets.join(',') : undefined
  }
  if (typeof tool.input?.file_path === 'string') return tool.input.file_path
  if (typeof tool.input?.path === 'string') return tool.input.path
  return tool.target
}
