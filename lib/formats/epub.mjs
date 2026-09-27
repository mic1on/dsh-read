// lib/formats/epub.mjs — EPUB (an OCF/ZIP container) → plain text + spine chapters.
//
// Only the handful of entries that hold prose are ever inflated: the container
// descriptor, the OPF package document and the spine documents. Images, fonts
// and stylesheets are skipped, which keeps a typical novel cheap to open.

import { inflateRawSync } from 'node:zlib'

import { decodeEntities, htmlToText } from '../html.mjs'

const UTF8 = new TextDecoder('utf-8')

const SIG_LOCAL_FILE = 0x04034b50
const SIG_CENTRAL_FILE = 0x02014b50
const SIG_END_OF_CENTRAL = 0x06054b50

/** True when the buffer starts with a ZIP local-file or empty-archive signature. */
export function isZip(buffer) {
  if (buffer.length < 4) return false
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false
  return buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07
}

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 66_000)
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === SIG_END_OF_CENTRAL) return at
  }
  return -1
}

function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('this file is not a readable EPUB archive')
  const total = buffer.readUInt16LE(eocd + 10)
  const start = buffer.readUInt32LE(eocd + 16)
  if (total === 0xffff || start === 0xffffffff) {
    throw new Error('ZIP64 EPUB archives are not supported')
  }

  const entries = new Map()
  let cursor = start
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL_FILE) break
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = UTF8.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    entries.set(name, { name, flags, method, compressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntry(buffer, entry) {
  const at = entry.localOffset
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== SIG_LOCAL_FILE) {
    throw new Error(`corrupt EPUB entry: ${entry.name}`)
  }
  const nameLength = buffer.readUInt16LE(at + 26)
  const extraLength = buffer.readUInt16LE(at + 28)
  const dataStart = at + 30 + nameLength + extraLength

  // Bit 3 defers the sizes to a trailing data descriptor; the central directory
  // may then carry a zero. Handing the inflater the rest of the stream is safe
  // because it stops at the end of the deflate stream.
  const streamed = (entry.flags & 0x08) !== 0 || entry.compressedSize === 0
  const raw = streamed
    ? buffer.subarray(dataStart)
    : buffer.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`unsupported EPUB compression method ${entry.method} in ${entry.name}`)
}

function attribute(tag, name) {
  const double = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  if (double) return double[1]
  const single = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)
  return single ? single[1] : ''
}

function directoryOf(path) {
  const at = path.lastIndexOf('/')
  return at >= 0 ? path.slice(0, at) : ''
}

function resolveRelative(base, href) {
  let clean = String(href).split('#')[0]
  try {
    clean = decodeURIComponent(clean)
  } catch {
    // keep the raw href when it is not valid percent-encoding
  }
  const joined = clean.startsWith('/') ? clean.slice(1) : base ? `${base}/${clean}` : clean
  const parts = []
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

function headingOf(html) {
  const match = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i.exec(html)
  if (!match) return ''
  return htmlToText(match[1]).replace(/\s+/g, ' ').trim().slice(0, 90)
}

function titleOf(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  if (!match) return ''
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 90)
}

function packageTitle(opf) {
  const match = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title\s*>/i.exec(opf)
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 120) : ''
}

/**
 * Parse an EPUB buffer.
 * @returns {{ text: string, chapters: {title: string, offset: number}[], headings: string[], title: string, format: string }}
 */
export function parseEpub(buffer) {
  const entries = readCentralDirectory(buffer)
  const readText = (name) => {
    const entry = entries.get(name)
    return entry ? UTF8.decode(readEntry(buffer, entry)) : null
  }

  let opfPath = ''
  const container = readText('META-INF/container.xml')
  if (container) {
    const match = /<rootfile\b[^>]*full-path="([^"]+)"/i.exec(container)
    if (match) opfPath = decodeEntities(match[1])
  }
  if (!opfPath) {
    for (const name of entries.keys()) {
      if (/\.opf$/i.test(name)) {
        opfPath = name
        break
      }
    }
  }
  if (!opfPath) throw new Error('this EPUB has no OPF package document')

  const opf = readText(opfPath)
  if (!opf) throw new Error(`unreadable EPUB package document: ${opfPath}`)
  const base = directoryOf(opfPath)

  const manifest = new Map()
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attribute(match[0], 'id')
    const href = attribute(match[0], 'href')
    if (id && href) {
      manifest.set(id, { href: decodeEntities(href), media: attribute(match[0], 'media-type') })
    }
  }

  const spine = []
  const spineBody = /<spine\b[^>]*>([\s\S]*?)<\/spine\s*>/i.exec(opf)
  if (spineBody) {
    for (const match of spineBody[1].matchAll(/<itemref\b[^>]*>/gi)) {
      const idref = attribute(match[0], 'idref')
      const linear = attribute(match[0], 'linear').toLowerCase()
      if (idref && linear !== 'no') spine.push(idref)
    }
  }
  if (spine.length === 0) {
    for (const [id, item] of manifest) {
      if (/xhtml|html/i.test(item.media) || /\.x?html?$/i.test(item.href)) spine.push(id)
    }
  }

  const chapters = []
  let text = ''
  let section = 0
  for (const idref of spine) {
    const item = manifest.get(idref)
    if (!item) continue
    const raw = readText(resolveRelative(base, item.href)) ?? readText(item.href)
    if (!raw) continue
    const body = htmlToText(raw)
    if (!body) continue
    section += 1
    chapters.push({
      title: headingOf(raw) || titleOf(raw) || `Section ${section}`,
      offset: text.length,
    })
    text += `${body}\n\n`
  }

  if (!text.replace(/\s/g, '')) throw new Error('this EPUB contains no extractable text')
  return { text, chapters, headings: [], title: packageTitle(opf), format: 'epub' }
}
