// Verifies the hand-written browser bundle honours the DSH client module contract:
// one ModuleLoader registration, only `react` requested, the expected plugin
// exports, and the `/read` command lifecycle folding into one Chat node.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const REACT_STUB = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}

function loadBundle(fetchImpl, globals) {
  const registrations = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    document: {
      createElement: () => ({ dataset: {}, remove() {} }),
      head: { append() {} },
    },
    fetch: fetchImpl || (() => Promise.reject(new Error('network disabled in tests'))),
    setTimeout,
    clearTimeout,
    console,
  }
  Object.assign(sandbox, globals || {})
  runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  return registrations
}

/** Load the plugin and run `apply` against a fake client context. */
function mount(react = REACT_STUB, options = {}) {
  const [registration] = loadBundle(options.fetch, options.globals)
  const plugin = registration.factory(() => react)

  const effects = []
  const definitions = []
  const injected = []
  const registered = []

  const ctx = {
    effect: (callback) => {
      effects.push(callback)
      return () => {}
    },
    uiConversation: {
      events: {
        register: (definition) => {
          definitions.push(definition)
          return () => {}
        },
      },
    },
    slots: {
      inject: (key, callback) => injected.push([key, callback]),
      register: (options, component) => registered.push({ options, component }),
    },
  }

  plugin.apply(ctx)

  // effects[0] installs styles, effects[1] registers the Chat node definition,
  // effects[2] adapts the Settings navigation icon.
  const disposers = []
  for (const effect of effects) {
    const dispose = effect()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  for (const [, callback] of injected) callback()

  return { plugin, definitions, registered, disposers }
}

/** Replay one `command/run` + `command/done` pair the way the runtime would.
 *
 * The registry correlates updates to starts by the match `id`, so an update whose
 * id belongs to a different lifecycle is dropped rather than merged — this harness
 * models that explicitly. */
function fold(definitions, runData, doneData) {
  const definition = definitions[0]
  const startMatch = definition.match({ type: 'command/run', data: runData })
  if (startMatch === null) return null

  const startEvent = { seq: 7, location: { kind: 'turn' } }
  const started = { key: runData.commandId, id: startMatch.id, start: { event: startEvent } }
  let context = { ...started, state: definition.start(started, { event: startEvent }) }

  const updateMatch = definition.match({ type: 'command/done', data: doneData })
  if (updateMatch !== null && updateMatch.id === startMatch.id) {
    context = { ...context, state: definition.update(context, { event: { data: doneData } }) }
  }
  return definition.buildViewNode(context)
}

test('client bundle registers exactly one DSH module under its package id', () => {
  const registrations = loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-read')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('every ctx.<service> the browser half touches is declared in inject', () => {
  const { plugin } = mount()
  const declared = new Set(plugin.inject)
  const builtins = new Set(['get', 'inject', 'effect', 'on', 'off', 'provide', 'logger'])

  const accessed = new Set()
  for (const [, name] of SOURCE.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) accessed.add(name)

  for (const name of accessed) {
    if (builtins.has(name)) continue
    assert.ok(declared.has(name), `ctx.${name} is accessed but missing from the plugin's inject`)
  }
})

test('client bundle only requires react from the platform', () => {
  const [registration] = loadBundle()
  const requested = new Set()
  registration.factory((specifier) => {
    requested.add(specifier)
    return REACT_STUB
  })
  assert.deepEqual([...requested], ['react'])
})

test('client plugin declares slots and uiConversation, and mounts the reader surfaces', () => {
  const { plugin, registered } = mount()

  assert.equal(plugin.name, 'dsh-read')
  // Spread first: the bundle's arrays come from the VM realm.
  assert.deepEqual([...plugin.inject], ['slots', 'uiConversation'])

  const node = registered.find((entry) => entry.options.name === 'conversation.chat.node')
  assert.ok(node, 'expected a conversation.chat.node registration')
  assert.equal(node.options.key, 'dsh-read')
  assert.equal(typeof node.component, 'function')

  const commandRow = registered.find(
    (entry) => entry.options.name === 'conversation.chat.commandview',
  )
  assert.ok(commandRow, 'expected a commandview registration to replace the generic row')
  assert.equal(commandRow.options.key, 'read')

  // The reading centre is a Settings page now, not a tab beside 对话/轨迹.
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section, 'expected a settings.section registration for the 阅读中心 page')
  assert.equal(section.options.id, 'dsh-read')
  assert.equal(section.options.label, '阅读中心')
  assert.equal(typeof section.component, 'function')
  assert.equal(
    registered.find((entry) => entry.options.name === 'conversation.view'),
    undefined,
    'the 阅读 tab must be gone from the conversation header',
  )
})

