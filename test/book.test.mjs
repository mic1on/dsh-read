// Tests build minimal EPUB and MOBI containers in memory and read them back through
// the real parsers, so no fixture binaries are needed and both container readers are
// exercised end to end.

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'

import { loadBook, detectChapters, snapChapters, splitParagraphs } from '../lib/book.mjs'
import { parseEpub } from '../lib/formats/epub.mjs'
import { parseMobi } from '../lib/formats/mobi.mjs'

/* ── container builders ─────────────────────────────────────────────────── */

function makeZip(entries) {
  const parts = []
  const central = []
  let offset = 0

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(data)
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    parts.push(local, nameBytes, compressed)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(checksum, 16)
    entry.writeUInt32LE(compressed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([entry, nameBytes]))

    offset += local.length + nameBytes.length + compressed.length
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...parts, centralBytes, end])
}

/** PalmDOC literal encoding (0x01 = "copy one byte verbatim") — valid, if unoptimized. */
function palmDocLiteralEncode(bytes) {
  const out = Buffer.alloc(bytes.length * 2)
  let size = 0
  for (const byte of bytes) {
    out[size] = 0x01
    out[size + 1] = byte
    size += 2
  }
  return out.subarray(0, size)
}

function makeMobi(html, title = 'Fixture Book') {
  const text = Buffer.from(html, 'utf8')
  const recordSize = 4096
  const textRecords = []
  for (let at = 0; at < text.length; at += recordSize) {
    textRecords.push(palmDocLiteralEncode(text.subarray(at, at + recordSize)))
  }

  const mobiHeaderLength = 232
  const titleBytes = Buffer.from(title, 'utf8')
  const exthRecord = Buffer.alloc(8 + titleBytes.length)
  exthRecord.writeUInt32BE(503, 0)
  exthRecord.writeUInt32BE(8 + titleBytes.length, 4)
  titleBytes.copy(exthRecord, 8)
  const exthLength = 12 + exthRecord.length

  const record0 = Buffer.alloc(16 + mobiHeaderLength + exthLength)
  record0.writeUInt16BE(2, 0) // PalmDOC compression
  record0.writeUInt32BE(text.length, 4)
  record0.writeUInt16BE(textRecords.length, 8)
  record0.writeUInt16BE(recordSize, 10)
  record0.writeUInt16BE(0, 12)
  record0.write('MOBI', 16, 'latin1')
  record0.writeUInt32BE(mobiHeaderLength, 20)
  record0.writeUInt32BE(2, 24)
  record0.writeUInt32BE(65001, 28)
  record0.write('EXTH', 16 + mobiHeaderLength, 'latin1')
  record0.writeUInt32BE(exthLength, 16 + mobiHeaderLength + 4)
  record0.writeUInt32BE(1, 16 + mobiHeaderLength + 8)
  exthRecord.copy(record0, 16 + mobiHeaderLength + 12)

  const records = [record0, ...textRecords]
  const headerSize = 78 + records.length * 8
  const header = Buffer.alloc(headerSize)
  header.write(title.slice(0, 31), 0, 'latin1')
  header.write('BOOK', 60, 'latin1')
  header.write('MOBI', 64, 'latin1')
  header.writeUInt16BE(records.length, 76)

  let offset = headerSize
  records.forEach((record, at) => {
    header.writeUInt32BE(offset, 78 + at * 8)
    offset += record.length
  })

  return Buffer.concat([header, ...records])
}

/* ── fixtures ───────────────────────────────────────────────────────────── */

const PROSE =
  'The lighthouse keeper counted the ships each morning, and every morning the number was different. ' +
  'He wrote the totals in a ledger that nobody else ever read, because the ledger was the only thing ' +
  'in his life that stayed exactly where he left it.'

