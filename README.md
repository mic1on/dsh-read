# dsh-read

Read the EPUB / MOBI / plain-text books on your disk **inside the conversation**, streamed
like an AI reply.

`dsh-read` adds a `/read` command to DeepSeek Harness. Type `/read` with a book and the text
appears as a card in the conversation flow, revealed one character at a time, with speed
control, pause, a table of contents and per-book resume.

```
You  ▸ /read ~/Books/三体.epub

  ┌──────────────────────────────────────────────────────┐
  │ 📖 三体            [EPUB]   42.7% · 第 118 / 642 段   │
  │ ──────────────────────────────────────────────────── │
  │ │ 港口的雾还没散，老周就已经坐在了堤坝上。            │
  │ │ 他数着进港的船，一条，两条……                       │
  │ █                                                     │
  │                                                       │
  │ [暂停] [上一段] [下一段] [慢│中│快] 20 字/秒  [目录▾] │
  └──────────────────────────────────────────────────────┘
```

## Features

- **In the conversation, not beside it.** The reader is a real Chat node in the transcript,
  rendered in the turn flow where you typed `/read`.
- **A fixed reading area.** The card claims the conversation viewport rather than growing with
  the text, so the transcript never reflows as paragraphs arrive and the prose scrolls inside
  the card. It tracks a resized window and a changing composer height by reading the two CSS
  variables DSH already publishes from the conversation scroll container.
- **Streams like a reply.** Paragraphs are revealed character by character, with a caret on
  the active one.
- **Speed, pause, seek.** 慢 / 中 / 快 presets (10 / 20 / 60 字/秒), and a 自定义 slider from 10 to
  160 characters per second that appears only once you pick it. Play/pause, previous/next
  paragraph, restart, and a chapter dropdown — and your speed choice is remembered.
- **Chrome on demand.** The header, the chapter line and the control bar fold away while you read
  and slide back the moment the pointer enters the card — or a control takes keyboard focus. Only
  the thin progress line stays behind.
- **Progress everywhere.** A live percentage in the card, and the same percentage listed per
  book in the 阅读 tab — saved per book, so reopening resumes where you stopped.
- **Zero tokens.** `/read` runs entirely outside the model: the command's lifecycle is logged
  directly with no turn wrapping it, and the book text never enters the context.
- **EPUB, MOBI and text.** EPUB is read through its OPF spine, MOBI through its PalmDB /
  PalmDOC records, and `.txt` / `.md` through encoding sniffing that falls back to
  GB18030/GBK/Big5 for Chinese novels that are not UTF-8.
- **Natural-language discovery.** A `book_search` tool lets the agent find a book by name;
  you then open it with `/read`.

## Install

`dsh plugin add` is a thin pnpm forwarder, so it accepts any pnpm specifier — including a
GitHub repo. Nothing needs to be published to npm first:

```bash
# straight from GitHub
dsh plugin --profile web add github:mic1on/dsh-read

# pinned to a tag, for a reproducible install
dsh plugin --profile web add github:mic1on/dsh-read#v0.1.0

# from a local checkout
dsh plugin --profile web add -w link:/path/to/dsh-read
```

Use the profile you actually run (`web` for the browser GUI), then **restart DSH**. The
client bundle is composed at boot, so reloading the page is not enough.

There is no build step and no `prepare` script: everything the plugin needs ships as source,
so a git install works as-is.

## Usage

### Settings → 阅读中心 (the reading centre)

Open **设置** at the foot of the sidebar, then pick **阅读中心** — the row whose icon is a book
rather than the shell's generic gear. It lives here instead of as a tab beside 对话 / 轨迹, so the
conversation header stays down to the two views that belong to a session.

- The directory bar shows the library root the plugin remembers, and it is refilled every time
  the page opens. Type any absolute path and press 加载 to switch — that directory becomes the
  primary library root and is remembered from then on.
- Subdirectories are listed first, so you can walk down to where your books live.
- Every book shows its format, size and progress (`已读 5.9% · 第 124 / 2083 段`, or 未开始).
- **开始阅读 / 继续阅读** runs the same `/read` command in the session the shell currently has
  selected, then closes settings so you land on the card, resuming from the saved paragraph.
