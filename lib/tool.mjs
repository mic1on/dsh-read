// lib/tool.mjs — the `book_search` model tool.
//
// Deliberately separate from index.mjs and imported lazily: `@deepseek-ai/dsh-tools`
// only resolves inside the DSH app (it is a peer dependency the host injects), so
// isolating it keeps the rest of the plugin importable under plain node for tests.
//
// This tool only *finds* books. Reading is the `/read` command's job, which keeps
// book text out of the model's context entirely.

import { defineTool } from '@deepseek-ai/dsh-tools'

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * @param ctx - owning Cordis context.
 * @param searchBooks - `(options: {query?: string, dir?: string}) => Promise<{books, roots, truncated}>`
 * @returns the registration disposer.
 */
export function registerBookSearch(ctx, searchBooks) {
  return ctx.tools.register(
    defineTool({
      name: 'book_search',
      description:
        'Find local ebook files (EPUB / MOBI / AZW3 / plain text) by file-name keyword and ' +
        'return their absolute paths. Searches the configured library roots by default, or ' +
        'one directory when `dir` is given. Use it when the user names a book they want to ' +
        'read: report the matching path, then tell them to open it with the `/read <path>` ' +
        'command. This tool never returns book text.',
      parameters: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring matched against the file name, e.g. "三体" or "Sapiens".',
        },
        dir: {
          type: 'string',
          description:
            'Optional directory to search instead of the configured roots (absolute, or ~/...).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            roots: {
              type: 'array',
              required: true,
              items: { type: 'string' },
              description: 'Directories that were searched.',
            },
            truncated: {
              type: 'boolean',
              required: true,
              description: 'True when the scan stopped at its limit and more books may exist.',
            },
            books: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  size: { type: 'number', required: true },
                  extension: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.books.length) {
            return [
              {
                type: 'text',
                text:
                  `No book matched. Searched: ${value.roots.join(', ') || '(no searchable directory)'}. ` +
                  'Ask the user for the directory, or suggest setting libraryRoots in the dsh-read config.',
              },
            ]
          }
          const lines = value.books
            .slice(0, 12)
            .map((book) => `- ${book.path}${book.size ? ` (${formatSize(book.size)})` : ''}`)
          const more = value.books.length > 12 ? `\n… and ${value.books.length - 12} more` : ''
          return [
            {
              type: 'text',
              text:
                `Found ${value.books.length} book(s)${value.truncated ? ' (scan truncated)' : ''}:\n` +
                `${lines.join('\n')}${more}\n\nOpen one with: /read <path>`,
            },
          ]
        },
      },
      async execute(args) {
        return searchBooks({ query: args?.query ?? '', dir: args?.dir })
      },
    }),
  )
}