test('the card definition folds a successful /read into a reader node', () => {
  const { definitions } = mount()
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].kind, 'dsh-read')
  assert.equal(definitions[0].target, 'chat')

  const book = {
    path: '/tmp/library/三体.epub',
    name: '三体.epub',
    title: '三体',
    format: 'epub',
    chars: 1200,
    bytes: 4096,
    paragraphCount: 12,
    chapters: [{ title: '第一章', offset: 0, index: 0 }],
  }

  const node = fold(
    definitions,
    { commandId: 'cmd-1', name: 'read', args: '/tmp/library/三体.epub' },
    { commandId: 'cmd-1', kind: 'success', text: JSON.stringify(book) },
  )

  assert.ok(node, 'expected a view node once the command settled')
  assert.equal(node.kind, 'dsh-read')
  assert.equal(node.target, 'chat')
  assert.equal(node.visibility, 'visible')
  assert.equal(node.anchorSeq, 7)
  assert.equal(node.data.book.path, book.path)
  assert.equal(node.data.error, '')
})

test('a failing /read produces an error node instead of a reader', () => {
  const { definitions } = mount()
  const node = fold(
    definitions,
    { commandId: 'cmd-2', name: 'read', args: '/nope.epub' },
    { commandId: 'cmd-2', kind: 'error', text: 'file not found: /nope.epub' },
  )

  assert.ok(node)
  assert.equal(node.data.book, null)
  assert.match(node.data.error, /file not found/)
})

test('unrelated commands are ignored, and an unsettled /read draws nothing', () => {
  const { definitions } = mount()
  const definition = definitions[0]

  assert.equal(
    definition.match({ type: 'command/run', data: { commandId: 'cmd-3', name: 'compact' } }),
    null,
  )

  const pending = fold(
    definitions,
    { commandId: 'cmd-4', name: 'read', args: '/tmp/a.epub' },
    { commandId: 'cmd-999', kind: 'success', text: '{}' },
  )
  assert.equal(pending, null, 'an unresolved lifecycle must not render a card')
})

/* ── the reader card's speed control ─────────────────────────────────────── */

/** A React just big enough to render the card and re-render after a setState. */
function createReact() {
  const slots = []
  const setters = []
  const refs = []
  let cursor = 0

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const slot = cursor
      cursor += 1
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      if (!(slot in setters)) {
        setters[slot] = (next) => {
          slots[slot] = typeof next === 'function' ? next(slots[slot]) : next
        }
      }
      return [slots[slot], setters[slot]]
    },
    // Real refs persist across renders and keep their identity; a fresh object per
    // render would silently hide any behaviour that depends on that.
    useRef: (initial) => {
      const slot = cursor
      cursor += 1
      if (!(slot in refs)) refs[slot] = { current: initial }
      return refs[slot]
    },
    // Effects are deliberately inert: the card's data loading is not under test.
    useEffect: () => {},
  }

  return {
    React,
    // ReaderCard's useState order: 0 stream, 1 index, 2 revealed, 3 playing, 4 speed, 5 status,
    // 6 busy. `setters` is populated by the first render.
    setters,
    render(Component, props) {
      cursor = 0
      return Component(props)
    },
  }
}

/** Every element in a rendered tree, depth first. */
function elements(tree, found = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) elements(child, found)
    return found
  }
  if (!tree || typeof tree !== 'object') return found
  found.push(tree)
  if (tree.children) for (const child of tree.children) elements(child, found)
  return found
}

/** The first element carrying `name` among its classes. */
function withClass(tree, name) {
  return elements(tree).find((element) =>
    String(element.props.className || '')
      .split(/\s+/)
      .includes(name),
  )
}

function labeledButton(tree, label) {
  return elements(tree).find(
    (element) => element.type === 'button' && element.children.includes(label),
  )
}

function slider(tree) {
  return elements(tree).find(
    (element) => element.type === 'input' && element.props.type === 'range',
  )
}

function textOf(tree) {
  const parts = []
  for (const element of elements(tree)) {
    for (const child of element.children) if (typeof child === 'string') parts.push(child)
  }
  return parts.join(' ')
}

