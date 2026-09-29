import { createHash } from 'node:crypto'
import type { ArtifactStore } from '../artifact/store.js'
import type { OaiMessage } from '../api/oai-types.js'
import { parseImageDataUrl, type RegisteredImage } from './image-registry.js'

export async function archiveContextImages(store: ArtifactStore, messages: OaiMessage[]): Promise<string[]> {
  const refs = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'image_url' || !part.image_url.url.startsWith('data:image/')) continue
      const data = part.image_url.url
      const target = `context-image:${createHash('sha256').update(data).digest('hex')}`
      const existing = store.listByTarget(target).find(a => a.tool === 'context-image')
      if (existing && await store.readRaw(existing.id) === data) {
        await store.confirmDurable(existing.id)
        refs.add(existing.id); continue
      }
      refs.add(await store.saveDurable({ tool: 'context-image', target, rawContent: data,
        summary: 'Original conversation image; recall with ask_image(imageId)', sections: [] }))
    }
  }
  return [...refs]
}

/** Only artifacts explicitly written as images may enter the visual tool path. */
export async function loadContextImage(store: ArtifactStore | undefined, id: string | undefined): Promise<RegisteredImage | undefined> {
  if (!store || !id) return undefined
  const artifact = store.get(id)
  if (!artifact || artifact.tool !== 'context-image' || artifact.charCount > 46 * 1024 * 1024) return undefined
  const dataUrl = await store.readRaw(id)
  const parsed = dataUrl ? parseImageDataUrl(dataUrl) : null
  if (!dataUrl || !parsed) return undefined
  return { id, dataUrl, mime: parsed.mime, bytes: Math.ceil(parsed.base64.length * 3 / 4), descriptions: new Map(), lastUsed: 0 }
}
