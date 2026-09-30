// office-pdf: Native PDF generation (pdfkit) + text extraction (pdf-parse)
// Replaces the browser-print HTML fallback (create_pdf).

import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { containsCjk, resolveCjkFont } from './fonts.js'

// ── Helpers ──────────────────────────────────────────────────────

function artifactHint(filePath, summary) {
  return [
    `📄 PDF: ${summary}`,
    `   File: ${filePath}`,
    `   Use read_file to inspect, or open_path to view.`,
  ].join('\n')
}

function toCellText(val) {
  if (val === null || val === undefined) return ''
  return String(val)
}

// ── pdf_create ──────────────────────────────────────────────────

function collectText(input) {
  const parts = []
  if (input.title) parts.push(input.title)
  const blocks = Array.isArray(input.content) ? input.content : []
  for (const b of blocks) {
    if (!b) continue
    if (b.text) parts.push(b.text)
    if (Array.isArray(b.headers)) parts.push(b.headers.map(toCellText).join(' '))
    if (Array.isArray(b.rows)) for (const r of b.rows) parts.push((Array.isArray(r) ? r : []).map(toCellText).join(' '))
    if (Array.isArray(b.items)) parts.push(b.items.map(toCellText).join(' '))
  }
  if (typeof input.content === 'string') parts.push(input.content)
  return parts.join('\n')
}

/** @param {import('pdfkit')} PDFDocument */
async function generatePdf(filePath, input) {
  const PDFDocument = (await import('pdfkit')).default
  const warnings = []

  // CJK glyphs are absent from the built-in fonts — resolve a system font.
  const cjkNeeded = containsCjk(collectText(input))
  let cjkFont = null
  if (cjkNeeded) {
    cjkFont = await resolveCjkFont()
    if (!cjkFont) {
      warnings.push('未找到 CJK 字体，中文可能无法渲染 (no CJK font found on this system; Chinese text may not render)')
    }
  }

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: !!input.pageNumbers })
  const buffers = []

  // Body/heading font setters — code blocks always switch back via applyBody.
  const applyBody = () => {
    if (cjkFont) doc.font(cjkFont.path, cjkFont.name || undefined)
    else doc.font('Helvetica')
  }
  const applyHeading = () => {
    if (cjkFont) doc.font(cjkFont.path, cjkFont.headingName || cjkFont.name || undefined)
    else doc.font('Helvetica')
  }

  return new Promise((resolve, reject) => {
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => {
      // 原子替换：同目录临时文件 + rename（跨文件系统会 EXDEV，故不用 os.tmpdir）
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, Buffer.concat(buffers))
      renameSync(tmp, filePath)
      resolve(warnings)
    })
    doc.on('error', reject)

    const { title, content } = input

    applyBody()

    // Title
    if (title) {
      applyHeading()
      doc.fontSize(20).text(title, { align: 'center' })
      applyBody()
      doc.moveDown(1.5)
    }

    // Content blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue

        if (block.type === 'heading' || block.type === 'h1') {
          doc.moveDown(0.5)
          applyHeading()
          doc.fontSize(16).text(block.text || '', { continued: false })
          applyBody()
          doc.moveDown(0.5)
        } else if (block.type === 'h2') {
          doc.moveDown(0.3)
          applyHeading()
          doc.fontSize(14).text(block.text || '', { continued: false })
          applyBody()
          doc.moveDown(0.3)
        } else if (block.type === 'h3') {
          applyHeading()
          doc.fontSize(12).text(block.text || '', { continued: false })
          applyBody()
          doc.moveDown(0.2)
        } else if (block.type === 'paragraph' || block.type === 'text') {
          doc.fontSize(10).text(block.text || '', { align: 'justify' })
          doc.moveDown(0.5)
        } else if (block.type === 'table') {
          drawTable(doc, block, applyBody)
          doc.moveDown(0.5)
        } else if (block.type === 'list') {
          drawList(doc, block)
          doc.moveDown(0.5)
        } else if (block.type === 'code') {
          doc.font('Courier').fontSize(8).text(block.text || '')
          applyBody()
          doc.moveDown(0.3)
        } else {
          // fallback: plain text
          doc.fontSize(10).text(block.text || String(block))
          doc.moveDown(0.3)
        }
      }
    } else if (typeof content === 'string') {
      doc.fontSize(10).text(content, { align: 'justify' })
    }

    // Footer page numbers — second pass over buffered pages.
    if (input.pageNumbers) {
      const range = doc.bufferedPageRange()
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i)
        applyBody()
        const label = cjkNeeded
          ? `第 ${i + 1} 页 / 共 ${range.count} 页`
          : `Page ${i + 1} of ${range.count}`
        doc.fontSize(8).text(label, doc.page.margins.left, doc.page.height - doc.page.margins.bottom + 15, {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'center',
          lineBreak: false,
        })
      }
    }

    doc.end()
  })
}

