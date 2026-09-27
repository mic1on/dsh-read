// Public types for dsh-read.
//
// The host half is a plain ESM Cordis plugin; the browser half is a hand-written
// ModuleLoader bundle and is intentionally not typed here.

import type { Context } from '@deepseek-ai/cordis'

declare const name: 'dsh-read'

declare function apply(ctx: Context): void

export { apply, name }

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
  chapters: BookChapter[]
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
