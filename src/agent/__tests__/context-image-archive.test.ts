import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore } from '../../artifact/store.js'
import { archiveContextImages, loadContextImage } from '../context-image-archive.js'

test('original image remains recallable after registry eviction and process restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-image-'))
  try {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    const store = new ArtifactStore(dir, 'session')
    const refs = await archiveContextImages(store, [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }])
    assert.equal(refs.length, 1)
    const restored = new ArtifactStore(dir, 'session')
    assert.equal((await loadContextImage(restored, refs[0]))?.dataUrl, url)
    const same = await archiveContextImages(restored, [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }])
    assert.deepEqual(same, refs)
    const other = await store.save({ tool: 'read', target: '', rawContent: url, summary: '', sections: [] })
    assert.equal(await loadContextImage(store, other), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('reusing an existing image still waits for its durability acknowledgement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'context-image-barrier-'))
  try {
    const store = new ArtifactStore(dir, 'session')
    const messages = [{ role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }]
    await archiveContextImages(store, messages)
    t.mock.method(store, 'confirmDurable', async () => { throw new Error('sync unavailable') })
    await assert.rejects(archiveContextImages(store, messages), /sync unavailable/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
