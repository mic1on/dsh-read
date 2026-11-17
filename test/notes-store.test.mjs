import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NotesStore, expandNotesPath } from '../lib/notes-store.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-read-store-'))
  return { root, store: new NotesStore(join(root, 'data')), vault: join(root, 'vault'), path: join(root, '书籍.epub') }
}
// Temp test artifacts are intentionally left to the OS temp-directory cleanup; never
// remove a computed path recursively in a test that exercises hostile filesystem paths.
async function markdownFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const name of await readdir(join(root, entry.name))) if (name.endsWith('.md')) files.push(join(root, entry.name, name))
    }
  }
  return files
}

test('archive disabled preserves JSON and enabling migrates even an existing Obsidian vault', async () => {
  const { store, vault, path } = await fixture()
  const saved = await store.add({ path, paragraph: 2, quote: '引用', kind: 'note', text: '想法' })
  assert.equal(saved.mdPath, undefined)
  assert.equal((await store.status()).path, '')
  await mkdir(join(vault, '.obsidian'), { recursive: true })
  const configured = await store.setVault(vault)
  assert.equal(configured.migration.exported, 1)
  const files = await markdownFiles(vault)
  assert.equal(files.length, 1)
  assert.match(await readFile(files[0], 'utf8'), /想法/)
  await store.setVault(vault)
  assert.deepEqual(await markdownFiles(vault), files)
})

test('parallel additions and config updates preserve every note and library roots', async () => {
  const { store, path, vault } = await fixture()
  await store.configure(() => ({ libraryRoots: ['/books'] }))
  await store.setVault(vault)
  const saved = await Promise.all(Array.from({ length: 12 }, () => store.add({ path, kind: 'note', quote: '同秒同段' })))
  assert.equal(new Set(saved.map(({ note }) => note.id)).size, 12)
  assert.equal((await store.notes())[path].length, 12)
  assert.equal((await markdownFiles(vault)).length, 12)
  assert.deepEqual((await store.read('config.json')).libraryRoots, ['/books'])
})

test('JSON survives Markdown errors, directory switching and disabling never delete files', async () => {
  const { root, store, path } = await fixture()
  const blocked = join(root, 'not-a-directory')
  await writeFile(blocked, 'unchanged')
  await store.setVault(blocked)
  const result = await store.add({ path, kind: 'note', quote: '引用' })
  assert.match(result.mdError, /Markdown/)
  assert.equal((await store.notes())[path].length, 1)
  assert.equal(await readFile(blocked, 'utf8'), 'unchanged')
  await store.setVault('')
  assert.equal((await store.status()).path, '')
})

test('question capture saves actual question and all answer text; export retains answer', async () => {
  const { store, vault, path } = await fixture()
  await store.setVault(vault)
  const { note, mdPath } = await store.add({ path, kind: 'question', sessionId: 'session-1', quote: '半个时辰' }, { title: '大秦帝国', progress: 37.1 })
  const record = {
    turn: 5, ended: true, completed: true, truncated: false,
    questions: [{ id: note.id, messageId: 'user-1', question: '多久？' }], answer: '一小时。\n\n详细解释。',
  }
  await store.capture('other-session', record)
  assert.equal((await store.notes())[path][0].answer, undefined)
  await store.capture('session-1', record)
  await store.exportAll({ overwrite: true })
  const content = await readFile(mdPath, 'utf8')
  assert.match(content, /多久？/)
  assert.match(content, /一小时。\n\n详细解释。/)
  assert.match(content, /answered/)
  await store.capture('session-1', { ...record, questions: [{ id: note.id, messageId: 'user-copy', question: 'copied' }], answer: 'must not replace' })
  assert.doesNotMatch(await readFile(mdPath, 'utf8'), /must not replace/)
  const unrelated = { ...record, turn: 9, answer: '不应该写入' }
  await store.capture('session-1', unrelated)
  assert.doesNotMatch(await readFile(mdPath, 'utf8'), /不应该写入/)
  const saved = (await store.notes())[path][0]
  assert.equal(saved.answerState, 'answered')
  assert.equal(saved.progress, 37.1)
  await store.remove(path, note.id)
  assert.equal((await markdownFiles(vault)).length, 0)
})

