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
    AbortController,
    console,
  }
  Object.assign(sandbox, globals || {})
  if (globals?.window) sandbox.window.__ModuleLoader__ = { load: (entry) => registrations.push(entry) }
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
    get: (name) => options.services?.[name],
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
  // The settings navigation icon is registered through its own slot.
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
  const effects = []
  let cursor = 0
  let effectCursor = 0

  const React = {
    // Function components render eagerly, the way React does. Without this a wrapper
    // component would come back as an opaque element and every assertion about the tree
    // would silently be about the wrapper instead of the UI.
    createElement: (type, props, ...children) => {
      const resolved = props || {}
      if (typeof type === 'function') return type({ ...resolved, children })
      return { type, props: resolved, children }
    },
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
    // Effects remain inert unless a test explicitly runs one, keeping playback timers out.
    useEffect: (callback, deps) => {
      const at = effectCursor++
      const previous = effects[at]
      if (!previous || !deps || deps.some((value, index) => value !== previous.deps?.[index])) {
        effects[at] = { callback, deps, cleanup: previous?.cleanup, pending: true }
      }
    },
  }

  return {
    React,
    // ReaderCard's useState order: 0 stream, 1 index, 2 revealed, 3 playing, 4 speed, 5 status,
    // 6 busy. `setters` is populated by the first render.
    setters,
    runEffect(index) {
      effects[index].pending = false
      effects[index].cleanup?.()
      effects[index].cleanup = effects[index].callback()
    },
    commit() {
      effects.forEach((effect, i) => { if (effect.pending) this.runEffect(i) })
    },
    unmount() {
      for (const effect of effects) effect.cleanup?.()
    },
    render(Component, props) {
      cursor = 0
      effectCursor = 0
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
  // Property presence rather than an exact prefix: the rule also anchors the ask bubble.
  const stream = /\.dshReadStream\{([^}]*)\}/.exec(css)
  assert.ok(stream, 'expected a .dshReadStream rule')
  assert.match(stream[1], /flex:1/)
  assert.match(stream[1], /min-height:0/)
  assert.match(stream[1], /overflow:auto/)
  assert.doesNotMatch(stream[1], /max-height:/, 'the stream must fill, not cap')

  // Ordering is load-bearing: equal specificity means the later flex:1 must win.
  assert.ok(
    css.indexOf('.dshReadCard>*{flex:none}') < css.indexOf('.dshReadStream{'),
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

/** A keyboard event as React would hand it to the card's handler. */
function keyEvent(key, { target = {}, ...modifiers } = {}) {
  return {
    key,
    target: { tagName: 'DIV', ...target },
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...modifiers,
  }
}

/** Build the contiguous run shape the card keeps in state. */
function run(from, count) {
  return {
    from,
    items: Array.from({ length: count }, (_, at) => ({ text: `p${from + at}`, offset: from + at })),
  }
}

/** The plugin object, so pure helpers can be exercised directly. */
function pluginExports() {
  const [registration] = loadBundle()
  return registration.factory(() => REACT_STUB)
}

test('scrolling back reaches earlier paragraphs instead of losing them', () => {
  const { mergeWindow } = pluginExports()

  // A forward page extends the run; it must not replace it, which is what used to make
  // everything already read vanish as soon as the next page arrived.
  let current = run(0, 60)
  current = mergeWindow(current, run(60, 60), 'append')
  assert.equal(current.from, 0)
  assert.equal(current.items.length, 120, 'the earlier paragraphs must still be there')
  assert.equal(current.items[0].text, 'p0')
  assert.equal(current.items[119].text, 'p119')

  // A backward page grows the run the other way and moves the origin down.
  current = mergeWindow(current, run(0, 0), 'prepend') // non-adjacent: ignored
  assert.equal(current.items.length, 120, 'a non-adjacent prepend must not merge')

  const back = mergeWindow(run(60, 60), run(0, 60), 'prepend')
  assert.equal(back.from, 0)
  assert.equal(back.items.length, 120)
  assert.equal(back.items[0].text, 'p0')
  assert.equal(back.items[60].text, 'p60')

  // Repeated appends keep growing rather than resetting.
  let grown = run(0, 60)
  for (const from of [60, 120, 180]) grown = mergeWindow(grown, run(from, 60), 'append')
  assert.equal(grown.from, 0)
  assert.equal(grown.items.length, 240)
})

test('the card renders the whole loaded run, not a fixed slice behind the cursor', () => {
  // The harness cannot drive the async load path, so this asserts the one line that decides
  // how much of the loaded run reaches the DOM. A fixed `local - N` slice would clip history
  // even once the run itself is complete, which is exactly the reported symptom.
  const start = SOURCE.indexOf('const blocks = []')
  assert.ok(start > 0, 'expected the block render loop')
  const loop = SOURCE.slice(start, start + 200)
  assert.match(loop, /for \(let at = 0; at <= local; at \+= 1\)/, 'must start at the run origin')
  assert.doesNotMatch(loop, /local - \d+/, 'must not clip a fixed window behind the cursor')
})

test('a jump starts a fresh run rather than splicing unrelated paragraphs', () => {
  const { mergeWindow } = pluginExports()

  // A chapter jump lands far away: merging would invent a run that never existed.
  const jumped = mergeWindow(run(0, 60), run(900, 60), 'append')
  assert.equal(jumped.from, 900)
  assert.equal(jumped.items.length, 60)
  assert.equal(jumped.items[0].text, 'p900')

  // A gap must not be papered over even when the direction says "append".
  const gapped = mergeWindow(run(0, 60), run(200, 60), 'append')
  assert.equal(gapped.from, 200)
  assert.equal(gapped.items.length, 60)

  // The very first load has nothing to merge with.
  const first = mergeWindow({ from: 0, items: [] }, run(120, 60), 'append')
  assert.equal(first.from, 120)
  assert.equal(first.items.length, 60)
})

/** A minimal DOM-ish selection, as window.getSelection() would report it. */
function fakeSelection(text, paragraph, { spansParagraphs = false, inProse = true } = {}) {
  const block = {
    getAttribute: (name) => (name === 'data-paragraph' ? String(paragraph) : null),
    // A quote that starts in one paragraph and ends in another cannot be attributed.
    contains: () => !spansParagraphs,
  }
  const host = {
    closest: (selector) => (inProse && selector === '[data-paragraph]' ? block : null),
    nodeType: 1,
  }
  const range = {
    startContainer: host,
    endContainer: host,
    getBoundingClientRect: () => ({ top: 10, bottom: 30, left: 40, right: 120 }),
  }
  return {
    isCollapsed: text.length === 0,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges() {
      this.cleared = true
    },
  }
}

/** Render the card with a window stub whose selection we control. */
function cardWithSelection(text, paragraph, options) {
  const selection = fakeSelection(text, paragraph, options)
  const react = createReact()
  // `globals` replaces a whole sandbox key, and `loadBundle` owns `window` for the
  // ModuleLoader stub — so the selection is hung off `globalThis` instead, which the bundle
  // reaches through the sandbox's own global object.
  const { registered } = mount(react.React, { globals: { __dshReadSelection: selection } })
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  return { react, card, selection }
}

test('a selection inside a paragraph offers to ask, and lands in the composer', () => {
  const drafts = []
  const { react, card } = cardWithSelection('\u6211\u6bd4\u73b0\u5728\u5e74\u8f7b\u5341\u5c81', 121)
  const props = {
    node: { data: { book: CARD_BOOK, error: '' } },
    inputActions: { setDraft: (text) => drafts.push(text) },
  }

  // The harness's effects are inert, so the loaded window is seeded directly: ReaderBody's
  // slot 0 is `stream`.
  let tree = react.render(card, props)
  react.setters[0]({
    from: 120,
    items: [
      { text: '\u524d\u4e00\u6bb5', offset: 120 },
      { text: '\u6211\u6bd4\u73b0\u5728\u5e74\u8f7b\u5341\u5c81', offset: 124 },
    ],
  })
  react.setters[1](121)
  react.setters[2](999)
  tree = react.render(card, props)

  // The paragraph must carry the anchor a selection resolves against.
  const block = elements(tree).find((element) => element.props['data-paragraph'] === '121')
  assert.ok(block, 'paragraphs need a data-paragraph anchor')
  assert.equal(block.props['data-noted'], 'false')

  // Simulate the reader releasing the mouse over a selected passage.
  const stream = elements(tree).find((element) =>
    String(element.props.className || '').includes('dshReadStream'),
  )
  stream.props.onMouseUp()
  tree = react.render(card, props)

  const askButton = labeledButton(tree, '问 AI')
  assert.ok(askButton, 'a selection should offer 问 AI')

  askButton.props.onClick()
  assert.equal(drafts.length, 1, 'asking must hand the question to the composer')
  assert.match(drafts[0], /活着/, 'the draft should name the book')
  assert.match(drafts[0], /第 122 段/, 'and the position, one-based')
  assert.match(drafts[0], /\u6211\u6bd4\u73b0\u5728\u5e74\u8f7b\u5341\u5c81/, 'and quote the passage')
  // It must not send: the reader decides when to submit.
  assert.equal(drafts[0].endsWith('\n\n'), true, 'leave the caret on a fresh line for a follow-up')
})

test('a collapsed selection, or one outside the prose, offers nothing', () => {
  const { react, card } = cardWithSelection('', 0)
  const props = { node: { data: { book: CARD_BOOK, error: '' } }, inputActions: {} }
  let tree = react.render(card, props)
  const stream = elements(tree).find((element) =>
    String(element.props.className || '').includes('dshReadStream'),
  )
  stream.props.onMouseUp()
  tree = react.render(card, props)
  assert.equal(labeledButton(tree, '问 AI'), undefined, 'an empty selection is not a question')
})

/** Render the card with a seeded window, then fire the selection handler. */
function renderWithSelection(text, paragraph, options) {
  const { react, card, selection } = cardWithSelection(text, paragraph, options)
  const props = { node: { data: { book: CARD_BOOK, error: '' } }, inputActions: {} }
  let tree = react.render(card, props)
  react.setters[0]({
    from: 120,
    items: [
      { text: '\u524d\u4e00\u6bb5', offset: 120 },
      { text: '\u6211\u6bd4\u73b0\u5728\u5e74\u8f7b\u5341\u5c81', offset: 124 },
    ],
  })
  react.setters[1](121)
  react.setters[2](999)
  tree = react.render(card, props)
  const stream = elements(tree).find((element) =>
    String(element.props.className || '').includes('dshReadStream'),
  )
  stream.props.onMouseUp()
  return { react, card, props, selection, tree: react.render(card, props) }
}

test('a quote spanning two paragraphs is not offered, since it has no single home', () => {
  const { tree } = renderWithSelection('crossing a boundary', 121, { spansParagraphs: true })
  assert.equal(
    labeledButton(tree, '问 AI'),
    undefined,
    'a selection with no single paragraph cannot be attributed, so it must not be offered',
  )
})

test('a selection outside the prose offers nothing', () => {
  const { tree } = renderWithSelection('somewhere else', 121, { inProse: false })
  assert.equal(labeledButton(tree, '问 AI'), undefined)
})

test('a whitespace-only selection is not a question', () => {
  const { tree } = renderWithSelection('   \n  ', 121)
  assert.equal(labeledButton(tree, '问 AI'), undefined, 'whitespace is not a passage')
})

test('asking without a session input facade must not throw', () => {
  // A container may mount the reader with no composer to talk to.
  const { react, card } = cardWithSelection('some passage', 7)
  const props = { node: { data: { book: CARD_BOOK, error: '' } }, inputActions: undefined }
  let tree = react.render(card, props)
  const stream = elements(tree).find((element) =>
    String(element.props.className || '').includes('dshReadStream'),
  )
  stream.props.onMouseUp()
  tree = react.render(card, props)
  assert.doesNotThrow(() => labeledButton(tree, '问 AI').props.onClick())
})

test('space toggles playback, and is advertised on the card', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  let tree = view.render()
  // The card must be reachable by keyboard, or the shortcut could never fire.
  assert.equal(tree.props.tabIndex, 0)
  assert.equal(typeof tree.props.onKeyDown, 'function')
  assert.match(textOf(tree), /空格 暂停\/继续/, 'the shortcut has to be discoverable')

  const labelNow = () => (labeledButton(tree, '暂停') !== undefined ? '暂停' : '播放')
  const before = labelNow()

  let event = keyEvent(' ')
  tree.props.onKeyDown(event)
  tree = view.render()
  assert.equal(event.defaultPrevented, true, 'space must not scroll the transcript')
  assert.notEqual(labelNow(), before, 'space should have toggled playback')

  // And pressing again returns to where it was.
  event = keyEvent(' ')
  tree.props.onKeyDown(event)
  tree = view.render()
  assert.equal(labelNow(), before, 'space should toggle back')
})

test('space is ignored when a control or the composer owns the keystroke', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const props = { node: { data: { book: CARD_BOOK, error: '' } } }

  let tree = react.render(card, props)
  const playingBefore = labeledButton(tree, '暂停') !== undefined

  // A keystroke aimed at a form control belongs to that control: the composer sits in the
  // same document, so swallowing its spaces would break typing.
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
    const event = keyEvent(' ', { target: { tagName } })
    tree.props.onKeyDown(event)
    assert.equal(event.defaultPrevented, false, `space aimed at <${tagName}> must pass through`)
  }
  const editable = keyEvent(' ', { target: { tagName: 'DIV', isContentEditable: true } })
  tree.props.onKeyDown(editable)
  assert.equal(editable.defaultPrevented, false, 'a contenteditable must keep its spaces')

  // Modified combinations belong to the browser and the OS.
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    const event = keyEvent(' ', { [modifier]: true })
    tree.props.onKeyDown(event)
    assert.equal(event.defaultPrevented, false, `space with ${modifier} must pass through`)
  }

  // Other keys are none of our business.
  const letter = keyEvent('a')
  tree.props.onKeyDown(letter)
  assert.equal(letter.defaultPrevented, false)

  tree = react.render(card, props)
  assert.equal(
    labeledButton(tree, '暂停') !== undefined,
    playingBefore,
    'none of those keystrokes may have toggled playback',
  )
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