const CARD_BOOK = {
  path: '/tmp/library/活着.epub',
  name: '活着.epub',
  title: '活着',
  format: 'epub',
  chars: 1000,
  paragraphCount: 5,
  chapters: [],
}

/** The bundled stylesheet, which is the only place the card's geometry is expressed. */
function stylesheet() {
  const match = /const CSS = `([\s\S]*?)\n`/.exec(SOURCE)
  assert.ok(match, 'the bundle must carry one CSS template')
  return match[1]
}

test('the reader fills the conversation viewport instead of growing with the text', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const tree = react.render(card, { node: { data: { book: CARD_BOOK, error: '' } } })

  // The card is the element that owns the height; a growing card would reflow the whole
  // transcript on every paragraph.
  assert.equal(tree.props['data-fill'], 'true', 'reading card should claim the viewport')

  const css = stylesheet()
  const fill = /\.dshReadCard\[data-fill="true"\]\{([^}]*)\}/.exec(css)
  assert.ok(fill, 'expected a data-fill height rule')
  // DSH publishes both variables from the conversation scroll container, so the card can
  // track a resized window without measuring anything itself.
  assert.match(fill[1], /--dsh-conversation-viewport-height/)
  assert.match(fill[1], /--dsh-composer-height/)
  assert.match(fill[1], /max\(240px,/, 'a very short window still needs a usable card')

  // Only the prose may flex; otherwise the chrome would be squashed into the fixed card.
  assert.match(css, /\.dshReadCard>\*\{flex:none\}/)
  assert.match(css, /\.dshReadStream\{flex:1;min-height:0;overflow:auto/)
  assert.doesNotMatch(css, /\.dshReadStream\{max-height:/, 'the stream must fill, not cap')

  // Ordering is load-bearing: equal specificity means the later flex:1 must win.
  assert.ok(
    css.indexOf('.dshReadCard>*{flex:none}') < css.indexOf('.dshReadStream{flex:1'),
    'the stream rule must come after the blanket flex:none',
  )
})

test('an error card stays compact rather than filling the viewport with one line', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const tree = react.render(card, {
    node: { data: { book: null, error: 'file not found: /nope.epub' } },
  })

  assert.equal(tree.props['data-fill'], undefined)
  assert.match(textOf(tree), /file not found/)
})

test('speed is picked by preset, and the slider exists only in 自定义 mode', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const props = { node: { data: { book: CARD_BOOK, error: '' } } }

  let tree = react.render(card, props)

  for (const label of ['慢', '中', '快', '自定义']) {
    assert.ok(labeledButton(tree, label), `expected a 速度「${label}」button`)
  }
  assert.equal(slider(tree), undefined, '预设模式不应该出现拖放条')
  assert.equal(labeledButton(tree, '中').props['data-active'], 'true')
  // The readout must be the rate the typewriter actually runs at — 中 is a decade, not a fib.
  assert.match(textOf(tree), /20 字\/秒/)
  assert.equal(labeledButton(tree, '中').props.title, '中 · 20 字/秒')

  // Entering 自定义 reveals the slider, seeded with the speed already in effect.
  labeledButton(tree, '自定义').props.onClick()
  tree = react.render(card, props)
  assert.ok(slider(tree), '自定义模式应该出现拖放条')
  assert.equal(slider(tree).props.value, '20')
  // The slider's grid is the engine's grid: min 10 and step 10, so every value stays truthful.
  assert.equal(slider(tree).props.min, '10')
  assert.equal(slider(tree).props.step, '10')
  assert.equal(labeledButton(tree, '自定义').props['data-active'], 'true')

  // Dragging it moves the speed, and an out-of-range drag is clamped.
  slider(tree).props.onChange({ target: { value: '80' } })
  tree = react.render(card, props)
  assert.equal(slider(tree).props.value, '80')

  slider(tree).props.onChange({ target: { value: '500' } })
  tree = react.render(card, props)
  assert.equal(slider(tree).props.value, '160')

  slider(tree).props.onChange({ target: { value: '3' } })
  tree = react.render(card, props)
  assert.equal(slider(tree).props.value, '10')

  // A preset takes over again and puts the slider away.
  labeledButton(tree, '快').props.onClick()
  tree = react.render(card, props)
  assert.equal(slider(tree), undefined)
  assert.equal(labeledButton(tree, '快').props['data-active'], 'true')
  assert.match(textOf(tree), /60 字\/秒/)
})

