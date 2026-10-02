import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockIn, MockOut } from './_harness.js'
import { setClipboardReader, type ClipboardImage } from '../clipboard-image.js'
import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'

const draft = 'original conversation draft'
const image: ClipboardImage = {
  dataUrl: 'data:image/png;base64,aGVsbG8=', mime: 'image/png', name: 'clipboard.png', source: 'png',
}

function makeApp() {
  const stdin = new MockIn(), out = new MockOut()
  const app = new TuiApp({ stdin: stdin as unknown as ReadStream, stdout: out as unknown as WriteStream, cols: 80, rows: 24 })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  app.start()
  app.setInput(draft)
  ;(app as unknown as { lastInputFocusAt: number }).lastInputFocusAt = Date.now() - 2000
  return { app, stdin }
}

for (const stage of ['text', 'image'] as const) {
  for (const exit of ['approve', 'escape-deny', 'ctrl-c', 'abort'] as const) {
    test(`pending ${stage} paste cannot leave approval editing via ${exit}`, async () => {
      const { app, stdin } = makeApp()
      let release!: (value: string | ClipboardImage | null) => void
      const read = new Promise<string | ClipboardImage | null>(resolve => { release = resolve })
      let started = false
      setClipboardReader({
        readImage: async () => stage === 'image' ? (started = true, await read as ClipboardImage | null) : null,
        readText: async () => { started = true; return await read as string | null },
      })
      try {
        const approval = app.callbacks.onApprovalRequired!('t1', 'write_file', { path: 'example.ts', content: 'original' })
        stdin.dataHandler!('e')
        assert.ok(app.getInputValue().includes('example.ts'), 'real edit key must load the approval draft')
        stdin.dataHandler!('\x16')
        await tick()
        assert.equal(started, true, 'clipboard read must actually be pending')
        if (exit === 'approve') { stdin.dataHandler!('\r'); stdin.dataHandler!('y') }
        else if (exit === 'escape-deny') { stdin.dataHandler!('\x1b'); await new Promise(resolve => setTimeout(resolve, 100)); stdin.dataHandler!('n') }
        else if (exit === 'ctrl-c') stdin.dataHandler!('\x03')
        else app.callbacks.onAbort()
        await approval
        assert.equal(app.getInputValue(), draft, 'leaving approval editing must restore the conversation draft')
        release(stage === 'image' ? image : 'late approval clipboard')
        await tick()
        await tick()
        assert.equal(app.getInputValue(), draft, 'old clipboard text must not cross into conversation input')
        assert.equal(app.getInputImagesCount(), 0, 'old clipboard image must not cross into conversation input')
      } finally { release(null); setClipboardReader(null); app.dispose() }
    })
  }
}

test('conversation paste pending across an approval prompt is discarded after resolution', async () => {
  const { app, stdin } = makeApp()
  let release!: (text: string | null) => void
  const read = new Promise<string | null>(resolve => { release = resolve })
  let started = false
  setClipboardReader({ readImage: async () => null, readText: async () => { started = true; return read } })
  try {
    stdin.dataHandler!('\x16')
    await tick()
    assert.equal(started, true)
    const approval = app.callbacks.onApprovalRequired!('t1', 'write_file', { path: 'example.ts', content: 'original' })
    stdin.dataHandler!('y')
    await approval
    release('late conversation clipboard')
    await tick()
    await tick()
    assert.equal(app.getInputValue(), draft)
  } finally { release(null); setClipboardReader(null); app.dispose() }
})

test('clipboard paste for the current approval editor remains available', async () => {
  const { app, stdin } = makeApp()
  setClipboardReader({ readImage: async () => null, readText: async () => 'current clipboard' })
  try {
    void app.callbacks.onApprovalRequired!('t1', 'write_file', { path: 'example.ts', content: 'original' })
    stdin.dataHandler!('e')
    stdin.dataHandler!('\x16')
    await tick()
    await tick()
    assert.ok(app.getInputValue().endsWith('current clipboard'), 'current owner must still accept its clipboard')
  } finally { setClipboardReader(null); app.dispose() }
})
