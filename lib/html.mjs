// lib/html.mjs — XHTML / HTML → plain text.
//
// EPUB spine documents and MOBI bodies are both HTML, so both parsers funnel
// through here and the reader model only ever sees plain paragraphs.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  laquo: '\u00ab',
  raquo: '\u00bb',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  times: '\u00d7',
  divide: '\u00f7',
  shy: '',
}

/** Decode numeric and the common named HTML entities. Unknown entities survive verbatim. */
export function decodeEntities(input) {
  return String(input).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      return whole
    }
    const key = body.toLowerCase()
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole
  })
}

/** Block-level tags that end a paragraph when they close. */
const BLOCK_END = /<\/(p|div|h[1-6]|li|tr|section|article|blockquote|figcaption|dd|dt|pre|table|ul|ol)\s*>/gi

/** Convert one HTML document to plain text with blank-line separated paragraphs. */
export function htmlToText(html) {
  let out = String(html)
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  // Drop non-prose elements whole, including their contents.
  out = out.replace(/<(script|style|head|title|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
  out = out.replace(/<(script|style|link|meta|img|image|hr|br)\b[^>]*>/gi, (tag) =>
    /^<br/i.test(tag) ? '\n' : '',
  )
  out = out.replace(BLOCK_END, '\n\n')
  out = out.replace(/<[^>]*>/g, '')
  out = decodeEntities(out)
  out = out.replace(/\r\n?/g, '\n')
  out = out.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ')
  out = out.replace(/ *\n */g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** Heading texts in document order — used as chapter-title hints when no markup index exists. */
export function headingTexts(html) {
  const found = []
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi
  let match
  while ((match = re.exec(html)) !== null) {
    const text = htmlToText(match[2]).replace(/\s+/g, ' ').trim()
    if (text) found.push(text.slice(0, 90))
  }
  return found
}
