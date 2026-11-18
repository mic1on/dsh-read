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
        effects[at] = { callback, deps, cleanup: previous?.cleanup }
      }
    },
  }

  return {
    React,
    // ReaderCard's useState order: 0 stream, 1 index, 2 revealed, 3 playing, 4 speed, 5 status,
    // 6 busy. `setters` is populated by the first render.
    setters,
    runEffect(index) {
      effects[index].cleanup?.()
      effects[index].cleanup = effects[index].callback()
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

test('space toggles playback, and is advertised on the card', () => {
  const react = createReact()
  const { registered } = mount(react.React)
  const card = registered.find((entry) => entry.options.name === 'conversation.chat.node').component
  const props = { node: { data: { book: CARD_BOOK, error: '' } } }

  let tree = react.render(card, props)
  // The card must be reachable by keyboard, or the shortcut could never fire.
  assert.equal(tree.props.tabIndex, 0)
  assert.equal(typeof tree.props.onKeyDown, 'function')
  assert.match(textOf(tree), /空格 暂停\/继续/, 'the shortcut has to be discoverable')

  // The card starts paused until its first window lands, so the first press starts playback.
  const labelNow = () => (labeledButton(tree, '暂停') !== undefined ? '暂停' : '播放')
  const before = labelNow()

  let event = keyEvent(' ')
  tree.props.onKeyDown(event)
  tree = react.render(card, props)
  assert.equal(event.defaultPrevented, true, 'space must not scroll the transcript')
  assert.notEqual(labelNow(), before, 'space should have toggled playback')

  // And pressing again returns to where it was.
  event = keyEvent(' ')
  tree.props.onKeyDown(event)
  tree = react.render(card, props)
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

test('library loads without a redundant count row and retains failure feedback', async () => {
  let fail = false
  const { react, section, props } = settingsPage({ fetch: async () => {
    if (fail) throw new Error('目录无权访问')
    return response({ ok: true, dir: '/books', parent: '/', directories: [], books: [
      { path: '/books/活着.epub', name: '活着.epub', extension: 'epub', size: 1024, progress: null },
    ] })
  } })
  const render = () => react.render(section, props)
  await labeledButton(render(), '加载').props.onClick()
  assert.equal(withClass(render(), 'dshReadLibStatus'), undefined)
  assert.doesNotMatch(textOf(render()), /共 \d+ 本书/)
  fail = true
  await labeledButton(render(), '加载').props.onClick()
  assert.match(textOf(withClass(render(), 'dshReadLibStatus')), /目录无权访问/)
  fail = false
  await labeledButton(render(), '加载').props.onClick()
  assert.equal(withClass(render(), 'dshReadLibStatus'), undefined)
})

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
