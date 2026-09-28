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

/**
 * Marker left in the text where an image sat, so the paragraph splitter can turn it into
 * its own item instead of losing it. NUL never occurs in real book prose; the `src` is
 * carried along because the caller has to resolve which asset it points at.
 */
const IMAGE_MARKER = '\u0000img:'
const IMAGE_MARKER_END = '\u0000'

/** Matches one whole image marker and captures its `src`. */
export const IMAGE_MARKER_PATTERN = new RegExp(
  `${IMAGE_MARKER}([^\\u0000]*)${IMAGE_MARKER_END}`,
  'g',
)

/** Build an image marker for one already-resolved asset index. */
export function imageMarkerFor(index) {
  return `${IMAGE_MARKER}${index}${IMAGE_MARKER_END}`
}

/** The `src` of one `<img>`/`<image>` tag, in either quoting style or the xlink form. */
function imageSource(tag) {
  const match =
    /\bsrc\s*=\s*"([^"]*)"/i.exec(tag) ||
    /\bsrc\s*=\s*'([^']*)'/i.exec(tag) ||
    /\bxlink:href\s*=\s*"([^"]*)"/i.exec(tag)
  return match ? decodeEntities(match[1]) : ''
}

/** Whether one paragraph text is an image marker rather than prose; returns its `src`. */
export function imageMarkerOf(text) {
  if (!text.startsWith(IMAGE_MARKER) || !text.endsWith(IMAGE_MARKER_END)) return null
  return text.slice(IMAGE_MARKER.length, -IMAGE_MARKER_END.length)
}

/** Convert one HTML document to plain text with blank-line separated paragraphs. */
export function htmlToText(html) {
  let out = String(html)
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  // Drop non-prose elements whole, including their contents.
  out = out.replace(/<(script|style|head|title|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
  out = out.replace(/<(script|style|link|meta|hr|br)\b[^>]*>/gi, (tag) =>
    /^<br/i.test(tag) ? '\n' : '',
  )
  // Images keep their place in the flow as a marker; the caller decides how to render it.
  out = out.replace(/<(img|image)\b[^>]*>/gi, (tag) =>
    `\n\n${IMAGE_MARKER}${imageSource(tag)}${IMAGE_MARKER_END}\n\n`,
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
