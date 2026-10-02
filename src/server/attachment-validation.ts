import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_DOCUMENTS, MAX_DOCUMENT_BYTES } from './attachment-limits.js'
import { contextFileKind, contextDataUrlBytes, decodeContextText, MAX_TEXT_ATTACHMENT_BYTES } from './file-context-policy.js'
import { extractDocumentText, EXTRACTION_CAVEAT, isExtractableDocument } from '../tools/doc-extract.js'
import { isSafeFileName } from '../utils/safe-path.js'

function decodedBase64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

/** Validate a documents payload: array of { name, dataUrl } for office/pdf files.
 *  Server extracts text via doc-extract (pdftotext/textutil/soffice/exceljs) and
 *  prepends to prompt — same injection pattern as the vision bridge.
 *  Shared by POST /sessions (create-with-documents，欢迎页附件) 与
 *  POST /sessions/:id/prompt。 */
export function validateDocumentsPayload(value: unknown): { documents?: Array<{ name: string; dataUrl: string }>; error?: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.length === 0) {
    return { error: '"documents" must be a non-empty array' }
  }
  if (value.length > MAX_DOCUMENTS) {
    return { error: `Max ${MAX_DOCUMENTS} documents allowed` }
  }
  for (const doc of value) {
    if (typeof doc !== 'object' || doc === null || typeof (doc as { name?: unknown }).name !== 'string' || typeof (doc as { dataUrl?: unknown }).dataUrl !== 'string') {
      return { error: 'Each document must be { name: string, dataUrl: string }' }
    }
    // 扩展名白名单（与图片路径的 ACCEPTED_IMAGE_DATA_URL 对称）：此前任意扩展名
    // 都能过校验、落盘并交给抽取器；白名单取 doc-extract 的 EXTRACTABLE——
    // 「能抽取才放行」，两侧语义单一来源。
    const { name, dataUrl } = doc as { name: string; dataUrl: string }
    if (!isSafeFileName(name) || contextFileKind(name) === 'unsupported') {
      return { error: 'Each document must be an extractable type or a readable text file' }
    }
    if (dataUrl.startsWith('data:text/plain;base64,')) {
      if (!['text', 'candidate'].includes(contextFileKind(name))) return { error: 'Text attachments must have a text filename' }
      if (decodedBase64Bytes(dataUrl) > MAX_TEXT_ATTACHMENT_BYTES) return { error: `${name}: text-too-large` }
      try { decodeContextText(contextDataUrlBytes(dataUrl)) }
      catch (err) { return { error: `${name}: ${(err as Error).message} (text limit ${MAX_TEXT_ATTACHMENT_BYTES / 1024} KiB)` } }
      continue
    }
    if (!isExtractableDocument(name)) {
      return { error: 'Each document must be an extractable type (.pdf/.docx/.xlsx/…)' }
    }
    if (decodedBase64Bytes(dataUrl) > MAX_DOCUMENT_BYTES) {
      return { error: `Each document must be <= ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB` }
    }
  }
  return { documents: value as Array<{ name: string; dataUrl: string }> }
}

/** 把文档附件（base64 dataUrl）落盘到临时目录，调 extractDocumentText 抽取文本，
 *  返回拼好的前置块（含 EXTRACTION_CAVEAT）。失败的单个文档降级为错误提示，
 *  不阻断整体发送。 */
export async function extractDocumentsToText(
  documents: Array<{ name: string; dataUrl: string }>,
): Promise<string | null> {
  const parts: string[] = []
  let tmpBase: string | undefined
  try {
    for (const doc of documents) {
      if (doc.dataUrl.startsWith('data:text/plain;base64,')) {
        parts.push(`[file: ${doc.name}]\n${decodeContextText(contextDataUrlBytes(doc.dataUrl))}`)
        continue
      }
      tmpBase ??= mkdtempSync(join(tmpdir(), 'rivet-doc-'))
      const tmpPath = join(tmpBase, `${doc.name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
      try {
        const base64 = doc.dataUrl.split(',')[1] ?? ''
        writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
        const result = await extractDocumentText(tmpPath)
        if (result.ok) {
          parts.push(`[document: ${doc.name}]\n${EXTRACTION_CAVEAT}\n\n${result.text}`)
        } else {
          parts.push(`[document: ${doc.name}]\n(extraction failed: ${result.suggestion})`)
        }
      } catch (err) {
        parts.push(`[document: ${doc.name}]\n(extraction error: ${(err as Error).message})`)
      }
    }
  } finally {
    if (tmpBase) rmSync(tmpBase, { recursive: true, force: true })
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null
}