/* ── reading typography ─────────────────────────────────────────────────── */

const TYPOGRAPHY_KEY = 'dsh-read:typography'

function typographyField(tree, label) {
  const control = elements(tree).find((element) => element.props['aria-label'] === label)
  assert.ok(control, `expected ${label} control`)
  return control
}

function proseStyle(tree) {
  return { ...withClass(tree, 'dshReadStream').props.style }
}

const DEFAULT_PROSE_STYLE = {
  '--dsh-read-font-size': '14.5px',
  '--dsh-read-line-height': '1.95',
  '--dsh-read-text-width': 'none',
}

function changeTypography(view, label, value) {
  typographyField(view.render(), label).props.onChange({ target: { value: String(value) } })
  return view.render()
}

function openTypography(view) {
  labeledButton(view.render(), '排版').props.onClick()
  return view.render()
}

test('排版默认收起，原生控件独立预览并立即保存，重新加载和重新打开后恢复', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  assert.equal(labeledButton(view.render(), '排版').props['aria-expanded'], false)
  assert.equal(withClass(view.render(), 'dshReadTypography'), undefined)
  assert.deepEqual(proseStyle(view.render()), DEFAULT_PROSE_STYLE)

  let tree = openTypography(view)
  assert.equal(labeledButton(tree, '排版').props['aria-expanded'], true)
  assert.equal(typographyField(tree, '字号').props.type, 'range')
  assert.equal(typographyField(tree, '字号').props.step, '0.5')
  assert.equal(typographyField(tree, '行距').props.type, 'range')
  assert.equal(typographyField(tree, '行距').props.step, '0.05')
  assert.equal(typographyField(tree, '正文宽度').type, 'select')

  tree = changeTypography(view, '字号', 22)
  assert.deepEqual(proseStyle(tree), { ...DEFAULT_PROSE_STYLE, '--dsh-read-font-size': '22px' })
  tree = changeTypography(view, '行距', 2.2)
  assert.deepEqual(proseStyle(tree), {
    ...DEFAULT_PROSE_STYLE, '--dsh-read-font-size': '22px', '--dsh-read-line-height': '2.2',
  })
  tree = changeTypography(view, '正文宽度', 720)
  assert.equal(proseStyle(tree)['--dsh-read-text-width'], '720px')
  assert.deepEqual(JSON.parse(view.values.get(TYPOGRAPHY_KEY)), { version: 1, fontSize: 22, lineHeight: 2.2, width: 720 })
  assert.deepEqual(elements(tree).filter((el) => el.props.style?.['--dsh-read-font-size']).map((el) => el.props.className),
    ['dshReadStream'], 'only the prose surface receives typography variables')

  labeledButton(tree, '排版').props.onClick()
  assert.equal(withClass(view.render(), 'dshReadTypography'), undefined)
  assert.equal(proseStyle(view.render())['--dsh-read-font-size'], '22px')
  const reopened = playbackFixture(t, [...view.values])
  await reopened.open()
  assert.deepEqual(proseStyle(reopened.render()), proseStyle(view.render()))
  await view.remount()
  assert.deepEqual(proseStyle(view.render()), proseStyle(reopened.render()))
})

test('恢复默认只重置排版，持久化结果在重新加载后仍为初始排版', async (t) => {
  const view = playbackFixture(t, [
    ['dsh-read:speed', JSON.stringify({ mode: 'fast', speed: 60 })],
    ['dsh-read:auto-pause', 'false'],
    [TYPOGRAPHY_KEY, JSON.stringify({ version: 1, fontSize: 28, lineHeight: 2.4, width: 900 })],
  ])
  await view.open()
  openTypography(view)
  labeledButton(view.render(), '恢复默认').props.onClick()
  assert.deepEqual(proseStyle(view.render()), DEFAULT_PROSE_STYLE)
  assert.equal(view.values.get('dsh-read:speed'), JSON.stringify({ mode: 'fast', speed: 60 }))
  assert.equal(view.values.get('dsh-read:auto-pause'), 'false')
  const reopened = playbackFixture(t, [...view.values])
  await reopened.open()
  assert.deepEqual(proseStyle(reopened.render()), DEFAULT_PROSE_STYLE)
})

for (const [label, stored, expected] of [
  ['破损 JSON', '{oops', DEFAULT_PROSE_STYLE],
  ['空值', 'null', DEFAULT_PROSE_STYLE],
  ['数组', '[]', DEFAULT_PROSE_STYLE],
  ['原始值', '42', DEFAULT_PROSE_STYLE],
  ['未知版本', '{"version":2,"fontSize":20,"width":720}', DEFAULT_PROSE_STYLE],
  ['旧版部分字段', '{"fontSize":18}', { ...DEFAULT_PROSE_STYLE, '--dsh-read-font-size': '18px' }],
  ['非法字段独立回退', '{"version":1,"fontSize":"24","lineHeight":2.1,"width":"900"}',
    { ...DEFAULT_PROSE_STYLE, '--dsh-read-line-height': '2.1' }],
  ['限制范围和步长', '{"version":1,"fontSize":99,"lineHeight":1.421,"width":560}',
    { '--dsh-read-font-size': '28px', '--dsh-read-line-height': '1.4', '--dsh-read-text-width': '560px' }],
  ['下限和未知宽度', '{"fontSize":-20,"lineHeight":8,"width":123}',
    { ...DEFAULT_PROSE_STYLE, '--dsh-read-font-size': '12px', '--dsh-read-line-height': '2.4' }],
  ['非有限值', '{"fontSize":1e999,"lineHeight":null,"width":-1}', DEFAULT_PROSE_STYLE],
]) {
  test(`排版偏好容错：${label}`, (t) => {
    const view = playbackFixture(t, [[TYPOGRAPHY_KEY, stored]])
    assert.deepEqual(proseStyle(view.render()), expected)
  })
}

