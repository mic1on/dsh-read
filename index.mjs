// dsh-read — host half.
//
// Owns filesystem access and book parsing, and exposes three seams to the browser
// half:
//
//   * the `/read` human command, whose settled result carries one book's metadata
//     into the transcript (the client folds that into an in-conversation reader);
//   * the library API behind the 阅读 Conversation View tab — the book list, its
//     per-book reading progress, and the target directory it is loaded from;
//   * a small JSON API the reader card uses to page through paragraphs.
//
// Access policy: the API can only ever read files whose extension is in
// BOOK_EXTENSIONS, and it returns either book metadata or book text — never
// arbitrary files. That matters because the DSH web server can be exposed beyond
// loopback.

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'

import { BOOK_EXTENSIONS, loadBook, paragraphWindow, publicBook } from './lib/book.mjs'

export const name = 'dsh-read'

// Hard dependencies: these throw on access unless they are declared here.
// `webServer` deliberately is NOT listed — it is optional and published late, so it
// is attached through `ctx.inject` inside apply() instead.
export const inject = ['agents', 'commands', 'tools']

const API_PREFIX = '/dsh-read/api'
const DATA_DIRECTORY = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-read')
const PROGRESS_FILE = join(DATA_DIRECTORY, 'progress.json')
const CONFIG_FILE = join(DATA_DIRECTORY, 'config.json')
const PROGRESS_LIMIT = 300

/** Where `/read <keyword>` and `book_search` look when nothing is configured. */
const DEFAULT_LIBRARY_ROOTS = ['~/Books', '~/Documents/Books', '~/Downloads', '~/Documents']
const SEARCH_DEPTH = 4
const SEARCH_LIMIT = 60
const SEARCH_VISIT_LIMIT = 600

