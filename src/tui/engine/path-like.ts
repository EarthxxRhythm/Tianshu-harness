/**
 * 输入更像文件路径而非 slash 命令的判定（纯函数叶子模块）。
 *
 * 从 `src/tui/engine/app.ts` 迁出（serve 启动图瘦身）：`session-routes` 侧的
 * prompt 解析只需要这一个纯函数，但原位置在 TUI 主图（app.ts）里——静态
 * import 会把整个 TUI 引擎图带进 sidecar 启动期。`app.ts` 保留再导出，
 * 既有调用方与测试 import 面不变。
 */

/** 判断输入是否更像文件路径而非 slash 命令。
 *  例如 `/src/main.ts` 或 `/tmp/foo bar` 应走普通文本流程，
 *  避免被当作未知 slash 命令报失败。
 *
 *  单段绝对路径（`/etc`、`/mnt`、`/usr`）在没有 isKnownCommand 谓词时
 *  回退到旧行为（视为命令）；传入谓词后，非已知命令的单段路径被
 *  正确识别为 Linux/WSL 文件路径。
 *
 *  若提供 isCommandPrefix，则第一 token 是某个已知命令前缀时视为 slash 命令，
 *  保证 `/h` 这类模糊输入仍能触发 slash 提示与补全。 */
export function looksLikeFilePath(
  input: string,
  isKnownCommand?: (name: string) => boolean,
  isCommandPrefix?: (name: string) => boolean,
): boolean {
  if (input.startsWith('~/')) return true
  // Windows 盘符路径 C:\... 或 C:/...（不是 slash 命令）
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true
  if (!input.startsWith('/')) return false
  const rest = input.slice(1)
  const slashIdx = rest.indexOf('/')
  if (slashIdx !== -1) {
    const spaceIdx = rest.indexOf(' ')
    return spaceIdx === -1 || slashIdx < spaceIdx
  }
  // 单段 /xxx：可能是命令（/exit）也可能是路径（/etc, /mnt）
  if (isKnownCommand) {
    const firstToken = rest.split(/\s/)[0] ?? ''
    if (firstToken === '') return false
    if (isCommandPrefix?.(firstToken)) return false
    return !isKnownCommand(firstToken)
  }
  return false
}