test('排版在同页阅读卡片间同步，卸载后取消订阅，存储读写失败保留内存偏好', async (t) => {
  let owner
  const react = Object.fromEntries(Object.keys(createReact().React).map((name) =>
    [name, (...args) => owner.React[name](...args)]))
  const { registered } = mount(react, {
    globals: { localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('quota') } },
      setTimeout: () => 0, clearTimeout() {} },
    fetch: async () => response({ ok: true, progress: {}, notes: [], from: 0, items: [] }),
  })
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  function reader(path, sessionId) {
    const hooks = createReact()
    const props = { sessionId, node: { id: path, data: { book: { ...CARD_BOOK, path } } } }
    const view = { render() {
      owner = hooks
      const tree = hooks.render(card, props)
      hooks.commit()
      return tree
    }, unmount() { hooks.unmount() } }
    t.after(() => hooks.unmount())
    return view
  }
  const first = reader('/books/first.txt', 'one')
  const second = reader('/books/second.txt', 'two')
  first.render(); second.render()
  openTypography(first)
  changeTypography(first, '字号', 24)
  changeTypography(first, '正文宽度', 560)
  assert.equal(proseStyle(second.render())['--dsh-read-font-size'], '24px')
  assert.equal(proseStyle(second.render())['--dsh-read-text-width'], '560px')
  openTypography(second)
  changeTypography(second, '行距', 2.1)
  assert.deepEqual(proseStyle(first.render()), {
    '--dsh-read-font-size': '24px', '--dsh-read-line-height': '2.1', '--dsh-read-text-width': '560px',
  }, 'a second card changes one field without losing the first card’s choices')
  const third = reader('/books/third.txt', 'three')
  assert.deepEqual(proseStyle(third.render()), proseStyle(first.render()))
  second.unmount()
  labeledButton(first.render(), '恢复默认').props.onClick()
  assert.deepEqual(proseStyle(third.render()), DEFAULT_PROSE_STYLE)
  await flush()
})

for (const state of ['playing', 'paused', 'auto-paused', 'finished']) {
  test(`排版调整和恢复默认保持正文、进度和 ${state} 状态`, async (t) => {
    const view = playbackFixture(t)
    await view.open()
    assert.ok(view.tick() && view.tick())
    if (state === 'paused') labeledButton(view.render(), '暂停').props.onClick()
    if (state === 'auto-paused') view.switchTo('other')
    if (state === 'finished') for (let i = 0; i < 15 && view.tick(); i += 1) { /* finish the short book */ }
    view.persist()
    const snapshot = () => {
      const tree = view.render()
      return {
        text: textOf(withClass(tree, 'dshReadProse')),
        progress: textOf(withClass(tree, 'dshReadHead')),
        playback: textOf(withClass(tree, 'dshReadControlsInner')),
        saved: JSON.stringify(view.savedProgress()),
      }
    }
    openTypography(view)
    const before = snapshot()
    const reads = view.reads.length
    const writes = view.writes.length
    changeTypography(view, '字号', 28)
    changeTypography(view, '行距', 2.4)
    changeTypography(view, '正文宽度', 900)
    labeledButton(view.render(), '恢复默认').props.onClick()
    await flush()
    assert.deepEqual(snapshot(), before)
    assert.equal(view.reads.length, reads, 'layout never reloads paragraphs or progress')
    view.persist()
    assert.equal(view.writes.length, writes, 'layout never schedules a progress write')
    if (state === 'playing') {
      assert.ok(view.tick())
      assert.equal(view.position(), '春风又绿')
    } else {
      assert.equal(view.tick(), false, 'layout must not start playback')
    }
  })
}

test('排版控件保留键盘原生操作，不触发卡片空格播放快捷键', (t) => {
  const view = playbackFixture(t)
  let tree = openTypography(view)
  for (const label of ['字号', '行距', '正文宽度']) {
    const field = typographyField(tree, label)
    const event = keyEvent(' ', { target: { tagName: field.type.toUpperCase() } })
    tree.props.onKeyDown(event)
    assert.equal(event.defaultPrevented, false)
    assert.ok(labeledButton(view.render(), '播放'))
  }
  labeledButton(tree, '排版').props.onClick()
  tree = view.render()
  assert.equal(withClass(tree, 'dshReadTypography'), undefined)
})

test('展开和调整排版不会触发正文自动追随滚动', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  const stream = { scrollTop: 850, scrollHeight: 1000, clientHeight: 100,
    addEventListener() {}, removeEventListener() {} }
  withClass(view.render(), 'dshReadStream').props.ref(stream)
  openTypography(view)
  changeTypography(view, '字号', 28)
  changeTypography(view, '行距', 2.4)
  changeTypography(view, '正文宽度', 560)
  assert.equal(stream.scrollTop, 850, 'layout renders must not pull a reader to the bottom')
})

