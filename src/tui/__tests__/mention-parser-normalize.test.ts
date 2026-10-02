import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { parseMentions, normalizeMentionRefs, normalizeMentionPath } from '../mention-parser.js'

/** 期望与实现同源：实现把产物归一为正斜杠（#308 收编；Windows 裸 join 产反斜杠
 *  会与归一输出失配——#189 族），期望以 join + 归一构造，两平台一致。 */
const expectRel = (...parts: string[]): string => join(...parts).replaceAll('\\', '/')

describe('normalizeMentionRefs（P3-C 提交规范化）', () => {
  it('dot-dot filename inside workspace stays local', () => {
    assert.equal(normalizeMentionPath(resolve('workspace'), './..notes.ts'), '..notes.ts')
  })
  it('cwd 内路径规范为相对路径', () => {
    const refs = parseMentions('fix @file:./src/../src/a.ts 与 @file:src/b.ts')
    const out = normalizeMentionRefs(refs, '/repo')
    assert.deepEqual(out.map(r => r.value), [expectRel('src', 'a.ts'), expectRel('src', 'b.ts')])
  })

  it('cwd 外路径保持原样（可识别外部引用）', () => {
    assert.equal(normalizeMentionPath('/repo', '/etc/passwd'), '/etc/passwd')
    assert.equal(normalizeMentionPath('/repo', '../outside.ts'), '../outside.ts')
  })

  it('绝对形式的 cwd 内路径转为相对', () => {
    assert.equal(normalizeMentionPath('/repo', '/repo/src/a.ts'), expectRel('src', 'a.ts'))
  })
})
