/* global window, document, fetch, setTimeout, clearTimeout, localStorage */
// dsh-read — browser half.
//
// Hand-written CJS factory loaded by the DSH web client ModuleLoader: no build
// step, and only `react` plus the injected `slots` / `uiConversation` services are
// consumed. Every filesystem and parsing concern lives in the host half.
//
// The reader is a real Chat node in the conversation stream. `/read <book>` logs
// the ordinary durable `command/run` + `command/done` pair; this half folds those
// two events into one custom node kind (`dsh-read`) and renders a streaming reader
// there. Nothing is added to the session log beyond the command the user typed,
// and the book text never reaches the model.

window.__ModuleLoader__.load({
  id: 'dsh-read',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const API = '/dsh-read/api'
    const KIND = 'dsh-read'
    const COMMAND = 'read'
    // Reading speed. Three presets cover almost every reader; the slider is a
    // deliberate escape hatch, revealed only once the reader picks 自定义.
    //
    // The typewriter advances `round(speed / 10)` characters every 100ms, so the engine's real
    // resolution is 10 字/秒: only multiples of ten keep the "N 字/秒" readout honest. Hence
    // presets on the decade and a slider that steps by ten.
    const SPEED_PRESETS = [
      { id: 'slow', label: '慢', speed: 10 },
      { id: 'medium', label: '中', speed: 20 },
      { id: 'fast', label: '快', speed: 60 },
    ]
    const CUSTOM_SPEED = 'custom'
    const SPEED_MIN = 10
    const SPEED_MAX = 160
    const SPEED_STEP = 10
    const DEFAULT_SPEED = { mode: 'medium', speed: 20 }
    const SPEED_STORAGE_KEY = 'dsh-read:speed'

    // The Settings nav label, and the marker the stylesheet hangs the reading icon on.
    const SETTINGS_LABEL = '阅读中心'
    const SETTINGS_NAV_MARKER = 'data-dsh-read-settings-nav'

    const CSS = `
.dshReadCard{margin:8px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshReadHead{padding:9px 12px}
.dshReadHeadInner{display:flex;align-items:center;gap:9px}
.dshReadTitle{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshReadMeta{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshReadTag{font-size:10px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);text-transform:uppercase;flex:none}
.dshReadBar{height:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshReadBar i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.dshReadStream{max-height:52vh;overflow:auto;padding:14px 16px 18px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dshReadStream::-webkit-scrollbar{width:8px;height:8px}
.dshReadStream::-webkit-scrollbar-track{background:transparent}
.dshReadStream::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:99px}
.dshReadBlock{position:relative;padding:1px 0 1px 13px;margin:0 0 13px;border-left:2px solid var(--dsw-alias-border-l1);line-height:1.95;font-size:14.5px;white-space:pre-wrap;word-break:break-word;opacity:.9}
.dshReadBlock[data-active="true"]{border-left-color:var(--dsw-alias-brand-primary);opacity:1}
.dshReadCaret{display:inline-block;width:7px;height:15px;margin-left:3px;vertical-align:-2px;background:var(--dsw-alias-brand-primary);animation:dshReadBlink 1s steps(1) infinite}
/* Paused mid-paragraph still owes the reader a cursor: hold it steady instead of blinking. */
.dshReadCaret[data-playing="false"]{animation:none;opacity:.7}
@keyframes dshReadBlink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
.dshReadControls{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshReadControlsInner{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshReadChapter{padding:12px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
/* Chrome belongs to the pointer: header, counters, chapter and controls fold away unless the
   pointer — or keyboard focus — is inside the card. Scoped to hover-capable pointers, since a
   touch screen can never summon the bar back. */
.dshReadFold{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .22s ease,opacity .18s ease,padding .22s ease,border-color .22s ease}
.dshReadFold>*{overflow:hidden;min-height:0}
@media (hover:hover){.dshReadCard:not(:hover):not(:focus-within) .dshReadFold{grid-template-rows:0fr;opacity:0;padding-top:0;padding-bottom:0;border-top-color:transparent;pointer-events:none}}
.dshReadBtn{padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit}
.dshReadBtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dshReadBtn:disabled{opacity:.45;cursor:default}
.dshReadBtn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dshReadRange{flex:1;min-width:80px;accent-color:var(--dsw-alias-brand-primary)}
.dshReadSeg{display:flex;flex:none;border-radius:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2)}
.dshReadSegBtn{padding:5px 9px;border:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit}
.dshReadSegBtn:first-child{border-left:0}
.dshReadSegBtn:hover{background:var(--dsw-alias-bg-layer-1)}
.dshReadSegBtn[data-active="true"],.dshReadSegBtn[data-active="true"]:hover{background:var(--dsw-alias-brand-primary);color:#fff}
.dshReadSelect{padding:5px 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;max-width:190px;font-family:inherit}
.dshReadNote{padding:12px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.dshReadError{padding:14px 16px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:1.7;white-space:pre-wrap}
.dshReadLib{display:flex;flex-direction:column;height:100%;min-height:320px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshReadLibBar{display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dshReadLibInput{flex:1;min-width:0;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none;font-family:inherit}
.dshReadLibInput:focus{border-color:var(--dsw-alias-brand-primary)}
.dshReadLibStatus{padding:8px 16px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dshReadLibStatus[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.dshReadLibBody{flex:1;min-height:0;overflow:auto;padding:6px 12px 24px}
.dshReadLibRow{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;cursor:pointer}
.dshReadLibRow:hover{background:var(--dsw-alias-bg-layer-2)}
.dshReadLibBook{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);margin:7px 0;background:var(--dsw-alias-bg-layer-1)}
.dshReadLibBookMain{flex:1;min-width:0}
.dshReadLibBookTitle{display:flex;align-items:center;gap:8px;min-width:0}
.dshReadLibName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshReadLibBookMeta{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:5px;font-variant-numeric:tabular-nums}
.dshReadLibBookActions{display:flex;gap:7px;flex:none}
.dshReadLibEmpty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.8}
/* The settings shell paints a generic gear beside every external section. This marker hides it
   and draws a book instead, in the nav row's own currentColor. */
[data-dsh-read-settings-nav] > svg{display:none}
[data-dsh-read-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 7v14'/%3E%3Cpath d='M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'/%3E%3C/svg%3E") center / contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 7v14'/%3E%3Cpath d='M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'/%3E%3C/svg%3E") center / contain no-repeat}
`

    function installStyles() {
      const element = document.createElement('style')
      element.dataset.plugin = 'dsh-read'
      element.textContent = CSS
      document.head.append(element)
      return () => element.remove()
    }

    /**
     * The settings shell projects no icon field, so it paints its own generic gear on every
     * external section. Tag the nav row whose visible text is our label and let the stylesheet
     * swap that gear for a book — the same DOM adaptation `dsh-better-sidebar` uses.
     *
     * @returns disposer that disconnects observation and removes the markers it owns.
     */
    function registerSettingsNavIcon() {
      // Headless hosts (and the plain-node tests) have no DOM to adapt.
      if (typeof MutationObserver !== 'function') return () => {}
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
        return () => {}
      }
      if (!document.body) return () => {}

      let disposed = false
      const sync = () => {
        if (disposed) return
        for (const button of document.querySelectorAll('[role="dialog"] nav button')) {
          const text = button.textContent ? button.textContent.trim() : ''
          if (text === SETTINGS_LABEL) button.setAttribute(SETTINGS_NAV_MARKER, '')
          else button.removeAttribute(SETTINGS_NAV_MARKER)
        }
      }

      sync()
      const observer = new MutationObserver(sync)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })

      return () => {
        disposed = true
        observer.disconnect()
        for (const element of document.querySelectorAll(`[${SETTINGS_NAV_MARKER}]`)) {
          element.removeAttribute(SETTINGS_NAV_MARKER)
        }
      }
    }

    async function call(path, options) {
      const response = await fetch(API + path, options)
      const payload = await response.json().catch(() => null)
      if (!payload) throw new Error(`请求失败（HTTP ${response.status}）`)
      if (payload.ok !== true) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`)
      return payload
    }

    function formatChars(count) {
      return count >= 10000 ? `${(count / 10000).toFixed(1)} 万字` : `${count} 字`
    }

    function presetSpeed(mode) {
      const preset = SPEED_PRESETS.find((entry) => entry.id === mode)
      return preset ? preset.speed : DEFAULT_SPEED.speed
    }

    /** Keep any incoming number inside the slider's range and on its step. */
    function clampSpeed(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return DEFAULT_SPEED.speed
      const stepped = Math.round(number / SPEED_STEP) * SPEED_STEP
      return Math.min(SPEED_MAX, Math.max(SPEED_MIN, stepped))
    }

    /** The reader's speed choice, remembered across cards and reloads. */
    function readSpeedPreference() {
      try {
        if (typeof localStorage === 'undefined') return { ...DEFAULT_SPEED }
        const saved = JSON.parse(localStorage.getItem(SPEED_STORAGE_KEY) || 'null')
        if (!saved || typeof saved !== 'object') return { ...DEFAULT_SPEED }
        if (saved.mode === CUSTOM_SPEED) return { mode: CUSTOM_SPEED, speed: clampSpeed(saved.speed) }
        if (SPEED_PRESETS.some((entry) => entry.id === saved.mode)) {
          return { mode: saved.mode, speed: presetSpeed(saved.mode) }
        }
      } catch {
        // an unavailable or corrupt store must never stop a book from opening
      }
      return { ...DEFAULT_SPEED }
    }

    function writeSpeedPreference(preference) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(SPEED_STORAGE_KEY, JSON.stringify(preference))
      } catch {
        // private mode or a full quota: keep the in-memory choice only
      }
    }

    async function post(path, body) {
      return call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    /** The in-conversation reader: one durable card per `/read` invocation. */
    function ReaderCard({ node }) {
      const data = (node && node.data) || {}
      const book = data.book || null
      const bookPath = book ? book.path : ''
      const failure = data.error || ''

      const [stream, setStream] = React.useState({ from: 0, items: [] })
      const [index, setIndex] = React.useState(0)
      const [revealed, setRevealed] = React.useState(0)
      const [playing, setPlaying] = React.useState(false)
      const [speedChoice, setSpeedChoice] = React.useState(readSpeedPreference)
      const speed = speedChoice.speed
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // One scroll handle per card: a module-level one would let the newest card hijack the
      // auto-follow of every earlier card in the same session.
      const scrollRef = React.useRef(null)

      async function loadWindow(from) {
        if (!bookPath) return
        setBusy(true)
        try {
          const payload = await call(
            `/paragraphs?path=${encodeURIComponent(bookPath)}&from=${from}&count=30`,
          )
          setStream({ from: payload.from, items: payload.items })
        } catch (error) {
          setStatus(error.message)
          setPlaying(false)
        } finally {
          setBusy(false)
        }
      }

      async function jumpTo(target) {
        if (!book) return
        const safe = Math.max(0, Math.min(book.paragraphCount - 1, target))
        if (safe < stream.from || safe >= stream.from + stream.items.length) {
          await loadWindow(Math.max(0, safe - 2))
        }
        setIndex(safe)
        setRevealed(0)
      }

      // Open once per book path: resume from saved progress, then start reading.
      React.useEffect(() => {
        if (!bookPath || !book) return undefined
        let cancelled = false
        void (async () => {
          setBusy(true)
          try {
            let resumeAt = 0
            try {
              const saved = await call('/progress')
              const entry = saved.progress ? saved.progress[bookPath] : undefined
              if (
                entry &&
                Number.isFinite(entry.index) &&
                entry.index > 0 &&
                entry.index < book.paragraphCount
              ) {
                resumeAt = entry.index
              }
            } catch {
              // progress is a convenience; never block opening on it
            }
            const from = Math.max(0, resumeAt - 2)
            const payload = await call(
              `/paragraphs?path=${encodeURIComponent(bookPath)}&from=${from}&count=30`,
            )
            if (cancelled) return
            setStream({ from: payload.from, items: payload.items })
            setIndex(resumeAt)
            setRevealed(0)
            setPlaying(resumeAt === 0)
          } catch (error) {
            if (!cancelled) {
              setStatus(error.message)
              setPlaying(false)
            }
          } finally {
            if (!cancelled) setBusy(false)
          }
        })()
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [bookPath])

      // One typewriter step. A fresh timeout per step keeps every captured value current.
      React.useEffect(() => {
        if (!book || !playing) return undefined
        if (index >= book.paragraphCount) {
          setPlaying(false)
          return undefined
        }
        const current = stream.items[index - stream.from]
        if (!current) {
          if (!busy) loadWindow(index)
          return undefined
        }
        const step = Math.max(1, Math.round(speed / 10))
        const timer = setTimeout(() => {
          const next = revealed + step
          if (next < current.text.length) {
            setRevealed(next)
            return
          }
          setRevealed(0)
          setIndex(index + 1)
        }, 100)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [book, playing, stream, index, revealed, speed, busy])

      // Fetch the next page before the cursor runs off the loaded paragraphs.
      React.useEffect(() => {
        if (!book || busy) return
        const loadedEnd = stream.from + stream.items.length
        if (index + 6 >= loadedEnd && loadedEnd < book.paragraphCount) loadWindow(loadedEnd)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [book, stream, index, busy])

      // Persist reading position, debounced, so the book can be resumed later.
      React.useEffect(() => {
        if (!bookPath || !book) return undefined
        const timer = setTimeout(() => {
          fetch(`${API}/progress`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: bookPath, name: book.name, index, chars: book.chars }),
          }).catch(() => {})
        }, 1200)
        return () => clearTimeout(timer)
      }, [bookPath, book, index])

      // Follow the stream while the reader stays near the bottom.
      React.useEffect(() => {
        const element = scrollRef.current
        if (!element) return
        const away = element.scrollHeight - element.scrollTop - element.clientHeight
        if (away < 160) element.scrollTop = element.scrollHeight
      })

      if (failure) {
        return h('div', { className: 'dshReadCard' }, h('div', { className: 'dshReadError' }, failure))
      }
      if (!book) {
        return h('div', { className: 'dshReadCard' }, h('div', { className: 'dshReadNote' }, '正在打开…'))
      }

      const local = index - stream.from
      const current = stream.items[local]
      const atEnd = index >= book.paragraphCount
      // Before the window loads there is no paragraph offset yet: fall back to the paragraph
      // ratio, so the bar never flashes to 100% and then snaps back.
      const cursorOffset = current
        ? current.offset
        : book.paragraphCount > 0
          ? (index / book.paragraphCount) * book.chars
          : 0
      const percent = book.chars > 0 ? Math.min(100, ((cursorOffset + revealed) / book.chars) * 100) : 0

      let chapterIndex = -1
      for (let at = 0; at < book.chapters.length; at += 1) {
        if (book.chapters[at].offset <= cursorOffset) chapterIndex = at
        else break
      }
      const chapterName =
        chapterIndex >= 0 && book.chapters[chapterIndex] ? book.chapters[chapterIndex].title : ''

      /**
       * Pick a preset, or enter/stay in 自定义. Entering 自定义 seeds the slider
       * with the speed already in effect, so the text never jumps on the switch.
       */
      function chooseSpeed(mode, value) {
        const next =
          mode === CUSTOM_SPEED
            ? { mode: CUSTOM_SPEED, speed: clampSpeed(value === undefined ? speed : value) }
            : { mode, speed: presetSpeed(mode) }
        writeSpeedPreference(next)
        setSpeedChoice(next)
      }

      function togglePlay() {
        if (atEnd) {
          setIndex(0)
          setRevealed(0)
          loadWindow(0)
          setPlaying(true)
          return
        }
        setPlaying(!playing)
      }

      const blocks = []
      const startLocal = Math.max(0, local - 120)
      for (let at = startLocal; at <= local; at += 1) {
        const paragraph = stream.items[at]
        if (!paragraph) continue
        const isCurrent = at === local
        // A paragraph still being revealed owes the reader a caret whether or not it is playing:
        // pausing mid-paragraph must not look like the text simply stops there.
        const partial = isCurrent && revealed < paragraph.text.length
        const text = isCurrent ? paragraph.text.slice(0, revealed) : paragraph.text
        if (!text && !isCurrent) continue
        blocks.push(
          h(
            'div',
            {
              key: stream.from + at,
              className: 'dshReadBlock',
              'data-active': isCurrent ? 'true' : 'false',
            },
            text,
            partial && !atEnd
              ? h('span', {
                  className: 'dshReadCaret',
                  'data-playing': playing ? 'true' : 'false',
                })
              : null,
          ),
        )
      }
      if (blocks.length === 0) {
        blocks.push(
          h(
            'div',
            { key: 'placeholder', className: 'dshReadNote' },
            atEnd ? '已经读完了。' : '准备中…',
          ),
        )
      }

      const chapterSelect =
        book.chapters.length > 0
          ? h(
              'select',
              {
                className: 'dshReadSelect',
                value: String(chapterIndex),
                onChange: (event) => {
                  const next = Number(event.target.value)
                  if (next >= 0) jumpTo(book.chapters[next].index)
                },
              },
              h('option', { value: '-1' }, '目录'),
              book.chapters.map((chapter) =>
                h('option', { key: chapter.index, value: String(chapter.index) }, chapter.title),
              ),
            )
          : null

      return h(
        'div',
        { className: 'dshReadCard' },
        h(
          'div',
          { className: 'dshReadHead dshReadFold' },
          h(
            'div',
            { className: 'dshReadHeadInner' },
            h('span', null, '\u{1F4D6}'),
            h('div', { className: 'dshReadTitle' }, book.title || book.name),
            h('span', { className: 'dshReadTag' }, book.format),
            h(
              'span',
              { className: 'dshReadMeta' },
              `${percent.toFixed(1)}% · 第 ${Math.min(index + 1, book.paragraphCount)} / ${book.paragraphCount} 段`,
            ),
          ),
        ),
        h('div', { className: 'dshReadBar' }, h('i', { style: { width: `${percent.toFixed(2)}%` } })),
        h(
          'div',
          {
            className: 'dshReadStream',
            ref: (element) => {
              scrollRef.current = element
            },
          },
          blocks,
        ),
        h(
          'div',
          { className: 'dshReadControls dshReadFold' },
          h(
            'div',
            { className: 'dshReadControlsInner' },
            h(
              'button',
              { className: 'dshReadBtn', 'data-variant': 'primary', onClick: togglePlay },
              atEnd ? '重新开始' : playing ? '暂停' : '播放',
            ),
            h(
              'button',
              { className: 'dshReadBtn', disabled: index <= 0, onClick: () => jumpTo(index - 1) },
              '上一段',
            ),
            h(
              'button',
              { className: 'dshReadBtn', disabled: atEnd, onClick: () => jumpTo(index + 1) },
              '下一段',
            ),
            h('span', { className: 'dshReadMeta' }, '速度'),
            h(
              'div',
              { className: 'dshReadSeg', role: 'group', 'aria-label': '播放速度' },
              SPEED_PRESETS.map((preset) =>
                h(
                  'button',
                  {
                    key: preset.id,
                    type: 'button',
                    className: 'dshReadSegBtn',
                    'data-active': speedChoice.mode === preset.id ? 'true' : 'false',
                    title: `${preset.label} · ${preset.speed} 字/秒`,
                    onClick: () => chooseSpeed(preset.id),
                  },
                  preset.label,
                ),
              ),
              h(
                'button',
                {
                  key: CUSTOM_SPEED,
                  type: 'button',
                  className: 'dshReadSegBtn',
                  'data-active': speedChoice.mode === CUSTOM_SPEED ? 'true' : 'false',
                  title: '拖动滑块自定义速度',
                  onClick: () => chooseSpeed(CUSTOM_SPEED),
                },
                '自定义',
              ),
            ),
            // The slider only exists in 自定义 mode: the presets need no fine tuning.
            speedChoice.mode === CUSTOM_SPEED
              ? h('input', {
                  className: 'dshReadRange',
                  type: 'range',
                  min: String(SPEED_MIN),
                  max: String(SPEED_MAX),
                  step: String(SPEED_STEP),
                  value: String(speed),
                  'aria-label': '自定义速度',
                  onChange: (event) => chooseSpeed(CUSTOM_SPEED, Number(event.target.value)),
                })
              : null,
            h('span', { className: 'dshReadMeta' }, `${speed} 字/秒`),
            chapterSelect,
          ),
        ),
        status ? h('div', { className: 'dshReadError' }, status) : null,
        chapterName
          ? h(
              'div',
              { className: 'dshReadChapter dshReadFold' },
              h('div', { className: 'dshReadChapterInner' }, `本章：${chapterName}`),
            )
          : null,
      )
    }

    /** The generic command row would show the raw metadata JSON; the card replaces it. */
    function HiddenCommandRow() {
      return null
    }

    /**
     * Fold the durable command lifecycle of `/read` into one Chat node.
     *
     * `command/run` carries the command name; `command/done` carries the settled
     * result, whose text is the book metadata the host resolved.
     */
    const readerDefinition = {
      kind: KIND,
      target: 'chat',
      match(event) {
        if (event.type === 'command/run' && event.data.name === COMMAND) {
          return { id: String(event.data.commandId), role: 'start' }
        }
        if (event.type === 'command/done') {
          return { id: String(event.data.commandId), role: 'update' }
        }
        return null
      },
      start() {
        return { book: null, error: '' }
      },
      update(context, match) {
        const data = match.event.data
        if (data.kind !== 'success') {
          return { book: null, error: String(data.text || '这条命令没有成功') }
        }
        try {
          const parsed = JSON.parse(data.text)
          if (!parsed || typeof parsed.path !== 'string') throw new Error('missing path')
          return { book: parsed, error: '' }
        } catch {
          return { book: null, error: '无法解析 /read 的返回值' }
        }
      },
      buildViewNode(context) {
        if (context.start === undefined) return null
        const state = context.state
        if (!state.book && !state.error) return null
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: context.start.event.seq,
          location: context.start.location,
          visibility: 'visible',
          data: { book: state.book, error: state.error },
        }
      },
    }

    function formatSize(bytes) {
      if (!bytes) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    }

    /**
     * The 阅读 settings page: browse a library directory, see each book's progress,
     * and start reading.
     *
     * Starting hands off to the host, which runs the same `/read` command the
     * composer would — so the book appears as the ordinary reader card in the
     * conversation, and this section owns none of the reading state itself. It
     * targets whichever session the shell currently has selected, which is also
     * where the user lands once the panel closes.
     */
    function LibraryView({ close, useSessions }) {
      // `useSessions` is a settings.section standard prop; the fallback keeps the page
      // renderable (session-less) if a host ever mounts it without the standard props.
      const sessionsFeed =
        typeof useSessions === 'function' ? useSessions : (selector) => selector(undefined)
      const currentSession = sessionsFeed((snapshot) => (snapshot ? snapshot.current : undefined))
      const [dir, setDir] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [parent, setParent] = React.useState(null)
      const [directories, setDirectories] = React.useState([])
      const [books, setBooks] = React.useState([])
      const [status, setStatus] = React.useState('')
      const [failed, setFailed] = React.useState(false)
      const [busy, setBusy] = React.useState('')

      function note(message, isFailure) {
        setStatus(message || '')
        setFailed(Boolean(isFailure))
      }

      async function load(target, remember) {
        setBusy(remember ? 'save' : 'load')
        try {
          const payload = remember
            ? await post('/library', { dir: target })
            : await call(`/library${target ? `?dir=${encodeURIComponent(target)}` : ''}`)
          setDir(payload.dir)
          setDraft(payload.dir)
          setParent(payload.parent)
          setDirectories(payload.directories)
          setBooks(payload.books)
          note(
            payload.books.length > 0 ? `共 ${payload.books.length} 本书` : '这个目录里没有书籍',
            payload.books.length === 0,
          )
        } catch (error) {
          note(error.message, true)
        } finally {
          setBusy('')
        }
      }

      React.useEffect(() => {
        load('', false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      async function startReading(book) {
        if (!currentSession) {
          note('当前没有打开的会话：先在「对话」里发一条消息，再回到这里开始阅读。', true)
          return
        }
        setBusy(book.path)
        try {
          await post('/start', { sessionId: String(currentSession), path: book.path })
          note('', false)
          // The card now exists in the conversation; step aside and show it.
          if (typeof close === 'function') close()
        } catch (error) {
          note(error.message, true)
        } finally {
          setBusy('')
        }
      }

      async function resetProgress(book) {
        setBusy(book.path)
        try {
          await post('/progress', { path: book.path, clear: true })
          await load(dir, false)
        } catch (error) {
          note(error.message, true)
        } finally {
          setBusy('')
        }
      }

      const rows = []

      for (const directory of directories) {
        rows.push(
          h(
            'div',
            {
              key: `d:${directory.path}`,
              className: 'dshReadLibRow',
              title: directory.path,
              onClick: () => load(directory.path, false),
            },
            h('span', null, '\u{1F4C1}'),
            h('span', { className: 'dshReadLibName' }, directory.name),
            h('span', { className: 'dshReadMeta' }, '目录'),
          ),
        )
      }

      for (const book of books) {
        const progress = book.progress
        rows.push(
          h(
            'div',
            { key: `b:${book.path}`, className: 'dshReadLibBook' },
            h(
              'div',
              { className: 'dshReadLibBookMain' },
              h(
                'div',
                { className: 'dshReadLibBookTitle' },
                h('span', null, '\u{1F4D6}'),
                h('span', { className: 'dshReadLibName', title: book.path }, book.name),
                h('span', { className: 'dshReadTag' }, book.extension),
                h('span', { className: 'dshReadMeta' }, formatSize(book.size)),
              ),
              h(
                'div',
                { className: 'dshReadLibBookMeta' },
                progress
                  ? `已读 ${progress.percent.toFixed(1)}% · 第 ${progress.index + 1}${
                      progress.paragraphCount ? ` / ${progress.paragraphCount}` : ''
                    } 段`
                  : '未开始',
              ),
              progress
                ? h(
                    'div',
                    { className: 'dshReadBar', style: { marginTop: '7px' } },
                    h('i', { style: { width: `${progress.percent.toFixed(2)}%` } }),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dshReadLibBookActions' },
              h(
                'button',
                {
                  className: 'dshReadBtn',
                  'data-variant': 'primary',
                  disabled: busy !== '',
                  onClick: () => startReading(book),
                },
                busy === book.path ? '…' : progress ? '继续阅读' : '开始阅读',
              ),
              progress
                ? h(
                    'button',
                    {
                      className: 'dshReadBtn',
                      disabled: busy !== '',
                      onClick: () => resetProgress(book),
                    },
                    '重置进度',
                  )
                : null,
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dshReadLib' },
        h(
          'div',
          { className: 'dshReadLibBar' },
          h(
            'button',
            {
              className: 'dshReadBtn',
              disabled: !parent || busy !== '',
              onClick: () => load(parent, false),
            },
            '\u2191 上一级',
          ),
          h('input', {
            className: 'dshReadLibInput',
            value: draft,
            spellCheck: false,
            placeholder: '书籍目录绝对路径，例如 ~/Books',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') load(draft, true)
            },
          }),
          h(
            'button',
            {
              className: 'dshReadBtn',
              'data-variant': 'primary',
              disabled: busy !== '',
              onClick: () => load(draft, true),
            },
            '加载',
          ),
        ),
        status
          ? h(
              'div',
              { className: 'dshReadLibStatus', 'data-error': failed ? 'true' : 'false' },
              status,
            )
          : null,
        rows.length > 0
          ? h('div', { className: 'dshReadLibBody' }, rows)
          : h(
              'div',
              { className: 'dshReadLibEmpty' },
              '这个目录里没有书籍。',
              h('br'),
              '支持 EPUB / MOBI / AZW3，以及 .txt / .md 等纯文本。',
            ),
      )
    }

    const name = 'dsh-read'
    const inject = ['slots', 'uiConversation']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-read: styles')

      // One Chat node kind per `/read` lifecycle, rendered inside the turn flow.
      ctx.effect(() => ctx.uiConversation.events.register(readerDefinition), 'dsh-read: card')

      // Give the 阅读中心 nav row a book instead of the shell's generic gear.
      ctx.effect(() => registerSettingsNavIcon(), 'dsh-read: settings navigation icon')

      // The reading centre lives in Settings (`settings.section`), not as a tab beside
      // 对话/轨迹: it manages the library, and starting a book hands it back to the
      // conversation, where the reader card is the only place reading actually happens.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: KIND, order: 22, label: SETTINGS_LABEL },
          LibraryView,
        ),
      )

      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: KIND }, ReaderCard),
      )

      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: COMMAND }, HiddenCommandRow),
      )
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