test('排版布局约束正文宽度与图片比例，短窗口控件仍可滚动和键盘聚焦', () => {
  const css = stylesheet()
  const rule = (selector) => {
    const start = css.indexOf(selector + '{')
    assert.ok(start >= 0, `expected ${selector} rule`)
    return css.slice(start + selector.length + 1, css.indexOf('}', start))
  }
  assert.match(rule('.dshReadProse'), /width:100%;max-width:var\(--dsh-read-text-width,none\)/)
  assert.match(rule('.dshReadProse'), /margin-inline:auto/)
  assert.match(rule('.dshReadBlock'), /overflow-wrap:anywhere/)
  assert.match(rule('.dshReadBlock'), /font-size:var\(--dsh-read-font-size,14\.5px\)/)
  assert.match(rule('.dshReadBlock'), /line-height:var\(--dsh-read-line-height,1\.95\)/)
  const image = rule('.dshReadFigureImg')
  assert.match(image, /max-width:100%/)
  assert.match(image, /height:auto/)
  assert.match(image, /box-sizing:border-box/)
  assert.match(rule('.dshReadTypography'), /flex-wrap:wrap/)
  assert.match(rule('.dshReadTypographyField'), /minmax\(0,1fr\)/)
  assert.match(rule('.dshReadTypographyField input'), /min-width:0/)
  assert.match(rule('.dshReadControls>.dshReadControlsBody'), /overflow:auto/,
    'the scrolling rule must beat .dshReadFold>* overflow:hidden')
  assert.match(rule('.dshReadControls'), /max-height:50%/)
  assert.match(rule('.dshReadChapterInner'), /text-overflow:ellipsis/)
  assert.match(css, /\.dshReadControls :is\(button,input,select\):focus-visible\{outline:2px solid/)
})

/* ── the 阅读 settings page ──────────────────────────────────────────────── */

/** Mount the plugin and hand back the 阅读 settings page with its owner + standard props. */
function settingsPage({ fetch: fetchImpl, session, snapshot, onClose = () => {} } = {}) {
  const react = createReact()
  const { registered } = mount(react.React, { fetch: fetchImpl })
  const section = registered.find((entry) => entry.options.name === 'settings.section').component
  const props = {
    close: onClose,
    // Default to the current DSH catalog contract; explicit snapshots cover legacy hosts.
    useSessions: (selector) => selector(snapshot || {
      ids: session ? [session] : [],
      byId: session ? { [session]: { id: session, retainedBy: { mainView: 1 } } } : {},
      phase: 'ready',
    }),
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
  await labeledButton(withClass(tree, 'dshReadLibEditor'), '保存').props.onClick()

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

test('阅读中心兼容旧版 current 会话字段', async () => {
  const calls = []
  const { react, section, props } = settingsPage({
    snapshot: { current: 'legacy', byId: {} },
    fetch: async (url, options) => {
      calls.push(JSON.parse(options.body))
      return { status: 200, json: async () => ({ ok: true }) }
    },
  })
  await labeledButton(seedBooks(react, section, props), '开始阅读').props.onClick()
  assert.equal(calls[0].sessionId, 'legacy')
})

test('阅读中心跟随主对话切换，忽略后台会话和 ids 顺序', async () => {
  const calls = []
  const snapshot = {
    ids: ['background'],
    byId: {
      background: { id: 'background', retainedBy: { gateway: 1 } },
      first: { id: 'first', retainedBy: { mainView: 1 } },
      second: { id: 'second', retainedBy: {} },
    },
  }
  const { react, section, props } = settingsPage({
    snapshot,
    fetch: async (url, options) => {
      calls.push(JSON.parse(options.body))
      return { status: 200, json: async () => ({ ok: true }) }
    },
  })
  await labeledButton(seedBooks(react, section, props), '开始阅读').props.onClick()
  snapshot.byId.first.retainedBy = {}
  snapshot.byId.second.retainedBy = { mainView: 1 }
  await labeledButton(react.render(section, props), '开始阅读').props.onClick()
  assert.deepEqual(calls.map((call) => call.sessionId), ['first', 'second'])
})

for (const [label, byId] of [
  ['只有后台会话', { background: { id: 'background', retainedBy: { gateway: 1 } } }],
  ['主对话不明确', {
    a: { id: 'a', retainedBy: { mainView: 1 } },
    b: { id: 'b', retainedBy: { mainView: 1 } },
  }],
]) {
  test(`阅读中心在${label}时不猜选会话`, async () => {
    let requests = 0
    const { react, section, props } = settingsPage({
      snapshot: { byId },
      fetch: async () => { requests += 1; throw new Error('unexpected request') },
    })
    await labeledButton(seedBooks(react, section, props), '开始阅读').props.onClick()
    assert.equal(requests, 0)
    assert.match(textOf(react.render(section, props)), /没有打开的会话/)
  })
}

/* ── library filtering and sorting ──────────────────────────────────────── */

test('阅读中心通过官方图标插槽提供唯一书本，不再注入 CSS 图标或观察宿主 DOM', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const icons = registered.filter((entry) => entry.options.name === 'settings.section.icon')
  assert.equal(icons.length, 1)
  assert.equal(icons[0].options.id, 'dsh-read')
  const icon = react.render(icons[0].component, { size: 22, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 22)
  assert.equal(icon.props.height, 22)
  assert.equal(icon.props.stroke, 'currentColor')
  assert.equal(icon.props['aria-hidden'], true)
  assert.equal(elements(icon).filter((node) => node.type === 'svg').length, 1)
  assert.doesNotMatch(SOURCE, /data-dsh-read-settings-nav|MutationObserver|registerSettingsNavIcon/)
})

function libraryFixture() {
  const book = (name, percent, at) => ({
    path: `/books/${name}.epub`, name: `${name}.epub`, extension: 'epub', size: 1024,
    progress: percent === null ? null : { index: percent, paragraphCount: 100, chars: 1000, percent, at },
  })
  return [book('D', null), book('B', 50, 200), book('A', 50, 200),
    book('C', 0, 300), book('E', 100, 100), book('F', 25, undefined)]
}

function bookNames(tree) {
  return elements(tree).filter((el) => el.props.className === 'dshReadLibBook')
    .map((el) => withClass(el, 'dshReadLibName').children[0])
}

function changeLibrarySelect(tree, label, value) {
  const select = elements(tree).find((el) => el.type === 'select' && el.props['aria-label'] === label)
  assert.ok(select, `missing select: ${label}`)
  select.props.onChange({ target: { value } })
}

function seededLibrary(books = libraryFixture()) {
  const page = settingsPage()
  page.react.render(page.section, page.props)
  page.react.setters[4](books)
  return { ...page, render: () => page.react.render(page.section, page.props) }
}

test('书库默认最近阅读优先，同时间按书名，未读及缺失时间始终排末尾', () => {
  const books = libraryFixture()
  const original = JSON.stringify(books)
  const { render } = seededLibrary(books)
  let tree = render()
  assert.deepEqual(bookNames(tree), ['C.epub', 'A.epub', 'B.epub', 'E.epub', 'D.epub', 'F.epub'])
  changeLibrarySelect(tree, '书籍排序方向', 'asc')
  tree = render()
  assert.deepEqual(bookNames(tree), ['E.epub', 'A.epub', 'B.epub', 'C.epub', 'D.epub', 'F.epub'])
  assert.equal(JSON.stringify(books), original, 'sorting must not mutate the host listing')
  assert.match(textOf(tree), /显示 6 \/ 6 本/)
})

test('书库按进度升降序，未读按零进度，同值始终按书名', () => {
  const { render } = seededLibrary()
  changeLibrarySelect(render(), '书籍排序字段', 'progress')
  assert.deepEqual(bookNames(render()), ['E.epub', 'A.epub', 'B.epub', 'F.epub', 'C.epub', 'D.epub'])
  changeLibrarySelect(render(), '书籍排序方向', 'asc')
  assert.deepEqual(bookNames(render()), ['C.epub', 'D.epub', 'F.epub', 'A.epub', 'B.epub', 'E.epub'])
})

test('在读按记录筛选（包含0%和100%），可叠加排序且保留目录', () => {
  const { react, render } = seededLibrary()
  react.setters[3]([{ path: '/books/子目录', name: '子目录' }])
  let tree = render()
  labeledButton(tree, '在读').props.onClick()
  tree = render()
  assert.equal(labeledButton(tree, '在读').props['aria-pressed'], true)
  assert.deepEqual(bookNames(tree), ['C.epub', 'A.epub', 'B.epub', 'E.epub', 'F.epub'])
  assert.ok(withClass(tree, 'dshReadLibRow'))
  changeLibrarySelect(tree, '书籍排序字段', 'progress')
  assert.deepEqual(bookNames(render()), ['E.epub', 'A.epub', 'B.epub', 'F.epub', 'C.epub'])
  labeledButton(render(), '未读').props.onClick()
  assert.deepEqual(bookNames(render()), ['D.epub'])
  assert.match(textOf(render()), /显示 1 \/ 6 本/)
  labeledButton(render(), '全部').props.onClick()
  assert.equal(bookNames(render()).length, 6)
})

test('筛选空结果保留目录并能恢复全部，切换筛选收起进度编辑器', async () => {
  const { react, render } = seededLibrary(libraryFixture().filter((book) => book.progress))
  react.setters[3]([{ path: '/books/child', name: 'child' }])
  await labeledButton(render(), '设置进度').props.onClick()
  assert.ok(withClass(render(), 'dshReadLibEditor'))
  labeledButton(render(), '未读').props.onClick()
  assert.equal(withClass(render(), 'dshReadLibEditor'), undefined)
  assert.ok(withClass(render(), 'dshReadLibRow'))
  assert.match(textOf(render()), /没有符合筛选条件的书籍/)
  labeledButton(render(), '查看全部').props.onClick()
  assert.equal(bookNames(render()).length, 5)
  assert.equal(withClass(render(), 'dshReadLibEditor'), undefined)
})

test('目录没有书籍时，即使有子目录也显示空书库提示', () => {
  const { react, render } = seededLibrary([])
  react.setters[3]([{ path: '/books/child', name: 'child' }])
  assert.ok(withClass(render(), 'dshReadLibRow'))
  assert.match(textOf(render()), /这个目录里没有书籍/)
  assert.equal(labeledButton(render(), '查看全部'), undefined)
})

test('无效时间安全放末尾，同名书籍用路径稳定排序', () => {
  const books = libraryFixture().slice(1, 3)
  books[0].progress.at = NaN
  books[1].progress.at = -1
  books[0].name = books[1].name = '同名.epub'
  const { render } = seededLibrary(books)
  const paths = () => elements(render()).filter((el) => el.props.className === 'dshReadLibBook')
    .map((el) => withClass(el, 'dshReadLibName').props.title)
  assert.deepEqual(paths(), ['/books/A.epub', '/books/B.epub'])
  changeLibrarySelect(render(), '书籍排序方向', 'asc')
  assert.deepEqual(paths(), ['/books/A.epub', '/books/B.epub'])
})

test('重置进度刷新后，当前在读筛选立即移除该书，切回未读能看到', async () => {
  const books = libraryFixture().slice(1, 2)
  const { react, section, props } = settingsPage({ fetch: async (url, options) => {
    if (url === '/dsh-read/api/progress' && options) books[0] = { ...books[0], progress: null }
    return { status: 200, json: async () => ({ ok: true, dir: '/books', parent: '/', directories: [], books }) }
  } })
  const render = () => react.render(section, props)
  await labeledButton(render(), '加载').props.onClick()
  labeledButton(render(), '在读').props.onClick()
  await labeledButton(render(), '重置进度').props.onClick()
  assert.deepEqual(bookNames(render()), [])
  assert.match(textOf(render()), /没有符合筛选条件/)
  labeledButton(render(), '未读').props.onClick()
  assert.deepEqual(bookNames(render()), ['B.epub'])
})

/* ── the Settings navigation icon ────────────────────────────────────────── */

test('阅读中心通过官方图标插槽提供唯一书本，不再注入 CSS 图标或观察宿主 DOM', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const icons = registered.filter((entry) => entry.options.name === 'settings.section.icon')
  assert.equal(icons.length, 1)
  assert.equal(icons[0].options.id, 'dsh-read')
  const icon = react.render(icons[0].component, { size: 22, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 22)
  assert.equal(icon.props.height, 22)
  assert.equal(icon.props.stroke, 'currentColor')
  assert.equal(icon.props['aria-hidden'], true)
  assert.equal(elements(icon).filter((node) => node.type === 'svg').length, 1)
  assert.doesNotMatch(SOURCE, /data-dsh-read-settings-nav|MutationObserver|registerSettingsNavIcon/)
})

test('加载书库只保留筛选栏的数量，不显示重复成功提示，空目录仍显示空态', async () => {
  let books = libraryFixture()
  const { react, section, props } = settingsPage({ fetch: async () => response({
    ok: true, dir: '/books', parent: '/', directories: [], books,
  }) })
  const render = () => react.render(section, props)
  await labeledButton(render(), '加载').props.onClick()
  assert.match(textOf(render()), /显示 6 \/ 6 本/)
  assert.doesNotMatch(textOf(render()), /共 \d+ 本书/)
  assert.equal(withClass(render(), 'dshReadLibStatus'), undefined)
  books = []
  await labeledButton(render(), '加载').props.onClick()
  assert.equal(withClass(render(), 'dshReadLibStatus'), undefined)
  assert.match(textOf(render()), /这个目录里没有书籍/)
})

test('移除数量提示后，书库加载失败仍显示错误并在下次成功时清除', async () => {
  let fails = true
  const { react, section, props } = settingsPage({ fetch: async () => {
    if (fails) throw new Error('目录无权访问')
    return response({ ok: true, dir: '/books', parent: '/', directories: [], books: libraryFixture() })
  } })
  const render = () => react.render(section, props)
  await labeledButton(render(), '加载').props.onClick()
  assert.match(textOf(withClass(render(), 'dshReadLibStatus')), /目录无权访问/)
  assert.equal(withClass(render(), 'dshReadLibStatus').props['data-error'], 'true')
  fails = false
  await labeledButton(render(), '加载').props.onClick()
  assert.equal(withClass(render(), 'dshReadLibStatus'), undefined)
})

/* ── background playback and exact cursor restoration ──────────────────── */

function playbackFixture(t, stored, paragraphs = ['甲', '春风又绿江南岸', '尾声']) {
  const window = new EventTarget()
  const document = Object.assign(new EventTarget(), {
    hidden: false, visibilityState: 'visible', hasFocus: () => true,
    createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} },
  })
  const values = new Map(stored)
  const localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) }
  window.localStorage = localStorage
  window.document = document
  const timers = new Map()
  let seq = 0
  let owner
  // A remount needs fresh hook state, but the *same* loaded plugin and window.
  const react = Object.fromEntries(Object.keys(createReact().React).map((name) =>
    [name, (...args) => owner.React[name](...args)]))
  const book = { ...CARD_BOOK, paragraphCount: paragraphs.length }
  let progress = {}
  const writes = []
  const reads = []
  let paragraphFailures = 0
  const { registered } = mount(react, {
    globals: { window, document, localStorage,
      setTimeout: (fn, delay) => { timers.set(++seq, { fn, delay }); return seq },
      clearTimeout: (id) => timers.delete(id) },
    fetch: async (url, options) => {
      if (!options) reads.push(url)
      if (url.includes('/paragraphs?')) {
        if (paragraphFailures > 0) {
          paragraphFailures -= 1
          throw new Error('正文暂时不可用')
        }
        return response({ ok: true, from: 0,
          items: paragraphs.map((text, i) => ({ text, offset: i })) })
      }
      if (url === '/dsh-read/api/progress' && options) {
        const body = JSON.parse(options.body)
        writes.push(body)
        progress = body.clear ? {} : { [body.path]: body }
      }
      return response({ ok: true, progress, notes: [], dir: '/books', directories: [],
        books: [{ ...book, extension: 'epub', progress: { index: 1, paragraphCount: paragraphs.length, chars: 100, percent: 33.3 } }] })
    },
  })
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const section = registered.find((entry) => entry.options.name === 'settings.section').component
  let active = 'reader'
  const props = { sessionId: 'reader', node: { id: 'command-1', data: { book } },
    useSessions: (select) => select({ byId: { [active]: { id: active, retainedBy: { mainView: 1 } } }, ids: [active] }) }
  let reader = createReact()
  const settings = createReact()
  const render = () => {
    owner = reader
    reader.render(card, props)
    reader.commit()
    return reader.render(card, props)
  }
  const open = async () => { render(); await flush(); return render() }
  const tick = () => {
    render()
    const next = [...timers].find(([, { delay }]) => delay === 100)
    if (!next) return false
    timers.delete(next[0]); next[1].fn(); render()
    return true
  }
  const position = () => elements(render()).find((el) => el.props['data-paragraph'] === '1')?.children[0]
  const control = () => {
    owner = settings
    const field = elements(settings.render(section, props)).find((el) => el.props.role === 'switch')
    assert.ok(field && field.type === 'input' && field.props.type === 'checkbox', 'expected native auto-pause switch')
    return field.props
  }
  t.after(() => { reader.unmount(); settings.unmount() })
  const view = { window, document, values, render, open, tick, position, control, writes, reads,
    savedProgress: () => progress[book.path],
    failParagraphs(count) { paragraphFailures = count },
    unmount() { reader.unmount() },
    persist() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 1200) continue
        timers.delete(id)
        timer.fn()
      }
    },
    async editProgress(index) {
      const page = () => { owner = settings; return settings.render(section, props) }
      await labeledButton(page(), '加载').props.onClick()
      if (index === null) {
        await labeledButton(page(), '重置进度').props.onClick()
      } else {
        await labeledButton(page(), '设置进度').props.onClick()
        withClass(page(), 'dshReadLibEditorSlider').props.onChange({ target: { value: String(index) } })
        await labeledButton(withClass(page(), 'dshReadLibEditor'), '保存').props.onClick()
      }
    },
    switchTo(id) { active = id; render() },
    async remount() { reader.unmount(); reader = createReact(); await open(); return view },
  }
  return view
}

