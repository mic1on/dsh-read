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
    // Same-bundle notification: an already mounted reader refreshes its archive flag after
    // Settings changes it, without a browser-global event or a polling timer.
    const vaultListeners = new Set()
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
    /**
     * Fold a freshly fetched page into the loaded run.
     *
     * The run is contiguous: `[from, from + items.length)`. Appending and prepending only
     * happen when the page really is adjacent, so a jump (a chapter, a restored position, a
     * restart) starts a fresh run instead of silently splicing in unrelated paragraphs.
     *
     * This is the rule that used to be missing: replacing the run outright is what made
     * everything already read disappear as soon as the next page arrived.
     */
    function mergeWindow(current, payload, direction) {
      if (current.items.length === 0) return { from: payload.from, items: payload.items }
      if (direction === 'append' && payload.from === current.from + current.items.length) {
        return { from: current.from, items: [...current.items, ...payload.items] }
      }
      if (direction === 'prepend' && payload.from + payload.items.length === current.from) {
        return { from: payload.from, items: [...payload.items, ...current.items] }
      }
      return { from: payload.from, items: payload.items }
    }

    /**
     * Paragraphs fetched per request. The loaded run grows and shrinks around the cursor
     * rather than being a single page, so this is a step size, not a limit on history.
     */
    const WINDOW_SIZE = 60
    const DEFAULT_SPEED = { mode: 'medium', speed: 20 }
    const SPEED_STORAGE_KEY = 'dsh-read:speed'

    const AUTO_PAUSE_KEY = 'dsh-read:auto-pause'
    let autoPause = true
    try { autoPause = localStorage.getItem(AUTO_PAUSE_KEY) !== 'false' } catch { /* storage unavailable */ }
    const preferenceListeners = new Set()
    // A conversation switch can unmount the card. Keep its exact cursor in this
    // window only, keyed by invocation rather than book (two cards may read it).
    const cursors = new Map()
    const progressVersions = new Map()
    const progressListeners = new Set()

    function invalidateProgress(path) {
      progressVersions.set(path, (progressVersions.get(path) || 0) + 1)
      for (const [key, checkpoint] of cursors) {
        if (checkpoint.path === path) cursors.delete(key)
      }
      for (const notify of progressListeners) notify(path)
    }

    /** The Settings toggle: module state plus localStorage, no library state. */
    function AutoPauseSettings() {
      const [enabled, setEnabled] = React.useState(autoPause)
      return h('label', { className: 'dshReadVaultRow dshReadAutoPause' },
        h('input', {
          type: 'checkbox', role: 'switch', className: 'dshReadAutoPauseInput',
          'aria-label': '离开阅读时自动暂停',
          checked: enabled,
          onChange: (event) => {
            autoPause = event.target.checked
            try { localStorage.setItem(AUTO_PAUSE_KEY, String(autoPause)) } catch { /* keep in memory */ }
            setEnabled(autoPause)
            for (const notify of preferenceListeners) notify()
          },
        }),
        h('span', { className: 'dshReadVaultTitle' }, '离开阅读时自动暂停'),
        h('span', { className: 'dshReadVaultHelp' }, '切换窗口或会话时暂停，回来后自动继续；手动暂停不受影响。'))
    }

    // The Settings navigation label; its icon uses the dedicated Host-owned slot.
    const SETTINGS_LABEL = '阅读中心'

    const CSS = `
.dshReadCard{margin:8px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column}
/* The reader owns the conversation viewport rather than growing with the text, so the
   page never reflows as paragraphs arrive. Both variables are published by DSH from the
   conversation scroll container itself, so this tracks a resized window with no measuring
   of our own. The gutter covers that container's own 16px top/bottom padding plus the
   card's 8px margins; max() keeps a usable card on a very short window. */
.dshReadCard[data-fill="true"]{height:max(240px, calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px) - var(--dsh-read-gutter,48px)))}
/* Only the prose flexes. Without this the chrome would shrink to fit a viewport-sized
   card and squash its own controls. */
.dshReadCard>*{flex:none}
/* A panel reader fills the box its container gives it; the conversation-sized geometry is
   the card variant's business, not the reader's. */
.dshReadPanelBody{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshReadPanelBody>*{flex:none}
.dshReadCard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* The fold-away chrome keys off :focus-within, so a focused card keeps its controls —
   which is what a keyboard user needs, and the pointer user never sees the difference. */
.dshReadHint{color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.dshReadHead{padding:9px 12px}
.dshReadHeadInner{display:flex;align-items:center;gap:9px}
.dshReadTitle{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshReadMeta{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshReadTag{font-size:10px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);text-transform:uppercase;flex:none}
.dshReadBar{height:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshReadBar i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.dshReadStream{position:relative;flex:1;min-height:0;overflow:auto;padding:14px 16px 18px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dshReadStream::-webkit-scrollbar{width:8px;height:8px}
.dshReadStream::-webkit-scrollbar-track{background:transparent}
.dshReadStream::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:99px}
.dshReadBlock{position:relative;padding:1px 0 1px 13px;margin:0 0 13px;border-left:2px solid var(--dsw-alias-border-l1);line-height:1.95;font-size:14.5px;white-space:pre-wrap;word-break:break-word;opacity:.9}
.dshReadBlock[data-active="true"]{border-left-color:var(--dsw-alias-brand-primary);opacity:1}
/* A passage that carries an annotation keeps a quiet mark, so "where was I confused" is
   answerable at a glance rather than by opening a list. */
.dshReadBlock[data-noted="true"]{border-left-color:var(--dsw-alias-state-warn-primary)}
.dshReadNoteMark{display:inline-block;margin-left:6px;padding:0 5px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;vertical-align:2px;cursor:pointer;font-family:inherit}
.dshReadNoteMark:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
/* The selection bubble floats over the prose, anchored to the passage it is about. */
.dshReadAsk{position:absolute;z-index:6;display:flex;gap:4px;padding:4px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 18px rgba(0,0,0,.26)}
.dshReadAskBtn{padding:4px 9px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit}
.dshReadAskBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshReadAskBtn:disabled{opacity:.45;cursor:default}
/* Brand-filled controls need the theme's own on-brand foreground: brand-primary inverts in
   dark mode (near-white fill), so a hardcoded #fff label would vanish. The fallbacks keep
   older hosts readable: bg-base inverts with the brand, and #fff is the classic look. */
.dshReadAskBtn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base,#fff))}
.dshReadAskBtn[data-variant="primary"]:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.dshReadFigure{margin:0 0 14px;padding:0;display:flex;justify-content:center}
.dshReadFigureImg{max-width:100%;height:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);opacity:.9}
.dshReadFigure[data-active="true"] .dshReadFigureImg{opacity:1;border-color:var(--dsw-alias-brand-primary)}
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
.dshReadBtn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base,#fff))}
.dshReadBtn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));border-color:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.dshReadRange{flex:1;min-width:80px;accent-color:var(--dsw-alias-brand-primary)}
.dshReadSeg{display:flex;flex:none;border-radius:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2)}
.dshReadSegBtn{padding:5px 9px;border:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit}
.dshReadSegBtn:first-child{border-left:0}
.dshReadSegBtn:hover{background:var(--dsw-alias-bg-layer-1)}
.dshReadSegBtn[data-active="true"],.dshReadSegBtn[data-active="true"]:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base,#fff))}
.dshReadSelect{padding:5px 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;max-width:190px;font-family:inherit}
.dshReadNote{padding:12px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.dshReadError{padding:14px 16px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:1.7;white-space:pre-wrap}
.dshReadLib{display:flex;flex-direction:column;height:100%;min-height:320px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshReadLibBar{display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dshReadLibInput{flex:1;min-width:0;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none;font-family:inherit}
.dshReadLibInput:focus{border-color:var(--dsw-alias-brand-primary)}
.dshReadLibToolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dshReadLibSort{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshReadLibToolbar :is(button,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
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
.dshReadLibEditor{display:flex;align-items:center;gap:10px;padding:9px 12px 11px;margin:0 0 9px;border-radius:0 0 10px 10px;border:1px solid var(--dsw-alias-border-l1);border-top:none;background:var(--dsw-alias-bg-base)}
.dshReadLibEditorSlider{flex:1;min-width:120px;accent-color:var(--dsw-alias-brand-primary)}
.dshReadLibEditorLabel{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:150px}
.dshReadLibBook[data-editing="true"]{border-radius:10px 10px 0 0;margin-bottom:0}
.dshReadLibInput:disabled{opacity:.6;cursor:progress}
.dshReadLibEmpty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.8}
.dshReadVault{padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px;flex:none;min-width:0}
.dshReadVaultHead{display:flex;align-items:center;gap:8px;min-width:0}
.dshReadVaultTitle{font-size:12.5px;font-weight:600;flex:1}
.dshReadVaultState{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshReadVaultState[data-enabled="true"]{color:var(--dsw-alias-state-success-primary)}
.dshReadVaultRow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dshReadVaultPath{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center}
.dshReadVaultPath .dshReadLibInput{width:100%;min-width:0;box-sizing:border-box}
.dshReadVaultMore{padding:2px 5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.dshReadVaultMore:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshReadVaultMore:disabled{opacity:.45;cursor:default}
.dshReadVaultActions{justify-content:flex-end}
.dshReadVaultHelp{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap}
.dshReadVaultHelp[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.dshReadVaultConfirm{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}
.dshReadVaultBrowser{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px;display:flex;flex-direction:column;gap:6px}
.dshReadVaultBrowserPath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dshReadVaultFolders{max-height:170px;overflow:auto;display:flex;flex-direction:column;gap:2px}
.dshReadVaultFolder{border:0;border-radius:5px;padding:5px 7px;text-align:left;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshReadVaultFolder:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshReadVaultFolder:disabled{opacity:.5;cursor:default}
.dshReadAutoPause{padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:baseline;cursor:pointer;flex:none}
.dshReadAutoPauseInput{accent-color:var(--dsw-alias-brand-primary);margin:0}

`

    /**
     * The document's current selection.
     *
     * `window.getSelection` is the real source; the fallback exists so the test sandbox —
     * which has no DOM — can present one without a full document implementation.
     */
    function currentSelection() {
      if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
        return window.getSelection()
      }
      return typeof globalThis !== 'undefined' ? globalThis.__dshReadSelection || null : null
    }

    function installStyles() {
      const element = document.createElement('style')
      element.dataset.plugin = 'dsh-read'
      element.textContent = CSS
      document.head.append(element)
      return () => element.remove()
    }

    /** The shell replaces its fallback glyph when this matching icon slot is occupied. */
    function ReadingSettingsIcon({ size = 18 } = {}) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
      },
        h('path', { d: 'M12 7v14' }),
        h('path', { d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 0 0 0-3-3z' }),
      )
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
    /**
     * The reader itself: paragraph engine plus the prose surface.
     *
     * Deliberately independent of where it is mounted. A container decides the geometry and
     * supplies the session's input actions; everything about reading — the typewriter, the
     * window, progress, illustrations, notes — lives here once, so a new reading mode is a
     * new container rather than a second copy of this.
     */
    function ReaderBody({ book, failure, inputActions, useInput, useSessions, cardId, sessionId, variant }) {
      const bookPath = book ? book.path : ''

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
      /** True while a backward load is in flight, so scrolling cannot stack requests. */
      const prepending = React.useRef(false)
      /** The pending selection: which paragraph it came from, the text, and where to draw. */
      const [ask, setAsk] = React.useState(null)
      /** This book's annotations, keyed by paragraph index for the in-flow marks. */
      const [notes, setNotes] = React.useState({})
      // Append hooks after the existing reader state so the playback engine stays untouched.
      const [archiveEnabled, setArchiveEnabled] = React.useState(Boolean(book && book.archiveEnabled))
      const [savingAnnotation, setSavingAnnotation] = React.useState(false)
      const annotationFlight = React.useRef(null)
      const latestAsk = React.useRef(ask)
      const readerContext = React.useRef(null)
      const mounted = React.useRef(true)
      const notesRequest = React.useRef(0)
      const inputFeed = typeof useInput === 'function' ? useInput : (selector) => selector(undefined)
      const revision = inputFeed((input) => input?.draftRev)
      const draftRevision = React.useRef(revision)
      draftRevision.current = revision
      latestAsk.current = ask
      if (!readerContext.current || readerContext.current.path !== bookPath || readerContext.current.sessionId !== sessionId) {
        readerContext.current = { path: bookPath, sessionId }
      }
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      function dismissSelection(selected) {
        if (latestAsk.current !== selected) return
        latestAsk.current = null
        setAsk((current) => current === selected ? null : current)
        const selection = currentSelection()
        // Do not clear a new DOM selection made while the request was in flight.
        if (selection && String(selection.toString()).trim().slice(0, 400) === selected.quote && selection.removeAllRanges) {
          selection.removeAllRanges()
        }
      }

      /**
       * Turn the current selection into a question.
       *
       * Only a selection that sits inside one paragraph is actionable: a quote spanning
       * paragraphs cannot be attributed to a single position, and guessing one would put the
       * note somewhere the reader never pointed at.
       */
      function captureSelection() {
        const invalidate = () => { latestAsk.current = null; setAsk(null) }
        const selection = currentSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return invalidate()
        const text = String(selection.toString()).trim()
        if (!text) return invalidate()

        const range = selection.getRangeAt(0)
        const host =
          range.startContainer.nodeType === 1
            ? range.startContainer
            : range.startContainer.parentElement
        const block = host && host.closest ? host.closest('[data-paragraph]') : null
        if (!block) return invalidate()
        // A quote that crosses paragraphs would be attributed to whichever end was grabbed.
        if (!block.contains(range.endContainer)) return invalidate()

        const rect = range.getBoundingClientRect()
        const stream = scrollRef.current
        const base = stream ? stream.getBoundingClientRect() : { left: 0, top: 0 }
        const selected = {
          paragraph: Number(block.getAttribute('data-paragraph')),
          quote: text.slice(0, 400),
          top: rect.bottom - base.top + (stream ? stream.scrollTop : 0),
          left: Math.max(8, rect.left - base.left),
        }
        latestAsk.current = selected
        setAsk(selected)
      }

      /** Fill only a draft: the reader still decides whether and when to send it. */
      function askAboutSelection() {
        if (!ask || !bookPath || annotationFlight.current) return
        if (!inputActions || typeof inputActions.setDraft !== 'function') {
          setStatus('当前没有可用的输入框，无法提问。')
          return
        }
        const selected = ask
        const context = readerContext.current
        const draftVersion = draftRevision?.current
        const draft = (anchor = '') => `《${book.title || book.name}》（第 ${selected.paragraph + 1} 段）：\n\n「${selected.quote}」${anchor}\n\n`
        if (!archiveEnabled) {
          // Preserve the original synchronous composer handoff when archiving is disabled.
          inputActions.setDraft(draft())
          dismissSelection(selected)
          return
        }
        annotationFlight.current = selected
        setSavingAnnotation(true)
        return (async () => {
          let anchor = ''
          let message = ''
          try {
            const payload = await post('/notes', {
              path: bookPath, paragraph: selected.paragraph, quote: selected.quote,
              kind: 'question', text: '', title: book.title || book.name,
              ...(sessionId ? { sessionId } : {}),
            })
            if (!payload.note || !/^[A-Za-z0-9_-]+$/.test(payload.note.id)) throw new Error('批注标识不可用')
            anchor = `<!--dshr-${payload.note.id}-->`
            message = payload.mdError ? `批注已保存，${payload.mdError}` : ''
            if (mounted.current && readerContext.current === context) void loadNotes()
          } catch (error) {
            message = `未能保存批注，本次提问不会自动归档：${error.message}`
          }
          if (mounted.current && readerContext.current === context) {
            // An old response must not replace a new selection's draft or dismiss its bubble.
            const draftChanged = draftRevision?.current !== draftVersion
            if (latestAsk.current === selected && !draftChanged) {
              inputActions.setDraft(draft(anchor))
              dismissSelection(selected)
            }
            setStatus(message || (draftChanged ? '输入框已更改，未覆盖你的草稿。' : latestAsk.current ? '批注已保存；选区已更改，未填入旧问题。' : ''))
          }
        })().finally(() => {
          annotationFlight.current = null
          if (mounted.current) setSavingAnnotation(false)
        })
      }

      /** Notes are kept independently of any conversation. */
      async function keepAnnotation(kind) {
        if (!ask || !bookPath || annotationFlight.current) return
        const selected = ask
        const context = readerContext.current
        annotationFlight.current = selected
        setSavingAnnotation(true)
        try {
          const payload = await post('/notes', {
            path: bookPath, paragraph: selected.paragraph, quote: selected.quote,
            kind, text: kind === 'question' ? selected.quote : '', title: book.title || book.name,
          })
          if (!mounted.current || readerContext.current !== context) return
          void loadNotes()
          setStatus(payload.mdError ? `批注已保存，${payload.mdError}` : '已记录')
          dismissSelection(selected)
        } catch (error) {
          if (mounted.current && readerContext.current === context) setStatus(error.message)
        } finally {
          annotationFlight.current = null
          if (mounted.current) setSavingAnnotation(false)
        }
      }

      async function loadNotes() {
        if (!bookPath) return
        const context = readerContext.current
        const request = ++notesRequest.current
        try {
          const payload = await call(`/notes?path=${encodeURIComponent(bookPath)}`)
          if (!mounted.current || readerContext.current !== context || request !== notesRequest.current) return
          const byParagraph = {}
          for (const note of payload.notes || []) {
            byParagraph[note.paragraph] = (byParagraph[note.paragraph] || 0) + 1
          }
          setNotes(byParagraph)
          setArchiveEnabled(payload.archiveEnabled === true)
        } catch {
          // annotations are an enhancement; never block reading on them
        }
      }

      React.useEffect(() => {
        setArchiveEnabled(Boolean(book && book.archiveEnabled))
        void loadNotes()
        const onVaultChange = (enabled) => {
          if (mounted.current) setArchiveEnabled(enabled)
          void loadNotes()
        }
        vaultListeners.add(onVaultChange)
        return () => { vaultListeners.delete(onVaultChange); notesRequest.current += 1 }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [bookPath, sessionId])

      /**
       * Extend the loaded run of paragraphs in whichever direction is asked for.
       *
       * `stream` is a contiguous run `[from, from + items.length)`, not a single page: it
       * grows forward as the reader advances and backward when they scroll up, so scrolling
       * up reaches everything already read instead of hitting the edge of a 30-paragraph
       * page. Replacing the run instead of merging is what used to make earlier prose vanish.
       */
      async function loadWindow(from, direction) {
        if (!bookPath) return
        setBusy(true)
        try {
          const payload = await call(
            `/paragraphs?path=${encodeURIComponent(bookPath)}&from=${from}&count=${WINDOW_SIZE}`,
          )
          setStream((current) => mergeWindow(current, payload, direction))
        } catch (error) {
          setStatus(error.message)
          setPlaying(false)
        } finally {
          setBusy(false)
        }
      }

      async function jumpTo(target) {
        if (!book) return
        if (refreshProgress()) return
        setHasRead(true)
        const safe = Math.max(0, Math.min(book.paragraphCount - 1, target))
        if (safe < stream.from || safe >= stream.from + stream.items.length) {
          // A jump is deliberately not adjacent, so it starts a fresh run rather than merging.
          await loadWindow(Math.max(0, safe - 2))
        }
        setIndex(safe)
        setRevealed(0)
      }

      const activeSession = useSessions ? useSessions(readingSession) : sessionId
      const backgroundSession = Boolean(sessionId && sessionId !== activeSession)
      const backgroundSessionRef = React.useRef(backgroundSession)
      backgroundSessionRef.current = backgroundSession
      /** True when auto-pause stopped an active read; coming back resumes it by itself. */
      const autoPaused = React.useRef(false)
      const playingRef = React.useRef(false)
      playingRef.current = playing
      const cursorKey = cardId && sessionId && JSON.stringify([sessionId, cardId, bookPath])
      const cursor = React.useRef(null)
      const loadedProgressVersion = React.useRef(null)
      const [progressVersion, setProgressVersion] = React.useState(progressVersions.get(bookPath) || 0)
      const loadingProgressVersion = React.useRef(progressVersion)
      const [loadRequest, setLoadRequest] = React.useState(0)
      const [hasRead, setHasRead] = React.useState(false)
      const requestedPlayback = React.useRef(false)

      function refreshProgress(play = false) {
        const version = progressVersions.get(bookPath) || 0
        if (loadedProgressVersion.current === version) return false
        requestedPlayback.current = requestedPlayback.current || play
        if (loadingProgressVersion.current === version) return true
        loadingProgressVersion.current = version
        setProgressVersion(version)
        setLoadRequest((request) => request + 1)
        return true
      }

      React.useEffect(() => {
        const onProgressChange = (path) => {
          if (path !== bookPath) return
          loadedProgressVersion.current = null
          cursor.current = null
          autoPaused.current = false
          playingRef.current = false
          setPlaying(false)
          setHasRead(false)
          requestedPlayback.current = false
        }
        progressListeners.add(onProgressChange)
        return () => progressListeners.delete(onProgressChange)
      }, [bookPath])
      // `resume` is "would be reading now": live playback or an auto-pause waiting to
      // continue. A manual pause clears both, so it survives a leave-and-return round trip.
      cursor.current = stream.items.length && loadedProgressVersion.current === progressVersion
        ? { path: bookPath, version: progressVersion, index, revealed, resume: playing || autoPaused.current } : null
      React.useEffect(() => () => {
        if (!cursorKey || !cursor.current
          || cursor.current.version !== (progressVersions.get(cursor.current.path) || 0)) return
        cursors.delete(cursorKey)
        cursors.set(cursorKey, cursor.current)
        if (cursors.size > 256) cursors.delete(cursors.keys().next().value)
      }, [cursorKey])

      /** Away means the reader cannot be watched: another tab, window, app, or session. */
      function readerAway() {
        return backgroundSessionRef.current || document.hidden || document.visibilityState === 'hidden'
          || document.hasFocus?.() === false
      }

      React.useEffect(() => {
        function leave() {
          if (!autoPause) return
          // Only a live read is resumable: pausing on leave must not resurrect one
          // the reader had already paused by hand.
          if (playingRef.current) autoPaused.current = true
          setPlaying(false)
        }
        function check() {
          if (!readerAway() && refreshProgress()) return
          if (readerAway()) {
            leave()
            return
          }
          // Returning mirrors leaving: continue exactly what auto-pause stopped. A manual
          // pause never set the flag, so it stays put across the round trip.
          if (autoPaused.current) {
            autoPaused.current = false
            setPlaying(true)
          }
        }
        check()
        preferenceListeners.add(check)
        window.addEventListener?.('blur', leave)
        window.addEventListener?.('focus', check)
        document.addEventListener?.('visibilitychange', check)
        return () => {
          preferenceListeners.delete(check)
          window.removeEventListener?.('blur', leave)
          window.removeEventListener?.('focus', check)
          document.removeEventListener?.('visibilitychange', check)
        }
      }, [backgroundSession])

      // Opening, explicit progress changes, and retries share this loader. A stale
      // response must not restore a cursor invalidated by a newer progress change.
      React.useEffect(() => {
        if (!bookPath || !book) return undefined
        let cancelled = false
        loadingProgressVersion.current = progressVersion
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
                entry.index <= book.paragraphCount
              ) {
                resumeAt = entry.index
              }
            } catch {
              // progress is a convenience; never block opening on it
            }
            const checkpoint = cursorKey && cursors.get(cursorKey)
            if (checkpoint && checkpoint.index !== null) resumeAt = checkpoint.index
            const from = Math.max(0, Math.min(resumeAt, book.paragraphCount - 1) - 2)
            const payload = await call(
              `/paragraphs?path=${encodeURIComponent(bookPath)}&from=${from}&count=30`,
            )
            if (cancelled || progressVersion !== (progressVersions.get(bookPath) || 0)) return
            loadedProgressVersion.current = progressVersion
            setStatus('')
            setStream({ from: payload.from, items: payload.items })
            setIndex(resumeAt)
            setRevealed(checkpoint ? checkpoint.revealed : 0)
            if (cursorKey) cursors.delete(cursorKey)
            // A checkpoint carries its own intent: `resume` was reading when the card
            // unmounted, so the remount continues by itself. A fresh open plays only
            // from the very start; a returned checkpoint that was paused stays paused.
            const wantsPlay = resumeAt < book.paragraphCount
              && (requestedPlayback.current || (checkpoint ? Boolean(checkpoint.resume) : resumeAt === 0))
            requestedPlayback.current = false
            setHasRead(false)
            const stillAway = (autoPause || progressVersion > 0) && readerAway()
            autoPaused.current = wantsPlay && stillAway
            playingRef.current = wantsPlay && !stillAway
            setPlaying(playingRef.current)
          } catch (error) {
            if (!cancelled) {
              setStatus(error.message)
              setPlaying(false)
            }
          } finally {
            if (!cancelled) {
              if (loadingProgressVersion.current === progressVersion) loadingProgressVersion.current = null
              setBusy(false)
            }
          }
        })()
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [bookPath, loadRequest])

      // One typewriter step. A fresh timeout per step keeps every captured value current.
      React.useEffect(() => {
        if (!book || !playing) return undefined
        if (index >= book.paragraphCount) {
          setPlaying(false)
          return undefined
        }
        const current = stream.items[index - stream.from]
        if (!current) {
          if (!busy) loadWindow(stream.from + stream.items.length, 'append')
          return undefined
        }
        // An illustration has no characters to type, but it must not flash past either:
        // give it a dwell scaled to the reading speed, then move on.
        if (current.image !== undefined) {
          const dwell = Math.max(600, Math.min(2600, (2200 / speed) * 1000))
          const timer = setTimeout(() => {
            if (loadedProgressVersion.current !== (progressVersions.get(bookPath) || 0)) return
            if (!readerAway()) setHasRead(true)
            setIndex(index + 1)
          }, dwell)
          return () => clearTimeout(timer)
        }
        const step = Math.max(1, Math.round(speed / 10))
        const timer = setTimeout(() => {
          if (loadedProgressVersion.current !== (progressVersions.get(bookPath) || 0)) return
          if (!readerAway()) setHasRead(true)
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

      // Extend the run forward before the cursor reaches its end.
      React.useEffect(() => {
        if (!book || busy || loadedProgressVersion.current !== (progressVersions.get(bookPath) || 0)) return
        const loadedEnd = stream.from + stream.items.length
        if (index + 6 >= loadedEnd && loadedEnd < book.paragraphCount) {
          loadWindow(loadedEnd, 'append')
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [book, stream, index, busy])

      // Extend the run backward when the reader scrolls up, so everything already read stays
      // reachable. `prepending` guards against firing a second request while one is in
      // flight, and against the loop that the scroll restore below would otherwise cause.
      React.useEffect(() => {
        const element = scrollRef.current
        if (!element) return undefined
        const onScroll = () => {
          if (prepending.current || busy) return
          if (stream.from === 0) return
          if (element.scrollTop > 240) return
          prepending.current = true
          const anchorHeight = element.scrollHeight
          const anchorTop = element.scrollTop
          loadWindow(Math.max(0, stream.from - WINDOW_SIZE), 'prepend').finally(() => {
            // Keep the reader looking at the same sentence: the run grew above them, so
            // restore the distance from the bottom.
            const node = scrollRef.current
            if (node) node.scrollTop = node.scrollHeight - anchorHeight + anchorTop
            prepending.current = false
          })
        }
        element.addEventListener('scroll', onScroll, { passive: true })
        return () => element.removeEventListener('scroll', onScroll)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [book, stream, index, busy])

      // Persist reading position, debounced, so the book can be resumed later.
      React.useEffect(() => {
        if (!bookPath || !book || !hasRead || loadedProgressVersion.current !== progressVersion) return undefined
        const timer = setTimeout(() => {
          if (progressVersion !== (progressVersions.get(bookPath) || 0)) return
          fetch(`${API}/progress`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: bookPath, name: book.name, index, chars: book.chars }),
          }).catch(() => {})
        }, 1200)
        return () => clearTimeout(timer)
      }, [bookPath, book, index, progressVersion, hasRead])

      // Follow the stream while the reader stays near the bottom.
      React.useEffect(() => {
        const element = scrollRef.current
        if (!element) return
        const away = element.scrollHeight - element.scrollTop - element.clientHeight
        if (away < 160) element.scrollTop = element.scrollHeight
      })

      const rootClass = variant === 'panel' ? 'dshReadPanelBody' : 'dshReadCard'

      if (failure) {
        // An error stays compact: filling the viewport with one line of red text would be
        // worse than the message being small.
        return h('div', { className: rootClass }, h('div', { className: 'dshReadError' }, failure))
      }
      if (!book) {
        return h(
          'div',
          variant === 'panel'
            ? { className: rootClass }
            : { className: rootClass, 'data-fill': 'true' },
          h('div', { className: 'dshReadNote' }, '正在打开…'),
        )
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

      /**
       * Space toggles playback while the reader has focus.
       *
       * Bound to the card rather than to `window`: the composer sits in the same document and
       * a global listener would turn every space the user types into a pause. Focus is what
       * makes the shortcut unambiguous, and it also means two reader cards in one session
       * cannot both react to the same keypress.
       */
      function handleKeyDown(event) {
        if (event.key !== ' ' && event.key !== 'Spacebar') return
        // A keystroke aimed at a control belongs to that control.
        const target = event.target
        const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return
        if (target && target.isContentEditable) return
        // Leave every modified combination alone (browser and OS shortcuts).
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        // Space would otherwise scroll the transcript behind the card.
        event.preventDefault()
        togglePlay()
      }

      function togglePlay() {
        if (refreshProgress(true)) return
        // Any hand on the play control speaks for the reader: an auto-pause waiting to
        // resume is cancelled, and pressing 播放 after it resumes normally.
        autoPaused.current = false
        playingRef.current = atEnd || !playing
        if (atEnd) {
          setIndex(0)
          setRevealed(0)
          loadWindow(0)
          setPlaying(true)
          return
        }
        setPlaying(!playing)
      }

      // Render the whole loaded run up to the cursor, not a fixed window behind it: the
      // reader can scroll back to anything already read. Paragraphs loaded *ahead* of the
      // cursor stay unrendered, which is what keeps the reveal a reveal.
      const blocks = []
      for (let at = 0; at <= local; at += 1) {
        const paragraph = stream.items[at]
        if (!paragraph) continue
        const isCurrent = at === local

        // An illustration sits in the flow where the book put it. It is not typed out, so
        // it is complete the moment it is reached.
        if (paragraph.image !== undefined) {
          blocks.push(
            h(
              'figure',
              {
                key: stream.from + at,
                className: 'dshReadFigure',
                'data-active': isCurrent ? 'true' : 'false',
              },
              h('img', {
                className: 'dshReadFigureImg',
                src: `${API}/image?path=${encodeURIComponent(book.path)}&index=${paragraph.image}`,
                alt: `插图 ${paragraph.image + 1}`,
                loading: 'lazy',
              }),
            ),
          )
          continue
        }

        // A paragraph still being revealed owes the reader a caret whether or not it is playing:
        // pausing mid-paragraph must not look like the text simply stops there.
        const partial = isCurrent && revealed < paragraph.text.length
        const text = isCurrent ? paragraph.text.slice(0, revealed) : paragraph.text
        if (!text && !isCurrent) continue
        const absolute = stream.from + at
        const noted = notes[absolute] || 0
        blocks.push(
          h(
            'div',
            {
              key: absolute,
              className: 'dshReadBlock',
              'data-active': isCurrent ? 'true' : 'false',
              // The anchor a selection resolves against, and where a note mark belongs.
              'data-paragraph': String(absolute),
              'data-noted': noted > 0 ? 'true' : 'false',
            },
            text,
            partial && !atEnd
              ? h('span', {
                  className: 'dshReadCaret',
                  'data-playing': playing ? 'true' : 'false',
                })
              : null,
            noted > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshReadNoteMark',
                    title: `这一段落有 ${noted} 条批注`,
                    onClick: () => setStatus(`第 ${absolute + 1} 段有 ${noted} 条批注`),
                  },
                  noted > 1 ? `\u{1F4AC}${noted}` : '\u{1F4AC}',
                )
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
        {
          className: rootClass,
          ...(variant === 'panel' ? {} : { 'data-fill': 'true' }),
          // Focusable so the reader can own Space without stealing it from the composer.
          tabIndex: 0,
          onFocus: (event) => {
            // Refresh when re-entering the reader, including config changed in another tab
            // or by a tool. Moving among its own buttons need not issue another request.
            if (!event.currentTarget.contains(event.relatedTarget)) void loadNotes()
          },
          onKeyDown: handleKeyDown,
        },
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
            // A selection is only actionable while it exists; clearing on mouse-up keeps a
            // stale bubble from offering to ask about text the reader has moved past.
            onMouseUp: captureSelection,
            onKeyUp: captureSelection,
          },
          blocks,
          ask
            ? h(
                'div',
                {
                  className: 'dshReadAsk',
                  style: { top: `${ask.top}px`, left: `${ask.left}px` },
                  // A button click collapses the DOM selection before its click handler;
                  // don't let the stream's selection capture invalidate that action first.
                  onMouseUp: (event) => event.stopPropagation(),
                  onKeyUp: (event) => event.stopPropagation(),
                },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshReadAskBtn',
                    'data-variant': 'primary',
                    disabled: savingAnnotation,
                    onClick: askAboutSelection,
                  },
                  '问 AI',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshReadAskBtn',
                    disabled: savingAnnotation,
                    onClick: () => keepAnnotation('note'),
                  },
                  '记一笔',
                ),
                h(
                  'button',
                  { type: 'button', className: 'dshReadAskBtn', disabled: savingAnnotation, onClick: () => { latestAsk.current = null; setAsk(null) } },
                  '取消',
                ),
              )
            : null,
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
            // Discoverability: the shortcut only exists while the card holds focus, so it has
            // to say so rather than being an invisible trick.
            h('span', { className: 'dshReadHint', title: '点击卡片后按空格' }, '空格 暂停/继续'),
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

    /**
     * The in-conversation container: unwraps the durable node and mounts the reader.
     *
     * `inputActions` is the session's input facade — a chat node receives it as a standard
     * prop, which is what lets a selection inside the prose become a question in the composer.
     */
    function ReaderCard({ node, inputActions, sessionId, useInput, useSessions }) {
      const data = (node && node.data) || {}
      return h(ReaderBody, {
        book: data.book || null,
        failure: data.error || '',
        inputActions,
        useInput,
        useSessions,
        cardId: node?.id,
        sessionId,
        variant: 'card',
      })
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
    /** Resolve only an explicitly selected session, never a recent/background one. */
    function readingSession(snapshot) {
      if (!snapshot) return undefined
      // Older DSH versions published selection directly on the catalog.
      if (typeof snapshot.current === 'string' && snapshot.current) return snapshot.current
      // Current DSH projects the main conversation's retention into byId. Include
      // rows outside ids (e.g. an opened subagent), and fail closed on ambiguity.
      const main = Object.values(snapshot.byId || {}).filter(
        (row) => row && row.retainedBy && row.retainedBy.mainView > 0,
      )
      return main.length === 1 ? main[0].id : undefined
    }

    /** A quiet, independent settings block; it owns no library or reading state. */
    function NotesVaultSettings({ pickDirectory, directoryCapability, listDirectory } = {}) {
      const [vault, setVault] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState('load')
      const [message, setMessage] = React.useState('')
      const [failed, setFailed] = React.useState(false)
      const [confirmExport, setConfirmExport] = React.useState(false)
      const [showMore, setShowMore] = React.useState(false)
      const [browser, setBrowser] = React.useState(null)
      const [browsing, setBrowsing] = React.useState(false)
      const [browseError, setBrowseError] = React.useState('')
      const browseRequest = React.useRef(0)
      const browseFlight = React.useRef(false)
      const browseAbort = React.useRef(null)
      const mounted = React.useRef(true)
      const revision = React.useRef(0)
      const flight = React.useRef(false)
      const request = React.useRef(0)

      function report(text, error) {
        setMessage(text || '')
        setFailed(Boolean(error))
      }

      function applyVault(payload, editedAt) {
        setVault(payload)
        if (revision.current === editedAt) setDraft(payload.path || '')
      }

      async function refresh() {
        if (flight.current) return
        flight.current = true
        const generation = ++request.current
        const editedAt = revision.current
        setBusy('load')
        try {
          const payload = await call('/vault')
          if (!mounted.current || request.current !== generation) return
          applyVault(payload, editedAt)
          report(payload.error || '', Boolean(payload.error))
        } catch (error) {
          if (mounted.current && request.current === generation) report(error.message, true)
        } finally {
          if (request.current === generation) {
            flight.current = false
            if (mounted.current) setBusy('')
          }
        }
      }

      React.useEffect(() => {
        mounted.current = true
        void refresh()
        return () => {
          mounted.current = false
          request.current += 1
          flight.current = false
          browseRequest.current += 1
          browseAbort.current?.abort()
        }
      }, [])

      function closeBrowser() {
        browseRequest.current += 1
        browseAbort.current?.abort()
        browseFlight.current = false
        setBrowser(null)
        setBrowseError('')
        setBrowsing(false)
      }

      async function browseDirectory(path) {
        const generation = ++browseRequest.current
        browseAbort.current?.abort()
        const controller = new AbortController()
        browseAbort.current = controller
        browseFlight.current = true
        setBrowsing(true)
        setBrowseError('')
        try {
          if (typeof listDirectory !== 'function') throw new Error('目录浏览器不可用')
          const listing = await listDirectory(path, controller.signal)
          if (!mounted.current || generation !== browseRequest.current) return
          if (!listing || typeof listing.path !== 'string' || !Array.isArray(listing.entries)) throw new Error('无效的目录列表')
          setBrowser(listing)
        } catch (error) {
          if (mounted.current && generation === browseRequest.current) setBrowseError(error.message)
        } finally {
          if (mounted.current && generation === browseRequest.current) {
            browseFlight.current = false
            setBrowsing(false)
          }
        }
      }

      function selectBrowsedDirectory() {
        if (!browser?.path || browsing || browseFlight.current) return
        revision.current += 1
        setDraft(browser.path)
        closeBrowser()
        report('', false)
      }

      async function chooseDirectory() {
        if (flight.current || busy || browser) return
        if (typeof pickDirectory !== 'function' && typeof listDirectory !== 'function') {
          report('当前宿主没有可用的目录选择器，请手动填写绝对路径。', true)
          return
        }
        flight.current = true
        const generation = ++request.current
        setBusy('pick')
        setConfirmExport(false)
        report('', false)
        try {
          const kind = typeof directoryCapability === 'function' ? await directoryCapability() : 'native'
          if (!mounted.current || request.current !== generation) return
          if (kind === 'browse') {
            setBrowser({ path: '', entries: [], crumbs: [] })
            await browseDirectory()
            return
          }
          if (kind !== 'native') throw new Error('当前宿主没有可用的目录选择器')
          const selected = await pickDirectory()
          if (!mounted.current || request.current !== generation) return
          // Choosing is not saving: cancellation leaves the existing draft and config intact.
          if (selected === null || selected === undefined) return
          if (typeof selected !== 'string' || !selected.trim()) throw new Error('目录选择器未返回有效路径')
          revision.current += 1
          setDraft(selected)
          report('', false)
        } catch (error) {
          if (mounted.current && request.current === generation) {
            report(`无法选择目录：${error.message}。也可以手动填写绝对路径。`, true)
          }
        } finally {
          if (request.current === generation) {
            flight.current = false
            if (mounted.current) setBusy('')
          }
        }
      }

      async function act(action) {
        if (flight.current || busy || browser) return
        if ((action === 'export' || action === 'open' || action === 'disable') && !(vault && vault.path)) return
        if (action === 'export' && !confirmExport) return
        if (action === 'save' && !draft.trim()) return
        flight.current = true
        const generation = ++request.current
        const editedAt = revision.current
        setBusy(action)
        setConfirmExport(false)
        report('', false)
        try {
          const payload = action === 'save' || action === 'disable'
            ? await post('/vault', { path: action === 'disable' ? '' : draft })
            : await post(action === 'export' ? '/export' : '/vault/open', {})
          if (!mounted.current || request.current !== generation) return
          if (action === 'save' || action === 'disable') {
            applyVault(payload, editedAt)
            for (const listener of vaultListeners) listener(Boolean(payload.path))
          }
          const result = action === 'export' ? payload : payload.migration
          const errors = result && Array.isArray(result.errors) ? result.errors : []
          const hasError = Boolean(payload.error || (result && result.failed))
          const text = hasError && result ? `成功 ${result.exported || 0} 条，失败 ${result.failed || 0} 条。` : ''
          report([text, payload.error, ...errors].filter(Boolean).join('\n'), hasError)
          if (action === 'disable') setShowMore(false)
        } catch (error) {
          if (mounted.current && request.current === generation) report(error.message, true)
        } finally {
          if (request.current === generation) {
            flight.current = false
            if (mounted.current) setBusy('')
          }
        }
      }

      const configured = Boolean(vault && vault.path)
      const locked = busy !== '' || browser !== null
      const actionButton = (label, action, disabled) => h('button', {
        type: 'button', className: 'dshReadBtn', disabled: locked || disabled,
        ...(action === 'save' ? { 'aria-label': '保存归档目录' } : {}),
        onClick: () => act(action),
      }, label)
      return h('section', { className: 'dshReadVault', 'aria-label': '批注归档', 'aria-busy': locked },
        h('div', { className: 'dshReadVaultHead' },
          h('span', { className: 'dshReadVaultTitle' }, '批注归档'),
          h('span', { className: 'dshReadVaultState', 'data-enabled': configured ? 'true' : 'false', role: 'status' },
            vault ? configured ? '已启用' : '未启用' : busy === 'load' ? '加载中…' : '不可用'),
          h('button', {
            type: 'button', className: 'dshReadVaultMore', disabled: locked,
            'aria-expanded': showMore, 'aria-label': '更多归档操作',
            onClick: () => { if (!flight.current) setShowMore((current) => !current) },
          }, showMore ? '更多 ▴' : '更多 ▾'),
        ),
        h('div', { className: 'dshReadVaultPath' },
          h('input', {
            className: 'dshReadLibInput', 'aria-label': 'Markdown 保存目录', value: draft,
            spellCheck: false, placeholder: vault ? vault.suggestedPath : '~/Documents/ReadingNotes',
            disabled: locked && busy !== 'load',
            onChange: (event) => { revision.current += 1; setDraft(event.target.value); setConfirmExport(false); report('', false) },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void act('save') } },
          }),
          h('button', {
            type: 'button', className: 'dshReadBtn', disabled: locked,
            'aria-label': '选择归档目录', onClick: chooseDirectory,
          }, busy === 'pick' ? '选择中…' : '选择…'),
          actionButton('保存', 'save', !draft.trim()),
        ),
        browser ? h('div', {
          className: 'dshReadVaultBrowser', role: 'group', 'aria-label': '选择归档目录',
          onKeyDown: (event) => {
            if (event.key === 'Escape') { event.stopPropagation(); closeBrowser() }
          },
        },
          h('div', { className: 'dshReadVaultRow' },
            h('span', { className: 'dshReadVaultBrowserPath', title: browser.path }, browser.path || '加载中…'),
            h('button', {
              type: 'button', className: 'dshReadBtn', disabled: browsing || !browser.home,
              onClick: () => browseDirectory(browser.home),
            }, '主目录'),
            h('button', {
              type: 'button', className: 'dshReadBtn',
              disabled: browsing || !(browser.crumbs || []).some((crumb) => crumb.path !== browser.path),
              onClick: () => {
                const ancestors = (browser.crumbs || []).filter((crumb) => crumb.path !== browser.path)
                if (ancestors.length) return browseDirectory(ancestors.at(-1).path)
              },
            }, '上一级'),
          ),
          h('div', { className: 'dshReadVaultFolders', 'aria-busy': browsing },
            (browser.entries || []).map((entry) => h('button', {
              key: entry.path, type: 'button', className: 'dshReadVaultFolder',
              title: entry.path, disabled: browsing, onClick: () => browseDirectory(entry.path),
            }, `▸ ${entry.name}`)),
            !browsing && !browser.entries.length && !browseError ? h('span', { className: 'dshReadVaultHelp' }, '没有子目录') : null,
          ),
          browser.truncated ? h('span', { className: 'dshReadVaultHelp' }, '目录列表已截断，可直接输入路径。') : null,
          browseError ? h('div', { className: 'dshReadVaultHelp', 'data-error': 'true', role: 'alert' }, browseError) : null,
          h('div', { className: 'dshReadVaultRow' },
            browseError ? h('button', { type: 'button', className: 'dshReadBtn', disabled: browsing, onClick: () => browseDirectory(browser.path || undefined) }, '重试目录') : null,
            h('button', { type: 'button', className: 'dshReadBtn', disabled: browsing || !browser.path, onClick: selectBrowsedDirectory }, '选择此目录'),
            h('button', { type: 'button', className: 'dshReadBtn', onClick: closeBrowser }, '取消选择'),
          ),
        ) : null,
        showMore ? h('div', { className: 'dshReadVaultRow dshReadVaultActions', 'aria-label': '更多归档操作' },
          h('button', {
            type: 'button', className: 'dshReadBtn', disabled: locked || !configured,
            onClick: () => { if (!flight.current && configured) setConfirmExport(true) },
          }, '导出全部'),
          actionButton('打开目录', 'open', !configured),
          actionButton('停用归档', 'disable', !configured),
        ) : null,
        !vault && !locked ? h('button', { type: 'button', className: 'dshReadBtn', onClick: refresh }, '重试') : null,
        confirmExport ? h('div', { className: 'dshReadVaultConfirm' },
          h('div', { className: 'dshReadVaultHelp' }, '将覆盖插件文件中的手动修改，其他文件不受影响。'),
          h('div', { className: 'dshReadVaultRow' },
            actionButton('确认覆盖并导出', 'export', !configured),
            h('button', { type: 'button', className: 'dshReadBtn', disabled: locked, onClick: () => setConfirmExport(false) }, '取消导出'),
          ),
        ) : null,
        message && failed ? h('div', { className: 'dshReadVaultHelp', 'data-error': 'true', role: 'alert' }, message) : null,
      )
    }

    /** Derive a display list without changing the host's listing or saved progress. */
    function libraryBooks(books, filter, sort, direction) {
      const value = (book) => {
        const number = book.progress && book.progress[sort === 'time' ? 'at' : 'percent']
        return Number.isFinite(number) ? Math.max(0, number) : 0
      }
      return books.filter((book) =>
        filter === 'reading' ? Boolean(book.progress) : filter === 'unread' ? !book.progress : true,
      ).sort((a, b) => {
        const av = value(a)
        const bv = value(b)
        // Unknown timestamps (including unread books) stay last in either direction.
        if (sort === 'time' && Boolean(av) !== Boolean(bv)) return av ? -1 : 1
        return (direction === 'asc' ? av - bv : bv - av)
          || a.name.localeCompare(b.name, 'zh')
          || a.path.localeCompare(b.path, 'zh')
      })
    }

    function LibraryView({ close, useSessions, pickDirectory, directoryCapability, listDirectory }) {
      // `useSessions` is a settings.section standard prop; the fallback keeps the page
      // renderable (session-less) if a host ever mounts it without the standard props.
      const sessionsFeed =
        typeof useSessions === 'function' ? useSessions : (selector) => selector(undefined)
      const currentSession = sessionsFeed(readingSession)
      const [dir, setDir] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [parent, setParent] = React.useState(null)
      const [directories, setDirectories] = React.useState([])
      const [books, setBooks] = React.useState([])
      const [status, setStatus] = React.useState('')
      const [failed, setFailed] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [editing, setEditing] = React.useState('')
      const [scrub, setScrub] = React.useState(0)
      const [scrubMax, setScrubMax] = React.useState(0)
      const [filter, setFilter] = React.useState('all')
      const [sort, setSort] = React.useState('time')
      const [direction, setDirection] = React.useState('desc')
      const visibleBooks = libraryBooks(books, filter, sort, direction)

      // The listing is async, so `draft` starts empty and is filled once it lands. This
      // flag keeps that fill from stomping a directory the user is already typing.
      const typed = React.useRef(false)

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
          setParent(payload.parent)
          setDirectories(payload.directories)
          setBooks(payload.books)
          // Never overwrite what the user has typed since the request went out.
          if (!typed.current) setDraft(payload.dir)
          // Successful loading needs no separate count/status row; errors still surface.
          note('', false)
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

      /**
       * Load the typed directory and remember it. The reply carries the canonical
       * resolved path, so clear the typing flag to let it settle into the field.
       */
      function submitDirectory() {
        typed.current = false
        return load(draft, true)
      }

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
          invalidateProgress(book.path)
          setEditing('')
          await load(dir, false)
        } catch (error) {
          note(error.message, true)
        } finally {
          setBusy('')
        }
      }

      /** Open the scrubber on one book, seeded from where it currently stands. */
      function beginSetProgress(book) {
        const at = book.progress ? book.progress.index : 0
        setEditing(book.path)
        setScrub(at)
      }

      /** Commit the scrubbed paragraph. The host already accepts an arbitrary index. */
      async function saveProgress(book, index) {
        setBusy(book.path)
        try {
          await post('/progress', {
            path: book.path,
            name: book.name,
            index,
            chars: book.progress ? book.progress.chars : 0,
          })
          invalidateProgress(book.path)
          setEditing('')
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

      /** Open the scrubber, fetching the paragraph count when the book was never read. */
      async function beginSetProgress(book) {
        const known = book.progress ? book.progress.paragraphCount : 0
        if (known > 0) {
          setScrubMax(known)
          setScrub(book.progress.index)
          setEditing(book.path)
          return
        }
        // A book with no saved progress carries no paragraph count, and that is exactly
        // the case this feature exists for — so ask the host to parse it.
        setBusy(book.path)
        try {
          const opened = await call(`/open?path=${encodeURIComponent(book.path)}`)
          setScrubMax(opened.book.paragraphCount)
          setScrub(0)
          setEditing(book.path)
        } catch (error) {
          note(error.message, true)
        } finally {
          setBusy('')
        }
      }

      for (const book of visibleBooks) {
        const progress = book.progress
        const isEditing = editing === book.path
        const max = isEditing ? Math.max(1, scrubMax) : 0
        const scrubPercent = max > 0 ? (scrub / max) * 100 : 0

        rows.push(
          h(
            'div',
            { key: `b:${book.path}`, className: 'dshReadLibBook', 'data-editing': isEditing ? 'true' : 'false' },
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
              h(
                'button',
                {
                  className: 'dshReadBtn',
                  disabled: busy !== '',
                  onClick: () => (isEditing ? setEditing('') : beginSetProgress(book)),
                },
                isEditing ? '取消' : '设置进度',
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

        if (isEditing) {
          rows.push(
            h(
              'div',
              { key: `e:${book.path}`, className: 'dshReadLibEditor' },
              h('input', {
                className: 'dshReadLibEditorSlider',
                type: 'range',
                min: '0',
                max: String(max),
                step: '1',
                value: String(Math.min(scrub, max)),
                disabled: busy !== '',
                onChange: (event) => setScrub(Number(event.target.value)),
              }),
              h(
                'span',
                { className: 'dshReadLibEditorLabel' },
                `第 ${Math.min(scrub, max) + 1} / ${max} 段 · ${scrubPercent.toFixed(1)}%`,
              ),
              h(
                'button',
                {
                  className: 'dshReadBtn',
                  'data-variant': 'primary',
                  disabled: busy !== '',
                  onClick: () => saveProgress(book, Math.min(scrub, max)),
                },
                '保存',
              ),
            ),
          )
        }
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
            onChange: (event) => {
              typed.current = true
              setDraft(event.target.value)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') submitDirectory()
            },
          }),
          h(
            'button',
            {
              className: 'dshReadBtn',
              'data-variant': 'primary',
              disabled: busy !== '',
              onClick: submitDirectory,
            },
            '加载',
          ),
        ),
        h('div', { className: 'dshReadLibToolbar', 'aria-label': '书籍筛选与排序' },
          h('div', { className: 'dshReadSeg', role: 'group', 'aria-label': '阅读状态' },
            [['all', '全部'], ['reading', '在读'], ['unread', '未读']].map(([value, label]) =>
              h('button', {
                key: value,
                type: 'button',
                className: 'dshReadSegBtn',
                'data-active': filter === value ? 'true' : 'false',
                'aria-pressed': filter === value,
                onClick: () => { setFilter(value); setEditing('') },
              }, label),
            ),
          ),
          h('label', { className: 'dshReadLibSort' }, '排序',
            h('select', {
              className: 'dshReadSelect', value: sort, 'aria-label': '书籍排序字段',
              title: '最近阅读时间取最后保存进度的时间，手动设置进度也会更新',
              onChange: (event) => setSort(event.target.value),
            },
            h('option', { value: 'time' }, '最近阅读时间'),
            h('option', { value: 'progress' }, '阅读进度')),
          ),
          h('select', {
            className: 'dshReadSelect', value: direction, 'aria-label': '书籍排序方向',
            onChange: (event) => setDirection(event.target.value),
          },
          h('option', { value: 'desc' }, sort === 'time' ? '降序 · 最近优先' : '降序 · 进度高优先'),
          h('option', { value: 'asc' }, sort === 'time' ? '升序 · 最早优先' : '升序 · 进度低优先')),
          h('span', { className: 'dshReadMeta', role: 'status' }, `显示 ${visibleBooks.length} / ${books.length} 本`),
        ),
        status
          ? h(
              'div',
              { className: 'dshReadLibStatus', 'data-error': failed ? 'true' : 'false' },
              status,
            )
          : null,
        h(AutoPauseSettings),
        h(NotesVaultSettings, { pickDirectory, directoryCapability, listDirectory }),
        h('div', { className: 'dshReadLibBody' }, rows,
          visibleBooks.length === 0 ? h('div', { className: 'dshReadLibEmpty' },
            books.length === 0 ? '这个目录里没有书籍。' : '没有符合筛选条件的书籍。',
            h('br'),
            books.length === 0 ? '支持 EPUB / MOBI / AZW3，以及 .txt / .md 等纯文本。'
              : h('button', {
                  type: 'button', className: 'dshReadBtn',
                  onClick: () => { setFilter('all'); setEditing('') },
                }, '查看全部'),
          ) : null,
        ),
      )
    }

    const name = 'dsh-read'
    const inject = ['slots', 'uiConversation']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-read: styles')

      // One Chat node kind per `/read` lifecycle, rendered inside the turn flow.
      ctx.effect(() => ctx.uiConversation.events.register(readerDefinition), 'dsh-read: card')

      // Match the section id so the shell replaces, rather than duplicates, its fallback.
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register({ name: 'settings.section.icon', id: KIND }, ReadingSettingsIcon),
      )

      // Discover the composed capability before invoking its verb. A browse Host must
      // use listDirectory, never native pickDirectory (which correctly refuses it).
      const directoryCapability = async () => (await call('/directory-picker')).kind
      const workspaceService = () => {
        const workspace = ctx.get('uiWorkspace')
        if (!workspace) throw new Error('当前宿主没有可用的目录选择器')
        return workspace
      }
      const pickDirectory = () => workspaceService().pickDirectory()
      const listDirectory = (path, signal) => workspaceService().listDirectory(path, signal)
      const ReadingSettings = (props) => h(LibraryView, { ...props, pickDirectory, directoryCapability, listDirectory })

      // The reading centre lives in Settings (`settings.section`), not as a tab beside
      // 对话/轨迹: it manages the library, and starting a book hands it back to the
      // conversation, where the reader card is the only place reading actually happens.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: KIND, order: 22, label: SETTINGS_LABEL },
          ReadingSettings,
        ),
      )

      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: KIND }, ReaderCard),
      )

      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: COMMAND }, HiddenCommandRow),
      )
    }

    // `mergeWindow` is exported for the test suite only; the loader ignores extra keys.
    module.exports = { name, inject, apply, mergeWindow, NotesVaultSettings }
    return module.exports
  },
})
