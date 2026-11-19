// Search the parsed book, never the conversation. Only one bounded page crosses the wire.
import { createHash } from 'node:crypto'
import { setImmediate as yieldTurn } from 'node:timers/promises'

export const SEARCH_PAGE_SIZE = 20
export const SEARCH_MAX_PAGE_SIZE = 50
export const SEARCH_QUERY_LIMIT = 100
const CHUNK_SIZE = 32 * 1024
const CONTEXT_SIZE = 60

export function searchQuery(value) {
  const query = String(value ?? '').trim()
  if (!query) throw new Error('请输入搜索关键词')
  if ([...query].length > SEARCH_QUERY_LIMIT) throw new Error('搜索关键词最多 100 个字符')
  return query
}

function chapterAt(chapters, index) {
  let low = 0
  let high = chapters.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (chapters[mid].index <= index) low = mid + 1
    else high = mid
  }
  return low ? chapters[low - 1].title : ''
}

function resultAt(book, index, start, length) {
  const paragraph = book.paragraphs[index]
  const end = start + length
  const from = Math.max(0, start - CONTEXT_SIZE)
  const to = Math.min(paragraph.text.length, end + CONTEXT_SIZE)
  return {
    index, start, end, offset: paragraph.offset + start,
    chapter: chapterAt(book.chapters, index),
    snippet: paragraph.text.slice(from, to),
    highlightStart: start - from, highlightEnd: end - from,
    leading: from > 0, trailing: to < paragraph.text.length,
  }
}

/** Literal, case-insensitive, non-overlapping matches within each prose paragraph. */
export async function searchBook(book, { query: input, cursor, limit = SEARCH_PAGE_SIZE, signal } = {}) {
  const query = searchQuery(input)
  const requested = Number(limit)
  if (!Number.isInteger(requested) || requested < 1) throw new Error('搜索分页大小必须为正整数')
  const size = Math.min(SEARCH_MAX_PAGE_SIZE, requested)
  // Parsing and LRU eviction may replace the object while its text stays identical.
  // This is a pagination consistency check, not an authentication token.
  const identity = createHash('sha256')
    .update(JSON.stringify([book.path, book.revision, query])).digest('hex')
  let index = 0
  let offset = 0
  if (cursor) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw new Error()
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (value.key !== identity || !Number.isInteger(value.index) || !Number.isInteger(value.offset)
        || value.index < 0 || value.index >= book.paragraphs.length || value.offset < 0
        || value.offset >= book.paragraphs[value.index].text.length) throw new Error()
      index = value.index
      offset = value.offset
    } catch { throw new Error('搜索游标无效，请重新搜索') }
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const results = []
  let scanned = 0
  for (; index < book.paragraphs.length; index += 1, offset = 0) {
    signal?.throwIfAborted()
    const paragraph = book.paragraphs[index]
    if (paragraph.image !== undefined) continue
    const text = paragraph.text
    while (offset < text.length) {
      const end = Math.min(text.length, offset + CHUNK_SIZE)
      // Overlap by the needle length so a chunk boundary cannot hide a match.
      const chunk = text.slice(offset, end + query.length - 1)
      pattern.lastIndex = 0
      let match
      let nextOffset = end
      while ((match = pattern.exec(chunk)) && offset + match.index < end) {
        const start = offset + match.index
        if (results.length === size) {
          const nextCursor = Buffer.from(JSON.stringify({ key: identity, index, offset: start })).toString('base64url')
          return { query, revision: book.revision, results, nextCursor }
        }
        results.push(resultAt(book, index, start, match[0].length))
        nextOffset = Math.max(nextOffset, start + match[0].length)
      }
      scanned += nextOffset - offset
      offset = nextOffset
      if (scanned >= CHUNK_SIZE) {
        await yieldTurn(undefined, { signal })
        scanned = 0
      }
    }
  }
  signal?.throwIfAborted()
  return { query, revision: book.revision, results, nextCursor: null }
}
