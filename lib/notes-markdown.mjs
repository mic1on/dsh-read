// Markdown is a projection, not the authoritative note database. Only files carrying
// our generated marker AND exact book/note identity may be updated or removed.
import { constants } from 'node:fs'
import { lstat, mkdir, realpath, readdir, open, link, rename, unlink } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, isAbsolute, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MARKER = 'dsh-read-note-v1'
const MANIFEST = '.dsh-read-book.json'
const MAX_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 10000
const MAX_DEPTH = 4
const queues = new Map()
const fields = new Set(['dsh_read', 'book', 'book_path', 'note_id', 'paragraph', 'paragraph_display',
  'created', 'kind', 'progress', 'answer_state', 'session_id', 'answer_truncated'])
const hash = (value) => createHash('sha256').update(value).digest('hex')
const fail = (message) => { throw new Error(`Markdown vault: ${message}`) }
const missing = (error) => error?.code === 'ENOENT'

function identity(bookPath, noteId) {
  if (typeof bookPath !== 'string' || !isAbsolute(bookPath) || bookPath.includes('\0')) fail('absolute book path required')
  if (typeof noteId !== 'string' || !noteId || noteId.includes('\0')) fail('note id required')
  return { bookPath, noteId }
}
function safeName(value, limit = 60) {
  let name = Array.from(String(value).normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '-'))
    .slice(0, limit).join('').replace(/^[.\s]+|[.\s]+$/g, '')
  // Leave room for the full collision hash even on 255-byte filename filesystems.
  while (Buffer.byteLength(name) > 160) name = Array.from(name).slice(0, -1).join('')
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `book-${name || 'untitled'}`
  return name
}
function titleOf(bookPath, note) {
  return String(note.title || basename(bookPath, extname(bookPath)))
}
function dateOf(note) {
  const date = new Date(note.createdAt)
  if (!Number.isFinite(date.getTime())) fail('valid createdAt required')
  return date
}
function paragraphOf(note) {
  if (!Number.isSafeInteger(note.paragraph) || note.paragraph < 0) fail('nonnegative integer paragraph required')
  return note.paragraph
}
function metadata(bookPath, note) {
  identity(bookPath, note.id)
  const paragraph = paragraphOf(note)
  const data = {
    dsh_read: MARKER, book: titleOf(bookPath, note), book_path: bookPath, note_id: note.id,
    paragraph, paragraph_display: paragraph + 1, created: dateOf(note).toISOString(),
    kind: note.kind === 'question' ? 'question' : 'note',
  }
  if (Number.isFinite(note.progress)) data.progress = note.progress
  if (note.kind === 'question') {
    const state = note.answerState || (note.answer ? 'answered' : 'pending')
    if (!['pending', 'answered', 'interrupted'].includes(state)) fail('invalid answer state')
    data.answer_state = state
  }
  if (note.sessionId) data.session_id = String(note.sessionId)
  if (note.answerTruncated !== undefined) data.answer_truncated = Boolean(note.answerTruncated)
  return data
}
// JSON strings are YAML double-quoted scalars. Escaping line separators also keeps
// every generated value on exactly one physical line for conservative identification.
const scalar = (value) => JSON.stringify(value).replace(/\u0085/g, '\\u0085').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const frontmatter = (data) => Object.entries(data).map(([key, value]) => `${key}: ${scalar(value)}`).join('\n')
function delimiters(bookPath, id) {
  const token = hash(`${bookPath}\0${id}`).slice(0, 24)
  return [`<!-- dsh-read:ai:${token}:start -->`, `<!-- dsh-read:ai:${token}:end -->`]
}
// Never let quoted/user/model content counterfeit our bounded update delimiters.
const text = (value) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/<!-- dsh-read:/g, '&lt;!-- dsh-read:')
function aiRegion(bookPath, note) {
  const [start, end] = delimiters(bookPath, note.id)
  const question = note.kind === 'question' ? text(note.question ?? note.text) : ''
  return `${start}\n${note.kind === 'question' ? `## 问题\n\n${question}\n\n## AI 回答\n\n${text(note.answer)}\n\n` : ''}${end}`
}