const CHAPTERED_BOOK = {
  ...CARD_BOOK,
  chapters: [{ title: '第一章', offset: 0, index: 0 }],
}

test('the whole card chrome folds away until the pointer or keyboard enters', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const tree = react.render(card, { node: { data: { book: CHAPTERED_BOOK, error: '' } } })

  // Header, control bar and chapter footer are each one collapsible row.
  for (const name of ['dshReadHead', 'dshReadControls', 'dshReadChapter']) {
    const fold = withClass(tree, name)
    assert.ok(fold, `expected ${name} on the card`)
    assert.ok(
      String(fold.props.className).split(/\s+/).includes('dshReadFold'),
      `${name} must take part in the fold`,
    )
    const inner = elements(fold.children)[0]
    assert.ok(inner && inner.type === 'div', `${name} needs one inner row to collapse`)
  }
  assert.ok(
    elements(withClass(tree, 'dshReadControlsInner').children).some(
      (element) => element.type === 'button',
    ),
    'the buttons belong inside the collapsible row',
  )
  // The thin progress line stays: it is the one piece of ambient chrome worth keeping.
  assert.ok(withClass(tree, 'dshReadBar'), 'the progress line stays visible')

  // With no hover and no focus the rows fold to nothing and stop taking clicks.
  assert.match(
    SOURCE,
    /@media \(hover:hover\)\{\.dshReadCard:not\(:hover\):not\(:focus-within\) \.dshReadFold\{grid-template-rows:0fr;opacity:0/,
  )
  assert.match(
    SOURCE,
    /\.dshReadCard:not\(:hover\):not\(:focus-within\) \.dshReadFold\{[^}]*pointer-events:none/,
  )
  // Keyboard focus inside the card keeps the chrome reachable.
  assert.match(SOURCE, /:focus-within/)
  // Scoped to hover-capable pointers, so a touch screen can never lose its controls.
  assert.ok(!/@media \(hover:none\)/.test(SOURCE), 'hover:none needs no override any more')
})

test('a paragraph paused mid-reveal keeps a steady caret', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const props = { node: { data: { book: CARD_BOOK, error: '' } } }

  react.render(card, props)
  const [setStream, , setRevealed, setPlaying] = react.setters

  setStream({ from: 0, items: [{ text: '港口的雾还没散', offset: 0 }] })
  setRevealed(3)
  setPlaying(false)

  let tree = react.render(card, props)
  const caret = withClass(tree, 'dshReadCaret')
  assert.ok(caret, 'a half-revealed paragraph must show where reading stopped')
  assert.equal(caret.props['data-playing'], 'false', 'paused holds the caret still')
  assert.equal(
    elements(tree).find((element) => element.props['data-active'] === 'true').children[0],
    '港口的',
  )

  // Playing blinks; a fully revealed paragraph needs no caret at all.
  setPlaying(true)
  tree = react.render(card, props)
  assert.equal(withClass(tree, 'dshReadCaret').props['data-playing'], 'true')

  setRevealed('港口的雾还没散'.length)
  tree = react.render(card, props)
  assert.equal(withClass(tree, 'dshReadCaret'), undefined)
})

test('the progress bar does not flash to 100% before the first window loads', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const tree = react.render(card, { node: { data: { book: CARD_BOOK, error: '' } } })

  // No paragraph offset is known yet; falling back to the book length claimed "finished".
  assert.match(textOf(tree), /0\.0%/)
  assert.doesNotMatch(textOf(tree), /100\.0%/)
})

/* ── the 阅读 settings page ──────────────────────────────────────────────── */

/** Mount the plugin and hand back the 阅读 settings page with its owner + standard props. */
function settingsPage({ fetch: fetchImpl, session, onClose = () => {} } = {}) {
  const react = createReact()
  const { registered } = mount(react.React, { fetch: fetchImpl })
  const section = registered.find((entry) => entry.options.name === 'settings.section').component
  const props = {
    close: onClose,
    // The shell's standard feed for this slot; `current` is the selected session.
    useSessions: (selector) => selector({ current: session, byId: {} }),
  }
  return { react, section, props }
}