for (const away of ['blur', 'visibilitychange', 'session']) {
  test(`自动暂停：${away} 停住逐字播放，回来后自动从同一字继续`, async (t) => {
    const view = playbackFixture(t)
    await view.open()
    assert.ok(view.tick() && view.tick())
    assert.equal(view.position(), '春风')
    if (away === 'blur') view.window.dispatchEvent(new Event('blur'))
    if (away === 'visibilitychange') {
      view.document.dispatchEvent(new Event('visibilitychange'))
      assert.ok(labeledButton(view.render(), '暂停'), 'visible events must not pause')
      Object.assign(view.document, { hidden: true, visibilityState: 'hidden' })
      view.document.dispatchEvent(new Event('visibilitychange'))
    }
    if (away === 'session') view.switchTo('other')
    assert.ok(labeledButton(view.render(), '播放'))
    assert.equal(view.tick(), false, 'no typewriter timer should survive the pause')
    Object.assign(view.document, { hidden: false, visibilityState: 'visible' })
    view.document.dispatchEvent(new Event('visibilitychange'))
    view.window.dispatchEvent(new Event('focus'))
    view.switchTo('reader')
    if (away === 'session') await view.remount()
    assert.equal(view.position(), '春风', 'restore both paragraph and revealed characters')
    assert.ok(labeledButton(view.render(), '暂停'), 'returning must resume by itself')
    assert.equal(view.tick(), true)
    assert.equal(view.position(), '春风又绿')
  })
}

test('自动暂停不打扰手动暂停：回来后仍停着，播放键照常可用', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  assert.ok(view.tick() && view.tick())
  labeledButton(view.render(), '暂停').props.onClick()
  view.window.dispatchEvent(new Event('blur'))
  Object.assign(view.document, { hidden: true, visibilityState: 'hidden' })
  view.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(view.tick(), false, 'manual pause keeps the typewriter stopped')
  Object.assign(view.document, { hidden: false, visibilityState: 'visible' })
  view.document.dispatchEvent(new Event('visibilitychange'))
  view.window.dispatchEvent(new Event('focus'))
  assert.ok(labeledButton(view.render(), '播放'), 'returning must not resume a manual pause')
  assert.equal(view.position(), '春风')
  labeledButton(view.render(), '播放').props.onClick()
  assert.ok(view.tick())
  assert.equal(view.position(), '春风又绿')
})

test('手动暂停后切离会话再切回：光标保留但不自动播放', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  assert.ok(view.tick() && view.tick())
  labeledButton(view.render(), '暂停').props.onClick()
  view.switchTo('other')
  const back = await view.remount()
  view.switchTo('reader')
  assert.equal(back.position(), '春风', 'the checkpoint keeps the exact character')
  assert.ok(labeledButton(view.render(), '播放'), 'a paused checkpoint stays paused')
  labeledButton(view.render(), '播放').props.onClick()
  assert.ok(view.tick())
  assert.equal(view.position(), '春风又绿')
})

test('自动暂停后切离会话再切回：恢复光标并自动继续', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  assert.ok(view.tick() && view.tick())
  view.window.dispatchEvent(new Event('blur'))
  view.switchTo('other')
  const back = await view.remount()
  view.switchTo('reader')
  assert.equal(back.position(), '春风', 'the checkpoint keeps the exact character')
  assert.ok(labeledButton(view.render(), '暂停'), 'a resumable checkpoint continues by itself')
  assert.ok(view.tick())
  assert.equal(view.position(), '春风又绿')
})

test('阅读中心关闭自动暂停会立即影响已挂载的卡片，并在新窗口中保留', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  assert.equal(view.control().checked, true)
  view.control().onChange({ target: { checked: false } })
  assert.equal(view.control().checked, false)
  assert.equal(view.values.get('dsh-read:auto-pause'), 'false')
  const reopened = playbackFixture(t, view.values)
  await reopened.open()
  assert.equal(reopened.control().checked, false)
  for (const reader of [view, reopened]) {
    reader.window.dispatchEvent(new Event('blur'))
    Object.assign(reader.document, { hidden: true, visibilityState: 'hidden' })
    reader.document.dispatchEvent(new Event('visibilitychange'))
    reader.switchTo('other')
    assert.ok(labeledButton(reader.render(), '暂停'))
    assert.ok(reader.tick() && reader.tick())
    assert.equal(reader.position(), '春风')
  }
})

test('关闭自动暂停后，首段内手动暂停仍跨卸载保留精确光标', async (t) => {
  const view = playbackFixture(t, [['dsh-read:auto-pause', 'false']], ['春风又绿江南岸', '尾声'])
  await view.open()
  assert.ok(view.tick())
  labeledButton(view.render(), '暂停').props.onClick()
  view.switchTo('other')
  await view.remount()
  view.switchTo('reader')
  view.window.dispatchEvent(new Event('focus'))
  const paragraph = elements(view.render()).find((el) => el.props['data-paragraph'] === '0')
  assert.equal(paragraph.children[0], '春风')
  assert.ok(labeledButton(view.render(), '播放'))
  assert.equal(view.tick(), false)
})

for (const index of [null, 2, 3]) {
  for (const unmounted of [true, false]) {
    test(`明确${index === null ? '重置' : '设置'}进度使${unmounted ? '已卸载' : '仍挂载'}阅读器的旧光标失效`, async (t) => {
      const view = playbackFixture(t)
      await view.open()
      assert.ok(view.tick() && view.tick())
      assert.equal(view.position(), '春风')
      view.switchTo('other')
      if (unmounted) view.unmount()
      await view.editProgress(index)
      const saved = view.writes.length
      view.persist()
      assert.equal(view.writes.length, saved, 'stale debounce must not overwrite explicit progress')
      const loads = view.reads.filter((url) => url.includes('/paragraphs?')).length
      if (unmounted) await view.remount()
      else {
        await view.open()
        assert.equal(view.reads.filter((url) => url.includes('/paragraphs?')).length, loads,
          'invalidation must not reload a mounted background reader')
      }
      view.persist()
      assert.equal(view.writes.length, saved)
      if (index === null) assert.equal(view.savedProgress(), undefined)
      view.switchTo('reader')
      await view.open()
      view.persist()
      assert.equal(view.writes.length, saved, 'returning without a reading step must not write')
      if (index === 3) {
        assert.ok(labeledButton(view.render(), '重新开始'))
        assert.equal(view.tick(), false)
        assert.equal(view.savedProgress().index, 3)
        return
      }
      const current = elements(view.render()).find((el) => el.props['data-paragraph'] === String(index ?? 0))
      assert.equal(current.children[0], '', 'explicit progress starts at the new paragraph, without stale characters')
      assert.equal(view.position(), index === null ? undefined : '春风又绿江南岸')
      if (index !== null) labeledButton(view.render(), '播放').props.onClick()
      assert.ok(view.tick())
      view.persist()
      assert.equal(view.writes.length, saved + 1)
      assert.equal(view.savedProgress().index, index === null ? 1 : 3)
    })
  }
}