/** Pure, dependency-free Markdown renderer. Dates in metadata are explicit UTC. */
export function renderNote(bookPath, note) {
  const data = metadata(bookPath, note)
  const quote = text(note.quote)
  const heading = text(titleOf(bookPath, note)).replace(/\n/g, ' ')
  const quoted = quote.split('\n').map((line) => `> ${line}`).join('\n')
  const memo = note.kind === 'question' ? '' : `## 笔记\n\n${text(note.text)}\n\n`
  return `---\n${frontmatter(data)}\n---\n\n# ${heading} · 第 ${data.paragraph_display} 段\n\n${quoted}\n\n${memo}${aiRegion(bookPath, note)}\n`
}

// Obsidian's Properties editor may reserialize JSON-compatible YAML strings as
// plain or single-quoted scalars. Read only the three ownership fields, not arbitrary
// YAML: unsupported identity syntax must fail closed instead of creating duplicates.
function identityScalar(source) {
  const value = source.trim()
  const double = /^("(?:\\.|[^"\\])*")[ \t]*(?:#.*)?$/.exec(value)
  if (double) {
    const parsed = JSON.parse(double[1])
    if (typeof parsed !== 'string') throw new Error('identity is not a string')
    return parsed
  }
  const single = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(value)
  if (single) return single[1].replace(/''/g, "'")
  const plain = value.replace(/[ \t]+#.*$/, '').trim()
  // Reject aliases, tags, block/flow values and malformed quoted strings. Colons
  // without following whitespace (e.g. Windows drive paths) remain plain strings.
  if (!plain || /^[!&*{}\[\],#|>@`"']/.test(plain) || /:[ \t]|[\r\n]/.test(plain)) {
    throw new Error('unsupported identity scalar')
  }
  return plain
}
function parseManaged(content, bookPath, noteId) {
  const normalized = content.replace(/\r\n/g, '\n')
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  if (!match) return null
  const identityKeys = new Set(['dsh_read', 'book_path', 'note_id'])
  const data = {}
  const extra = []
  let invalidIdentity = false
  let recognizable = false
  for (const line of match[1].split('\n')) {
    const pair = /^([a-z_]+):[ \t]*(.*)$/.exec(line)
    if (!pair || !fields.has(pair[1])) { extra.push(line); continue }
    if (!identityKeys.has(pair[1])) continue // regenerated from authoritative JSON
    if (pair[1] === 'dsh_read' && pair[2].includes(MARKER)) recognizable = true
    if (Object.hasOwn(data, pair[1])) { invalidIdentity = true; continue }
    try { data[pair[1]] = identityScalar(pair[2]) } catch { invalidIdentity = true }
  }
  if (invalidIdentity && recognizable) fail('managed identity YAML is unsupported or ambiguous')
  if (data.dsh_read !== MARKER) return null
  if (typeof data.book_path !== 'string' || typeof data.note_id !== 'string') {
    fail('managed identity fields missing; refusing to duplicate or remove the note')
  }
  if (data.book_path !== bookPath || data.note_id !== noteId) return null
  return { data, extra, body: normalized.slice(match[0].length) }
}
function updateManaged(content, bookPath, note) {
  const parsed = parseManaged(content, bookPath, note.id)
  if (!parsed) fail('generated identity changed')
  const [start, end] = delimiters(bookPath, note.id)
  const a = parsed.body.indexOf(start), b = parsed.body.indexOf(end)
  if (a < 0 || b < a || parsed.body.indexOf(start, a + 1) !== -1 || parsed.body.indexOf(end, b + 1) !== -1) {
    fail('managed AI delimiters missing or ambiguous; explicit overwrite required')
  }
  const body = parsed.body.slice(0, a) + aiRegion(bookPath, note) + parsed.body.slice(b + end.length)
  const header = [frontmatter(metadata(bookPath, note)), ...parsed.extra].join('\n')
  return `---\n${header}\n---\n${body}`
}
function filename(note) {
  const date = dateOf(note)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  const summary = Array.from(String(note.quote || note.text || '批注').replace(/\s+/g, ' ').trim()).slice(0, 12).join('')
  return `${stamp}-第${paragraphOf(note) + 1}段-${safeName(summary, 12)}.md`
}
function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}
async function info(path) {
  try { return await lstat(path) } catch (error) { if (missing(error)) return null; throw error }
}
function same(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs }

