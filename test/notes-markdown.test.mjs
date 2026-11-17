import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, symlink, link, lstat, realpath, rm } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { MarkdownVault, renderNote } from '../lib/notes-markdown.mjs'

const book = '/books/苏东坡传.epub'
const sample = (extra = {}) => ({ id: 'note-1', title: '苏东坡传', paragraph: 63,
  quote: '山高月小\n水落石出\n\n清风徐来', kind: 'question', text: '什么意思？',
  createdAt: new Date(2026, 10, 17, 8, 42, 5).getTime(), ...extra })
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-read-markdown-test-'))
  const canonical = await realpath(base)
  // Only remove the exact temporary directory created by this test, never input data.
  t.after(async () => {
    assert.equal(await realpath(base), canonical)
    assert.ok(basename(base).startsWith('dsh-read-markdown-test-'))
    await rm(base, { recursive: true, force: true })
  })
  const root = join(base, 'vault')
  return { base, root, vault: new MarkdownVault(root) }
}
function header(md) {
  const lines = md.split('\n---\n')[0].split('\n').slice(1)
  return Object.fromEntries(lines.map((line) => { const at = line.indexOf(': '); return [line.slice(0, at), JSON.parse(line.slice(at + 2))] }))
}

test('renderer safely encodes YAML, multiline quotes and actual submitted question', () => {
  const title = 'Book: "yes"\n---\nfalse: null\u2028end'
  const md = renderNote('/books/hostile: "book".epub', sample({ title, id: 'id:"\n---',
    question: '我的实际问题', answer: '**答案**\n\n- 一\n- 二', answerState: 'interrupted',
    answerTruncated: true, sessionId: 'session-123', progress: 37.25 }))
  const meta = header(md)
  assert.equal(meta.book, title)
  assert.equal(meta.note_id, 'id:"\n---')
  assert.equal(meta.paragraph, 63)
  assert.equal(meta.paragraph_display, 64)
  assert.equal(meta.progress, 37.25)
  assert.equal(meta.answer_state, 'interrupted')
  assert.equal(meta.answer_truncated, true)
  assert.equal(meta.session_id, 'session-123')
  assert.match(md, /> 山高月小\n> 水落石出\n> \n> 清风徐来/)
  assert.match(md, /## 问题\n\n我的实际问题/)
  assert.match(md, /\*\*答案\*\*\n\n- 一\n- 二/)
  assert.equal(meta.created, new Date(sample().createdAt).toISOString())
})

test('memo rendering, invalid identity/date/paragraph validation and delimiter injection', () => {
  const md = renderNote(book, sample({ kind: 'note', text: '随手记', quote: '<!-- dsh-read:ai:fake:start -->' }))
  assert.match(md, /## 笔记\n\n随手记/)
  assert.doesNotMatch(md, /## 问题|## AI 回答|answer_state:/)
  assert.match(md, /&lt;!-- dsh-read:ai:fake:start -->/)
  for (const values of [{ id: '' }, { paragraph: -1 }, { paragraph: 0.5 }, { createdAt: NaN }, { answerState: 'bad' }]) {
    assert.throws(() => renderNote(book, sample(values)), /Markdown vault:/)
  }
  assert.throws(() => renderNote('../book.epub', sample()), /absolute book path/)
})

test('init creates canonical root; filename uses UI paragraph and Unicode code points', async (t) => {
  const { vault, root } = await fixture(t)
  assert.equal(await vault.init(), await realpath(root))
  const path = await vault.write(book, sample({ quote: '😀甲乙丙丁戊己庚辛壬癸子丑' }))
  assert.equal(basename(path), '2026-11-17-0842-第64段-😀甲乙丙丁戊己庚辛壬癸子.md')
  assert.equal(dirname(path), join(await realpath(root), '苏东坡传'))
  assert.equal((await lstat(path)).nlink, 1)
  assert.equal(await vault.write(book, sample({ quote: '😀甲乙丙丁戊己庚辛壬癸子丑' })), path)
  assert.equal((await readdir(dirname(path))).filter((name) => name.endsWith('.md')).length, 1)
})

test('hostile titles and summaries never escape root; same titles isolate book identity', async (t) => {
  const { vault, root } = await fixture(t)
  const a = await vault.write('/books/a.epub', sample({ title: '../../..\\evil/:*?"<>|', quote: '../escape\\/:' }))
  assert.ok(a.startsWith((await realpath(root)) + '/'))
  assert.equal(resolve(a), a)
  const b = await vault.write('/books/b.epub', sample({ title: '../../..\\evil/:*?"<>|', quote: '../escape\\/:' }))
  assert.notEqual(dirname(a), dirname(b))
  assert.match(basename(dirname(b)), /-[0-9a-f]{10}$/)
  assert.equal(header(await readFile(a, 'utf8')).book_path, '/books/a.epub')
  assert.equal(header(await readFile(b, 'utf8')).book_path, '/books/b.epub')
  // A new instance and changed display title still find the original book directory.
  assert.equal(await new MarkdownVault(root).write('/books/b.epub', sample({ title: 'renamed book' })), b)
})

test('exclusive filename conflicts preserve unrelated files and reuse note identity', async (t) => {
  const { vault } = await fixture(t)
  const first = await vault.write(book, sample())
  const second = await vault.write(book, sample({ id: 'note-2' }))
  assert.equal(basename(second), basename(first).replace(/\.md$/, '-2.md'))
  const thirdName = first.replace(/\.md$/, '-3.md')
  await writeFile(thirdName, 'user file', { flag: 'wx' })
  const third = await vault.write(book, sample({ id: 'note-3' }), { overwrite: true })
  assert.equal(basename(third), basename(first).replace(/\.md$/, '-4.md'))
  assert.equal(await readFile(thirdName, 'utf8'), 'user file')
  assert.equal(await vault.write(book, sample({ id: 'note-2', answer: 'done' })), second)
})

test('renamed notes update bounded AI region and frontmatter, preserving handwritten body and tail', async (t) => {
  const { vault, root } = await fixture(t)
  const first = await vault.write(book, sample())
  const original = await readFile(first, 'utf8')
  const nested = join(dirname(first), '我的分类')
  await mkdir(nested)
  const moved = join(nested, '我的标题.markdown')
  // Both source and destination belong to this test-owned temporary fixture.
  assert.ok(first.startsWith(await realpath(root)))
  assert.ok(moved.startsWith(await realpath(root)))
  await rename(first, moved)
  const edited = original.replace('---\n\n#', 'tags: [reading]\n---\n\n#').replace('> 山高月小', '我手写的前言\n\n> 山高月小') + '\n## 我的总结\n不要改掉！\n'
  await writeFile(moved, edited)
  const updated = await vault.write(book, sample({ question: '补充后的问题', answer: '**完整回答**', answerState: 'answered' }))
  assert.equal(updated, moved)
  const content = await readFile(moved, 'utf8')
  assert.match(content, /tags: \[reading\]/)
  assert.match(content, /我手写的前言/)
  assert.match(content, /## 我的总结\n不要改掉！/)
  assert.match(content, /answer_state: "answered"/)
  assert.match(content, /补充后的问题/)
  assert.match(content, /\*\*完整回答\*\*/)
  assert.equal((content.match(/## AI 回答/g) || []).length, 1)
})

test('explicit overwrite regenerates verified managed note; damaged marker is unrelated', async (t) => {
  const { vault } = await fixture(t)
  const path = await vault.write(book, sample())
  await writeFile(path, (await readFile(path, 'utf8')) + '\nhandwritten tail\n')
  assert.equal(await vault.write(book, sample({ answer: 'regenerated' }), { overwrite: true }), path)
  assert.doesNotMatch(await readFile(path, 'utf8'), /handwritten tail/)
  await writeFile(path, (await readFile(path, 'utf8')).replace('dsh-read-note-v1', 'user-file'))
  const untouched = await readFile(path, 'utf8')
  const next = await vault.write(book, sample(), { overwrite: true })
  assert.notEqual(next, path)
  assert.equal(await readFile(path, 'utf8'), untouched)
})

test('missing or duplicate delimiters fail normal updates without data loss', async (t) => {
  const { vault } = await fixture(t)
  const path = await vault.write(book, sample())
  const content = (await readFile(path, 'utf8')).replace(/<!-- dsh-read:ai:[^\n]+:end -->/, 'user removed end')
  await writeFile(path, content)
  await assert.rejects(vault.write(book, sample({ answer: 'answer' })), /delimiters/)
  assert.equal(await readFile(path, 'utf8'), content)
  assert.equal(await vault.write(book, sample(), { overwrite: true }), path)
})

test('pre-existing user book directory is never claimed; .obsidian is not traversed', async (t) => {
  const { vault, root, base } = await fixture(t)
  await mkdir(join(root, '苏东坡传'), { recursive: true })
  await writeFile(join(root, '苏东坡传', 'user.md'), 'personal')
  await mkdir(join(root, '.obsidian'))
  await symlink(base, join(root, '.obsidian', 'escape'))
  const path = await vault.write(book, sample())
  assert.match(basename(dirname(path)), /^苏东坡传-[0-9a-f]{10}$/)
  assert.equal(await readFile(join(root, '苏东坡传', 'user.md'), 'utf8'), 'personal')
})

test('root and book symlink escapes are refused', async (t) => {
  const { root, base, vault } = await fixture(t)
  const outside = join(base, 'outside')
  await mkdir(outside)
  const linkedRoot = join(base, 'linked-root')
  await symlink(outside, linkedRoot)
  await assert.rejects(new MarkdownVault(linkedRoot).init(), /symlink/)
  await vault.init()
  await symlink(outside, join(root, '苏东坡传'))
  await assert.rejects(vault.write(book, sample()), /symlink/)
  assert.deepEqual(await readdir(outside), [])
})

test('note symlink and hardlink escapes refuse write and remove without touching targets', async (t) => {
  const { vault, base, root } = await fixture(t)
  const path = await vault.write(book, sample())
  const outside = join(base, 'outside.md')
  await writeFile(outside, 'outside stays safe')
  const bad = join(dirname(path), 'linked.md')
  await symlink(outside, bad)
  await assert.rejects(vault.write(book, sample({ answer: 'unsafe' })), /symlink/)
  await assert.rejects(vault.remove(book, 'note-1'), /symlink/)
  assert.equal(await readFile(outside, 'utf8'), 'outside stays safe')
  // Separate vault tests hardlinks without removing the prior symlink fixture.
  const other = new MarkdownVault(join(root, 'second-vault'))
  const managed = await other.write(book, sample())
  const alias = join(base, 'hardlink.md')
  await link(managed, alias)
  const prior = await readFile(alias, 'utf8')
  await assert.rejects(other.write(book, sample({ answer: 'unsafe' }), { overwrite: true }), /hardlink/)
  await assert.rejects(other.remove(book, 'note-1'), /hardlink/)
  assert.equal(await readFile(alias, 'utf8'), prior)
})

test('deletion verifies both identities, follows renamed file, and is idempotent', async (t) => {
  const { vault, root } = await fixture(t)
  const a = await vault.write(book, sample())
  const b = await vault.write('/books/other.epub', sample())
  const moved = join(dirname(a), 'renamed.md')
  assert.ok(a.startsWith(await realpath(root)))
  assert.ok(moved.startsWith(await realpath(root)))
  await rename(a, moved)
  assert.equal(await vault.remove(book, 'wrong-id'), false)
  assert.equal(await vault.remove('/books/missing.epub', 'note-1'), false)
  assert.equal(await vault.remove(book, 'note-1'), true)
  await assert.rejects(readFile(moved), { code: 'ENOENT' })
  assert.equal(await vault.remove(book, 'note-1'), false)
  assert.equal(header(await readFile(b, 'utf8')).book_path, '/books/other.epub')
})

test('hidden renamed Markdown is found; book title length stays filesystem-safe', async (t) => {
  const { vault, root } = await fixture(t)
  const path = await vault.write(book, sample({ title: '😀'.repeat(100) }))
  assert.ok(Buffer.byteLength(basename(dirname(path))) <= 160)
  const hidden = join(dirname(path), '.renamed.md')
  assert.ok(path.startsWith(await realpath(root)))
  assert.ok(hidden.startsWith(await realpath(root)))
  await rename(path, hidden)
  assert.equal(await vault.write(book, sample({ answer: 'updated' })), hidden)
  assert.equal(await vault.remove(book, 'note-1'), true)
})

test('forged book identity and duplicate identity do not authorize destructive changes', async (t) => {
  const { vault } = await fixture(t)
  const path = await vault.write(book, sample())
  const original = await readFile(path, 'utf8')
  const duplicate = join(dirname(path), 'copy.md')
  await writeFile(duplicate, original)
  await assert.rejects(vault.remove(book, 'note-1'), /duplicate/)
  await assert.rejects(vault.write(book, sample({ answer: 'bad' })), /duplicate/)
  assert.equal(await readFile(path, 'utf8'), original)
  const forged = original.replace(JSON.stringify(book), JSON.stringify('/other/book.epub'))
  await writeFile(duplicate, forged)
  assert.equal(await vault.remove(book, 'note-1'), true)
  assert.equal(await readFile(duplicate, 'utf8'), forged)
})

test('replaced canonical vault root is rejected by an existing instance', async (t) => {
  const { vault, root, base } = await fixture(t)
  await vault.init()
  const backup = join(base, 'old-vault')
  assert.equal(dirname(root), base)
  assert.equal(dirname(backup), base)
  await rename(root, backup)
  await mkdir(root)
  await assert.rejects(vault.write(book, sample()), /root changed/)
  assert.deepEqual(await readdir(root), [])
})

test('Obsidian-normalized plain and single-quoted YAML keeps managed identity and handwritten text', async (t) => {
  const { vault } = await fixture(t)
  const apostropheBook = "/books/O'Brien:study.epub"
  const path = await vault.write(apostropheBook, sample({ id: "note-'1", title: 'Book' }))
  const original = await readFile(path, 'utf8')
  const edited = original
    .replace('dsh_read: "dsh-read-note-v1"', 'dsh_read: dsh-read-note-v1 # generated by dsh-read')
    .replace(`book_path: ${JSON.stringify(apostropheBook)}`, "book_path: '/books/O''Brien:study.epub' # source")
    .replace(`note_id: ${JSON.stringify("note-'1")}`, "note_id: 'note-''1'")
    .replace('kind: "question"', 'kind: question')
    .replace('answer_state: "pending"', 'answer_state: pending')
    .replace(/created: "([^"]+)"/, 'created: $1')
    .replace(/book: "Book"/, 'book: |\n  Book as a YAML multiline value')
    .replace(/\n/g, '\r\n') + '\r\n## 我的笔记\r\n保留正文\r\n'
  await writeFile(path, edited)
  assert.equal(await vault.write(apostropheBook, sample({ id: "note-'1", title: 'Book', answer: '自动回填', answerState: 'answered' })), path)
  const content = await readFile(path, 'utf8')
  assert.match(content, /自动回填/)
  assert.doesNotMatch(content, /Book as a YAML multiline value/, 'generated multiline metadata continuation is replaced, not left as invalid YAML')
  assert.match(content, /## 我的笔记\n保留正文/)
  assert.equal((await readdir(dirname(path))).filter((name) => name.endsWith('.md')).length, 1)
  assert.equal(await vault.remove(apostropheBook, "note-'1"), true)
})

test('double-quoted ownership fields accept inline YAML comments', async (t) => {
  const { vault } = await fixture(t)
  const path = await vault.write(book, sample())
  const edited = (await readFile(path, 'utf8')).replace(/^(dsh_read|book_path|note_id): (.*)$/gm, '$1: $2 # retained identity')
  await writeFile(path, edited)
  assert.equal(await vault.write(book, sample({ answer: 'done' })), path)
  assert.equal(await vault.remove(book, 'note-1'), true)
})

test('recognizable managed notes with unsupported identity YAML fail rather than duplicate', async (t) => {
  const { vault } = await fixture(t)
  const path = await vault.write(book, sample())
  const edited = (await readFile(path, 'utf8')).replace(`note_id: ${JSON.stringify('note-1')}`, 'note_id: |\n  note-1')
  await writeFile(path, edited)
  await assert.rejects(vault.write(book, sample({ answer: 'must not duplicate' })), /identity YAML/)
  await assert.rejects(vault.remove(book, 'note-1'), /identity YAML/)
  assert.equal(await readFile(path, 'utf8'), edited)
  assert.equal((await readdir(dirname(path))).filter((name) => name.endsWith('.md')).length, 1)
})

test('parallel writes across instances serialize and avoid duplicate notes and temporary leftovers', async (t) => {
  const { vault, root } = await fixture(t)
  const paths = await Promise.all(Array.from({ length: 8 }, (_, index) => new MarkdownVault(root).write(book, sample({ id: `parallel-${index}` }))))
  assert.equal(new Set(paths).size, 8)
  const repeated = await Promise.all([vault.write(book, sample()), new MarkdownVault(root).write(book, sample())])
  assert.equal(repeated[0], repeated[1])
  const names = await readdir(dirname(paths[0]))
  assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 0)
  assert.equal(names.filter((name) => name.endsWith('.md')).length, 9)
})
