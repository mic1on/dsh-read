// Host wiring with realistic awaited projection registration, committed session events
// and HTTP calls; no model requests, profile mutation, or real notes are involved.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return {
      url: 'data:text/javascript,export const defineTool = (definition) => definition',
      shortCircuit: true,
    }
    return nextResolve(specifier, context)
  }
`)}`)

const home = await mkdtemp(join(tmpdir(), 'dsh-read-integration-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.mjs')

async function mount() {
  const routes = new Map(), listeners = new Map(), pending = [], cleanup = [], tools = new Map()
  const sessions = []
  let toolRegistered
  const toolsReady = new Promise((resolve) => { toolRegistered = resolve })
  let definition
  const cells = new WeakMap()
  const handle = { stateOf(session) {
    let cell = cells.get(session) || { state: definition.init({}, 0), through: 0 }
    for (const event of session.events.slice(cell.through)) cell.state = definition.apply(cell.state, event)
    cell.through = session.events.length
    cells.set(session, cell)
    definition.stateSchema.parse(cell.state)
    return cell.state
  }, dispose: async () => {} }
  const capabilities = {
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    sessionProjections: { register: async (value) => { definition = value; return handle } },
    sessions: { list: () => sessions },
    sessionQuery: { readSession: async () => { throw new Error('not persisted') } },
  }
  const ctx = {
    ...capabilities,
    get: () => undefined,
    agents: { list: () => [], get: () => undefined },
    commands: { register: () => () => {} }, tools: { register(tool) { tools.set(tool.name, tool); if (tool.name === 'reading_notes') toolRegistered(); return () => tools.delete(tool.name) } },
    inject(deps, callback) { const result = callback(ctx); if (result?.then) pending.push(result) },
    on(name, listener) {
      const set = listeners.get(name) || new Set()
      listeners.set(name, set); set.add(listener)
      return () => set.delete(listener)
    },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') cleanup.push(dispose) },
  }
  apply(ctx)
  await Promise.all([...pending, toolsReady])
  const session = { id: 'test-reading-session', events: [] }
  sessions.push(session)
  for (const listener of listeners.get('session/created') || []) listener(session)
  function append(type, data) {
    const event = { type, data, seq: session.events.length, time: Date.now() }
    session.events.push(event)
    for (const listener of listeners.get('session/event') || []) listener(session, event)
  }
  async function request(path, body) {
    let status, payload
    const res = { writableEnded: false, writeHead(code) { status = code }, end(text) { payload = JSON.parse(text); this.writableEnded = true } }
    const handler = routes.get(path.split('?')[0])
    assert.ok(handler, path)
    await handler({ url: path, method: body === undefined ? 'GET' : 'POST', async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }, res)
    return { status, ...payload }
  }
  return { request, append, tools, async dispose() { for (const fn of cleanup.reverse()) await fn() } }
}

test('configure → question → committed turn → Markdown → export → remove round trip', async () => {
  const { request, append, dispose } = await mount()
  const path = join(home, '苏东坡传.txt')
  await writeFile(path, '第一章\n\n原文摘录\n\n后文')
  const vault = join(home, 'Obsidian', 'Reading')
  assert.equal((await request('/dsh-read/api/vault')).path, '')
  const configured = await request('/dsh-read/api/vault', { path: vault })
  assert.equal(configured.status, 200)
  assert.equal(configured.path, vault)
  const saved = await request('/dsh-read/api/notes', { path, paragraph: 1, quote: '原文摘录', kind: 'question', sessionId: 'test-reading-session' })
  assert.ok(saved.mdPath)
  assert.match(await readFile(saved.mdPath, 'utf8'), /pending/)
  append('turn/start', { turn: 1 })
  append('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `《苏东坡传》（第 2 段）：\n\n「原文摘录」<!--dshr-${saved.note.id}-->\n\n这里什么意思？` }] })
  append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一部分' }, { type: 'reasoning', text: '不导出' }] } })
  append('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '**第二部分**' }] } })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await dispose() // drains event IO, not a sleep or polling loop
  const md = await readFile(saved.mdPath, 'utf8')
  assert.match(md, /这里什么意思？/)
  assert.match(md, /第一部分\n\n\*\*第二部分\*\*/)
  assert.doesNotMatch(md, /不导出/)
  assert.match(md, /answered/)
  // Routes are disposed; JSON is a durable independent backup.
  const notes = JSON.parse(await readFile(join(home, 'dsh-read', 'notes.json'), 'utf8'))
  assert.equal(notes[path][0].answerState, 'answered')
})

test('tool export requires explicit boolean overwrite consent; confirmed UI export still works', async () => {
  const { request, tools, dispose } = await mount()
  try {
    await request('/dsh-read/api/vault', { path: join(home, 'consent-vault') })
    const saved = await request('/dsh-read/api/notes', { path: join(home, '苏东坡传.txt'), kind: 'note', text: 'memo' })
    const original = await readFile(saved.mdPath, 'utf8')
    const edited = original + '\nhandwritten tail\n'
    await writeFile(saved.mdPath, edited)
    const tool = tools.get('reading_notes')
    assert.ok(tool)
    for (const value of [undefined, false, 'true', 1]) {
      const result = JSON.parse((await tool.execute({ action: 'export', confirmOverwrite: value })).result)
      assert.equal(result.confirmationRequired, true)
      assert.equal(result.exported, undefined)
      assert.equal(await readFile(saved.mdPath, 'utf8'), edited)
    }
    const exported = JSON.parse((await tool.execute({ action: 'export', confirmOverwrite: true })).result)
    assert.ok(exported.exported >= 1)
    assert.equal(await readFile(saved.mdPath, 'utf8'), original)
    await writeFile(saved.mdPath, edited)
    assert.ok((await request('/dsh-read/api/export', {})).exported >= 1)
    assert.equal(await readFile(saved.mdPath, 'utf8'), original)
    await request('/dsh-read/api/notes', { path: join(home, '苏东坡传.txt'), remove: saved.note.id })
  } finally { await dispose() }
})

test('vault and export method boundaries reject mixed operations, preserve config', async () => {
  const { request, dispose } = await mount()
  const vault = join(home, 'second-vault')
  const config = await request('/dsh-read/api/vault', { action: 'remove', path: vault })
  assert.equal(config.path, vault, 'caller cannot override configure with an arbitrary action')
  const exported = await request('/dsh-read/api/export', {})
  assert.ok(exported.exported >= 1)
  assert.equal((await request('/dsh-read/api/export')).status, 400)
  assert.equal((await request('/dsh-read/api/vault', {})).status, 400)
  const removed = await request('/dsh-read/api/notes', { path: join(home, '苏东坡传.txt'), remove: Object.values(JSON.parse(await readFile(join(home, 'dsh-read', 'notes.json'), 'utf8')))[0][0].id })
  assert.equal(removed.notes.length, 0)
  const listing = await request('/dsh-read/api/library', { dir: home })
  assert.equal(listing.ok, true)
  const disabled = await request('/dsh-read/api/vault', { path: '' })
  assert.equal(disabled.path, '')
  const data = JSON.parse(await readFile(join(home, 'dsh-read', 'config.json'), 'utf8'))
  assert.equal(data.libraryRoots[0], home)
  assert.ok((await readdir(vault)).length >= 1)
  await dispose()
})