- **设置进度** opens a slider under the book so you can move its position anywhere — for a book
  you already read on paper, or one you want to skip around in. The label tracks the exact
  paragraph and percentage while you drag. A book that was never opened has no paragraph count
  yet, so the page parses it first and then shows the slider.
- **重置进度** clears one book's position.

### The /read command

The reading centre is a convenience over the command — both do exactly the same thing.

```bash
/read ~/Books/三体.epub      # an explicit path
/read /Volumes/library/Dune.mobi
/read 三体                   # a keyword, resolved against the library roots
```

A keyword is matched against file names under the **library roots** (the 阅读 tab manages the
primary one; the rest stay available for search). Defaults are `~/Books`, `~/Documents/Books`,
`~/Downloads` and `~/Documents`; only directories that exist are used. You can also edit:

```jsonc
// $DSH_HOME/dsh-read/config.json   (usually ~/.dsh/dsh-read/config.json)
{ "libraryRoots": ["/Volumes/books", "~/Calibre Library"] }
```

Or just ask the agent in natural language — it can call `book_search` and hand you the path:

> 帮我找一下《三体》
> → `book_search({ "query": "三体" })` → `/Users/you/Books/三体.epub`
> → then `/read /Users/you/Books/三体.epub`

## Supported formats

| Format | How it is read | Notes |
| --- | --- | --- |
| `.epub` | OCF/ZIP central directory → OPF manifest and spine → XHTML | Non-linear spine items are skipped; images, fonts and CSS are never inflated |
| unpacked `.epub` | The same OCF package read straight off disk | For books iBooks and some converters leave as a folder — recognised by `META-INF/container.xml` and listed as a book, not a directory |
| `.mobi` | PalmDB record table → PalmDOC LZ77 | Uncompressed and PalmDOC compression |
| `.azw3` / `.azw` | Same as `.mobi`, for the MOBI-7 text part | KF8-only files are rejected with a conversion hint |
| `.txt`, `.md`, `.markdown`, `.text`, `.log` | Encoding sniffing | UTF-8, UTF-16, GB18030/GBK, Big5, Shift-JIS |

Deliberate limitations, each reported as an actionable error rather than a silent failure:

- **HUFF/CDIC compression** (MOBI type 17480) is not implemented — convert to EPUB.
- **DRM-encrypted** books are refused.
- **ZIP64** EPUB archives are not supported.
- Files above **256 MB** are refused.

## How it works

The two halves every DSH plugin ships.

**Host half** (`index.mjs`, `lib/`) runs in the DSH node process and owns everything real:
filesystem access, ZIP and PalmDB parsing, HTML-to-text, the paragraph/chapter model,
library search and progress persistence.

- `export const inject = ['agents', 'commands', 'tools']` — cordis throws when you read a
  service property you have not declared, and a throw inside `apply()` takes the entire
  composition down with it, so every service is declared up front. `webServer` is the
  deliberate exception.
- `ctx.commands.register({ name: 'read', … })` resolves one book and returns its metadata
  (path, title, format, character and paragraph counts, chapter index) as the command's
  settled result text.
- A `book_search` model tool exposes library search to the agent — and nothing else. It never
  returns book text.
- Five JSON routes back the tab and the reader card, registered through
  `ctx.inject(['webServer'], …)` rather than the plugin's `inject` array, because `webServer`
  is optional and published late and a headless profile would otherwise keep the plugin
  pending forever.

| Route | Purpose |
| --- | --- |
| `GET\|POST /dsh-read/api/library` | One directory level for the 阅读 tab: subdirectories, books, and each book's saved progress |
| `POST /dsh-read/api/start` | Run `/read <path>` on a live session so the reader appears in the conversation |
| `GET /dsh-read/api/open?path=` | Parse a book, return metadata and the table of contents |
| `GET /dsh-read/api/paragraphs?path=&from=&count=` | One page of paragraphs |
| `GET\|POST /dsh-read/api/progress` | Read, save or clear reading positions |