test('explicit export preserves unrelated files and partial answer is visibly interrupted', async () => {
  const { store, vault, path } = await fixture()
  await store.setVault(vault)
  await writeFile(join(vault, '我的笔记.md'), 'handwritten')
  const { note, mdPath } = await store.add({ path, kind: 'question', quote: '原文' })
  await store.capture('s', { turn: 1, questions: [{ id: note.id, messageId: 'm', question: 'Q' }], ended: true, completed: false, answer: '部分' })
  await store.exportAll({ overwrite: true })
  assert.match(await readFile(mdPath, 'utf8'), /interrupted/)
  assert.equal(await readFile(join(vault, '我的笔记.md'), 'utf8'), 'handwritten')
})

test('answered JSON with a failed Markdown mirror is retried after restart', async () => {
  const { store, vault, path } = await fixture()
  await store.setVault(vault)
  const { note, mdPath } = await store.add({ path, kind: 'question', quote: '摘录' })
  const realWrite = store.vaults.get(vault).write.bind(store.vaults.get(vault))
  store.vaults.get(vault).write = async () => { throw new Error('disk temporarily unavailable') }
  await store.capture('s', { turn: 1, questions: [{ id: note.id, messageId: 'm', question: 'Q' }], ended: true, completed: true, answer: 'A' })
  assert.equal((await store.notes())[path][0].mdDirty, true)
  assert.equal((await store.notes())[path][0].answerState, 'answered')
  store.vaults.get(vault).write = realWrite
  const restored = new NotesStore(store.directory)
  await restored.retryMirrors()
  assert.match(await readFile(mdPath, 'utf8'), /answered/)
  assert.equal((await restored.notes())[path][0].mdDirty, undefined)
})

test('Markdown removal can be retried safely after JSON entry is already removed', async () => {
  const { store, vault, path } = await fixture()
  await store.setVault(vault)
  const { note } = await store.add({ path, kind: 'note', quote: '摘录' })
  const mirror = store.vaults.get(vault)
  const remove = mirror.remove.bind(mirror)
  mirror.remove = async () => { throw new Error('try later') }
  assert.match((await store.remove(path, note.id)).mdError, /try later/)
  mirror.remove = remove
  assert.equal((await store.remove(path, note.id)).mdError, undefined)
  assert.equal((await markdownFiles(vault)).length, 0)
})

test('migration and export use one batch with per-note failure reporting', async () => {
  const { store, path, vault } = await fixture()
  for (let i = 0; i < 4; i++) await store.add({ path, kind: 'note', paragraph: i, text: `memo ${i}` })
  assert.equal((await store.setVault(vault)).migration.exported, 4)
  const mirror = store.vaults.get(vault)
  const batch = mirror.writeAll.bind(mirror)
  let calls = 0
  mirror.write = async () => { throw new Error('single-note export must not run') }
  mirror.writeAll = async (...args) => { calls++; return batch(...args) }
  const notes = await store.notes()
  notes[path].push({ ...notes[path][0], id: 'invalid', paragraph: -1 })
  await store.write('notes.json', notes)
  const result = await store.exportAll({ overwrite: true })
  assert.equal(calls, 1)
  assert.equal(result.exported, 4)
  assert.equal(result.failed, 1)
  assert.match(result.errors[0], /invalid.*paragraph/)
  assert.match((await store.status()).error, /1 条批注未导出/)
  const migration = await store.setVault(vault)
  assert.equal(calls, 2)
  assert.equal(migration.migration.exported, 4)
  assert.equal(migration.migration.failed, 1)
})

test('corrupted JSON is refused rather than overwritten and invalid paths fail clearly', async () => {
  const { store, path } = await fixture()
  await mkdir(store.directory)
  await writeFile(join(store.directory, 'notes.json'), '{broken')
  await assert.rejects(store.add({ path, quote: 'new' }))
  assert.equal(await readFile(join(store.directory, 'notes.json'), 'utf8'), '{broken')
  assert.throws(() => expandNotesPath('relative/path'), /绝对路径/)
  assert.ok(expandNotesPath('~/Notes').endsWith('/Notes'))
})
