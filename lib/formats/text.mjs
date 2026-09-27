// lib/formats/text.mjs — plain-text books with encoding sniffing.
//
// Most Chinese .txt novels in the wild are GBK/GB18030 rather than UTF-8, so a
// straight UTF-8 decode would yield replacement characters. Node ships full ICU,
// which makes the legacy decoders available without a dependency.

const UTF8 = new TextDecoder('utf-8')
const LEGACY_ENCODINGS = ['gb18030', 'gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']

function decodeWith(bytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(bytes)
  } catch {
    return null
  }
}

/** Decode a text buffer, preferring an explicit BOM, then clean UTF-8, then legacy CJK code pages. */
export function decodeTextBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: UTF8.decode(buffer.subarray(3)), format: 'txt/utf-8-bom' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const text = decodeWith(buffer.subarray(2), 'utf-16le')
    if (text !== null) return { text, format: 'txt/utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const text = decodeWith(buffer.subarray(2), 'utf-16be')
    if (text !== null) return { text, format: 'txt/utf-16be' }
  }

  const utf8 = UTF8.decode(buffer)
  if (!utf8.includes('\ufffd')) return { text: utf8, format: 'txt/utf-8' }

  for (const encoding of LEGACY_ENCODINGS) {
    const text = decodeWith(buffer, encoding)
    // A wrong code page still decodes "successfully"; require one with no replacement chars.
    if (text !== null && !text.includes('\ufffd')) return { text, format: `txt/${encoding}` }
  }

  return { text: utf8, format: 'txt/utf-8-lossy' }
}