/* ── helpers ─────────────────────────────────────────────────────────────── */

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function expandHome(input) {
  const text = String(input).trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

function isBookFile(fileName) {
  return BOOK_EXTENSIONS.includes(extname(fileName).toLowerCase())
}

async function readJson(filePath, fallback) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await mkdir(DATA_DIRECTORY, { recursive: true })
  const temporary = `${filePath}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, filePath)
}

/* ── library search ──────────────────────────────────────────────────────── */

/** Configured roots, or the conventional defaults, keeping only directories that exist. */
async function libraryRoots() {
  const config = await readJson(CONFIG_FILE, {})
  const configured = Array.isArray(config.libraryRoots) ? config.libraryRoots : []
  const candidates = configured.length > 0 ? configured : DEFAULT_LIBRARY_ROOTS

  const roots = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const expanded = expandHome(candidate)
    const info = await stat(expanded).catch(() => null)
    if (info?.isDirectory()) roots.push(expanded)
  }
  return roots
}

/** Bounded recursive search for book files whose name contains `query`. */
async function searchBooks({ query = '', dir, limit = SEARCH_LIMIT } = {}) {
  const roots = dir ? [expandHome(dir)] : await libraryRoots()
  const needle = String(query).trim().toLowerCase()
  const books = []
  let visited = 0
  let truncated = false

  const walk = async (directory, depth) => {
    if (truncated || visited > SEARCH_VISIT_LIMIT) return
    visited += 1
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < SEARCH_DEPTH) await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !isBookFile(entry.name)) continue
      if (needle && !entry.name.toLowerCase().includes(needle)) continue
      if (books.length >= limit) {
        truncated = true
        return
      }
      const info = await stat(full).catch(() => null)
      books.push({
        path: full,
        name: entry.name,
        size: info?.size ?? 0,
        extension: extname(entry.name).slice(1).toLowerCase(),
      })
    }
  }

  for (const root of roots) {
    if (truncated) break
    const info = await stat(root).catch(() => null)
    if (info?.isDirectory()) await walk(root, 0)
  }

  books.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { books, roots, truncated }
}

/** Turn one `/read` argument into a single readable book path. */
async function resolveBookArgument(input) {
  const argument = String(input).trim()
  if (!argument) throw new Error('用法：/read <书的绝对路径，或书名关键词>')

  const expanded = expandHome(argument)

  // An explicit path is taken at face value, but still has to pass the same book
  // whitelist the HTTP API enforces — the command must not become a way to read
  // arbitrary files into the transcript.
  if (expanded.startsWith('/') || expanded.startsWith('./') || expanded.startsWith('../')) {
    return requireBookPath(expanded)
  }

  // A bare file name may be something the user is standing right next to.
  if (BOOK_EXTENSIONS.includes(extname(expanded).toLowerCase())) {
    const nearby = await stat(resolve(expanded)).catch(() => null)
    if (nearby?.isFile()) return requireBookPath(expanded)
  }

  const { books, roots } = await searchBooks({ query: argument })
  if (books.length === 0) {
    const where = roots.length > 0 ? roots.join('、') : '（没有可搜索的目录）'
    throw new Error(
      `没有找到书名包含「${argument}」的书。搜索范围：${where}。` +
        `可以在 ${CONFIG_FILE} 里配置 libraryRoots，或直接用 /read <绝对路径>。`,
    )
  }
  if (books.length > 1) {
    const candidates = books.slice(0, 6).map((book) => book.path).join('\n')
    throw new Error(`找到 ${books.length} 本匹配的书，请用完整路径再试一次：\n${candidates}`)
  }
  return requireBookPath(books[0].path)
}

/* ── routes ──────────────────────────────────────────────────────────────── */

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** Wrap a route body so an expected failure stays a readable `{ok:false,error}`. */
function route(run) {
  return async (req, res) => {
    try {
      const payload = await run(req, res)
      if (payload !== undefined && !res.writableEnded) sendJson(res, 200, payload)
    } catch (error) {
      if (!res.writableEnded) sendJson(res, 400, { ok: false, error: messageOf(error) })
    }
  }
}

function parameters(req) {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

/** The one place a caller-supplied path becomes a readable file. */
function requireBookPath(value) {
  if (!value) throw new Error('missing book path')
  const target = resolve(value)
  if (!BOOK_EXTENSIONS.includes(extname(target).toLowerCase())) {
    throw new Error(`unsupported book format: ${extname(target) || '(none)'}`)
  }
  return target
}

async function writeProgressEntry(entry) {
  const progress = await readJson(PROGRESS_FILE, {})

  if (entry.clear) {
    delete progress[entry.path]
  } else {
    progress[entry.path] = {
      name: entry.name ?? '',
      index: Number.isFinite(entry.index) ? Math.max(0, Math.floor(entry.index)) : 0,
      chars: Number.isFinite(entry.chars) ? Math.floor(entry.chars) : 0,
      at: Date.now(),
    }
  }

  const keys = Object.keys(progress)
  if (keys.length > PROGRESS_LIMIT) {
    keys.sort((a, b) => (progress[a]?.at ?? 0) - (progress[b]?.at ?? 0))
    for (const key of keys.slice(0, keys.length - PROGRESS_LIMIT)) delete progress[key]
  }

  await writeJson(PROGRESS_FILE, progress)
  return progress
}

/* ── library (the 阅读 tab's data) ───────────────────────────────────────── */

/** The directory the 阅读 tab browses: the primary root, or the home directory. */
async function primaryLibraryDirectory() {
  const config = await readJson(CONFIG_FILE, {})
  const roots = Array.isArray(config.libraryRoots) ? config.libraryRoots : []
  const first = roots.find((root) => typeof root === 'string' && root.trim())
  if (first) {
    const expanded = expandHome(first)
    const info = await stat(expanded).catch(() => null)
    if (info?.isDirectory()) return expanded
  }
  return homedir()
}

/** Make one directory primary while keeping the other library roots for search. */
async function setPrimaryLibraryDirectory(directory) {
  const config = await readJson(CONFIG_FILE, {})
  const roots = Array.isArray(config.libraryRoots) ? config.libraryRoots : []
  const kept = roots.filter((root) => typeof root === 'string' && root.trim() && root !== directory)
  await writeJson(CONFIG_FILE, { ...config, libraryRoots: [directory, ...kept] })
}

/**
 * List one directory level for the 阅读 tab: subdirectories to descend into, the
 * books in it, and the saved progress for each.
 *
 * Only books that already have progress are parsed, so a large library stays cheap
 * — a percentage needs the paragraph count, and that is the one expensive field.
 */
async function libraryListing(requested) {
  const directory = requested ? expandHome(requested) : await primaryLibraryDirectory()
  const target = resolve(directory)
  const info = await stat(target).catch(() => null)
  if (!info) throw new Error(`目录不存在：${target}`)
  if (!info.isDirectory()) throw new Error(`不是目录：${target}`)

  const saved = await readJson(PROGRESS_FILE, {})
  const directories = []
  const books = []

  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(target, entry.name)
    if (entry.isDirectory()) {
      directories.push({ name: entry.name, path: full })
      continue
    }
    if (!entry.isFile() || !isBookFile(entry.name)) continue

    const fileInfo = await stat(full).catch(() => null)
    const record = saved[full]
    let progress = null

    if (record) {
      let paragraphCount = 0
      let chars = 0
      try {
        const parsed = await loadBook(full)
        paragraphCount = parsed.paragraphCount
        chars = parsed.chars
      } catch {
        // an unreadable book still lists; it just has no percentage
      }
      const index = Number.isFinite(record.index) ? record.index : 0
      progress = {
        index,
        paragraphCount,
        chars,
        percent: paragraphCount > 0 ? Math.min(100, (index / paragraphCount) * 100) : 0,
        at: Number.isFinite(record.at) ? record.at : 0,
      }
    }

    books.push({
      path: full,
      name: entry.name,
      size: fileInfo?.size ?? 0,
      extension: extname(entry.name).slice(1).toLowerCase(),
      progress,
    })
  }

  directories.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  books.sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  return {
    dir: target,
    parent: dirname(target) === target ? null : dirname(target),
    directories,
    books,
  }
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  const disposers = []

  // `/read` is the whole entry point: the handler resolves one book and returns
  // its metadata as the settled result text. The browser half folds the durable
  // command/run + command/done events into a reader card, so the book text never
  // reaches the model and the reading costs no tokens.
  disposers.push(
    ctx.commands.register({
      name: 'read',
      description: '打开一本本地书籍（EPUB / MOBI / 文本），正文在对话流里逐字展开',
      input: { hint: '<书的绝对路径，或书名关键词>' },
      recordInput: true,
      async handler(invocation) {
        // `rawInput` is the argument text; tolerate a fully qualified line too.
        const argument = String(invocation.rawInput ?? '')
          .trim()
          .replace(/^\/read\b/, '')
          .trim()
        try {
          const entry = await loadBook(await resolveBookArgument(argument))
          return { kind: 'success', text: JSON.stringify(publicBook(entry)) }
        } catch (error) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    }),
  )

  // Natural-language discovery: the agent finds a book, the user opens it with /read.
  // Imported lazily so the plugin still loads where `@deepseek-ai/dsh-tools` is not
  // resolvable (plain-node tests, headless profiles).
  void import('./lib/tool.mjs')
    .then(({ registerBookSearch }) => disposers.push(registerBookSearch(ctx, searchBooks)))
    .catch(() => {
      // book_search unavailable; /read still works from a path or keyword
    })

  // The reader card pages through paragraphs over HTTP. `webServer` is optional
  // and published late, so it is attached through ctx.inject rather than the
  // plugin's inject array — otherwise a headless profile would never settle.
  ctx.inject(['webServer'], (webCtx) => {
    const register = (path, run) => {
      disposers.push(webCtx.webServer.register({ kind: 'exact', path, handler: route(run) }))
    }

    register(`${API_PREFIX}/open`, async (req) => {
      const entry = await loadBook(requireBookPath(parameters(req).get('path')))
      return { ok: true, book: publicBook(entry) }
    })

    register(`${API_PREFIX}/paragraphs`, async (req) => {
      const params = parameters(req)
      const entry = await loadBook(requireBookPath(params.get('path')))
      const from = Number(params.get('from') ?? 0)
      const count = Number(params.get('count') ?? 30)
      return { ok: true, path: entry.path, ...paragraphWindow(entry, from, count) }
    })

    register(`${API_PREFIX}/progress`, async (req) => {
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const target = requireBookPath(body.path)
        await writeProgressEntry({ ...body, path: target })
        return { ok: true }
      }
      return { ok: true, progress: await readJson(PROGRESS_FILE, {}) }
    })

    // The 阅读 tab: one directory level, its books, and each book's progress.
    register(`${API_PREFIX}/library`, async (req) => {
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const requested = body.dir ? expandHome(String(body.dir)) : ''
        const listing = await libraryListing(requested)
        await setPrimaryLibraryDirectory(listing.dir)
        return { ok: true, ...listing }
      }
      return { ok: true, ...(await libraryListing(parameters(req).get('dir'))) }
    })

    // "开始阅读" from the Settings reading centre: run the very same `/read` command the
    // composer would, so the durable lifecycle — and therefore the reader card — is identical.
    // The settings page is global, so it may hand us a session id or leave it out; with no id
    // we fall back to the only live agent, and refuse to guess when several are running.
    register(`${API_PREFIX}/start`, async (req) => {
      const body = await readJsonBody(req)
      const target = requireBookPath(body.path)
      let sessionId = String(body.sessionId ?? '')

      if (!sessionId) {
        const live = ctx.agents.list()
        if (live.length === 1) {
          sessionId = String(live[0].id)
        } else if (live.length === 0) {
          throw new Error('当前没有运行中的会话：先在「对话」里发一条消息，再回到设置里开始阅读')
        } else {
          throw new Error(
            `现在有 ${live.length} 个运行中的会话，无法确定要在哪个会话里打开：请直接在对话里用 /read 打开这本书`,
          )
        }
      }

      const agent = ctx.agents.get(sessionId)
      if (!agent) throw new Error('这个会话当前不在运行，请先在对话里发一条消息再试')

      const execution = await ctx.commands.execute(
        agent,
        `/read ${target}`,
        [],
        new AbortController().signal,
      )
      if (!execution) throw new Error('无法执行 /read 命令（命令未注册？）')
      if (execution.result.kind === 'error') throw new Error(execution.result.text)
      return { ok: true }
    })
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // already gone
      }
    }
  })
}