/** Safe vault projection. Does not read books, session logs, or user configuration.
 * Path-based Node APIs cannot eliminate races from a hostile process concurrently
 * replacing ancestors; checks fail closed on observed changes. No symlink traversal
 * below the canonical root is permitted. All instances serialize per canonical root.
 */
export class MarkdownVault {
  constructor(root) {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) fail('vault root required')
    this.root = resolve(root)
    this.canonicalRoot = null
    this.rootIdentity = null
  }
  async init() {
    const before = await info(this.root)
    if (before?.isSymbolicLink()) fail('symlink vault root refused')
    await mkdir(this.root, { recursive: true })
    const current = await lstat(this.root)
    if (!current.isDirectory() || current.isSymbolicLink()) fail('unsafe vault root')
    const canonical = await realpath(this.root)
    if (this.canonicalRoot && (this.canonicalRoot !== canonical || this.rootIdentity.dev !== current.dev || this.rootIdentity.ino !== current.ino)) fail('vault root changed')
    this.canonicalRoot = canonical
    this.rootIdentity = { dev: current.dev, ino: current.ino }
    return canonical
  }
  async _serial(action) {
    const root = await this.init()
    const previous = queues.get(root) || Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    queues.set(root, next)
    try { return await next } finally { if (queues.get(root) === next) queues.delete(root) }
  }
  async _directory(path) {
    const root = this.canonicalRoot
    if (!inside(root, path)) fail('path escapes vault')
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.dev !== this.rootIdentity.dev || rootInfo.ino !== this.rootIdentity.ino || await realpath(root) !== root) fail('vault root changed')
    const rel = relative(root, path)
    let current = root
    for (const segment of rel ? rel.split(/[\\/]/) : []) {
      current = join(current, segment)
      const item = await lstat(current)
      if (item.isSymbolicLink() || !item.isDirectory()) fail('unsafe book directory')
    }
    if (!inside(root, await realpath(path))) fail('directory escapes vault')
  }
  async _read(path) {
    await this._directory(dirname(path))
    const item = await info(path)
    if (!item) return null
    if (item.isSymbolicLink() || !item.isFile() || item.nlink !== 1) fail('symlink, hardlink or nonregular file refused')
    if (item.size > MAX_BYTES) fail('file exceeds scan byte budget')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!same(item, opened) || opened.nlink !== 1) fail('file changed during read')
      const content = await handle.readFile('utf8')
      if (!same(opened, await handle.stat()) || Buffer.byteLength(content) > MAX_BYTES) fail('file changed during read')
      return { content, stat: opened }
    } finally { await handle.close() }
  }
  async _manifest(dir) {
    const saved = await this._read(join(dir, MANIFEST))
    if (!saved) return null
    try {
      const data = JSON.parse(saved.content)
      return data.marker === 'dsh-read-book-v1' && typeof data.book_path === 'string' ? data.book_path : null
    } catch { return null }
  }
  async _books(bookPath) {
    const entries = await readdir(this.canonicalRoot, { withFileTypes: true })
    if (entries.length > MAX_ENTRIES) fail('vault directory scan budget exceeded')
    const found = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.obsidian' || !entry.isDirectory()) continue
      const dir = join(this.canonicalRoot, entry.name)
      await this._directory(dir)
      if (await this._manifest(dir) === bookPath) found.push(dir)
    }
    return found
  }
  async _locate(dirs, bookPath, id) {
    let count = 0
    const matches = []
    const walk = async (dir, depth) => {
      await this._directory(dir)
      const entries = await readdir(dir, { withFileTypes: true })
      count += entries.length
      if (count > MAX_ENTRIES) fail('note scan budget exceeded')
      for (const entry of entries) {
        if (entry.name === '.obsidian' || entry.name === MANIFEST || (entry.name.startsWith('.dsh-read-') && entry.name.endsWith('.tmp'))) continue
        const path = join(dir, entry.name)
        if (entry.isSymbolicLink()) fail('symlink in book directory refused')
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH) fail('note scan depth exceeded')
          await walk(path, depth + 1)
        } else if (/\.(?:md|markdown)$/i.test(entry.name)) {
          const file = await this._read(path)
          if (file && parseManaged(file.content, bookPath, id)) matches.push({ path, ...file })
        }
      }
    }
    for (const dir of dirs) await walk(dir, 0)
    if (matches.length > 1) fail('duplicate generated note identity')
    return matches[0] || null
  }
  async _publish(path, content, previous = null) {
    if (Buffer.byteLength(content) > MAX_BYTES) fail('note exceeds byte budget')
    await this._directory(dirname(path))
    const temp = join(dirname(path), `.dsh-read-${randomUUID()}.tmp`)
    // temp is an explicit, checked child of the canonical vault; never user data.
    if (!inside(this.canonicalRoot, temp)) fail('temporary path escapes vault')
    let created = false
    try {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
      await this._directory(dirname(path))
      if (previous) {
        const fresh = await this._read(path)
        if (!fresh || !same(previous.stat, fresh.stat) || previous.content !== fresh.content) fail('file changed before update')
        // Both resolved targets have been checked; atomic replacement never writes
        // through an existing inode (including a hardlink added after our read).
        await rename(temp, path)
        created = false
      } else {
        // Exclusive publication of a complete file, unlike rename() which clobbers.
        await link(temp, path)
      }
    } finally {
      if (created) { await this._directory(dirname(temp)); await unlink(temp) }
    }
  }
  async _bookDirectory(bookPath, note) {
    const title = safeName(titleOf(bookPath, note))
    const choices = [title, `${title}-${hash(bookPath).slice(0, 10)}`, `${title}-${hash(bookPath)}`]
    for (const name of choices) {
      const dir = join(this.canonicalRoot, name)
      const existing = await info(dir)
      if (existing?.isSymbolicLink()) fail('symlink book directory refused')
      if (existing) {
        if (!existing.isDirectory()) continue
        await this._directory(dir)
        if (await this._manifest(dir) === bookPath) return dir
        continue // Never claim a pre-existing user directory, even an empty one.
      }
      try { await mkdir(dir) } catch (error) { if (error.code === 'EEXIST') continue; throw error }
      await this._directory(dir)
      await this._publish(join(dir, MANIFEST), `${JSON.stringify({ marker: 'dsh-read-book-v1', book_path: bookPath })}\n`)
      return dir
    }
    fail('book directory identity collision')
  }
  async write(bookPath, note, { overwrite = false } = {}) {
    metadata(bookPath, note) // Validate before any IO.
    return this._serial(async () => {
      const dirs = await this._books(bookPath)
      const existing = await this._locate(dirs, bookPath, note.id)
      if (existing) {
        const content = overwrite ? renderNote(bookPath, note) : updateManaged(existing.content, bookPath, note)
        if (content !== existing.content) await this._publish(existing.path, content, existing)
        return existing.path
      }
      const dir = dirs[0] || await this._bookDirectory(bookPath, note)
      const base = filename(note).slice(0, -3)
      for (let suffix = 1; suffix <= MAX_ENTRIES; suffix++) {
        const path = join(dir, `${base}${suffix === 1 ? '' : `-${suffix}`}.md`)
        const candidate = await info(path)
        if (candidate?.isSymbolicLink() || (candidate?.isFile() && candidate.nlink !== 1)) fail('unsafe filename collision')
        if (candidate) continue
        try { await this._publish(path, renderNote(bookPath, note)); return path }
        catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      fail('filename collision budget exceeded')
    })
  }
  async remove(bookPath, noteId) {
    identity(bookPath, noteId)
    return this._serial(async () => {
      const file = await this._locate(await this._books(bookPath), bookPath, noteId)
      if (!file) return false
      const fresh = await this._read(file.path)
      if (!fresh || !same(file.stat, fresh.stat) || fresh.content !== file.content || !parseManaged(fresh.content, bookPath, noteId)) fail('file changed before removal')
      // file.path is absolute, contained and verified against BOTH identities.
      await this._directory(dirname(file.path))
      await unlink(file.path)
      return true
    })
  }
}
