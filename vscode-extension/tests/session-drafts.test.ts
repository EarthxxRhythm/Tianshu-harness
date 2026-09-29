import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { switchComposerDraft, type ComposerDraft } from '../webview-ui/src/session-drafts.ts'

// issue #296 — Composer 草稿按会话隔离。事故形态：扩展端 composer 的 text/images
// 是全局单值，A 会话运行中打好跟进内容 → 切到 B → 按发送，文本直接进入 B 的
// queue/prompt。修复 = 切会话时暂存旧会话、恢复目标会话（switchComposerDraft）。

const draft = (text: string, images: string[] = []): ComposerDraft => ({ text, images })

test('切走暂存、目标会话无暂存则得空草稿——A 的文本不进 B 的输入框', () => {
  const stash = new Map<string, ComposerDraft>()
  const next = switchComposerDraft(stash, 'A', 'B', draft('缩小一点训练日卡片的宽度'))
  assert.deepEqual(next, { text: '', images: [] })
  assert.deepEqual(stash.get('A'), draft('缩小一点训练日卡片的宽度'))
})

test('切回恢复原文与图片', () => {
  const stash = new Map<string, ComposerDraft>()
  switchComposerDraft(stash, 'A', 'B', draft('A 的话', ['data:image/png;base64,x']))
  const back = switchComposerDraft(stash, 'B', 'A', draft('B 的话'))
  assert.deepEqual(back, draft('A 的话', ['data:image/png;base64,x']))
  // B 的话也被暂存，再切回 B 仍在
  const backToB = switchComposerDraft(stash, 'A', 'B', back)
  assert.deepEqual(backToB, draft('B 的话'))
})

test('同 key 不切：原样返回，不写箱', () => {
  const stash = new Map<string, ComposerDraft>()
  const cur = draft('打字中')
  assert.equal(switchComposerDraft(stash, 'A', 'A', cur), cur)
  assert.equal(stash.size, 0)
})

test("欢迎页草稿桶 ''：新会话 ↔ 会话切换互不串", () => {
  const stash = new Map<string, ComposerDraft>()
  // 欢迎页打了字 → 切去 A：欢迎草稿留下，A 得空
  const atA = switchComposerDraft(stash, '', 'A', draft('欢迎页草稿'))
  assert.deepEqual(atA, { text: '', images: [] })
  // A 打字 → 切回新会话：A 暂存，欢迎草稿回来
  const atWelcome = switchComposerDraft(stash, 'A', '', draft('A 的内容'))
  assert.deepEqual(atWelcome, draft('欢迎页草稿'))
})

test('返回与暂存均为拷贝：改返回值不污染箱内条目', () => {
  const stash = new Map<string, ComposerDraft>()
  const next = switchComposerDraft(stash, 'A', 'B', draft('x', ['img']))
  next.images.push('mutated')
  const again = switchComposerDraft(stash, 'B', 'A', next)
  assert.deepEqual(again, draft('x', ['img']))
})

// 接线契约（纯函数正确但组件不接 = 缺陷仍在——仓库既有的「自写用例没牙」教训）：
// Composer 必须在 sessionKey 变化 effect 里调 switchComposerDraft 并落地其结果。
test('接线：App.tsx 的 Composer 用 switchComposerDraft 做切会话暂存/恢复', () => {
  const appSrc = readFileSync(new URL('../webview-ui/src/App.tsx', import.meta.url), 'utf8')
  assert.match(appSrc, /import \{ switchComposerDraft, type ComposerDraft \} from '\.\/session-drafts\.js'/)
  assert.match(appSrc, /const next = switchComposerDraft\(draftStash\.current, fromKey, toKey, draftRef\.current\)/)
  assert.match(appSrc, /setText\(next\.text\)/)
  assert.match(appSrc, /setImages\(next\.images\)/)
})
