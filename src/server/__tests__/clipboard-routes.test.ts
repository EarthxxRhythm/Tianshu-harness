import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildClipboardRoutes } from '../clipboard-routes.js'
import { createRouter } from '../index.js'

const TOKEN = 'test-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function routerWith(image: { dataUrl: string; mime: string; name: string } | null) {
  return createRouter(buildClipboardRoutes(TOKEN, {
    readImage: async () => (image ? { ...image, source: 'png' as const } : null),
  }))
}

beforeEach(() => {})

test('GET /clipboard/image 有图时返回 dataUrl/mime/name', async () => {
  const router = routerWith({ dataUrl: 'data:image/png;base64,QUJD', mime: 'image/png', name: 'clipboard.png' })
  const res = await router('GET', '/clipboard/image', {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { image: { dataUrl: string; mime: string; name: string } }
  assert.equal(body.image.mime, 'image/png')
  assert.equal(body.image.dataUrl, 'data:image/png;base64,QUJD')
  assert.equal(body.image.name, 'clipboard.png')
})

test('GET /clipboard/image 剪贴板无图时 image:null（前端据此 toast，不静默）', async () => {
  const router = routerWith(null)
  const res = await router('GET', '/clipboard/image', {}, AUTH)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body as { image: null }, { image: null })
})

test('GET /clipboard/image 拒绝未授权请求', async () => {
  const router = routerWith(null)
  const res = await router('GET', '/clipboard/image', {}, {})
  assert.equal(res.status, 401)
})

test('GET /clipboard/image 取图抛错时返回 500（可解释失败，不静默空响应）', async () => {
  const router = createRouter(buildClipboardRoutes(TOKEN, {
    readImage: async () => { throw new Error('no clipboard tool') },
  }))
  const res = await router('GET', '/clipboard/image', {}, AUTH)
  assert.equal(res.status, 500)
})