function drawList(doc, block) {
  const items = Array.isArray(block.items) ? block.items : []
  if (items.length === 0) return
  const ordered = !!block.ordered
  const left = doc.page.margins.left
  const usable = doc.page.width - left - doc.page.margins.right

  doc.fontSize(10)
  items.forEach((item, idx) => {
    const bullet = ordered ? `${idx + 1}.` : '•'
    const y = doc.y
    // hanging indent: bullet in the gutter, text body indented
    doc.text(bullet, left + 4, y, { lineBreak: false })
    doc.text(toCellText(item), left + 20, y, { width: usable - 20 })
  })
}

function drawTable(doc, block, applyBody) {
  const rows = block.rows || []
  const headers = block.headers || []
  if (rows.length === 0 && headers.length === 0) return

  if (applyBody) applyBody()
  const allRows = headers.length > 0 ? [headers, ...rows] : rows
  const colCount = Math.max(...allRows.map(r => Array.isArray(r) ? r.length : 0), 1)
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / colCount
  const rowHeight = 18
  const fontSize = 9

  for (let ri = 0; ri < allRows.length; ri++) {
    const row = allRows[ri]
    const y = doc.y
    let maxH = rowHeight

    for (let ci = 0; ci < colCount; ci++) {
      const x = doc.page.margins.left + ci * colWidth
      const text = toCellText(Array.isArray(row) ? row[ci] : '')
      doc.fontSize(fontSize).text(text, x + 2, y + 2, {
        width: colWidth - 4,
        height: rowHeight - 4,
        ellipsis: true,
      })
    }

    // Draw cell borders
    doc.lineWidth(0.5)
    for (let ci = 0; ci <= colCount; ci++) {
      doc.moveTo(doc.page.margins.left + ci * colWidth, y)
        .lineTo(doc.page.margins.left + ci * colWidth, y + rowHeight)
        .stroke()
    }
    doc.moveTo(doc.page.margins.left, y + rowHeight)
      .lineTo(doc.page.margins.left + colCount * colWidth, y + rowHeight)
      .stroke()
    if (ri === 0) {
      doc.moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.margins.left + colCount * colWidth, y)
        .stroke()
    }

    doc.y = y + rowHeight
    if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage()
    }
  }
}

// ── pdf_read ────────────────────────────────────────────────────

async function extractPdfPages(filePath) {
  // 解析层用 pdf.js 官方的 pdfjs-dist（legacy 构建，专为 Node/旧环境）。
  //
  // 这里换掉过 pdf-parse@1.1.4：它捆绑的 pdf.js 四个版本（v1.9.426 / v1.10.88 /
  // v1.10.100 / v2.0.550）在 Node 24 下解析 pdfkit 生成的 PDF 会**概率性失败**
  // （'bad XRef entry' / 'Invalid number: …'），同一份 buffer 反复读也会（实测：
  // 有时第 1 次成功、有时第 3 次、也见过连续 15 次全失败）。四种手段逐一试过且
  // 全部无效：重试次数（3→8→15）、退避时长（50ms→1s）、等待（0→3s）、解析器版本。
  // 故这是解析层的兼容性问题，不是可调参修的——重试只会把不确定性往下游推。
  //
  // pdfjs-dist legacy 实测首次即稳定成功，因此本函数不再需要退避重试。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(filePath)),
    // Node 环境：不通过 fetch 取 worker/CMap（没有这个网络面），标准字体数据也不
    // 提供——纯文本提取不需要字形，缺它只会多一条无害 warning。
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise
  try {
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      // pdf.js 的 item 切分会把行内间距留在 str 里，再被 join(' ') 叠加成伪空格
      // （实测 code 行读回成 'const   answer   =   42'，title 与 heading 之间也是双空格）。
      // 折叠连续空白才是可读文本——注意 item 切分本就不保留缩进，折叠不损失更多信息。
      const text = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim()
      pages.push({ page: i, text })
    }
    return pages
  } finally {
    await doc.destroy()
  }
}

