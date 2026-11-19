import assert from 'node:assert/strict'
import test from 'node:test'
import { searchBook } from '../lib/book-search.mjs'
import { detectChapters, snapChapters, splitParagraphs } from '../lib/book.mjs'

function book(text) {
  const paragraphs = splitParagraphs(text)
  return { path: '/test/book.txt', chars: text.length, paragraphCount: paragraphs.length,
    paragraphs, chapters: snapChapters(detectChapters(paragraphs), paragraphs) }
}

test('searches the entire book, reports original offsets, chapters, and individual literal matches', async () => {
  const entry = book('序章\n\nFirst\n\n第二章 风\n\n' + Array(200).fill('风吹草低').join('\n\n') + '\n\nAlpha [x]. ALPHA [x]. 中文中文')
  const result = await searchBook(entry, { query: '  aLpHa [x].  ' })
  assert.equal(result.query, 'aLpHa [x].')
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].index, entry.paragraphCount - 1)
  assert.equal(result.results[0].chapter, '第二章 风')
  for (const hit of result.results) {
    assert.equal(hit.snippet.slice(hit.highlightStart, hit.highlightEnd).toLowerCase(), result.query.toLowerCase())
    assert.equal(hit.offset, entry.paragraphs[hit.index].offset + hit.start)
  }
  assert.equal((await searchBook(entry, { query: '中文' })).results.length, 2)
  assert.equal((await searchBook(entry, { query: 'First\n第二章' })).results.length, 0)
})

test('bounded cursor pages include every non-overlapping hit once, including within the same paragraph', async () => {
  const entry = book('aaaaa\n\n' + 'needle '.repeat(123))
  assert.deepEqual((await searchBook(entry, { query: 'aa' })).results.map((hit) => hit.start), [0, 2])
  const all = []
  let cursor
  do {
    const page = await searchBook(entry, { query: 'needle', cursor })
    assert.ok(page.results.length <= 20)
    all.push(...page.results)
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(all.length, 123)
  assert.equal(new Set(all.map((hit) => hit.offset)).size, 123)
  assert.equal((await searchBook(entry, { query: 'needle', limit: 999 })).results.length, 50)
  const exact = await searchBook(book('x '.repeat(20)), { query: 'x' })
  assert.equal(exact.nextCursor, null)
})

test('chunk boundaries neither lose nor overlap matches; snippets stay bounded in huge paragraphs', async () => {
  const entry = book('z'.repeat(32766) + 'ababab' + 'z'.repeat(70000) + 'abab')
  const page = await searchBook(entry, { query: 'abab' })
  assert.deepEqual(page.results.map((hit) => hit.start), [32766, 102772])
  assert.ok(page.results.every((hit) => hit.snippet.length <= 124 && hit.leading && hit.trailing === (hit.start === 32766)))
})

test('rejects empty, oversized queries, invalid limits, and cursors from other queries or books', async () => {
  const entry = book('x '.repeat(100))
  for (const query of ['', '  ', '😀'.repeat(101)]) await assert.rejects(searchBook(entry, { query }), /关键词/)
  assert.equal((await searchBook(entry, { query: '😀'.repeat(100) })).results.length, 0)
  for (const limit of [0, -1, NaN, Infinity, 1.5, 100.5, 'wat']) await assert.rejects(searchBook(entry, { query: 'x', limit }), /分页/)
  const { nextCursor } = await searchBook(entry, { query: 'x' })
  for (const cursor of ['broken', 'x'.repeat(513), Buffer.from('{"index":-1}').toString('base64url')]) {
    await assert.rejects(searchBook(entry, { query: 'x', cursor }), /游标/)
  }
  await assert.rejects(searchBook(entry, { query: 'y', cursor: nextCursor }), /游标/)
  await assert.rejects(searchBook({ ...entry, path: '/another.txt' }, { query: 'x', cursor: nextCursor }), /游标/)
  await assert.rejects(searchBook({ ...entry }, { query: 'x', cursor: nextCursor }), /游标/)
})

test('skips images and returns safe source text without interpreting query markup', async () => {
  const entry = book('<img onerror="alert(1)"> & [.*]')
  entry.paragraphs.unshift({ text: 'hidden', image: 0, offset: 0 })
  entry.paragraphCount += 1
  assert.equal((await searchBook(entry, { query: 'hidden' })).results.length, 0)
  assert.equal((await searchBook(entry, { query: '<img' })).results[0].snippet, '<img onerror="alert(1)"> & [.*]')
  assert.equal((await searchBook(entry, { query: '[.*]' })).results.length, 1)
})

test('long scans yield to the event loop and honor cancellation', async () => {
  const entry = book('plain '.repeat(1000000))
  const controller = new AbortController()
  let yielded = false
  const pending = searchBook(entry, { query: 'missing', signal: controller.signal })
  setImmediate(() => { yielded = true; controller.abort() })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yielded, true)
})
