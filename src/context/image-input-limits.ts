import type { OaiMessage } from '../api/oai-types.js'

/** Native DeepSeek limits; unknown providers must not inherit this contract. */
export function deepSeekImageLimitError(messages: OaiMessage[]): Error | undefined {
  let count = 0, totalBytes = 0
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'image_url') continue
      if (++count > 600) return rejected('单次请求最多支持 600 张图片')
      const url = part.image_url.url
      const comma = url.indexOf(',')
      if (!url.startsWith('data:image/') || comma < 0 || !url.slice(0, comma).endsWith(';base64')) continue
      // Count decoded bytes without allocating another 32 MB buffer.
      const bytes = Math.floor((url.length - comma - 1) * 3 / 4) - (url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0)
      if (bytes > 32 * 1024 * 1024) return rejected('单张图片超过 32 MiB')
      totalBytes += bytes
      if (totalBytes > 64 * 1024 * 1024) return rejected('图片总大小超过 64 MiB')
    }
  }
  return undefined
}

function rejected(reason: string): Error {
  return Object.assign(new Error(`${reason}。原图片已保留，本次请求尚未发送；请减少当前附件或降低图片大小。`), { name: 'ImageInputRejectedError' })
}
