import { splitShellSegments } from './permissions.js'

export function verificationAttempted(name: string, input?: Record<string, unknown>): boolean {
  if (['run_tests', 'typecheck', 'lsp_diagnostics'].includes(name)) return true
  if (name !== 'bash' || typeof input?.command !== 'string') return false
  // The denylist splitter deliberately over-approximates shell syntax. Hide
  // quoted prose first; ambiguous substitutions/heredocs are not evidence.
  if (/\$\(|`|<</.test(input.command)) return false
  const masked = input.command.replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"/g, '__quoted__')
  return splitShellSegments(masked).some(segment => {
    const words = segment.replace(/^(?:[A-Za-z_]\w*=\S+\s+)*/, '').trim().split(/\s+/)
    if (words[0] === 'rtk' || words[0] === 'npx') words.shift()
    const bin = words.shift()?.replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
    if (words.some(w => ['--help', '-h', '--version'].includes(w))) return false
    if (['pytest', 'vitest', 'jest', 'mocha', 'tsc'].includes(bin ?? '')) return true
    if (bin === 'python' || bin === 'python3') return words[0] === '-m' && words[1] === 'pytest'
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin ?? '')) {
      if (words[0] === 'run' || words[0] === 'run-script') words.shift()
      return /^(?:test|typecheck)(?::[\w-]+)?$/.test(words[0] ?? '')
    }
    if (bin === 'node' || bin === 'tsx') {
      for (let i = 0; i < words.length; i++) {
        if (words[i] === '--test') return true
        if (['--import', '--require', '-r'].includes(words[i]!)) { i++; continue }
        if (!words[i]!.startsWith('-') || ['-e', '--eval', '-p', '--print'].includes(words[i]!)) return false
      }
    }
    return false
  })
}
export function recentVerification(history: ReadonlyArray<{ verificationAttempted?: boolean; modelTurn?: number }>, turn: number) {
  return history.filter(h => h.verificationAttempted && h.modelTurn !== undefined && h.modelTurn <= turn && h.modelTurn >= turn - 1).at(-1)
}