test('关闭自动暂停时重置仍保持未读，直到返回并实际阅读', async (t) => {
  const view = playbackFixture(t, [['dsh-read:auto-pause', 'false']])
  await view.open()
  assert.ok(view.tick() && view.tick())
  view.switchTo('other')
  await view.editProgress(null)
  await view.open()
  assert.equal(view.tick(), false)
  view.persist()
  assert.equal(view.savedProgress(), undefined)
  await view.remount()
  assert.equal(view.tick(), false)
  view.persist()
  assert.equal(view.savedProgress(), undefined)
  view.switchTo('reader')
  await view.open()
  view.persist()
  assert.equal(view.savedProgress(), undefined)
  assert.ok(view.tick())
  view.persist()
  assert.equal(view.savedProgress().index, 1)
})

test('前台明确设置进度后主动播放才同步位置，加载不写回', async (t) => {
  const view = playbackFixture(t)
  await view.open()
  assert.ok(view.tick() && view.tick())
  const loads = view.reads.filter((url) => url.includes('/paragraphs?')).length
  await view.editProgress(2)
  await view.open()
  assert.equal(view.reads.filter((url) => url.includes('/paragraphs?')).length, loads)
  assert.equal(view.tick(), false)
  labeledButton(view.render(), '播放').props.onClick()
  await view.open()
  view.persist()
  assert.equal(view.savedProgress().index, 2)
  assert.equal(view.writes.length, 1)
  assert.ok(view.tick())
  view.persist()
  assert.equal(view.savedProgress().index, 3)
})

for (const retry of ['播放', '下一段', 'focus']) {
  for (const index of [null, 2, 3]) {
    test(`进度同步失败后通过 ${retry} 重试同一版本 ${index ?? '重置'}`, async (t) => {
      const view = playbackFixture(t)
      await view.open()
      assert.ok(view.tick() && view.tick())
      view.switchTo('other')
      await view.editProgress(index)
      view.failParagraphs(2)
      view.switchTo('reader')
      await view.open()
      assert.match(textOf(view.render()), /正文暂时不可用/)
      const saved = view.writes.length
      const loads = () => view.reads.filter((url) => url.includes('/paragraphs?')).length
      const before = loads()
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (retry === 'focus') view.window.dispatchEvent(new Event('focus'))
        else await labeledButton(view.render(), retry).props.onClick()
        await view.open()
        assert.equal(loads(), before + attempt)
        view.persist()
        assert.equal(view.writes.length, saved, 'failed retries and loading must not write progress')
        assert.equal(view.savedProgress()?.index, index ?? undefined)
        if (attempt === 1) {
          assert.match(textOf(view.render()), /正文暂时不可用/)
          assert.equal(view.tick(), false)
        }
      }
      assert.doesNotMatch(textOf(view.render()), /正文暂时不可用/)
      if (index === 3) {
        assert.ok(labeledButton(view.render(), '重新开始'))
        assert.equal(view.tick(), false)
      } else {
        const current = elements(view.render()).find((el) => el.props['data-paragraph'] === String(index ?? 0))
        assert.equal(current.children[0], '')
        const play = labeledButton(view.render(), '播放')
        if (play) play.props.onClick()
        assert.ok(view.tick())
        view.persist()
        assert.equal(view.writes.length, saved + 1)
        assert.equal(view.savedProgress().index, index === null ? 1 : 3)
      }
    })
  }
}

for (const retry of ['播放', '下一段', 'focus']) {
  test(`首次正文加载失败后通过 ${retry} 重试版本零并继续逐字播放`, async (t) => {
    const view = playbackFixture(t)
    view.failParagraphs(2)
    await view.open()
    const loads = () => view.reads.filter((url) => url.includes('/paragraphs?')).length
    assert.equal(loads(), 1)
    assert.match(textOf(view.render()), /正文暂时不可用/)
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (retry === 'focus') view.window.dispatchEvent(new Event('focus'))
      else await labeledButton(view.render(), retry).props.onClick()
      await view.open()
      assert.equal(loads(), attempt + 1)
      view.persist()
      assert.equal(view.savedProgress(), undefined)
      if (attempt === 1) {
        assert.match(textOf(view.render()), /正文暂时不可用/)
        assert.equal(view.tick(), false)
      }
    }
    assert.doesNotMatch(textOf(view.render()), /正文暂时不可用/)
    assert.ok(view.tick() && view.tick())
    assert.equal(view.position(), '春风')
    view.persist()
    assert.equal(view.savedProgress().index, 1)
    labeledButton(view.render(), '暂停').props.onClick()
    view.window.dispatchEvent(new Event('focus'))
    assert.equal(view.tick(), false)
    assert.equal(loads(), 3)
  })
}

/* ── Markdown archive interactions ──────────────────────────────────────── */

const response = (payload) => ({ status: 200, json: async () => payload })
const flush = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function archiveReader({ enabled = true, save = async () => ({ ok: true, note: { id: 'note-1' } }), facade = true, book = CARD_BOOK, getNotes } = {}) {
  const calls = []
  const drafts = []
  const globals = { __dshReadSelection: fakeSelection('原文引用', 3) }
  const react = createReact()
  const { registered } = mount(react.React, {
    globals,
    fetch: async (url, options) => {
      calls.push({ url, options })
      return response(options?.method === 'POST' ? await save(JSON.parse(options.body))
        : getNotes ? await getNotes() : { ok: true, notes: [], archiveEnabled: enabled })
    },
  })
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const props = { node: { data: { book } }, sessionId: 'reading-session',
    inputActions: facade ? { setDraft: (text) => drafts.push(text) } : undefined }
  react.render(card, props)
  react.runEffect(0) // mounted guard
  react.runEffect(1) // notes + archiveEnabled, not the paragraph/typewriter effects
  await flush()
  const render = () => react.render(card, props)
  withClass(render(), 'dshReadStream').props.onMouseUp()
  return { react, props, render, calls, drafts, selection: globals.__dshReadSelection }
}

test('archive-enabled ask persists a question before filling a tagged draft, without double submission', async () => {
  const pending = deferred()
  const reader = await archiveReader({ save: () => pending.promise })
  const ask = labeledButton(reader.render(), '问 AI')
  const saving = ask.props.onClick()
  ask.props.onClick() // same stale closure, before React rerenders
  assert.equal(reader.drafts.length, 0)
  assert.equal(reader.calls.filter((call) => call.options).length, 1)
  assert.equal(labeledButton(reader.render(), '问 AI').props.disabled, true)
  assert.equal(labeledButton(reader.render(), '记一笔').props.disabled, true)
  const post = reader.calls.find((call) => call.options)
  assert.deepEqual(JSON.parse(post.options.body), {
    path: CARD_BOOK.path, paragraph: 3, quote: '原文引用', kind: 'question', text: '',
    title: '活着', sessionId: 'reading-session',
  })
  pending.resolve({ ok: true, note: { id: 'note-1' } })
  await saving
  assert.equal(reader.drafts.length, 1)
  assert.equal(reader.drafts[0], '《活着》（第 4 段）：\n\n「原文引用」<!--dshr-note-1-->\n\n')
  assert.equal(withClass(reader.render(), 'dshReadAsk'), undefined)
})

test('book archive metadata keeps asks archived while notes GET is unresolved', async () => {
  const pending = deferred()
  const reader = await archiveReader({ book: { ...CARD_BOOK, archiveEnabled: true }, getNotes: () => pending.promise })
  await labeledButton(reader.render(), '问 AI').props.onClick()
  assert.equal(reader.calls.filter((call) => call.options).length, 1)
  assert.match(reader.drafts[0], /<!--dshr-note-1-->/)
  pending.resolve({ ok: true, notes: [], archiveEnabled: true })
  await flush()
})

test('re-entering the reader refreshes archive configuration without polling on internal focus', async () => {
  let enabled = false
  const reader = await archiveReader({ getNotes: async () => ({ ok: true, notes: [], archiveEnabled: enabled }) })
  const before = reader.calls.length
  reader.render().props.onFocus({ currentTarget: { contains: () => true }, relatedTarget: {} })
  assert.equal(reader.calls.length, before)
  enabled = true
  reader.render().props.onFocus({ currentTarget: { contains: () => false }, relatedTarget: null })
  await flush()
  await labeledButton(reader.render(), '问 AI').props.onClick()
  assert.match(reader.drafts[0], /<!--dshr-note-1-->/)
})

test('late annotation save cannot replace a composer draft the reader edited meanwhile', async () => {
  const pending = deferred()
  const reader = await archiveReader({ save: () => pending.promise })
  let revision = 1
  reader.props.useInput = (selector) => selector({ draftRev: revision })
  const saving = labeledButton(reader.render(), '问 AI').props.onClick()
  revision = 2
  reader.render()
  pending.resolve({ ok: true, note: { id: 'note-1' } })
  await saving
  assert.equal(reader.drafts.length, 0)
  assert.match(textOf(reader.render()), /未覆盖你的草稿/)
})

test('archive-disabled ask remains synchronous and does not write a question', async () => {
  const reader = await archiveReader({ enabled: false })
  const result = labeledButton(reader.render(), '问 AI').props.onClick()
  assert.equal(result, undefined)
  assert.equal(reader.drafts.length, 1)
  assert.doesNotMatch(reader.drafts[0], /<!--/)
  assert.equal(reader.calls.filter((call) => call.options).length, 0)
})

