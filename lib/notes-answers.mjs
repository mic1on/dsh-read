// Pure, replayable session fold. Only committed user/assistant text is archived;
// tool results, reasoning, provider attempts, and fork-inherited exchanges are not.
const MARKER = /<!--dshr-([A-Za-z0-9_-]{1,100})-->/g
const ANSWER_LIMIT = 2 * 1024 * 1024
const QUESTION_LIMIT = 100000

export function initialAnswers(inheritedEventCount = 0) {
  return { inheritedEventCount, active: null, records: [] }
}

export function textOf(message) {
  return (message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n\n')
}

export function questionMarkers(message) {
  if (message?.role !== 'user' || message.source?.kind !== 'user') return []
  const text = textOf(message)
  const matches = [...text.matchAll(MARKER)]
  // The generated prefix ends at the marker; save what the reader actually typed.
  // For an edited/custom prompt keep the whole text (minus markup), never guess.
  const prefix = /^《[^\n]*》（第 \d+ 段）：\n\n「[\s\S]*?」<!--dshr-[A-Za-z0-9_-]+-->/
  const question = text.replace(prefix, '').replace(MARKER, '').trim().slice(0, QUESTION_LIMIT)
  return [...new Set(matches.map((match) => match[1]))].map((id) => ({
    id, messageId: String(message.id || ''), question,
  }))
}

export function foldAnswers(state, event) {
  if (event.seq < state.inheritedEventCount) return state
  const data = event.data || {}
  if (event.type === 'turn/start') {
    return { ...state, active: { turn: data.turn, startedAt: event.time, questions: [], answer: '', truncated: false, interrupted: false } }
  }
  const active = state.active
  if (!active) return state
  if (event.type === 'user/message' && (!event.surfaceOp || event.surfaceOp === 'append')) {
    const additions = questionMarkers(data)
    if (!additions.length) return state
    const questions = [...active.questions]
    for (const entry of additions) if (!questions.some((known) => known.id === entry.id)) questions.push({ ...entry, answer: '' })
    return { ...state, active: { ...active, questions } }
  }
  if (event.type === 'assistant/message' && data.turn === active.turn && active.questions.length) {
    const text = textOf(data.message)
    if (!text && !data.interrupted) return state
    const combined = [active.answer, text].filter(Boolean).join('\n\n')
    return { ...state, active: {
      ...active, answer: combined.slice(0, ANSWER_LIMIT),
      truncated: active.truncated || combined.length > ANSWER_LIMIT,
      interrupted: active.interrupted || Boolean(data.interrupted),
      questions: active.questions.map((question) => ({
        ...question, answer: [question.answer || '', text].filter(Boolean).join('\n\n').slice(0, ANSWER_LIMIT),
      })),
    } }
  }
  if (event.type === 'turn/end' && data.turn === active.turn) {
    const record = {
      ...active, ended: true,
      completed: data.reason?.kind === 'completed' && !active.interrupted,
      finishedAt: event.time,
    }
    return {
      ...state, active: null,
      // Keep only the last completion in checkpoints. Cold recovery processes each
      // turn as it replays, so dozens of multi-megabyte answers need not stay resident.
      records: active.questions.length ? [record] : state.records,
    }
  }
  return state
}

/** Called at user admission and turn completion, not on live token publication. */
export async function mountAnswerCapture(ctx, store, { stateSchema }) {
  const projections = ctx.sessionProjections
  const handle = await projections.register({
    key: 'dsh-read.answers', stateVersion: 2, stateSchema,
    init: (_header, inherited) => initialAnswers(inherited), apply: foldAnswers,
  })
  let disposed = false
  const pending = new Set()
  const run = (operation) => {
    if (disposed) return Promise.resolve()
    const task = Promise.resolve().then(operation).catch((error) => {
      store.lastError = `问答归档失败：${error.message}`
    }).finally(() => pending.delete(task))
    pending.add(task)
    return task
  }
  const consume = (session, event) => {
    if (!['user/message', 'turn/end'].includes(event.type)) return
    const state = handle.stateOf(session)
    // Read synchronously so two rapidly committed turns cannot cross-associate.
    const record = event.type === 'user/message' ? state.active : state.records.at(-1)
    if (!record?.questions.length) return
    if (event.type === 'turn/end' && record.turn !== event.data.turn) return
    // A long-running reply stays pending until the next recovery pass.
    if (record.ended && record.finishedAt - record.startedAt > 10 * 60 * 1000) return
    void run(() => store.capture(String(session.id), record))
  }
  const disposers = [
    ctx.on('session/event', consume),
    ctx.on('session/created', (session) => {
      const state = handle.stateOf(session)
      for (const record of state.records) void run(() => store.capture(String(session.id), record))
      if (state.active?.questions.length) void run(() => store.capture(String(session.id), state.active))
    }),
  ]
  // A hot install must also reconcile already mounted sessions.
  for (const session of ctx.sessions.list()) {
    const state = handle.stateOf(session)
    for (const record of state.records) void run(() => store.capture(String(session.id), record))
    if (state.active?.questions.length) void run(() => store.capture(String(session.id), state.active))
  }
  return async () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) dispose()
    await Promise.all([...pending])
    await handle.dispose()
  }
}

/** Known-session recovery only: never enumerate or decompress other conversations. */
export async function recoverAnswers(store, query) {
  let notes
  try {
    if (store.retryMirrors) await store.retryMirrors()
    notes = await store.notes()
  }
  catch (error) {
    store.lastError = `问答恢复失败：${error.message}`
    return
  }
  const ids = new Set(Object.values(notes).flatMap((list) => Array.isArray(list)
    ? list.filter((note) => note.kind === 'question' && note.sessionId && note.answerState !== 'answered').map((note) => note.sessionId)
    : []))
  for (const id of ids) {
    try {
      const snapshot = await query.readSession(id)
      let state = initialAnswers(snapshot.inheritedEventCount)
      for (const event of snapshot.events) {
        state = foldAnswers(state, event)
        if (event.type === 'turn/end') {
          const record = state.records.at(-1)
          if (record?.turn === event.data.turn) await store.capture(id, record)
        }
      }
      if (state.active?.questions.length) await store.capture(id, state.active)
    } catch (error) {
      store.lastError = `部分问答尚未恢复：${error.message}`
    }
  }
}