/** The listing effect is inert in the harness, so seed the book rows directly (slot 4 = books). */
function seedBooks(react, section, props) {
  react.render(section, props)
  react.setters[4]([
    { path: '/books/活着.epub', name: '活着.epub', extension: 'epub', size: 1024, progress: null },
  ])
  return react.render(section, props)
}

/** The directory field, which the harness identifies by its placeholder. */
function directoryField(tree) {
  return elements(tree).find(
    (element) => element.type === 'input' && element.props.className === 'dshReadLibInput',
  )
}

test('重新打开设置页时，输入框回填已记住的目录，而不是留空', async () => {
  const { react, section, props } = settingsPage({
    fetch: async () => ({
      status: 200,
      json: async () => ({
        ok: true,
        dir: '/Users/me/Books',
        parent: '/Users/me',
        directories: [],
        books: [],
      }),
    }),
  })

  // First paint: the listing has not landed yet, so the field is still empty.
  assert.equal(directoryField(react.render(section, props)).props.value, '')

  // Clicking 加载 is how the harness drives the otherwise-inert listing effect.
  await labeledButton(react.render(section, props), '加载').props.onClick()

  // The regression this guards: the remembered directory must settle into the field,
  // otherwise reopening the page looks like the choice was lost.
  assert.equal(directoryField(react.render(section, props)).props.value, '/Users/me/Books')
})

test('回填不会覆盖用户正在输入的目录', async () => {
  // A listing that is still in flight while the user starts typing.
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const { react, section, props } = settingsPage({
    fetch: async () => {
      await pending
      return {
        status: 200,
        json: async () => ({
          ok: true,
          dir: '/Users/me/Books',
          parent: '/Users/me',
          directories: [],
          books: [],
        }),
      }
    },
  })

  let tree = react.render(section, props)
  const inflight = labeledButton(tree, '加载').props.onClick()

  // The user types while that request is still open.
  directoryField(tree).props.onChange({ target: { value: '/Volumes/library' } })
  tree = react.render(section, props)
  assert.equal(directoryField(tree).props.value, '/Volumes/library')

  release()
  await inflight
  tree = react.render(section, props)

  // The late reply must not clobber what the user typed.
  assert.equal(directoryField(tree).props.value, '/Volumes/library')
})

test('设置进度：滑杆保存的是拖到的段落，而不是原地不动', async () => {
  const calls = []
  const { react, section, props } = settingsPage({
    session: 'session-9',
    fetch: async (url, options) => {
      calls.push({ url, options })
      return {
        status: 200,
        json: async () => ({
          ok: true,
          dir: '/books',
          parent: '/',
          directories: [],
          books: [
            {
              path: '/books/活着.epub',
              name: '活着.epub',
              extension: 'epub',
              size: 1024,
              // Half-read, so the scrubber has a paragraph count to work from.
              progress: { index: 100, paragraphCount: 2083, chars: 96487, percent: 4.8, at: 1 },
            },
          ],
        }),
      }
    },
  })

  let tree = react.render(section, props)
  await labeledButton(tree, '加载').props.onClick()
  tree = react.render(section, props)

  await labeledButton(tree, '设置进度').props.onClick()
  tree = react.render(section, props)

  const slider = elements(tree).find(
    (element) => element.props.className === 'dshReadLibEditorSlider',
  )
  assert.ok(slider, '设置进度 应该展开一个滑杆')
  assert.equal(slider.props.max, '2083', '滑杆上界是这本书的段落总数')
  assert.equal(slider.props.value, '100', '滑杆从当前进度起步')

  slider.props.onChange({ target: { value: '900' } })
  tree = react.render(section, props)
  assert.match(textOf(tree), /第 901 \/ 2083 段/)

  const before = calls.length
  await labeledButton(tree, '保存').props.onClick()

  const saved = calls.slice(before).find((call) => call.url === '/dsh-read/api/progress')
  assert.ok(saved, '保存应该写入进度')
  assert.deepEqual(JSON.parse(saved.options.body), {
    path: '/books/活着.epub',
    name: '活着.epub',
    index: 900,
    chars: 96487,
  })
})

