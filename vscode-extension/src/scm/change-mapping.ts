/**
 * SCM 资源映射（纯函数）— working-tree file → 原生 SCM 资源描述子。
 *
 * 红线：本模块无 vscode 运行时依赖（import type only）——node --test 直接
 * 加载做单测；vscode 对象（ThemeIcon/Command/Uri）由 source-control.ts 装配。
 * tooltip 文本与 changes-view 的 TreeItem description 同格式（标签后两空格、
 * 行数 +N −M、U+2212 减号），SCM 与树两处对同一文件显示一致。
 */
import type { WorkingTreeFile } from '../sidecar/protocol.js'

export interface ChangeResource {
  /** codicon 名（fork 注册表：diff-added/modified/removed/renamed）。 */
  iconId: string
  /** 悬停文本：`${label}  +${additions} −${deletions}`。 */
  tooltip: string
  /** SCM 资源上下文值（scm/resourceState/context 菜单 when 用）。 */
  contextValue: string
}

/** 变更态标签（M/A/D/R/U）——SCM 资源与 Explorer 树共用的单一来源。 */
export const STATUS_LABEL: Record<WorkingTreeFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

const STATUS_ICON: Record<WorkingTreeFile['status'], string> = {
  modified: 'diff-modified',
  added: 'diff-added',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
  untracked: 'diff-added',
}

const RESOURCE_CONTEXT = 'session-change'

/** 未知态（server 版本漂移）兜底：标签 ?、图标保守取 diff-modified。 */
export function mapWorkingTreeFile(file: WorkingTreeFile): ChangeResource {
  const status = file.status
  const label = (STATUS_LABEL as Record<string, string | undefined>)[status] ?? '?'
  const iconId = (STATUS_ICON as Record<string, string | undefined>)[status] ?? 'diff-modified'
  return {
    iconId,
    tooltip: `${label}  +${file.additions} −${file.deletions}`,
    contextValue: RESOURCE_CONTEXT,
  }
}
