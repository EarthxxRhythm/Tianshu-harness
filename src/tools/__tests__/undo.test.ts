import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUndoTool } from '../undo.js'
import { FileHistory } from '../../agent/file-history.js'

const TMP = join(import.meta.dirname, '.undo-test-tmp')
const BACKUP = join(import.meta.dirname, '.undo-test-backup')

describe('createUndoTool', () => {
  let history: FileHistory

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    mkdirSync(BACKUP, { recursive: true })
    history = new FileHistory(BACKUP, 'undo-session')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
  })

  it('returns error when no history available', async () => {
    const tool = createUndoTool(() => undefined)
    const result = await tool.execute({ input: {}, toolUseId: 't', cwd: '/' })
    assert.equal(result.isError, true)
  })

  it('shows preview without confirm', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    writeFileSync(file, 'v2')

    const tool = createUndoTool(() => history)
    const result = await tool.execute({ input: {}, toolUseId: 't', cwd: '/' })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('预览'))
    assert.ok(result.content.includes('a.txt'))
  })

  it('restores files with confirm', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    writeFileSync(file, 'v2')

    const tool = createUndoTool(() => history)
    const result = await tool.execute({ input: { confirm: true }, toolUseId: 't', cwd: '/' })
    assert.ok(result.content.includes('已恢复'))
    assert.equal(readFileSync(file, 'utf-8'), 'v1')
  })

  it('skips a file claimed by another session and reports it', async () => {
    const own = join(TMP, 'own.txt')
    const peer = join(TMP, 'peer.txt')
    writeFileSync(own, 'v1')
    writeFileSync(peer, 'v1')
    await history.trackEdit(own, 'msg_1')
    await history.trackEdit(peer, 'msg_1')
    writeFileSync(own, 'v2')
    writeFileSync(peer, 'peer-v2')
    history.setClaimGuard({ isOwnedByOther: (filePath: string) => filePath === peer })

    const tool = createUndoTool(() => history)
    const result = await tool.execute({ input: { confirm: true }, toolUseId: 't', cwd: TMP })

    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('跳过'))
    assert.ok(result.content.includes('peer.txt'))
    assert.equal(readFileSync(own, 'utf-8'), 'v1', 'unclaimed file restored')
    assert.equal(readFileSync(peer, 'utf-8'), 'peer-v2', 'peer-claimed file untouched')
  })

  it('has correct tool name', () => {
    const tool = createUndoTool(() => undefined!)
    assert.equal(tool.definition.name, 'undo')
  })

  it('requires approval', () => {
    const tool = createUndoTool(() => undefined!)
    assert.equal(tool.requiresApproval({ input: {}, toolUseId: 't', cwd: '/' }), true)
  })
})