test('设置进度：从未读过的书先去问 host 要段落总数', async () => {
  const calls = []
  const { react, section, props } = settingsPage({
    fetch: async (url) => {
      calls.push(url)
      if (url.startsWith('/dsh-read/api/open')) {
        return {
          status: 200,
          json: async () => ({ ok: true, book: { path: '/books/新书.epub', paragraphCount: 500 } }),
        }
      }
      return { status: 200, json: async () => ({ ok: true }) }
    },
  })

  // No saved progress: exactly the "already read it on paper" case.
  let tree = seedBooks(react, section, props)
  await labeledButton(tree, '设置进度').props.onClick()
  tree = react.render(section, props)

  assert.ok(
    calls.some((url) => url.startsWith('/dsh-read/api/open')),
    '没有进度记录的书必须先去解析段落总数',
  )
  const slider = elements(tree).find(
    (element) => element.props.className === 'dshReadLibEditorSlider',
  )
  assert.equal(slider.props.max, '500')
  assert.equal(slider.props.value, '0', '新书从第 1 段起步')
})

test('「阅读」设置页把书交给当前会话，然后退出设置', async () => {
  const calls = []
  let closed = 0
  const { react, section, props } = settingsPage({
    session: 'session-9',
    fetch: async (url, options) => {
      calls.push({ url, options })
      return { status: 200, json: async () => ({ ok: true }) }
    },
    onClose: () => {
      closed += 1
    },
  })

  await labeledButton(seedBooks(react, section, props), '开始阅读').props.onClick()

  assert.equal(calls.length, 1, '开始阅读 只应该发一个请求')
  assert.equal(calls[0].url, '/dsh-read/api/start')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: 'session-9',
    path: '/books/活着.epub',
  })
  assert.equal(closed, 1, '开始阅读 之后要退出设置，让用户看到对话里的卡片')
})

test('没有当前会话时，「阅读」设置页给出提示而不是静默失败', async () => {
  const calls = []
  const { react, section, props } = settingsPage({
    // No `session`: the shell has no selected session.
    fetch: async (url, options) => {
      calls.push({ url, options })
      return { status: 200, json: async () => ({ ok: true }) }
    },
  })

  await labeledButton(seedBooks(react, section, props), '开始阅读').props.onClick()

  assert.equal(calls.length, 0, '没有会话就不该发请求')
  assert.match(textOf(react.render(section, props)), /没有打开的会话/)
})

/* ── the Settings navigation icon ────────────────────────────────────────── */

/** One fake settings-nav row, as far as the adaptation touches it. */
function fakeNavRow(text) {
  return {
    textContent: text,
    attributes: {},
    setAttribute(name) {
      this.attributes[name] = ''
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
  }
}

test('设置导航给「阅读中心」换成书本图标，退出时把行还给外壳', () => {
  const MARKER = 'data-dsh-read-settings-nav'
  // Real rows carry the label with whatever whitespace the shell renders around it.
  const rows = [fakeNavRow('常规'), fakeNavRow('  阅读中心  '), fakeNavRow('模型')]
  const observers = []

  class FakeObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observers.push(this)
    }
    observe() {}
    disconnect() {
      this.disconnected = true
    }
  }

  const { disposers } = mount(REACT_STUB, {
    globals: {
      document: {
        body: {},
        createElement: () => ({ dataset: {}, remove() {} }),
        head: { append() {} },
        querySelectorAll: (selector) =>
          selector === '[role="dialog"] nav button'
            ? rows
            : rows.filter((row) => MARKER in row.attributes),
      },
      MutationObserver: FakeObserver,
    },
  })

  // Only our row is tagged, and the label is matched after trimming.
  assert.equal(MARKER in rows[1].attributes, true, 'expected our nav row to be marked')
  assert.equal(MARKER in rows[0].attributes, false, 'another section must not be touched')
  assert.equal(MARKER in rows[2].attributes, false)
  assert.equal(observers.length, 1, 'the nav re-renders, so the row must be observed')

  // The stylesheet hides whatever the shell drew and paints the book in its place.
  assert.match(SOURCE, /\[data-dsh-read-settings-nav\] > svg\{display:none\}/)
  assert.match(
    SOURCE,
    /\[data-dsh-read-settings-nav\]::before\{content:'';flex:none;width:16px;height:16px;background:currentColor/,
  )

  for (const dispose of disposers) dispose()
  assert.equal(MARKER in rows[1].attributes, false, 'disposal must give the shell its row back')
  assert.equal(observers[0].disconnected, true, 'disposal must stop the observer')
})

test('没有 DOM 可改时，导航图标适配安静跳过', () => {
  // The default sandbox has neither querySelectorAll nor MutationObserver.
  assert.doesNotThrow(() => mount())
})
