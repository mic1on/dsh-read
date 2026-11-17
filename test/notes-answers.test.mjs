import assert from 'node:assert/strict'
import test from 'node:test'
import { foldAnswers, initialAnswers, mountAnswerCapture, questionMarkers, recoverAnswers } from '../lib/notes-answers.mjs'

const user = (id = 'note-1', messageId = 'user-1') => ({
  id: messageId, role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: `《苏东坡传》（第 64 段）：\n\n「原文」<!--dshr-${id}-->\n\n为什么？` }],
})
const event = (type, data, seq = 1) => ({ type, data, seq, time: seq * 10 })
const assistant = (text, turn = 1) => event('assistant/message', {
  turn, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'private thinking' }, { type: 'text', text }] },
})
const start = (turn = 1) => event('turn/start', { turn })
const end = (turn = 1, kind = 'completed') => event('turn/end', { turn, reason: { kind } })
const fold = (events) => events.reduce(foldAnswers, initialAnswers())

test('question marker extracts submitted question, not the generated book/quote prefix', () => {
  assert.deepEqual(questionMarkers(user()), [{ id: 'note-1', messageId: 'user-1', question: '为什么？' }])
  assert.deepEqual(questionMarkers({ ...user(), source: { kind: 'tool' } }), [])
  assert.deepEqual(questionMarkers({ ...user(), role: 'assistant' }), [])
})

test('fold associates exact turn, joins all assistant text, excludes tools and reasoning', () => {
  const state = fold([
    start(), event('user/message', user()),
    assistant('先解释'), event('tool/result', { message: { content: [{ type: 'text', text: 'tool secret' }] } }),
    assistant('不属于此轮', 9), assistant('再总结'), end(),
  ])
  assert.equal(state.active, null)
  assert.equal(state.records.length, 1)
  assert.equal(state.records[0].answer, '先解释\n\n再总结')
  assert.equal(state.records[0].completed, true)
  assert.equal(state.records[0].questions[0].id, 'note-1')
  assert.equal(foldAnswers(state, event('tool/call', {})), state)
})

test('multiple markers supported, duplicate markers de-duped; unrelated next turn is not archived', () => {
  const message = user()
  message.content[0].text += '\n<!--dshr-note-2--><!--dshr-note-1-->'
  const state = fold([start(), event('user/message', message), assistant('回答'), end(), start(2), assistant('无关', 2), end(2)])
  assert.equal(state.records.length, 1)
  assert.equal(state.records[0].questions.length, 2)
})

test('fork inherited quotes and compaction replacements cannot create archive targets', () => {
  let state = initialAnswers(10)
  state = foldAnswers(state, start())
  state = foldAnswers(state, event('user/message', user(), 2))
  assert.equal(state.active, null)
  state = foldAnswers(state, event('turn/start', { turn: 2 }, 10))
  state = foldAnswers(state, { ...event('user/message', user(), 11), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 9 } })
  assert.equal(state.active.questions.length, 0)
})

test('a steering question never receives assistant text from before its admission', () => {
  const state = fold([start(), event('user/message', user()), assistant('before second question'),
    event('user/message', user('note-2', 'user-2')), assistant('after both'), end()])
  assert.equal(state.records[0].questions[0].answer, 'before second question\n\nafter both')
  assert.equal(state.records[0].questions[1].answer, 'after both')
})

test('interrupted response retains text but never advertises a complete answer', () => {
  const partial = assistant('部分')
  partial.data.interrupted = true
  const state = fold([start(), event('user/message', user()), partial, end(1, 'aborted')])
  assert.equal(state.records[0].answer, '部分')
  assert.equal(state.records[0].completed, false)
})

test('restart recovery reads only exact pending sessions and tolerates unavailable logs', async () => {
  const read = []
  const captures = []
  const store = {
    notes: async () => ({ '/book': [
      { kind: 'question', sessionId: 'known', answerState: 'pending' },
      { kind: 'question', sessionId: 'missing', answerState: 'pending' },
      { kind: 'question', sessionId: 'done', answerState: 'answered' },
      { kind: 'note' },
    ] }),
    capture: async (...args) => captures.push(args),
  }
  await recoverAnswers(store, { readSession: async (id) => {
    read.push(id)
    if (id === 'missing') throw new Error('unavailable')
    return { inheritedEventCount: 0, events: [start(), event('user/message', user()), assistant('完整'), end()] }
  } })
  assert.deepEqual(read, ['known', 'missing'])
  assert.equal(captures[0][1].answer, '完整')
  assert.match(store.lastError, /unavailable/)
})

test('corrupted note store cannot become an unhandled startup recovery rejection', async () => {
  const store = { notes: async () => { throw new Error('corrupt notes') } }
  await recoverAnswers(store, {})
  assert.match(store.lastError, /corrupt notes/)
})

test('event listener snapshots the matching turn synchronously and drains on dispose', async () => {
  const listeners = new Map()
  let state = initialAnswers()
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const captures = []
  let released = false
  const ctx = {
    sessionProjections: { register: async () => ({ stateOf: () => state, dispose: async () => { released = true } }) },
    sessions: { list: () => [] },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
  }
  const dispose = await mountAnswerCapture(ctx, { capture: async (_id, record) => {
    await blocked
    captures.push(record)
  } }, { stateSchema: {} })
  const session = { id: 'one' }
  for (const item of [start(), event('user/message', user()), assistant('A'), end(), start(2), event('user/message', user('note-2','user-2')), assistant('B',2), end(2)]) {
    state = foldAnswers(state, item)
    listeners.get('session/event')(session, item)
  }
  const draining = dispose()
  assert.equal(released, false)
  release()
  await draining
  assert.equal(captures.filter((record) => record.ended)[0].answer, 'A')
  assert.equal(captures.filter((record) => record.ended)[1].answer, 'B')
  assert.equal(listeners.size, 0)
  assert.equal(released, true)
})