`/library` parses only the books that already have progress: a percentage needs the paragraph
count, that is the one expensive field, and everything else in the listing is a directory
read.

**Browser half** (`lib/client.js`) is a hand-written ModuleLoader bundle — one
`window.__ModuleLoader__.load({ id, factory })` call, no build step. It requires only `react`
and the injected `slots` / `uiConversation` services, and it uses four seams:

```js
// The reading centre: one Settings page, id'd so it sits beside the shipped sections.
ctx.slots.register({ name: 'settings.section', id: 'dsh-read', order: 22, label: '阅读' }, LibraryView)

// Fold the durable /read lifecycle into one custom Chat node kind.
ctx.uiConversation.events.register({ kind: 'dsh-read', target: 'chat', match, start, update, buildViewNode })

// Render that node inside the conversation flow.
ctx.slots.register({ name: 'conversation.chat.node', key: 'dsh-read' }, ReaderCard)

// Replace the generic command row, which would otherwise dump the metadata JSON.
ctx.slots.register({ name: 'conversation.chat.commandview', key: 'read' }, () => null)
```

`match` claims `command/run` (where `name === 'read'`) and `command/done`; `update` parses the
settled result text into the book metadata the card renders. The typewriter timing lives in
the card: one `setTimeout` per step, keyed on the current values, so changing speed or pausing
takes effect on the very next tick.

`settings.section` projects no icon field, so the shell paints its own generic gear beside every
external section. The bundle therefore tags its own nav row — matched by the label it registered —
with a `data-dsh-read-settings-nav` attribute and swaps that gear for a book in `currentColor`
(the same DOM adaptation `dsh-better-sidebar` uses, and undone on disposal).

The 阅读 page deliberately owns no reading state. Pressing 开始阅读 posts to `/start` — with the
session the shell has selected, from the `useSessions` standard prop — and the host runs the real
`/read` command there. Only once that succeeded does the page call `close()`, so it can never
claim a book is open when the card was not actually created.

### Why the text is not a forged assistant message

The conversation's node key domain is fixed (`assistant-step`, `user`, `tool-call`, `command`,
`steering`, …) — a plugin cannot invent an assistant message, and it should not: forging one
would put the book into the model's context and persist it as something the model said.
Instead the plugin adds its **own** node kind and folds the ordinary durable `command/run` +
`command/done` pair that `/read` already logs. The result looks and behaves like a streaming
reply, costs no tokens, and stays fully reversible — the only thing in the session log is the
command you typed.

Because each `/read` is its own lifecycle, several reader cards can coexist in one session and
each keeps its own position.

## Security

The reader API only ever reads files whose extension is in the supported book list, and the
`/read` command enforces the same whitelist — an explicit path to a non-book file is rejected
rather than decoded as text. It is not a generic file-read endpoint, which matters because
DSH's web server can be exposed beyond loopback. Progress and library roots are the only
things written, and only under `$DSH_HOME/dsh-read/`.

## Development

```bash
node --test "test/*.test.mjs"
```

No dependencies and no build step. The tests build minimal EPUB and MOBI containers in memory
and read them back through the real parsers, drive the host's `/read` command and HTTP routes
against a fake cordis context, and verify the browser bundle's loader contract — including a
replay of the `command/run` + `command/done` fold that produces the reader node.

### Layout

```
index.mjs              host plugin: /read command, library search, routes
lib/book.mjs           book model: paragraphs, chapters, LRU cache
lib/tool.mjs           the book_search model tool
lib/html.mjs           XHTML/HTML → text
lib/formats/epub.mjs   ZIP central directory + OPF spine
lib/formats/mobi.mjs   PalmDB + PalmDOC LZ77 + EXTH metadata
lib/formats/text.mjs   plain text with encoding sniffing
lib/client.js          browser bundle: the in-conversation reader card
cordis.patch.yml       mounts the host plugin into the composition
test/                  parsers, host command + API, client loader contract
```

## License

MIT
