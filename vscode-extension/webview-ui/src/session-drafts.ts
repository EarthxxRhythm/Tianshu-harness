/**
 * 会话级 composer 草稿箱（issue #296）。
 *
 * Composer 的 text/images 属于「正在看的那个会话」——若用全局单值，切会话后
 * A 打好的内容会出现在 B 的输入框里，用户在 B 里按发送即把 A 的话发进 B
 * （跨会话泄漏）。这里把「切会话 = 暂存旧会话 + 恢复目标会话」抽成纯函数，
 * 组件侧只持有 Map ref 与 prevKey ref。
 *
 * 未附着任何会话时的欢迎页草稿用空串作 key（'' = 新会话草稿桶）。
 */
export interface ComposerDraft {
  text: string
  images: string[]
}

export const EMPTY_DRAFT: ComposerDraft = { text: '', images: [] }

/**
 * 切会话：把 current 暂存到 fromKey 名下，返回 toKey 的暂存（无则空草稿）。
 * fromKey === toKey 时原样返回（不切）。返回与暂存均为拷贝——调用方后续的
 * setState 不可变更新不会回写箱内条目。
 */
export function switchComposerDraft(
  stash: Map<string, ComposerDraft>,
  fromKey: string,
  toKey: string,
  current: ComposerDraft,
): ComposerDraft {
  if (fromKey === toKey) return current
  stash.set(fromKey, { text: current.text, images: [...current.images] })
  const next = stash.get(toKey)
  return next ? { text: next.text, images: [...next.images] } : { ...EMPTY_DRAFT }
}
