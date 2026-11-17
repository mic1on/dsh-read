// Serialized plugin-owned JSON and its optional Markdown mirror.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { MarkdownVault } from './notes-markdown.mjs'

export function expandNotesPath(input) {
  const path = String(input ?? '').trim()
  if (!path) return ''
  const expanded = path === '~' ? homedir() : /^~[/\\]/.test(path) ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error('批注目录请使用绝对路径或 ~/ 开头的路径')
  return resolve(expanded)
}

export class NotesStore {
  constructor(directory) {
    this.directory = directory
    this.tail = Promise.resolve()
    this.vaults = new Map()
    this.lastError = ''
  }

  serial(operation) {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  async read(name) {
    try {
      const value = JSON.parse(await readFile(join(this.directory, name), 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
      return value
    } catch (error) {
      // Corrupt data must not be silently replaced with an empty object.
      if (error.code === 'ENOENT') return {}
      throw error
    }
  }

  async write(name, value) {
    await mkdir(this.directory, { recursive: true })
    const target = join(this.directory, name)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  }

  async configure(change) {
    return this.serial(async () => {
      const current = await this.read('config.json')
      const next = await change(current)
      await this.write('config.json', next)
      return next
    })
  }

  async notes() {
    await this.tail
    return this.read('notes.json')
  }

  async archiveEnabled() {
    try { return Boolean(expandNotesPath((await this.read('config.json')).notesVaultPath)) }
    catch { return false }
  }

  async vault() {
    const config = await this.read('config.json')
    const path = expandNotesPath(config.notesVaultPath)
    if (!path) return null
    if (!this.vaults.has(path)) this.vaults.set(path, new MarkdownVault(path))
    return this.vaults.get(path)
  }

  async mirror(bookPath, note, options) {
    try {
      const vault = await this.vault()
      if (!vault) return {}
      const mdPath = await vault.write(bookPath, note, options)
      // Capture is already committed to JSON. Persist a mirror retry bit so a crash
      // or filesystem failure cannot hide an answered-but-unmirrored note on restart.
      if (note.mdDirty) {
        const all = await this.read('notes.json')
        const saved = all[bookPath]?.find((entry) => entry.id === note.id)
        if (saved) { delete saved.mdDirty; await this.write('notes.json', all) }
        delete note.mdDirty
      }
      return { mdPath }
    } catch (error) {
      this.lastError = `Markdown 保存失败：${error.message}`
      try {
        const all = await this.read('notes.json')
        const saved = all[bookPath]?.find((entry) => entry.id === note.id)
        if (saved) { saved.mdDirty = true; await this.write('notes.json', all) }
      } catch { /* the original JSON write is already acknowledged; retain error */ }
      return { mdError: this.lastError }
    }
  }

  async add(entry, metadata = {}) {
    return this.serial(async () => {
      const all = await this.read('notes.json')
      const path = resolve(entry.path)
      const list = Array.isArray(all[path]) ? all[path] : []
      const note = {
        id: randomUUID(),
        paragraph: Number.isFinite(entry.paragraph) ? Math.max(0, Math.floor(entry.paragraph)) : 0,
        quote: String(entry.quote ?? '').slice(0, 400),
        kind: entry.kind === 'note' ? 'note' : 'question',
        text: String(entry.text ?? '').slice(0, 2000),
        createdAt: Date.now(),
        mdDirty: true,
        title: String(metadata.title || basename(path).replace(/\.[^.]+$/, '')),
      }
      if (Number.isFinite(metadata.progress)) note.progress = metadata.progress
      if (note.kind === 'question') {
        note.answerState = 'pending'
        if (entry.sessionId) note.sessionId = String(entry.sessionId)
      }
      // Never silently evict an older note: its question/answer may be irreplaceable.
      all[path] = [...list, note]
      await this.write('notes.json', all)
      return { note, ...(await this.mirror(path, note)) }
    })
  }

  async remove(bookPath, id) {
    return this.serial(async () => {
      const all = await this.read('notes.json')
      const list = Array.isArray(all[bookPath]) ? all[bookPath] : []
      all[bookPath] = list.filter((note) => note.id !== id)
      await this.write('notes.json', all)
      let mdError
      try {
        const vault = await this.vault()
        // Safe identity checks in the vault make retries possible after JSON removal.
        if (vault) await vault.remove(bookPath, id)
      } catch (error) {
        mdError = `Markdown 删除失败：${error.message}`
        this.lastError = mdError
      }
      return { notes: all[bookPath], ...(mdError ? { mdError } : {}) }
    })
  }

  async capture(sessionId, record) {
    return this.serial(async () => {
      const all = await this.read('notes.json')
      let changed = false
      const touched = []
      const byId = new Map(record.questions.map((question) => [question.id, question]))
      for (const [path, list] of Object.entries(all)) {
        if (!Array.isArray(list)) continue
        for (const note of list) {
          const match = byId.get(note.id)
          if (!match || note.kind !== 'question') continue
          if (note.sessionId && note.sessionId !== sessionId) continue
          // A copied marker in a later turn must never replace the original exchange.
          if (note.turn !== undefined && note.turn !== record.turn) continue
          if (note.messageId && note.messageId !== match.messageId) continue
          const patch = {
            sessionId, turn: record.turn, messageId: match.messageId,
            question: match.question,
          }
          if (record.ended) {
            patch.answer = match.answer === undefined ? record.answer : match.answer
            patch.answerState = record.completed && patch.answer && !record.truncated ? 'answered' : 'interrupted'
            patch.answerTruncated = Boolean(record.truncated)
          }
          if (Object.entries(patch).some(([key, value]) => note[key] !== value)) {
            Object.assign(note, patch)
            note.mdDirty = true
            changed = true
          }
          touched.push([path, note])
        }
      }
      if (changed) await this.write('notes.json', all)
      // Also retry failed MD mirrors on recovery even if the JSON was already committed.
      for (const [path, note] of touched) await this.mirror(path, note)
    })
  }

  async retryMirrors() {
    return this.serial(async () => {
      const all = await this.read('notes.json')
      for (const [path, list] of Object.entries(all)) {
        if (!Array.isArray(list)) continue
        for (const note of list) if (note.mdDirty) await this.mirror(path, note)
      }
    })
  }

  async status() {
    await this.tail
    const config = await this.read('config.json')
    const all = await this.read('notes.json')
    const lists = Object.values(all).filter(Array.isArray)
    return {
      path: expandNotesPath(config.notesVaultPath),
      suggestedPath: '~/Documents/ReadingNotes',
      bookCount: lists.filter((list) => list.length).length,
      noteCount: lists.reduce((sum, list) => sum + list.length, 0),
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  async exportAll({ overwrite = false } = {}) {
    return this.serial(async () => {
      const vault = await this.vault()
      if (!vault) throw new Error('请先设置批注保存目录')
      return this.exportInto(vault, overwrite)
    })
  }

  async exportInto(vault, overwrite) {
    const all = await this.read('notes.json')
    let exported = 0
    let failed = 0
    const errors = []
    for (const [path, list] of Object.entries(all)) {
      if (!Array.isArray(list)) continue
      for (const note of list) {
        try {
          await vault.write(path, note, { overwrite })
          exported += 1
        } catch (error) {
          failed += 1
          if (errors.length < 10) errors.push(`${path} (${note.id}): ${error.message}`)
        }
      }
    }
    this.lastError = failed ? `${failed} 条批注未导出：${errors[0]}` : ''
    return { exported, failed, errors }
  }

  async setVault(input) {
    const path = expandNotesPath(input)
    const migration = await this.serial(async () => {
      const config = await this.read('config.json')
      await this.write('config.json', { ...config, notesVaultPath: path })
      this.lastError = ''
      if (!path) return { exported: 0, failed: 0, errors: [] }
      const vault = await this.vault()
      try {
        await vault.init()
      } catch (error) {
        this.lastError = `Markdown 保存失败：${error.message}`
        return { exported: 0, failed: 1, errors: [this.lastError] }
      }
      // Existing Obsidian vaults contain .obsidian: migration must not require emptiness.
      return this.exportInto(vault, false)
    })
    return { ...(await this.status()), migration }
  }
}
