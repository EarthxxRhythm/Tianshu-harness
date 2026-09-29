import type { OaiMessage } from './oai-types.js'

/** Old releases could truncate protocol strings on disk. Never resend those bytes. */
export function assertCompleteAttachments(messages: readonly OaiMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const damaged = Array.isArray(message.content)
      ? message.content.some(part => part.type === 'image_url' && part.image_url.url.includes('<session-message-truncated '))
      : message.content.startsWith('{"role":"user","content":[')
        && message.content.includes('"image_url"') && message.content.includes('<session-message-truncated ')
    if (damaged) throw new Error('附件不完整：旧版本保存时截断了图片。请移除损坏附件并重新添加原图；原始会话记录未被修改。')
  }
}
