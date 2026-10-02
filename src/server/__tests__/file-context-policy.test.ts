import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextFileKind, decodeContextText, contextDataUrlBytes, isSuggestedContextFile, MAX_TEXT_ATTACHMENT_BYTES } from '../file-context-policy.js'
import { rankFiles } from '../file-list.js'

test('human files: office, markdown, scripts and source; private/binary files excluded', () => {
  for (const file of ['报告.docx', 'README.md', 'deploy.sh', 'data.csv', 'view.cs', 'Dockerfile']) assert.notEqual(contextFileKind(file), 'candidate')
  for (const file of ['app.exe', 'video.mp4', 'font.woff2', '.env', 'credentials.json', 'id_rsa']) assert.equal(contextFileKind(file), 'unsupported')
  assert.equal(contextFileKind('notes.custom'), 'candidate')
})
test('generated files hidden by default, explicit names remain searchable', () => {
  assert.equal(isSuggestedContextFile('public/app.min.js'), false)
  assert.equal(isSuggestedContextFile('public/app.min.js', 'app.min.js'), true)
  assert.equal(isSuggestedContextFile('notes.custom'), false)
  assert.equal(isSuggestedContextFile('notes.custom', 'notes.custom'), true)
  assert.equal(isSuggestedContextFile('app.exe', 'app.exe'), false)
  assert.equal(isSuggestedContextFile('pnpm-lock.yaml'), false)
})
test('ranking prioritizes documents and scripts; filename match outranks category', () => {
  assert.deepEqual(rankFiles(['a.ts', 'deploy.sh', 'report.docx', 'README.md'], ''), ['README.md', 'report.docx', 'deploy.sh', 'a.ts'])
  assert.equal(rankFiles(['docs/controller.md', 'controller.ts'], 'controller.ts')[0], 'controller.ts')
})
test('text decoding preserves Unicode/empty files, supports BOM and rejects binary/oversize', () => {
  assert.equal(decodeContextText(new TextEncoder().encode('你好\n#!/bin/sh')), '你好\n#!/bin/sh')
  assert.equal(decodeContextText(new Uint8Array()), '')
  assert.equal(decodeContextText(Uint8Array.from([0xff, 0xfe, 65, 0])), 'A')
  assert.throws(() => decodeContextText(Uint8Array.from([65, 0, 66])), /text-binary/)
  assert.throws(() => decodeContextText(Uint8Array.from([0xff, 0xab])), /text-encoding/)
  assert.throws(() => decodeContextText(new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1)), /text-too-large/)
  assert.deepEqual(contextDataUrlBytes('data:text/plain;base64,5L2g5aW9'), new TextEncoder().encode('你好'))
  assert.throws(() => contextDataUrlBytes('data:text/plain;base64,%%%%'), /attachment-data/)
})