function epubFixture() {
  return makeZip([
    [
      'META-INF/container.xml',
      '<?xml version="1.0"?><container><rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
        '</rootfiles></container>',
    ],
    [
      'OEBPS/content.opf',
      '<package><metadata><dc:title>Fixture EPUB</dc:title></metadata><manifest>' +
        '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="css" href="style.css" media-type="text/css"/>' +
        '</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    ],
    [
      'OEBPS/ch1.xhtml',
      `<html><head><title>one</title></head><body><h1>Chapter One</h1><p>${PROSE}</p></body></html>`,
    ],
    [
      'OEBPS/ch2.xhtml',
      `<html><head><title>two</title></head><body><h1>Chapter Two</h1><p>${PROSE}</p>` +
        '<p>Salty &amp; cold &#8212; he liked it that way.</p></body></html>',
    ],
    ['OEBPS/style.css', 'body { color: red }'],
  ])
}

const MOBI_HTML =
  `<html><body><h1>Chapter One</h1><p>${PROSE}</p>` +
  `<h1>Chapter Two</h1><p>${PROSE}</p><p>Salty &amp; cold &#8212; he liked it that way.</p></body></html>`

/* ── tests ──────────────────────────────────────────────────────────────── */

test('EPUB: reads the spine in order and skips non-prose entries', () => {
  const parsed = parseEpub(epubFixture())
  assert.equal(parsed.title, 'Fixture EPUB')
  assert.equal(parsed.chapters.length, 2)
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['Chapter One', 'Chapter Two'],
  )
  assert.match(parsed.text, /Chapter One/)
  assert.match(parsed.text, /Salty & cold \u2014 he liked it that way\./)
  assert.doesNotMatch(parsed.text, /color: red/)
})

test('MOBI: expands PalmDOC records and strips markup', () => {
  const parsed = parseMobi(makeMobi(MOBI_HTML))
  assert.equal(parsed.title, 'Fixture Book')
  assert.match(parsed.text, /Chapter One/)
  assert.match(parsed.text, /Salty & cold \u2014 he liked it that way\./)
  assert.doesNotMatch(parsed.text, /<p>/)
  assert.deepEqual(parsed.headings, ['Chapter One', 'Chapter Two'])
})

test('MOBI: HUFF/CDIC compression is rejected with a useful message', () => {
  const mobi = makeMobi(MOBI_HTML)
  const headerOffset = mobi.readUInt32BE(78) // record 0 is the PalmDOC/MOBI header
  mobi.writeUInt16BE(17480, headerOffset)
  assert.throws(() => parseMobi(mobi), /HUFF\/CDIC/)
})

test('paragraph splitting keeps offsets that address the original text', () => {
  const text = 'first paragraph\n\nsecond paragraph\n\nthird'
  const paragraphs = splitParagraphs(text)
  assert.equal(paragraphs.length, 3)
  for (const paragraph of paragraphs) {
    assert.equal(text.slice(paragraph.offset, paragraph.offset + paragraph.text.length), paragraph.text)
  }
})

test('line-per-paragraph novels fall back to line splitting', () => {
  const text = Array.from({ length: 250 }, (_, at) => `line ${at}`).join('\n')
  assert.equal(splitParagraphs(text).length, 250)
})

test('chapter detection snapshots offsets onto paragraph indices', () => {
  const paragraphs = splitParagraphs('序章\n\nbody one\n\n第一章 起风\n\nbody two\n\n第二章 落雨\n\nbody three')
  const chapters = snapChapters(detectChapters(paragraphs), paragraphs)
  assert.deepEqual(
    chapters.map((chapter) => [chapter.index, chapter.title]),
    [
      [0, '序章'],
      [2, '第一章 起风'],
      [4, '第二章 落雨'],
    ],
  )
})

test('loadBook reads an EPUB and a MOBI from disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-'))
  try {
    const epubPath = join(directory, 'fixture.epub')
    const mobiPath = join(directory, 'fixture.mobi')
    await writeFile(epubPath, epubFixture())
    await writeFile(mobiPath, makeMobi(MOBI_HTML))

    const epub = await loadBook(epubPath)
    assert.equal(epub.format, 'epub')
    assert.equal(epub.chapters.length, 2)
    assert.ok(epub.paragraphCount > 2)
    assert.equal(epub.paragraphs[0].text, 'Chapter One')

    const mobi = await loadBook(mobiPath)
    assert.equal(mobi.format, 'mobi')
    assert.equal(mobi.title, 'Fixture Book')
    assert.ok(mobi.paragraphCount > 2)
    assert.equal(mobi.chapters.length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
