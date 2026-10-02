import type { RuntimeSessionManager, SessionDocumentRef } from './session-manager.js'
import type { SessionRecord } from './protocol.js'
import { MAX_DOCUMENTS, MAX_IMAGES } from './attachment-limits.js'
import { extractDocumentsToText } from './attachment-validation.js'
import { contextFileKind } from './file-context-policy.js'

export function rememberGoalInputs(record: SessionRecord, imageIds: string[], documents: SessionDocumentRef[]): void {
  const previous = record.goalInputs ?? { imageIds: [], documents: [] }
  record.goalInputs = {
    imageIds: [...new Set([...previous.imageIds, ...imageIds])],
    documents: [...new Map([...previous.documents, ...documents].map(d => [d.id, d])).values()],
  }
}

/** Copy original bytes, not references to another session's removable storage. */
export async function prepareRolloverInputs(manager: RuntimeSessionManager, source: SessionRecord) {
  const snapshot = { ...source, goalInputs: source.goalInputs }
  for (const event of (await manager.getAllEventsAsync(source.id))?.events ?? []) {
    if (event.type !== 'user') continue
    rememberGoalInputs(snapshot, Array.isArray(event.data.imageIds) ? event.data.imageIds as string[] : [],
      Array.isArray(event.data.documents) ? event.data.documents as SessionDocumentRef[] : [])
  }
  const refs = snapshot.goalInputs ?? { imageIds: [], documents: [] }
  if (refs.imageIds.length > MAX_IMAGES || refs.documents.length > MAX_DOCUMENTS) throw new Error('附件超过单轮限额，请先整理原始输入后恢复接力')
  const images = refs.imageIds.map(id => {
    const image = manager.readImage(source.id, id)
    if (!image) throw new Error('原始图片快照不可用，接力已暂停')
    return `data:${image.mime};base64,${image.bytes.toString('base64')}`
  })
  const documents = refs.documents.map(ref => {
    const doc = manager.readDocument(source.id, ref.id)
    if (!doc) throw new Error(`原始文件快照不可用：${ref.name}`)
    const mime = contextFileKind(ref.name) === 'text' ? 'text/plain' : doc.mime
    return { name: ref.name, dataUrl: `data:${mime};base64,${doc.bytes.toString('base64')}` }
  })
  const text = await extractDocumentsToText(documents)
  return { images, documents, text }
}
