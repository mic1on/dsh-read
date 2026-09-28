// lib/formats/epub.mjs — EPUB (an OCF container) → plain text + spine chapters.
//
// Two shapes reach this parser. The common one is a ZIP archive, where only the handful
// of entries that hold prose are ever inflated — the container descriptor, the OPF package
// document and the spine documents — so a typical novel stays cheap to open. The other is
// an already-unpacked OCF directory, which iBooks and several converters produce and which
// carries exactly the same OPF; both funnel into one spine reader.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { IMAGE_MARKER_PATTERN, decodeEntities, htmlToText, imageMarkerFor } from '../html.mjs'

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

/** Every file below `root`, as POSIX-relative names — the same shape ZIP entry names take. */
async function listFiles(root, prefix = '') {
  const found = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await listFiles(root, name)))
    else if (entry.isFile()) found.push(name)
  }
  return found
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
 * Walk an OCF package: resolve the OPF, then read the spine in order.
 *
 * Shared by the ZIP and unpacked-directory entry points so the manifest, spine and
 * chapter rules cannot drift between them.
 *
 * @param readText - `(path: string) => string | null`, relative to the OCF root.
 * @param listNames - every entry name, used only to locate a fallback OPF.
 */
function readOcfPackage(readText, listNames) {
  let opfPath = ''
  const container = readText('META-INF/container.xml')
  if (container) {
    const match = /<rootfile\b[^>]*full-path="([^"]+)"/i.exec(container)
    if (match) opfPath = decodeEntities(match[1])
  }
  if (!opfPath) {
    for (const name of listNames) {
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
  const images = []
  let text = ''
  let section = 0
  for (const idref of spine) {
    const item = manifest.get(idref)
    if (!item) continue
    const documentPath = resolveRelative(base, item.href)
    const raw = readText(documentPath) ?? readText(item.href)
    if (!raw) continue
    let body = htmlToText(raw)
    if (!body) continue
    section += 1
    chapters.push({
      title: headingOf(raw) || titleOf(raw) || `Section ${section}`,
      offset: text.length,
    })

    // A marker's href is relative to the document that carried it, not to the package
    // root, so resolve it here while that document's path is still in hand. Only assets
    // the manifest actually declares are kept: that is what makes an image fetchable
    // without ever turning the asset route into an arbitrary file read.
    body = body.replace(IMAGE_MARKER_PATTERN, (whole, src) => {
      const resolved = src ? resolveRelative(directoryOf(documentPath), src) : ''
      const declared = resolved && [...manifest.values()].some((entry) => entry.href === resolved)
      if (!declared) return ''
      images.push({ path: resolved })
      return imageMarkerFor(images.length - 1)
    })

    text += `${body}\n\n`
  }

  if (!text.replace(/\s/g, '')) throw new Error('this EPUB contains no extractable text')
  return { text, chapters, headings: [], images, title: packageTitle(opf) }
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
  const parsed = readOcfPackage(readText, entries.keys())
  // Assets stay inside the archive; the reader pulls one on demand by its manifest path.
  parsed.readAsset = (name) => {
    const entry = entries.get(name)
    if (!entry) return null
    return { bytes: readEntry(buffer, entry), mediaType: mediaTypeOf(name) }
  }
  return { ...parsed, format: 'epub' }
}

/**
 * Parse an already-unpacked OCF directory — the shape iBooks and several converters
 * leave behind, where `META-INF/container.xml` and the OPF sit on disk as ordinary files.
 *
 * Entry names are POSIX-relative, matching the names inside a ZIP, so the same OPF and
 * spine rules apply verbatim.
 */
export async function parseEpubDirectory(directory) {
  const readText = async (name) => {
    // A href may point outside the package root in a malformed book; refuse to escape.
    if (name.split('/').includes('..')) return null
    try {
      return UTF8.decode(await readFile(join(directory, name)))
    } catch {
      return null
    }
  }

  // The shared reader is synchronous; pre-read only what it can ask for.
  const names = await listFiles(directory)
  const cache = new Map()
  const syncRead = (name) => (cache.has(name) ? cache.get(name) : null)

  // Prime the entries the package actually needs: the descriptor, any OPF, and the
  // spine documents the OPF names. Two passes keeps it simple and still cheap.
  const container = await readText('META-INF/container.xml')
  if (container) cache.set('META-INF/container.xml', container)
  let opfPath = ''
  if (container) {
    const match = /<rootfile\b[^>]*full-path="([^"]+)"/i.exec(container)
    if (match) opfPath = decodeEntities(match[1])
  }
  if (!opfPath) opfPath = names.find((name) => /\.opf$/i.test(name)) ?? ''
  if (!opfPath) throw new Error('this EPUB has no OPF package document')

  const opf = await readText(opfPath)
  if (!opf) throw new Error(`unreadable EPUB package document: ${opfPath}`)
  cache.set(opfPath, opf)

  const base = directoryOf(opfPath)
  const wanted = new Set([opfPath, 'META-INF/container.xml'])
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const href = attribute(match[0], 'href')
    if (!href) continue
    const decoded = decodeEntities(href)
    wanted.add(resolveRelative(base, decoded))
    wanted.add(decoded)
  }
  for (const name of wanted) {
    if (cache.has(name)) continue
    const text = await readText(name)
    if (text !== null) cache.set(name, text)
  }

  const parsed = readOcfPackage(syncRead, names)
  // Assets are read straight off disk, but only for names the package declared.
  parsed.readAsset = async (name) => {
    if (name.split('/').includes('..')) return null
    const bytes = await readFile(join(directory, name)).catch(() => null)
    return bytes ? { bytes, mediaType: mediaTypeOf(name) } : null
  }
  return { ...parsed, format: 'epub-unpacked' }
}

/** Content type for one asset, by extension — the image formats an EPUB actually carries. */
function mediaTypeOf(name) {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'image/jpeg'
}
