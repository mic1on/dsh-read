// lib/formats/mobi.mjs — MOBI / PalmDB → plain text.
//
// A MOBI is a Palm database whose record 0 is a PalmDOC header followed by the
// MOBI header and an EXTH metadata block; the prose lives in the text records
// after it, either stored raw or PalmDOC LZ77 compressed.
//
// HUFF/CDIC compression (type 17480) needs the book's own Huffman tables and is
// deliberately not implemented — those files get a clear, actionable error.

import { headingTexts, htmlToText } from '../html.mjs'

const PALMDOC_COMPRESSION = 2
const NO_COMPRESSION = 1
const HUFFCDIC_COMPRESSION = 17480

const EXTH_UPDATED_TITLE = 503

/** True when the buffer carries a PalmDB `BOOKMOBI` type/creator pair. */
export function isPalmDatabase(buffer) {
  return buffer.length >= 78 && buffer.toString('latin1', 60, 68) === 'BOOKMOBI'
}

function palmDatabaseName(buffer) {
  let end = 0
  while (end < 32 && buffer[end] !== 0) end += 1
  return buffer.toString('latin1', 0, end).trim()
}

/** Expand one PalmDOC LZ77 record. */
function decompressPalmDoc(input) {
  let out = Buffer.alloc(Math.max(input.length * 4, 4096))
  let size = 0

  const reserve = (extra) => {
    if (size + extra <= out.length) return
    let capacity = out.length
    while (capacity < size + extra) capacity *= 2
    const grown = Buffer.alloc(capacity)
    out.copy(grown, 0, 0, size)
    out = grown
  }

  let at = 0
  while (at < input.length) {
    const byte = input[at]
    at += 1

    if (byte === 0) {
      reserve(1)
      out[size] = 0
      size += 1
    } else if (byte <= 8) {
      // 1..8 literal bytes follow verbatim.
      reserve(byte)
      for (let index = 0; index < byte && at < input.length; index += 1) {
        out[size] = input[at]
        size += 1
        at += 1
      }
    } else if (byte <= 0x7f) {
      reserve(1)
      out[size] = byte
      size += 1
    } else if (byte <= 0xbf) {
      if (at >= input.length) break
      const pair = (byte << 8) | input[at]
      at += 1
      const distance = (pair >> 3) & 0x07ff
      const count = (pair & 0x07) + 3
      if (distance === 0 || distance > size) throw new Error('corrupt PalmDOC back-reference')
      reserve(count)
      let from = size - distance
      for (let index = 0; index < count; index += 1) {
        out[size] = out[from]
        size += 1
        from += 1
      }
    } else {
      // 0xc0..0xff encode a space plus the byte with the high bit cleared.
      reserve(2)
      out[size] = 32
      size += 1
      out[size] = byte ^ 0x80
      size += 1
    }
  }

  return out.subarray(0, size)
}

function readExth(header) {
  const records = new Map()
  if (header.length < 24 || header.toString('latin1', 16, 20) !== 'MOBI') return records
  const headerLength = header.readUInt32BE(20)
  const exthStart = 16 + headerLength
  if (exthStart + 12 > header.length) return records
  if (header.toString('latin1', exthStart, exthStart + 4) !== 'EXTH') return records

  const count = header.readUInt32BE(exthStart + 8)
  let cursor = exthStart + 12
  for (let index = 0; index < count; index += 1) {
    if (cursor + 8 > header.length) break
    const type = header.readUInt32BE(cursor)
    const length = header.readUInt32BE(cursor + 4)
    if (length < 8 || cursor + length > header.length) break
    if (!records.has(type)) records.set(type, header.subarray(cursor + 8, cursor + length))
    cursor += length
  }
  return records
}

/**
 * Parse a MOBI buffer.
 * @returns {{ text: string, chapters: never[], headings: string[], title: string, format: string }}
 */
export function parseMobi(buffer) {
  if (buffer.length < 100) throw new Error('this MOBI file is too small to be valid')

  const recordCount = buffer.readUInt16BE(76)
  if (recordCount < 2) throw new Error('this MOBI file has an unusable record table')

  const offsets = []
  for (let index = 0; index < recordCount; index += 1) offsets.push(buffer.readUInt32BE(78 + index * 8))
  offsets.push(buffer.length)

  const header = buffer.subarray(offsets[0], offsets[1])
  if (header.length < 16) throw new Error('this MOBI file has a truncated header')

  const compression = header.readUInt16BE(0)
  const textLength = header.readUInt32BE(4)
  const textRecordCount = header.readUInt16BE(8)
  const encryption = header.readUInt16BE(12)

  if (encryption !== 0) throw new Error('this MOBI file is DRM-encrypted and cannot be read')
  if (compression === HUFFCDIC_COMPRESSION) {
    throw new Error(
      'this MOBI uses HUFF/CDIC compression, which is not supported; convert it to EPUB first (for example with Calibre)',
    )
  }
  if (compression !== NO_COMPRESSION && compression !== PALMDOC_COMPRESSION) {
    throw new Error(`unsupported MOBI compression type ${compression}; convert the book to EPUB first`)
  }

  const exth = readExth(header)
  const encodingCode = header.length >= 32 && header.toString('latin1', 16, 20) === 'MOBI'
    ? header.readUInt32BE(28)
    : 65001
  const encoding = encodingCode === 1252 ? 'windows-1252' : 'utf-8'

  const chunks = []
  for (let index = 1; index <= textRecordCount && index < recordCount; index += 1) {
    const record = buffer.subarray(offsets[index], offsets[index + 1])
    chunks.push(compression === PALMDOC_COMPRESSION ? decompressPalmDoc(record) : record)
  }

  let raw = Buffer.concat(chunks)
  if (textLength > 0 && textLength < raw.length) raw = raw.subarray(0, textLength)

  let html
  try {
    html = new TextDecoder(encoding).decode(raw)
  } catch {
    html = new TextDecoder('utf-8').decode(raw)
  }
  html = html.replace(/\u0000+$/g, '')

  const text = htmlToText(html)
  if (text.replace(/\s/g, '').length < 200) {
    throw new Error(
      'this file looks like KF8/AZW3, whose prose is not stored as plain MOBI text; convert it to EPUB first',
    )
  }

  const updatedTitle = exth.get(EXTH_UPDATED_TITLE)
  const title = updatedTitle
    ? new TextDecoder('utf-8').decode(updatedTitle).replace(/\u0000+$/g, '').trim().slice(0, 120)
    : palmDatabaseName(buffer)

  return { text, chapters: [], headings: headingTexts(html), title, format: 'mobi' }
}