test('Markdown write failure still fills the tagged draft and reports the partial failure', async () => {
  const reader = await archiveReader({ save: async () => ({ ok: true, note: { id: 'note-2' }, mdError: 'Markdown 保存失败：只读目录' }) })
  await labeledButton(reader.render(), '问 AI').props.onClick()
  assert.match(reader.drafts[0], /<!--dshr-note-2-->/)
  assert.match(textOf(reader.render()), /批注已保存，Markdown 保存失败：只读目录/)
})

test('JSON save failure falls back to an ordinary draft and warns that it will not auto archive', async () => {
  const reader = await archiveReader({ save: async () => { throw new Error('磁盘已满') } })
  await labeledButton(reader.render(), '问 AI').props.onClick()
  assert.equal(reader.drafts.length, 1)
  assert.doesNotMatch(reader.drafts[0], /<!--/)
  assert.match(textOf(reader.render()), /本次提问不会自动归档：磁盘已满/)
})

test('no composer facade means no unsendable archive question is created', async () => {
  const reader = await archiveReader({ facade: false })
  await labeledButton(reader.render(), '问 AI').props.onClick()
  assert.equal(reader.calls.filter((call) => call.options).length, 0)
  assert.match(textOf(reader.render()), /没有可用的输入框/)
})

test('a newer selection survives a late archive response and the old draft is not inserted', async () => {
  const pending = deferred()
  const reader = await archiveReader({ save: () => pending.promise })
  const saving = labeledButton(reader.render(), '问 AI').props.onClick()
  reader.selection.toString = () => '新的选区'
  withClass(reader.render(), 'dshReadStream').props.onMouseUp()
  reader.render()
  pending.resolve({ ok: true, note: { id: 'old-note' } })
  await saving
  assert.equal(reader.drafts.length, 0)
  assert.equal(reader.selection.cleared, undefined)
  assert.ok(labeledButton(reader.render(), '问 AI'))
  assert.equal(labeledButton(reader.render(), '问 AI').props.disabled, false)
})

test('invalidated selections cannot receive a late archived draft', async () => {
  for (const mode of ['collapsed', 'whitespace', 'outside', 'cross-paragraph']) {
    const pending = deferred()
    const reader = await archiveReader({ save: () => pending.promise })
    const saving = labeledButton(reader.render(), '问 AI').props.onClick()
    if (mode === 'collapsed') reader.selection.isCollapsed = true
    if (mode === 'whitespace') reader.selection.toString = () => '  '
    if (mode === 'outside') reader.selection.getRangeAt().startContainer.closest = () => null
    if (mode === 'cross-paragraph') reader.selection.getRangeAt().startContainer.closest('[data-paragraph]').contains = () => false
    withClass(reader.render(), 'dshReadStream').props.onMouseUp()
    assert.equal(withClass(reader.render(), 'dshReadAsk'), undefined, mode)
    pending.resolve({ ok: true, note: { id: 'old-note' } })
    await saving
    assert.equal(reader.drafts.length, 0, mode)
  }
})

test('selection bubble mouse and keyboard events do not bubble into selection capture', async () => {
  const reader = await archiveReader({ enabled: false })
  let stopped = 0
  const bubble = withClass(reader.render(), 'dshReadAsk')
  bubble.props.onMouseUp({ stopPropagation: () => stopped++ })
  bubble.props.onKeyUp({ stopPropagation: () => stopped++ })
  assert.equal(stopped, 2)
  labeledButton(reader.render(), '问 AI').props.onClick()
  assert.equal(reader.drafts.length, 1)
})

test('unmounted or changed-session readers never fill a stale draft', async () => {
  for (const mode of ['unmount', 'session']) {
    const pending = deferred()
    const reader = await archiveReader({ save: () => pending.promise })
    const saving = labeledButton(reader.render(), '问 AI').props.onClick()
    if (mode === 'unmount') reader.react.unmount()
    else { reader.props.sessionId = 'another-session'; reader.render() }
    pending.resolve({ ok: true, note: { id: 'old-note' } })
    await saving
    assert.equal(reader.drafts.length, 0, mode)
  }
})

test('记一笔 sends the title and shows Markdown failure without pretending the note was lost', async () => {
  const pending = deferred()
  const reader = await archiveReader({ save: () => pending.promise })
  const note = labeledButton(reader.render(), '记一笔')
  const saving = note.props.onClick()
  note.props.onClick()
  assert.equal(reader.calls.filter((call) => call.options).length, 1)
  assert.equal(JSON.parse(reader.calls.find((call) => call.options).options.body).title, '活着')
  pending.resolve({ ok: true, note: { id: 'note-1' }, mdError: 'Markdown 保存失败：只读目录' })
  await saving
  assert.match(textOf(reader.render()), /批注已保存，Markdown 保存失败：只读目录/)
  assert.equal(reader.drafts.length, 0)
})

function vaultSettings(fetchImpl, props = {}) {
  const react = createReact()
  const { plugin } = mount(react.React, { fetch: fetchImpl })
  const render = () => react.render(plugin.NotesVaultSettings, props)
  render()
  react.runEffect(0)
  return { react, render }
}
function vaultField(tree) {
  return elements(tree).find((element) => element.type === 'input' && element.props['aria-label'] === 'Markdown 保存目录')
}
const VAULT = { ok: true, path: '/Users/me/My Vault', suggestedPath: '~/Documents/ReadingNotes', bookCount: 2, noteCount: 9 }

test('archive settings default to two compact rows without counts or explanatory copy', async () => {
  const pending = deferred()
  const view = vaultSettings(() => pending.promise)
  for (const label of ['选择…', '保存', '更多 ▾']) {
    assert.equal(labeledButton(view.render(), label).props.disabled, true)
  }
  pending.resolve(response(VAULT))
  await flush()
  assert.equal(vaultField(view.render()).props.value, VAULT.path)
  assert.equal(vaultField(view.render()).props.placeholder, VAULT.suggestedPath)
  assert.match(textOf(view.render()), /已启用/)
  assert.doesNotMatch(textOf(view.render()), /已记录|本书|条批注|Obsidian|Markdown 保存目录|不代表|每本书/)
  for (const label of ['停用归档', '导出全部', '打开目录']) assert.equal(labeledButton(view.render(), label), undefined)
  const section = view.render()
  assert.equal(section.children.filter(Boolean).length, 2, 'normal state contains only header and path row')
  labeledButton(view.render(), '更多 ▾').props.onClick()
  assert.equal(labeledButton(view.render(), '更多 ▴').props['aria-expanded'], true)
  assert.equal(labeledButton(view.render(), '打开目录').props.disabled, false)
  labeledButton(view.render(), '更多 ▴').props.onClick()
  assert.equal(labeledButton(view.render(), '打开目录'), undefined)
})

test('late GET vault response does not overwrite an edited path', async () => {
  const pending = deferred()
  const view = vaultSettings(() => pending.promise)
  vaultField(view.render()).props.onChange({ target: { value: '/new/vault' } })
  pending.resolve(response(VAULT))
  await flush()
  assert.equal(vaultField(view.render()).props.value, '/new/vault')
})

test('export requires inline overwrite confirmation and locks all actions while pending', async () => {
  const pending = deferred()
  const calls = []
  const view = vaultSettings(async (url, options) => {
    calls.push({ url, options })
    return options ? pending.promise : response(VAULT)
  })
  await flush()
  labeledButton(view.render(), '更多 ▾').props.onClick()
  labeledButton(view.render(), '导出全部').props.onClick()
  assert.equal(calls.length, 1, 'opening confirmation must not export')
  assert.match(textOf(view.render()), /覆盖插件文件中的手动修改/)
  labeledButton(view.render(), '取消导出').props.onClick()
  assert.equal(labeledButton(view.render(), '确认覆盖并导出'), undefined)
  labeledButton(view.render(), '导出全部').props.onClick()
  const confirm = labeledButton(view.render(), '确认覆盖并导出')
  const exporting = confirm.props.onClick()
  confirm.props.onClick()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, '/dsh-read/api/export')
  for (const label of ['选择…', '保存', '更多 ▴', '停用归档', '导出全部', '打开目录']) {
    assert.equal(labeledButton(view.render(), label).props.disabled, true)
  }
  pending.resolve(response({ ok: true, exported: 8, failed: 1, errors: ['一条失败'] }))
  await exporting
  assert.match(textOf(view.render()), /成功 8 条，失败 1 条/)
  assert.match(textOf(view.render()), /一条失败/)
  assert.equal(elements(view.render()).find((element) => element.props.role === 'alert').props['data-error'], 'true')
})

test('save reports migration, open targets configured directory, and disable sends an empty path', async () => {
  const calls = []
  const view = vaultSettings(async (url, options) => {
    calls.push({ url, options })
    if (!options) return response({ ...VAULT, path: '' })
    if (url.endsWith('/open')) return response({ ok: true })
    return response({ ...VAULT, path: JSON.parse(options.body).path, migration: { exported: 3, failed: 0, errors: [] } })
  })
  await flush()
  labeledButton(view.render(), '更多 ▾').props.onClick()
  for (const label of ['停用归档', '导出全部', '打开目录']) assert.equal(labeledButton(view.render(), label).props.disabled, true)
  // The suggested placeholder must never enable archiving implicitly.
  assert.equal(vaultField(view.render()).props.value, '')
  vaultField(view.render()).props.onChange({ target: { value: '/new/vault' } })
  await labeledButton(view.render(), '保存').props.onClick()
  assert.deepEqual(JSON.parse(calls[1].options.body), { path: '/new/vault' })
  assert.equal(elements(view.render()).some((element) => element.props.role === 'alert'), false)
  assert.match(textOf(view.render()), /已启用/)
  await labeledButton(view.render(), '打开目录').props.onClick()
  assert.equal(calls[2].url, '/dsh-read/api/vault/open')
  await labeledButton(view.render(), '停用归档').props.onClick()
  assert.deepEqual(JSON.parse(calls[3].options.body), { path: '' })
  assert.equal(vaultField(view.render()).props.value, '')
  assert.match(textOf(view.render()), /未启用/)
  assert.equal(labeledButton(view.render(), '停用归档'), undefined)
  labeledButton(view.render(), '更多 ▾').props.onClick()
  for (const label of ['停用归档', '导出全部', '打开目录']) assert.equal(labeledButton(view.render(), label).props.disabled, true)
})

