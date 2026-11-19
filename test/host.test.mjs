// Exercises the host half against a fake cordis context: the `/read` command's
// resolution and safety rules, the reader HTTP surface it feeds, and progress
// persistence. Fixtures are real EPUB files built in memory by the ZIP writer below.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'

// The plugin resolves its data directory at import time, so point DSH_HOME at a
// throwaway directory before importing it.
const sandboxHome = await mkdtemp(join(tmpdir(), 'dsh-read-home-'))
process.env.DSH_HOME = sandboxHome
const { apply, name } = await import('../index.mjs')

after(() => rm(sandboxHome, { recursive: true, force: true }))

/* ── fake host context ───────────────────────────────────────────────────── */

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      if (headers) this.headers = headers
    },
    end(body) {
      this.body = body
      this.raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      this.writableEnded = true
    },
  }
}

function mount({ agent, agents, picker } = {}) {
  const routes = new Map()
  const commands = new Map()
  const executed = []
  const injected = []
  // `agents` is the live registry; a bare `agent` is the one-entry shorthand.
  const live = agents ?? (agent ? [agent] : [])

  const ctx = {
    inject: (dependencies, callback) => {
      injected.push(dependencies)
      if (dependencies[0] !== 'webServer') return () => {}
      callback({
        get: (key) => key === 'directoryPicker' ? picker : undefined,
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
      })
    },
    commands: {
      register: (definition) => {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
      async execute(target, line) {
        executed.push({ target, line })
        return { commandId: 'cmd-exec', result: { kind: 'success', text: '{}' } }
      },
    },
    agents: {
      get: (id) => live.find((candidate) => candidate.id === id),
      list: () => [...live],
    },
    effect: () => {},
  }

  apply(ctx)
  return { routes, commands, injected, executed }
}

/** Like request(), but without JSON parsing — for routes that answer with bytes. */
async function rawRequest(routes, url) {
  const handler = routes.get(url.split('?')[0])
  assert.ok(handler, `route not registered: ${url}`)
  const res = response()
  await handler({ url, method: 'GET', async *[Symbol.asyncIterator]() {} }, res)
  return { status: res.status, headers: res.headers, body: res.raw }
}

async function request(routes, url, { method = 'GET', body } = {}) {
  const handler = routes.get(url.split('?')[0])
  assert.ok(handler, `route not registered: ${url}`)
  const req = {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const res = response()
  await handler(req, res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

/** Invoke a registered command the way the commands service would. */
async function runCommand(commands, commandName, rawInput) {
  const definition = commands.get(commandName)
  assert.ok(definition, `command not registered: ${commandName}`)
  return definition.handler({
    commandId: 'cmd-test',
    agent: { id: 'session-test' },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  })
}

async function configureRoots(roots) {
  await mkdir(join(sandboxHome, 'dsh-read'), { recursive: true })
  await writeFile(
    join(sandboxHome, 'dsh-read', 'config.json'),
    JSON.stringify({ libraryRoots: roots }),
    'utf8',
  )
}

async function clearRoots() {
  await rm(join(sandboxHome, 'dsh-read', 'config.json'), { force: true })
}

/* ── fixtures ────────────────────────────────────────────────────────────── */

/** Smallest valid PNG: a 1x1 transparent pixel. */
const PLATE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

function makeZip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const [entryName, content] of entries) {
    const nameBytes = Buffer.from(entryName, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(data)
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    parts.push(local, nameBytes, compressed)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(checksum, 16)
    entry.writeUInt32LE(compressed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([entry, nameBytes]))
    offset += local.length + nameBytes.length + compressed.length
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBytes, end])
}

function fixtureEpub(title = 'Host Fixture') {
  const prose = `${'A'.repeat(40)} the keeper wrote the same sentence twice and meant it. ${'B'.repeat(40)}`
  return makeZip([
    [
      'META-INF/container.xml',
      '<?xml version="1.0"?><container><rootfiles>' +
        '<rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ],
    [
      'content.opf',
      `<package><metadata><dc:title>${title}</dc:title></metadata><manifest>` +
        '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="p1" href="images/plate.png" media-type="image/png"/>' +
        '</manifest><spine><itemref idref="c1"/></spine></package>',
    ],
    [
      'ch1.xhtml',
      `<html><body><h1>\u7b2c\u4e00\u7ae0</h1><p>${prose}</p>` +
        '<p><img alt="picture" src="images/plate.png"/></p></body></html>',
    ],
    ['images/plate.png', PLATE],
  ])
}

/** The same book, unpacked on disk — the shape iBooks and several converters leave behind. */
async function writeUnpackedEpub(directory, title = 'Unpacked Fixture') {
  const prose = `${'A'.repeat(40)} the keeper wrote the same sentence twice and meant it. ${'B'.repeat(40)}`
  await mkdir(join(directory, 'META-INF'), { recursive: true })
  await writeFile(
    join(directory, 'META-INF', 'container.xml'),
    '<?xml version="1.0"?><container><rootfiles>' +
      '<rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  )
  await writeFile(
    join(directory, 'content.opf'),
    `<package><metadata><dc:title>${title}</dc:title></metadata><manifest>` +
      '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
      '</manifest><spine><itemref idref="c1"/></spine></package>',
  )
  await writeFile(
    join(directory, 'ch1.xhtml'),
    `<html><body><h1>\u7b2c\u4e00\u7ae0</h1><p>${prose}</p></body></html>`,
  )
  return directory
}

/* ── tests ───────────────────────────────────────────────────────────────── */

test('apply survives a strict cordis context that only exposes declared services', async () => {
  // Cordis throws on reading an undeclared service property, and a throw inside
  // apply() takes the whole composition down — this reproduces that guard.
  const { apply: load, inject: declared = [] } = await import('../index.mjs')
  const allowed = new Set(declared)

  const builtins = {
    get: () => undefined,
    inject: () => () => {},
    effect: () => () => {},
    on: () => () => {},
    off: () => {},
    provide: () => () => {},
  }
  const services = {
    agents: { get: () => undefined, list: () => [] },
    commands: { register: () => () => {}, execute: async () => undefined },
    tools: { register: () => () => {} },
  }

  const strict = new Proxy(
    {},
    {
      get(_target, key) {
        if (key in builtins) return builtins[key]
        if (allowed.has(key) && key in services) return services[key]
        throw new Error(`cannot get property "${String(key)}" without inject`)
      },
    },
  )

  assert.doesNotThrow(() => load(strict))
})

test('host plugin exports its cordis name, mounts routes late, and registers /read', () => {
  assert.equal(name, 'dsh-read')
  const { routes, commands, injected } = mount()
  assert.deepEqual(injected, [['sessionProjections', 'sessions'], ['sessionQuery'], ['webServer']])
  assert.deepEqual([...routes.keys()].sort(), [
    '/dsh-read/api/directory-picker',
    '/dsh-read/api/export',
    '/dsh-read/api/image',
    '/dsh-read/api/library',
    '/dsh-read/api/notes',
    '/dsh-read/api/notes/locate',
    '/dsh-read/api/open',
    '/dsh-read/api/paragraphs',
    '/dsh-read/api/progress',
    '/dsh-read/api/search',
    '/dsh-read/api/start',
    '/dsh-read/api/vault',
    '/dsh-read/api/vault/open',
  ])
  assert.ok(commands.has('read'))
  // The typed argument must reach the durable log for the client card to fold.
  assert.notEqual(commands.get('read').recordInput, false)
})

test('directory picker advertises composed browse/native capability without opening a chooser', async () => {
  for (const kind of ['browse', 'native']) {
    const { routes } = mount({ picker: { capability: () => ({ kind }) } })
    assert.equal((await request(routes, '/dsh-read/api/directory-picker')).payload.kind, kind)
    const rejected = await request(routes, '/dsh-read/api/directory-picker', { method: 'POST', body: {} })
    assert.equal(rejected.status, 400)
  }
  assert.equal((await request(mount().routes, '/dsh-read/api/directory-picker')).payload.kind, 'unavailable')
})

test('/read <path> resolves the book and returns its metadata as result text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-open-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())

    const { commands } = mount()
    const result = await runCommand(commands, 'read', bookPath)

    assert.equal(result.kind, 'success')
    const book = JSON.parse(result.text)
    assert.equal(book.title, 'Host Fixture')
    assert.equal(book.format, 'epub')
    assert.equal(book.path, bookPath)
    assert.equal(book.chapters[0].title, '\u7b2c\u4e00\u7ae0')
    assert.ok(book.paragraphCount >= 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('/read refuses non-book paths instead of reading them into the transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-guard-'))
  try {
    const secret = join(directory, 'passwd.bin')
    await writeFile(secret, 'classified')

    const { commands } = mount()
    const result = await runCommand(commands, 'read', secret)

    assert.equal(result.kind, 'error')
    assert.match(result.text, /unsupported book format/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('/read with no argument explains its usage', async () => {
  const { commands } = mount()
  const result = await runCommand(commands, 'read', '   ')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
})

test('/read resolves a keyword through the configured library roots', async () => {
  const library = await mkdtemp(join(tmpdir(), 'dsh-read-library-'))
  try {
    await writeFile(join(library, 'Sapiens.epub'), fixtureEpub('Sapiens'))
    await writeFile(join(library, 'unrelated.txt'), 'no match here')
    await configureRoots([library])

    const { commands } = mount()
    const result = await runCommand(commands, 'read', 'sapiens')

    assert.equal(result.kind, 'success')
    assert.equal(JSON.parse(result.text).title, 'Sapiens')
  } finally {
    await clearRoots()
    await rm(library, { recursive: true, force: true })
  }
})

test('/read reports an unhelpful keyword instead of guessing', async () => {
  const library = await mkdtemp(join(tmpdir(), 'dsh-read-missing-'))
  try {
    await configureRoots([library])
    const { commands } = mount()
    const result = await runCommand(commands, 'read', 'nothing-like-this')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /没有找到/)
  } finally {
    await clearRoots()
    await rm(library, { recursive: true, force: true })
  }
})

test('the library route lists one level of directories and books', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-library-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    await writeFile(join(directory, 'notes.pdf'), 'not a book')
    await mkdir(join(directory, 'nested'), { recursive: true })

    const { routes } = mount()
    const listing = await request(
      routes,
      `/dsh-read/api/library?dir=${encodeURIComponent(directory)}`,
    )

    assert.equal(listing.payload.ok, true)
    assert.equal(listing.payload.dir, directory)
    assert.deepEqual(
      listing.payload.directories.map((entry) => entry.name),
      ['nested'],
    )
    assert.deepEqual(
      listing.payload.books.map((book) => book.name),
      ['fixture.epub'],
    )
    // Nothing read yet.
    assert.equal(listing.payload.books[0].progress, null)

    // Once progress exists, the tab gets a real percentage — which is why the
    // route parses only the books that have been started.
    await request(routes, '/dsh-read/api/progress', {
      method: 'POST',
      body: { path: bookPath, name: 'fixture.epub', index: 1, chars: 100 },
    })

    const withProgress = await request(
      routes,
      `/dsh-read/api/library?dir=${encodeURIComponent(directory)}`,
    )
    const progress = withProgress.payload.books[0].progress
    assert.equal(progress.index, 1)
    assert.ok(progress.paragraphCount >= 2)
    assert.ok(progress.percent > 0 && progress.percent <= 100)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loading a directory in the tab makes it the primary library root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-primary-'))
  try {
    await writeFile(join(directory, 'Sapiens.epub'), fixtureEpub('Sapiens'))
    const { routes } = mount()

    const saved = await request(routes, '/dsh-read/api/library', {
      method: 'POST',
      body: { dir: directory },
    })
    assert.equal(saved.payload.dir, directory)

    // A later GET with no argument now defaults to that directory.
    const current = await request(routes, '/dsh-read/api/library')
    assert.equal(current.payload.dir, directory)
    assert.equal(current.payload.books[0].name, 'Sapiens.epub')
  } finally {
    await clearRoots()
    await rm(directory, { recursive: true, force: true })
  }
})

test('开始阅读 runs the very same /read command on that session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-start-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    const agent = { id: 'session-1' }
    const { routes, executed } = mount({ agent })

    const started = await request(routes, '/dsh-read/api/start', {
      method: 'POST',
      body: { sessionId: 'session-1', path: bookPath },
    })

    assert.equal(started.payload.ok, true)
    assert.equal(executed.length, 1)
    assert.equal(executed[0].target, agent)
    assert.equal(executed[0].line, `/read ${bookPath}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('开始阅读 reports a cold session instead of failing silently', async () => {
  const { routes, executed } = mount({})
  const started = await request(routes, '/dsh-read/api/start', {
    method: 'POST',
    body: { sessionId: 'not-live', path: '/tmp/whatever.epub' },
  })

  assert.equal(started.payload.ok, false)
  assert.match(started.payload.error, /不在运行/)
  assert.equal(executed.length, 0)
})

test('设置页不带会话 ID 时，开始阅读落到唯一在跑的那个会话', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-only-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    const agent = { id: 'only-one' }
    const { routes, executed } = mount({ agents: [agent] })

    const started = await request(routes, '/dsh-read/api/start', {
      method: 'POST',
      body: { path: bookPath },
    })

    assert.equal(started.payload.ok, true)
    assert.equal(executed.length, 1)
    assert.equal(executed[0].target, agent)
    assert.equal(executed[0].line, `/read ${bookPath}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('有多个会话在跑时，开始阅读不猜，而是说清楚该怎么办', async () => {
  const { routes, executed } = mount({ agents: [{ id: 'a' }, { id: 'b' }] })
  const started = await request(routes, '/dsh-read/api/start', {
    method: 'POST',
    body: { path: '/tmp/whatever.epub' },
  })

  assert.equal(started.payload.ok, false)
  assert.match(started.payload.error, /2 个运行中的会话/)
  assert.equal(executed.length, 0)
})

test('一个会话都没有时，开始阅读提示先开一个会话', async () => {
  const { routes, executed } = mount({})
  const started = await request(routes, '/dsh-read/api/start', {
    method: 'POST',
    body: { path: '/tmp/whatever.epub' },
  })

  assert.equal(started.payload.ok, false)
  assert.match(started.payload.error, /没有运行中的会话/)
  assert.equal(executed.length, 0)
})

test('an illustration becomes its own item in the paragraph flow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-image-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    const { routes } = mount()

    const opened = await request(routes, `/dsh-read/api/open?path=${encodeURIComponent(bookPath)}`)
    assert.equal(opened.payload.book.imageCount, 1, 'the plate must be counted')

    const page = await request(
      routes,
      `/dsh-read/api/paragraphs?path=${encodeURIComponent(bookPath)}&from=0&count=30`,
    )
    const images = page.payload.items.filter((item) => item.image !== undefined)
    assert.equal(images.length, 1, 'the plate must hold a place in the flow')
    assert.equal(typeof images[0].image, 'number')
    // It sits after the prose, where the book put it.
    assert.ok(
      page.payload.items.indexOf(images[0]) > 0,
      'the illustration must not jump to the front of the book',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the image route serves declared plates and refuses everything else', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-image-route-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    const { routes } = mount()

    const res = await rawRequest(
      routes,
      `/dsh-read/api/image?path=${encodeURIComponent(bookPath)}&index=0`,
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'image/png')
    // A real PNG header, not an error body wearing an image content type.
    assert.equal(res.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')

    // An index the book does not have is refused rather than reaching for a path.
    const missing = await request(
      routes,
      `/dsh-read/api/image?path=${encodeURIComponent(bookPath)}&index=99`,
    )
    assert.equal(missing.payload.ok, false)
    assert.match(missing.payload.error, /no image at index/)

    // The route takes a book path plus an index; there is no way to ask for a bare file.
    const notABook = await request(
      routes,
      `/dsh-read/api/image?path=${encodeURIComponent(join(directory, 'passwd.bin'))}&index=0`,
    )
    assert.equal(notABook.payload.ok, false)
    assert.match(notABook.payload.error, /unsupported book format/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('annotations accumulate per book and can be removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-notes-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    const otherPath = join(directory, 'other.epub')
    await writeFile(bookPath, fixtureEpub())
    await writeFile(otherPath, fixtureEpub('Other'))
    const { routes } = mount()

    const added = await request(routes, '/dsh-read/api/notes', {
      method: 'POST',
      body: {
        path: bookPath,
        paragraph: 124,
        quote: '\u6211\u6bd4\u73b0\u5728\u5e74\u8f7b\u5341\u5c81',
        kind: 'question',
        text: '\u8fd9\u6bb5\u8bdd\u662f\u4ec0\u4e48\u610f\u601d\uff1f',
      },
    })
    assert.equal(added.payload.ok, true)
    assert.equal(added.payload.note.paragraph, 124)
    assert.equal(added.payload.note.kind, 'question')
    assert.ok(added.payload.note.id, 'every annotation needs an id to be removable')
    assert.ok(added.payload.note.createdAt > 0)

    // A second book must not share the first book's list.
    await request(routes, '/dsh-read/api/notes', {
      method: 'POST',
      body: { path: otherPath, paragraph: 3, quote: 'x', kind: 'note', text: 'mine' },
    })

    const forBook = await request(
      routes,
      `/dsh-read/api/notes?path=${encodeURIComponent(bookPath)}`,
    )
    assert.equal(forBook.payload.notes.length, 1)
    assert.equal(forBook.payload.notes[0].paragraph, 124)

    // The library-wide view is what the reading centre lists.
    const all = await request(routes, '/dsh-read/api/notes')
    assert.equal(Object.keys(all.payload.notes).length, 2)

    const removed = await request(routes, '/dsh-read/api/notes', {
      method: 'POST',
      body: { path: bookPath, remove: added.payload.note.id },
    })
    assert.equal(removed.payload.notes.length, 0)

    const after = await request(routes, `/dsh-read/api/notes?path=${encodeURIComponent(bookPath)}`)
    assert.equal(after.payload.notes.length, 0, 'the other book must survive the removal')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an annotation is clamped, so a stray payload cannot grow without bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-notes-limit-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    const { routes } = mount()

    const added = await request(routes, '/dsh-read/api/notes', {
      method: 'POST',
      body: {
        path: bookPath,
        paragraph: -5,
        quote: 'q'.repeat(5000),
        kind: 'nonsense',
        text: 't'.repeat(5000),
      },
    })

    assert.equal(added.payload.note.paragraph, 0, 'a negative paragraph clamps to the start')
    assert.equal(added.payload.note.quote.length, 400)
    assert.equal(added.payload.note.text.length, 2000)
    // An unknown kind falls back to question rather than being stored verbatim.
    assert.equal(added.payload.note.kind, 'question')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('locate returns a verified distant paragraph, scopes IDs to the book and does not change notes or progress', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-location-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'book.txt')
  const other = join(directory, 'other.txt')
  const paragraphs = Array.from({ length: 160 }, (_, i) => `这是第 ${i} 段的唯一内容。`)
  await writeFile(path, paragraphs.join('\n\n'))
  await writeFile(other, '其他书籍')
  const { routes } = mount()
  const add = async (book, paragraph, quote) => (await request(routes, '/dsh-read/api/notes', {
    method: 'POST', body: { path: book, paragraph, quote, kind: 'note', text: '笔记' },
  })).payload.note
  const first = await add(path, 130, paragraphs[130])
  const second = await add(path, 130, '唯一内容。')
  const alien = await add(other, 0, '其他书籍')
  const list = (await request(routes, `/dsh-read/api/notes?path=${encodeURIComponent(path)}`)).payload.notes
  assert.deepEqual(list.map((note) => note.id), [first.id, second.id])
  await request(routes, '/dsh-read/api/progress', { method: 'POST', body: { path, index: 7 } })
  const progressBefore = (await request(routes, '/dsh-read/api/progress')).payload.progress
  const locate = (id, method = 'GET') => request(routes,
    `/dsh-read/api/notes/locate?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`, { method })
  const located = await locate(first.id)
  assert.equal(located.payload.ok, true)
  assert.equal(located.payload.book.path, path)
  assert.equal(located.payload.book.paragraphCount, 160)
  assert.equal(located.payload.index, 130)
  assert.equal(located.payload.items[130 - located.payload.from].text, paragraphs[130])
  assert.match(located.payload.book.revision, /^[a-f0-9]{64}$/)
  assert.equal((await locate(alien.id)).payload.ok, false)
  assert.equal((await locate(first.id, 'POST')).status, 400)
  assert.equal((await locate('')).payload.ok, false)
  assert.match((await locate(second.id)).payload.error, /多个段落/)
  assert.deepEqual((await request(routes, '/dsh-read/api/progress')).payload.progress, progressBefore)
  assert.deepEqual((await request(routes, `/dsh-read/api/notes?path=${encodeURIComponent(path)}`)).payload.notes, list)
  await request(routes, '/dsh-read/api/notes', { method: 'POST', body: { path, remove: first.id } })
  assert.match((await locate(first.id)).payload.error, /不存在/)
})

test('locate rejects changed, shifted, missing and unreadable books even after caching; list remains available', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-location-changes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'book.txt')
  const original = '开头\n\n唯一原文摘录\n\n结尾'
  await writeFile(path, original)
  const { routes } = mount()
  const saved = (await request(routes, '/dsh-read/api/notes', {
    method: 'POST', body: { path, paragraph: 1, quote: '唯一原文摘录' },
  })).payload.note
  const url = `/dsh-read/api/notes/locate?path=${encodeURIComponent(path)}&id=${saved.id}`
  const first = (await request(routes, url)).payload
  assert.equal(first.ok, true)
  for (const changed of ['开头\n\n改写的段落\n\n结尾', '插入前文\n\n' + original, '只有一段']) {
    await writeFile(path, changed)
    assert.equal((await request(routes, url)).payload.ok, false)
    const stalePage = await request(routes, `/dsh-read/api/paragraphs?path=${encodeURIComponent(path)}&revision=${first.book.revision}`)
    assert.match(stalePage.payload.error, /内容已变化/)
  }
  await writeFile(path, '')
  assert.match((await request(routes, url)).payload.error, /无法读取原书/)
  await rm(path)
  assert.match((await request(routes, url)).payload.error, /移动、删除或不可用/)
  assert.equal((await request(routes, `/dsh-read/api/notes?path=${encodeURIComponent(path)}`)).payload.notes[0].id, saved.id)
  await writeFile(path, original)
  assert.equal((await request(routes, url)).payload.ok, true, 'retry works after restoring the original')
})

test('notes read failure is explicit and retry preserves the stored data', async () => {
  const file = join(sandboxHome, 'dsh-read', 'notes.json')
  const original = await readFile(file, 'utf8')
  const { routes } = mount()
  try {
    await writeFile(file, '{broken')
    const failed = await request(routes, '/dsh-read/api/notes?path=/books/a.txt')
    assert.equal(failed.payload.ok, false)
    assert.ok(failed.payload.error)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally { await writeFile(file, original) }
  assert.equal((await request(routes, '/dsh-read/api/notes?path=/books/a.txt')).payload.ok, true)
})

test('locate sees an unpacked EPUB spine change without relying on the parent directory timestamp', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-location-unpacked-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'book.epub')
  await writeUnpackedEpub(path)
  const { routes } = mount()
  const page = (await request(routes, `/dsh-read/api/paragraphs?path=${encodeURIComponent(path)}`)).payload
  const saved = (await request(routes, '/dsh-read/api/notes', {
    method: 'POST', body: { path, paragraph: 1, quote: page.items[1].text },
  })).payload.note
  const url = `/dsh-read/api/notes/locate?path=${encodeURIComponent(path)}&id=${saved.id}`
  const located = (await request(routes, url)).payload
  assert.equal(located.ok, true)
  await writeFile(join(path, 'ch1.xhtml'), '<html><body><h1>第一章</h1><p>完全替换的正文</p></body></html>')
  assert.equal((await request(routes, url)).payload.ok, false)
  const next = await request(routes, `/dsh-read/api/paragraphs?path=${encodeURIComponent(path)}&revision=${located.book.revision}`)
  assert.match(next.payload.error, /内容已变化/)
})

test('an unpacked EPUB is listed as a book, not offered as a directory', async () => {
  // The reported case: a book that is really a folder full of OCF files. It must appear in
  // the book list, because descending into it yields nothing a reader can open.
  const library = await mkdtemp(join(tmpdir(), 'dsh-read-unpacked-'))
  try {
    await writeUnpackedEpub(join(library, '1913.epub'))
    await mkdir(join(library, 'ordinary-folder'), { recursive: true })

    const { routes } = mount()
    const listing = await request(routes, `/dsh-read/api/library?dir=${encodeURIComponent(library)}`)

    assert.deepEqual(
      listing.payload.books.map((book) => book.name),
      ['1913.epub'],
      'an unpacked EPUB belongs in the book list',
    )
    assert.deepEqual(
      listing.payload.directories.map((entry) => entry.name),
      ['ordinary-folder'],
      'a real folder must still be navigable',
    )
  } finally {
    await rm(library, { recursive: true, force: true })
  }
})

test('/read opens an unpacked EPUB directory and refuses an unrelated folder', async () => {
  const library = await mkdtemp(join(tmpdir(), 'dsh-read-unpacked-read-'))
  try {
    const bookPath = join(library, '1913.epub')
    await writeUnpackedEpub(bookPath, 'Unpacked Book')

    const { commands } = mount()
    const result = await runCommand(commands, 'read', bookPath)

    assert.equal(result.kind, 'success')
    const book = JSON.parse(result.text)
    assert.equal(book.title, 'Unpacked Book')
    assert.equal(book.format, 'epub-unpacked')
    assert.equal(book.paragraphCount >= 2, true)
    assert.equal(book.chapters[0].title, '\u7b2c\u4e00\u7ae0')

    // A directory without the OCF marker is still not a book.
    const plain = join(library, 'just-a-folder')
    await mkdir(plain, { recursive: true })
    const refused = await runCommand(commands, 'read', plain)
    assert.equal(refused.kind, 'error')
    assert.match(refused.text, /unsupported book format|not a file/)
  } finally {
    await rm(library, { recursive: true, force: true })
  }
})

test('the reader API pages through an unpacked EPUB too', async () => {
  const library = await mkdtemp(join(tmpdir(), 'dsh-read-unpacked-api-'))
  try {
    const bookPath = join(library, '1913.epub')
    await writeUnpackedEpub(bookPath)
    const { routes } = mount()

    const opened = await request(routes, `/dsh-read/api/open?path=${encodeURIComponent(bookPath)}`)
    assert.equal(opened.payload.ok, true)
    assert.equal(opened.payload.book.format, 'epub-unpacked')

    const page = await request(
      routes,
      `/dsh-read/api/paragraphs?path=${encodeURIComponent(bookPath)}&from=0&count=10`,
    )
    assert.equal(page.payload.ok, true)
    assert.equal(page.payload.items[0].text, '\u7b2c\u4e00\u7ae0')
  } finally {
    await rm(library, { recursive: true, force: true })
  }
})

test('the reader API parses books, pages paragraphs, and refuses non-books', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-api-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    const { routes } = mount()

    const opened = await request(routes, `/dsh-read/api/open?path=${encodeURIComponent(bookPath)}`)
    assert.equal(opened.payload.ok, true)
    assert.equal(opened.payload.book.title, 'Host Fixture')

    const page = await request(
      routes,
      `/dsh-read/api/paragraphs?path=${encodeURIComponent(bookPath)}&from=0&count=10`,
    )
    assert.equal(page.payload.ok, true)
    assert.equal(page.payload.items[0].text, '\u7b2c\u4e00\u7ae0')

    const refused = await request(
      routes,
      `/dsh-read/api/open?path=${encodeURIComponent(join(directory, 'passwd.bin'))}`,
    )
    assert.equal(refused.payload.ok, false)
    assert.match(refused.payload.error, /unsupported book format/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('progress round-trips through the data directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-progress-'))
  try {
    const bookPath = join(directory, 'fixture.epub')
    await writeFile(bookPath, fixtureEpub())
    const { routes } = mount()

    await request(routes, '/dsh-read/api/progress', {
      method: 'POST',
      body: { path: bookPath, name: 'fixture.epub', index: 3, chars: 900 },
    })

    const saved = await request(routes, '/dsh-read/api/progress')
    assert.equal(saved.payload.progress[bookPath].index, 3)

    await request(routes, '/dsh-read/api/progress', {
      method: 'POST',
      body: { path: bookPath, clear: true },
    })
    const cleared = await request(routes, '/dsh-read/api/progress')
    assert.equal(cleared.payload.progress[bookPath], undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('content search returns bounded pages from the whole book without changing saved progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-content-search-'))
  try {
    const path = join(directory, 'whole.txt')
    await writeFile(path, '第一章\n\n' + Array.from({ length: 250 }, (_, i) => `正文 ${i} needle ` + '长'.repeat(300)).join('\n\n'))
    const { routes } = mount()
    await request(routes, '/dsh-read/api/progress', { method: 'POST', body: { path, index: 17, chars: 1000 } })
    const before = (await request(routes, '/dsh-read/api/progress')).payload
    let cursor
    const hits = []
    do {
      const page = await request(routes, `/dsh-read/api/search?path=${encodeURIComponent(path)}&query=NEEDLE${cursor ? `&cursor=${cursor}` : ''}`)
      assert.equal(page.status, 200)
      assert.ok(page.payload.results.length <= 20)
      assert.equal('paragraphs' in page.payload, false)
      for (const hit of page.payload.results) {
        assert.equal(hit.chapter, '第一章')
        assert.ok(hit.snippet.length <= 126)
      }
      hits.push(...page.payload.results)
      cursor = page.payload.nextCursor
    } while (cursor)
    assert.equal(hits.length, 250)
    assert.equal(hits.at(-1).index, 250)
    assert.deepEqual((await request(routes, '/dsh-read/api/progress')).payload, before)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('search cursors survive reparsing, cache eviction and another reader locating notes, but reject content changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-search-location-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { routes } = mount()
  for (const format of ['txt', 'epub-unpacked']) {
    await t.test(format, async () => {
      const path = join(directory, format === 'txt' ? 'book.txt' : 'book.epub')
      const paragraphs = Array.from({ length: 65 }, (_, index) => `needle unique passage ${index}.`)
      const original = format === 'txt' ? paragraphs.join('\n\n')
        : `<html><body>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</body></html>`
      if (format !== 'txt') await writeUnpackedEpub(path)
      const source = format === 'txt' ? path : join(path, 'ch1.xhtml')
      await writeFile(source, original)
      const saved = (await request(routes, '/dsh-read/api/notes', {
        method: 'POST', body: { path, paragraph: 5, quote: paragraphs[5] },
      })).payload.note
      const progress = (await request(routes, '/dsh-read/api/progress')).payload
      const url = `/dsh-read/api/search?path=${encodeURIComponent(path)}&query=needle`
      const first = (await request(routes, url)).payload
      assert.equal(first.ok, true)
      assert.match(first.revision, /^[a-f0-9]{64}$/)
      assert.ok(first.nextCursor)
      const next = (await request(routes, `${url}&cursor=${first.nextCursor}`)).payload
      assert.equal(next.ok, true, 'an unchanged unpacked EPUB must support a second page')
      const located = (await request(routes,
        `/dsh-read/api/notes/locate?path=${encodeURIComponent(path)}&id=${saved.id}`)).payload
      assert.equal(located.ok, true)
      const afterLocate = (await request(routes, `${url}&cursor=${next.nextCursor}`)).payload
      assert.equal(afterLocate.ok, true, 'fresh annotation reads must not expire another card’s cursor')
      for (let i = 0; i < 4; i += 1) {
        const other = join(directory, `other-${i}.txt`)
        await writeFile(other, 'unrelated book')
        await request(routes, `/dsh-read/api/open?path=${encodeURIComponent(other)}`)
      }
      const last = (await request(routes, `${url}&cursor=${afterLocate.nextCursor}`)).payload
      assert.equal(last.ok, true, 'LRU eviction must not expire a content cursor')
      assert.equal(last.nextCursor, null)
      const hits = [...first.results, ...next.results, ...afterLocate.results, ...last.results]
      assert.deepEqual(hits.map((hit) => hit.index), Array.from({ length: 65 }, (_, i) => i))
      assert.deepEqual((await request(routes, '/dsh-read/api/progress')).payload, progress)
      await writeFile(source, original.replace('passage 1.', 'changed 1.'))
      const oldSearch = (await request(routes, `${url}&revision=${first.revision}`)).payload
      assert.equal(oldSearch.ok, false)
      assert.match(oldSearch.error, /内容已变化/)
      assert.equal((await request(routes, url)).payload.ok, true, 'search may restart with the current version')
      const stale = (await request(routes, `${url}&cursor=${first.nextCursor}`)).payload
      assert.equal(stale.ok, false)
      assert.match(stale.error, /游标/)
    })
  }
})

test('search HTTP validation, parser failures, and no-result responses are explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-search-errors-'))
  try {
    const path = join(directory, 'book.txt')
    await writeFile(path, '书的正文')
    await writeFile(join(directory, 'broken.mobi'), 'invalid')
    const { routes } = mount()
    const url = `/dsh-read/api/search?path=${encodeURIComponent(path)}`
    for (const suffix of ['', '&query=%20', `&query=${'x'.repeat(101)}`, '&query=x&cursor=invalid', '&query=x&limit=no']) {
      const result = await request(routes, url + suffix)
      assert.equal(result.status, 400)
      assert.equal(result.payload.ok, false)
      assert.ok(result.payload.error)
    }
    assert.equal((await request(routes, url + '&query=x', { method: 'POST' })).status, 400)
    for (const file of ['private.bin', 'missing.txt', 'broken.mobi']) {
      const result = await request(routes, `/dsh-read/api/search?path=${encodeURIComponent(join(directory, file))}&query=x`)
      assert.equal(result.payload.ok, false)
    }
    const empty = await request(routes, url + '&query=missing')
    assert.deepEqual(empty.payload.results, [])
    assert.equal(empty.payload.nextCursor, null)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('search HTTP supports zipped and unpacked EPUB, and every allowed text extension', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-read-search-formats-'))
  try {
    const zipped = join(directory, 'book.epub')
    const unpacked = join(directory, 'unpacked.epub')
    await writeFile(zipped, fixtureEpub())
    await writeUnpackedEpub(unpacked)
    const { routes } = mount()
    for (const path of [zipped, unpacked]) {
      const result = await request(routes, `/dsh-read/api/search?path=${encodeURIComponent(path)}&query=${encodeURIComponent('第一章')}`)
      assert.equal(result.status, 200)
      assert.equal(result.payload.results[0].index, 0)
    }
    for (const extension of ['txt', 'md', 'markdown', 'text', 'log']) {
      const path = join(directory, `book.${extension}`)
      await writeFile(path, '\ufeff中文正文 keyword')
      const result = await request(routes, `/dsh-read/api/search?path=${encodeURIComponent(path)}&query=KEYWORD`)
      assert.equal(result.payload.results.length, 1)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