// ── Tool definitions ────────────────────────────────────────────

export const tools = [
  {
    definition: {
      name: 'pdf_create',
      description: 'Generate a real PDF with text, headings, tables, and lists. CJK text is rendered via an auto-detected system font (warns if none found). Content is an array of blocks: {type:"heading"|"h2"|"h3"|"paragraph"|"table"|"code"|"list", text?, headers?, rows?, items?, ordered?}',
      input_schema: {
        type: 'object',
        properties: {
          destination_path: { type: 'string', description: 'Output .pdf file path' },
          title: { type: 'string', description: 'Document title' },
          page_numbers: { type: 'boolean', description: 'Add centered footer page numbers ("Page X of Y" / "第 X 页 / 共 Y 页")' },
          content: {
            description: 'Content blocks array: [{type, text?, headers?, rows?, items?, ordered?}]',
          },
        },
        required: ['destination_path', 'content'],
      },
    },
    execute: async (params) => {
      const dest = params.destination_path
      if (!dest) return { content: 'Error: destination_path is required', isError: true }

      try {
        const warnings = await generatePdf(dest, {
          title: params.title,
          content: params.content,
          pageNumbers: params.page_numbers === true,
        })
        const name = basename(dest)
        const warnText = warnings.length > 0 ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : ''
        return {
          content: artifactHint(dest, `Generated "${name}"`) + warnText,
          rawPath: dest,
        }
      } catch (err) {
        return { content: `PDF generation failed: ${err.message}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'pdf_read',
      description: 'Extract text from a PDF file for reading into context. Each page is emitted under a "--- Page N ---" marker. Use start_page/end_page to read a specific range; large documents are truncated at 8000 characters with a continuation hint.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .pdf file to read' },
          start_page: { type: 'number', description: 'First page to read (1-based, default 1)' },
          end_page: { type: 'number', description: 'Last page to read (1-based, default last page)' },
        },
        required: ['file_path'],
      },
    },
    execute: async (params) => {
      const fp = params.file_path
      if (!fp) return { content: 'Error: file_path is required', isError: true }
      if (!existsSync(fp)) return { content: `Error: file not found: ${fp}`, isError: true }

      try {
        const pages = await extractPdfPages(fp)
        if (pages.length === 0) {
          return { content: 'PDF appears to contain no extractable text (scanned image?).' }
        }
        const start = Math.max(1, params.start_page ?? 1)
        const end = Math.min(pages.length, params.end_page ?? pages.length)
        if (start > end) {
          return { content: `Error: invalid page range: start_page ${start} > end_page ${end} (total ${pages.length} pages)`, isError: true }
        }

        const blocks = []
        let chars = 0
        for (let i = start - 1; i < end; i++) {
          const p = pages[i]
          if (!p) continue
          const block = p.text.length > 0
            ? `--- Page ${p.page} ---\n${p.text}`
            : `--- Page ${p.page} ---\n(empty)`
          if (chars + block.length > 8000 && blocks.length > 0) break
          blocks.push(block)
          chars += block.length + 1
        }

        const shownEnd = start + blocks.length - 1
        const hints = []
        if (shownEnd < end) hints.push(`Showing pages ${start}-${shownEnd} of ${pages.length}. Continue with start_page: ${shownEnd + 1}.`)
        else if (end < pages.length) hints.push(`Showing pages ${start}-${end} of ${pages.length}. Continue with start_page: ${end + 1}.`)
        if (hints.length > 0) blocks.push(hints.join('\n'))
        return { content: blocks.join('\n\n'), rawPath: fp }
      } catch (err) {
        return { content: `PDF read failed: ${err.message}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