test('archive settings expose GET errors and can retry without implicit writes', async () => {
  let attempts = 0
  const view = vaultSettings(async (url, options) => {
    assert.equal(url, '/dsh-read/api/vault')
    assert.equal(options, undefined)
    if (++attempts === 1) throw new Error('暂时离线')
    return response(VAULT)
  })
  await flush()
  assert.match(textOf(view.render()), /暂时离线/)
  await labeledButton(view.render(), '重试').props.onClick()
  assert.equal(vaultField(view.render()).props.value, VAULT.path)
  assert.doesNotMatch(textOf(view.render()), /暂时离线/)
})

test('failed note save preserves selection for retry rather than losing it', async () => {
  const reader = await archiveReader({ save: async () => { throw new Error('无法保存') } })
  await labeledButton(reader.render(), '记一笔').props.onClick()
  assert.ok(labeledButton(reader.render(), '记一笔'))
  assert.equal(labeledButton(reader.render(), '记一笔').props.disabled, false)
  assert.match(textOf(reader.render()), /无法保存/)
})

test('directory selection fills the path without saving and prevents duplicate chooser calls', async () => {
  const picked = deferred()
  const calls = []
  let selections = 0
  const view = vaultSettings(async (url, options) => {
    calls.push({ url, options })
    return response(VAULT)
  }, { pickDirectory: () => { selections += 1; return picked.promise } })
  await flush()
  const button = labeledButton(view.render(), '选择…')
  const selecting = button.props.onClick()
  button.props.onClick()
  assert.equal(selections, 1)
  assert.equal(labeledButton(view.render(), '选择中…').props.disabled, true)
  assert.equal(labeledButton(view.render(), '保存').props.disabled, true)
  picked.resolve('/Users/me/Obsidian/阅读笔记')
  await selecting
  assert.equal(vaultField(view.render()).props.value, '/Users/me/Obsidian/阅读笔记')
  assert.equal(elements(view.render()).some((element) => element.props.role === 'alert'), false)
  assert.equal(calls.length, 1, 'choosing must not POST config or migrate notes')
})

test('cancelled or failed directory selection preserves path and supports manual input', async () => {
  let fail = false
  const view = vaultSettings(async () => response(VAULT), {
    pickDirectory: async () => { if (fail) throw new Error('选择器不可用'); return null },
  })
  await flush()
  vaultField(view.render()).props.onChange({ target: { value: '/my/unsaved-path' } })
  await labeledButton(view.render(), '选择…').props.onClick()
  assert.equal(vaultField(view.render()).props.value, '/my/unsaved-path')
  fail = true
  await labeledButton(view.render(), '选择…').props.onClick()
  assert.equal(vaultField(view.render()).props.value, '/my/unsaved-path')
  assert.match(textOf(view.render()), /无法选择目录：选择器不可用/)
  assert.equal(labeledButton(view.render(), '保存').props.disabled, false)
})

test('directory selection result after unmount is ignored and missing chooser is explicit', async () => {
  const picked = deferred()
  const view = vaultSettings(async () => response(VAULT), { pickDirectory: () => picked.promise })
  await flush()
  const selecting = labeledButton(view.render(), '选择…').props.onClick()
  view.react.unmount()
  picked.resolve('/late/path')
  await selecting
  assert.equal(vaultField(view.render()).props.value, VAULT.path)
  const legacy = vaultSettings(async () => response(VAULT))
  await flush()
  await labeledButton(legacy.render(), '选择…').props.onClick()
  assert.match(textOf(legacy.render()), /请手动填写绝对路径/)
})

test('reading settings wire the chooser to the current uiWorkspace service', async () => {
  const react = createReact()
  const { registered } = mount(react.React, {
    fetch: async (url) => response(url.endsWith('/directory-picker') ? { ok: true, kind: 'native' } : VAULT),
    services: { uiWorkspace: { pickDirectory: async () => '/native/path' } },
  })
  const settings = registered.find((entry) => entry.options.name === 'settings.section').component
  const props = { useSessions: (select) => select(undefined) }
  let tree = react.render(settings, props)
  const choose = labeledButton(tree, '选择…')
  assert.ok(choose)
  // Library state precedes the archive block. Its GET hasn't run in this focused test.
  // Let the archive's GET settle by driving its last effect.
  react.runEffect(1)
  await flush()
  tree = react.render(settings, props)
  await labeledButton(tree, '选择…').props.onClick()
  tree = react.render(settings, props)
  assert.equal(vaultField(tree).props.value, '/native/path')
})

const DIRECTORY_HOME = {
  path: '/Users/me', home: '/Users/me',
  crumbs: [{ name: '/', path: '/' }, { name: 'Users', path: '/Users' }, { name: 'me', path: '/Users/me' }],
  entries: [{ name: 'Documents', path: '/Users/me/Documents' }], truncated: false,
}

test('browse capability navigates folders and selects a directory without calling native pick or saving', async () => {
  const listed = []
  let nativeCalls = 0
  const calls = []
  const view = vaultSettings(async (url, options) => { calls.push({ url, options }); return response(VAULT) }, {
    directoryCapability: async () => 'browse',
    pickDirectory: async () => { nativeCalls++; throw new Error('native not allowed') },
    listDirectory: async (path, signal) => {
      assert.ok(signal instanceof AbortSignal)
      listed.push(path)
      return path === '/Users/me/Documents' ? {
        ...DIRECTORY_HOME, path, entries: [], crumbs: [...DIRECTORY_HOME.crumbs, { name: 'Documents', path }],
      } : DIRECTORY_HOME
    },
  })
  await flush()
  await labeledButton(view.render(), '选择…').props.onClick()
  assert.equal(nativeCalls, 0)
  assert.match(textOf(view.render()), /Documents/)
  assert.equal(labeledButton(view.render(), '保存').props.disabled, true)
  await labeledButton(view.render(), '▸ Documents').props.onClick()
  assert.match(textOf(view.render()), /没有子目录/)
  await labeledButton(view.render(), '上一级').props.onClick()
  assert.equal(listed.at(-1), '/Users/me')
  await labeledButton(view.render(), '▸ Documents').props.onClick()
  labeledButton(view.render(), '选择此目录').props.onClick()
  assert.equal(vaultField(view.render()).props.value, '/Users/me/Documents')
  assert.equal(labeledButton(view.render(), '取消选择'), undefined)
  assert.equal(calls.length, 1, 'only initial GET, no config mutation')
})

test('browse cancellation aborts pending request and ignores late listings', async () => {
  const listing = deferred()
  let signal
  const view = vaultSettings(async () => response(VAULT), {
    directoryCapability: async () => 'browse', pickDirectory: async () => { throw new Error('wrong capability') },
    listDirectory: async (_path, requestSignal) => { signal = requestSignal; return listing.promise },
  })
  await flush()
  const selecting = labeledButton(view.render(), '选择…').props.onClick()
  await flush()
  labeledButton(view.render(), '取消选择').props.onClick()
  assert.equal(signal.aborted, true)
  listing.resolve(DIRECTORY_HOME)
  await selecting
  assert.equal(labeledButton(view.render(), '选择此目录'), undefined)
  assert.equal(vaultField(view.render()).props.value, VAULT.path)
})

test('browse errors can be retried or cancelled; unavailable capability never invokes native picker', async () => {
  let attempts = 0
  const view = vaultSettings(async () => response(VAULT), {
    directoryCapability: async () => 'browse', pickDirectory: async () => { throw new Error('wrong capability') },
    listDirectory: async () => { if (++attempts === 1) throw new Error('无权限'); return DIRECTORY_HOME },
  })
  await flush()
  await labeledButton(view.render(), '选择…').props.onClick()
  assert.match(textOf(view.render()), /无权限/)
  assert.equal(labeledButton(view.render(), '选择此目录').props.disabled, true)
  await labeledButton(view.render(), '重试目录').props.onClick()
  assert.doesNotMatch(textOf(view.render()), /无权限/)
  labeledButton(view.render(), '取消选择').props.onClick()
  const unavailable = vaultSettings(async () => response(VAULT), {
    directoryCapability: async () => 'unavailable', pickDirectory: async () => assert.fail('native must not be called'),
  })
  await flush()
  await labeledButton(unavailable.render(), '选择…').props.onClick()
  assert.match(textOf(unavailable.render()), /没有可用的目录选择器/)
})

test('browse folder rows keep their height so a long listing stays readable', () => {
  const css = stylesheet()
  const folders = /\.dshReadVaultFolders\{([^}]*)\}/.exec(css)
  const folder = /\.dshReadVaultFolder\{([^}]*)\}/.exec(css)
  assert.ok(folders, 'expected a .dshReadVaultFolders scroll-box rule')
  assert.ok(folder, 'expected a .dshReadVaultFolder rule')
  // The scroll box is capped; overflow:auto only preserves readability if its
  // flex children refuse to shrink. A shrinkable row clips its name to specks.
  assert.match(folders[1], /max-height:/)
  assert.match(folders[1], /overflow:auto/)
  assert.match(folders[1], /flex-direction:column/)
  assert.match(folder[1], /flex:none/, 'folder buttons must not collapse in the flex column')
})

test('archive settings ignore results after unmount', async () => {
  const pending = deferred()
  const view = vaultSettings(() => pending.promise)
  view.react.unmount()
  pending.resolve(response(VAULT))
  await flush()
  assert.equal(vaultField(view.render()).props.value, '')
})
