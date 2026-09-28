// Exercises the host half against a fake cordis context: the `/read` command's
// resolution and safety rules, the reader HTTP surface it feeds, and progress
// persistence. Fixtures are real EPUB files built in memory by the ZIP writer below.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

function mount({ agent, agents } = {}) {
  const routes = new Map()
  const commands = new Map()
  const executed = []
  const injected = []
  // `agents` is the live registry; a bare `agent` is the one-entry shorthand.
  const live = agents ?? (agent ? [agent] : [])

  const ctx = {
    inject: (dependencies, callback) => {
      injected.push(dependencies)
      callback({
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
  assert.deepEqual(injected, [['webServer']])
  assert.deepEqual([...routes.keys()].sort(), [
    '/dsh-read/api/image',
    '/dsh-read/api/library',
    '/dsh-read/api/open',
    '/dsh-read/api/paragraphs',
    '/dsh-read/api/progress',
    '/dsh-read/api/start',
  ])
  assert.ok(commands.has('read'))
  // The typed argument must reach the durable log for the client card to fold.
  assert.notEqual(commands.get('read').recordInput, false)
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
