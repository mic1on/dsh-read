// Public types for dsh-read.
//
// The host half is a plain ESM Cordis plugin; the browser half is a hand-written
// ModuleLoader bundle and is intentionally not typed here.

import type { Context } from '@deepseek-ai/cordis'

declare const name: 'dsh-read'

declare function apply(ctx: Context): void

export { apply, name }

/** Stored per book in dsh-read/notes.json; Markdown is an optional readable mirror. */
export interface ReadingNote {
  id: string
  paragraph: number
  quote: string
  kind: 'note' | 'question'
  text: string
  createdAt: number
  title?: string
  progress?: number
  question?: string
  answer?: string
  answerState?: 'pending' | 'answered' | 'interrupted'
  answerTruncated?: boolean
  sessionId?: string
  messageId?: string
  turn?: number
}

/** One entry of the table of contents, addressed by paragraph index. */
export interface BookChapter {
  /** Chapter heading text, or a generated `Section N` fallback. */
  title: string
  /** Character offset of the chapter's first paragraph in the whole book. */
  offset: number
  /** Absolute paragraph index, the unit the reader navigates by. */
  index: number
}

/** A parsed book as the browser half sees it — never the full text. */
export interface PublicBook {
  /** Absolute path on the host. */
  path: string
  /** File name including extension. */
  name: string
  /** Title taken from the book metadata when the format carries one. */
  title: string
  /** Parser that produced the text, e.g. `epub`, `mobi`, `txt/gb18030`. */
  format: string
  /** Length of the extracted text in characters. */
  chars: number
  /** Size of the source file in bytes. */
  bytes: number
  /** Total paragraph count; the cursor runs from 0 to `paragraphCount - 1`. */
  paragraphCount: number
  /** Parsed content revision; optional for reader cards recorded by older versions. */
  revision?: string
  chapters: BookChapter[]
  /** Snapshot hint; refreshed by the annotations endpoint. */
  archiveEnabled?: boolean
}

/** One page of paragraphs, addressed by absolute index. */
export interface ParagraphWindow {
  from: number
  total: number
  items: { text: string; offset: number }[]
}

/** A saved reading position. */
export interface ReadingProgress {
  name: string
  index: number
  chars: number
  /** Epoch milliseconds of the last update. */
  at: number
}

/** One literal occurrence in the current book. All character offsets use UTF-16 units. */
export interface BookSearchHit {
  /** Zero-based paragraph index. */
  index: number
  /** Match range within that paragraph. */
  start: number
  end: number
  /** Absolute character offset in the extracted book text. */
  offset: number
  chapter: string
  /** Bounded text context; render as text, never HTML. */
  snippet: string
  highlightStart: number
  highlightEnd: number
  leading: boolean
  trailing: boolean
}

/** GET /dsh-read/api/search; default 20 results, hard maximum 50 per page. */
export interface BookSearchPage {
  ok: true
  query: string
  /** Content version used to validate previews and subsequent pages. */
  revision: string
  results: BookSearchHit[]
  /** Continuation token tied to path, content revision and query; not an auth token. */
  nextCursor: string | null
}
