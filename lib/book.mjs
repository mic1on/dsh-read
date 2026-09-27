// lib/book.mjs — the reader model: bytes on disk → chapters + chapters of paragraphs.
//
// A parsed book is kept in a small LRU because the GUI asks for it again on every
// panel reopen and paragraph window; parsing a 5 MB EPUB on each request would be
// wasteful. Only `CACHE_LIMIT` books are retained, so memory stays bounded.

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { isZip, parseEpub } from './formats/epub.mjs'
import { isPalmDatabase, parseMobi } from './formats/mobi.mjs'
import { decodeTextBuffer } from './formats/text.mjs'

/** Extensions the browser and scanner will offer. */
export const BOOK_EXTENSIONS = [
  '.epub',
  '.mobi',
  '.azw',
  '.azw3',
  '.txt',
  '.md',
  '.markdown',
  '.text',
  '.log',
]

const KINDLY_EXTENSIONS = new Set(['.mobi', '.azw', '.azw3'])

/** Refuse absurd inputs rather than exhausting the host process. */
export const MAX_BOOK_BYTES = 256 * 1024 * 1024

const CACHE_LIMIT = 3
const cache = new Map()

const CHAPTER_PATTERN =
  /^(?:第\s*[0-9\uff10-\uff19\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u96f6\u3007\u4e24]{1,12}\s*[\u7ae0\u8282\u7bc0\u56de\u5377\u7bc7\u90e8\u96c6]|(?:chapter|part|book)\s+[0-9ivxlcdm]+|prologue|epilogue|foreword|preface|introduction|\u5e8f\u7ae0|\u5e8f\u8a00|\u81ea\u5e8f|\u524d\u8a00|\u5f15\u5b50|\u6954\u5b50|\u540e\u8bb0|\u5f8c\u8a18|\u5c3e\u58f0|\u5c3e\u8072|\u756a\u5916|\u9644\u5f55|\u9644\u9304)/i

function parseBookBuffer(buffer, filePath) {
  const extension = extname(filePath).toLowerCase()

  if (extension === '.epub' || isZip(buffer)) return parseEpub(buffer)
  if (isPalmDatabase(buffer)) return parseMobi(buffer)
  if (KINDLY_EXTENSIONS.has(extension)) {
    throw new Error(
      'this file is not a standard MOBI container; convert it to EPUB or MOBI first (for example with Calibre)',
    )
  }

  const decoded = decodeTextBuffer(buffer)
  return { ...decoded, chapters: [], headings: [], title: '' }
}

/**
 * Split prose into paragraphs while preserving each paragraph's offset in the
 * whole text, so progress can be measured in characters.
 *
 * Blank-line separated blocks win; a file that is one line per paragraph with no
 * blank lines at all (the usual shape of a Chinese .txt novel) falls back to lines.
 */
export function splitParagraphs(text) {
  const lines = text.split('\n')
  let blocks = text.split(/\n[ \t]*\n+/)
  if (blocks.length < 12 && lines.length > 200) blocks = lines

  const paragraphs = []
  let cursor = 0
  for (const block of blocks) {
    const trimmed = block.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '')
    if (!trimmed) continue
    let offset = text.indexOf(trimmed, cursor)
    if (offset < 0) offset = cursor
    paragraphs.push({ text: trimmed, offset })
    cursor = offset + trimmed.length
  }
  return paragraphs
}

/** Find chapter starts by heading convention, extended by parser-supplied heading hints. */
export function detectChapters(paragraphs, headings = []) {
  const hints = new Set(headings.filter(Boolean))
  const found = []
  for (let index = 0; index < paragraphs.length && found.length < 800; index += 1) {
    const paragraph = paragraphs[index]
    const matches = CHAPTER_PATTERN.test(paragraph.text.slice(0, 48))
    const hinted = hints.has(paragraph.text.slice(0, 90))
    if (!matches && !hinted) continue
    found.push({ title: paragraph.text.split('\n')[0].slice(0, 90), offset: paragraph.offset })
  }
  return found
}

/** Map character offsets onto paragraph indices, dropping duplicates. */
export function snapChapters(chapters, paragraphs) {
  const out = []
  let cursor = 0
  for (const chapter of chapters) {
    const target = Number(chapter.offset) || 0
    while (cursor + 1 < paragraphs.length && paragraphs[cursor + 1].offset <= target) cursor += 1
    if (out.length > 0 && out[out.length - 1].index === cursor) continue
    out.push({
      title: String(chapter.title || '').slice(0, 90),
      offset: paragraphs[cursor].offset,
      index: cursor,
    })
  }
  return out
}

/** Parse a book from disk, reusing the cached parse when it is still hot. */
export async function loadBook(filePath) {
  const cached = cache.get(filePath)
  if (cached) {
    cache.delete(filePath)
    cache.set(filePath, cached)
    return cached
  }

  const info = await stat(filePath).catch(() => null)
  if (!info) throw new Error(`file not found: ${filePath}`)
  if (!info.isFile()) throw new Error(`not a file: ${filePath}`)
  if (info.size > MAX_BOOK_BYTES) {
    throw new Error(`file exceeds the ${MAX_BOOK_BYTES / 1024 / 1024} MB limit`)
  }

  const buffer = await readFile(filePath)
  const parsed = parseBookBuffer(buffer, filePath)
  const paragraphs = splitParagraphs(parsed.text)
  if (paragraphs.length === 0) throw new Error('this book has no readable text')

  const declared = parsed.chapters && parsed.chapters.length > 0
    ? parsed.chapters
    : detectChapters(paragraphs, parsed.headings)

  const entry = {
    path: filePath,
    name: basename(filePath),
    title: parsed.title || basename(filePath).replace(/\.[^.]+$/, ''),
    format: parsed.format,
    chars: parsed.text.length,
    bytes: info.size,
    paragraphCount: paragraphs.length,
    paragraphs,
    chapters: snapChapters(declared, paragraphs),
  }

  cache.set(filePath, entry)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return entry
}

/** The subset of a parsed book that crosses the wire. */
export function publicBook(entry) {
  return {
    path: entry.path,
    name: entry.name,
    title: entry.title,
    format: entry.format,
    chars: entry.chars,
    bytes: entry.bytes,
    paragraphCount: entry.paragraphCount,
    chapters: entry.chapters,
  }
}

/** One page of paragraphs, addressed by absolute index. */
export function paragraphWindow(entry, from, count) {
  const safeFrom = Math.max(0, Math.min(entry.paragraphCount, Math.floor(from)))
  const safeCount = Math.max(1, Math.min(120, Math.floor(count)))
  return {
    from: safeFrom,
    total: entry.paragraphCount,
    items: entry.paragraphs
      .slice(safeFrom, safeFrom + safeCount)
      .map((paragraph) => ({ text: paragraph.text, offset: paragraph.offset })),
  }
}
