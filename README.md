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
- **Illustrations, in place.** A plate in the book becomes its own item in the reading flow:
it appears where the book put it and playback dwells on it instead of typing past it.
Bytes are fetched by book + index, so the reader can only ever reach assets the book's
own package declared.
- **Space toggles playback.** Click the card once to focus it, then space plays and pauses.
It is bound to the card rather than the window on purpose: the composer lives in the same
document, so a global listener would turn every space you type into a pause.
- **Auto-pause when you leave reading** (on by default in 阅读中心 → 离开阅读时自动暂停). Switching
tabs, minimising, focusing another app, or switching to a different DSH conversation stops the
typewriter exactly where it is — including mid-word. Returning automatically resumes from
that character, but a manually paused reader stays paused. Clicking the composer in the same
conversation is not "leaving"; turning the switch off disables automatic pausing on departure.
The switch is remembered in this browser's `localStorage` (only in memory if storage is unavailable).
Exact character positions and manual-pause state are cached per reader card in the current window,
not saved to disk; a page reload or a new window falls back to the saved paragraph. Returning to
an existing card is different from issuing a new `/read` command.
- **伴读：划词提问，留痕。** Select a passage and the reader offers 问 AI or 记一笔. 问 AI writes
the question — book, paragraph and quote — into the composer, so you can add your own
framing and send it yourself; 记一笔 records it without involving a session at all. Notes
and captured questions/answers are stored per book under `$DSH_HOME/dsh-read/notes.json`.
Configure an archive directory in 阅读中心 → 批注归档 to mirror each annotation as a Markdown file
in a book folder. Completed AI answers are filled in automatically; no duplicate chat messages are inserted.
- **Scroll back through everything you have read.** The loaded run grows in both
directions instead of being one page: scrolling up pulls in earlier paragraphs and keeps
your place, so you can reach the start of the book.
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
- Filter the current directory with **全部 / 在读 / 未读** (all / reading / unread); **全部** is the
  default. Any saved progress counts as reading, including 0% and completed books; no record means
  unread. Subdirectories stay first, outside filtering and sorting. An empty filtered result offers
  **查看全部**; changing the filter closes the progress editor.
- Sort by **reading progress / last-read time**, ascending or descending; newest first is the default.
  Ties use Chinese-locale book-name order, then path order, both ascending. Last-read time uses the
  last progress save, including manual position changes, not time spent reading. Unread books and
  missing or invalid timestamps stay last in either time-sort direction; unread progress is 0%.
  Filter and sort choices survive data refreshes and directory changes until the settings page is
  unmounted; they are not saved as preferences.
- **开始阅读 / 继续阅读** runs the same `/read` command in the session the shell currently has
  selected, then closes settings so you land on the card, resuming from the saved paragraph.
- **设置进度** opens a slider under the book so you can move its position anywhere — for a book
  you already read on paper, or one you want to skip around in. The label tracks the exact
  paragraph and percentage while you drag. A book that was never opened has no paragraph count
  yet, so the page parses it first and then shows the slider.
- **空格 暂停/继续** — click the card to focus it, then space toggles playback.
- **重置进度** clears one book's position.

Setting or resetting progress also invalidates that book's old card positions in this window and
stops their playback, even with auto-pause disabled. A mounted card reloads the saved position when
you return to it or use a playback/seek control; a completed book stays complete. Reset leaves the
book unread until you actually read in the foreground or seek, rather than creating progress merely
by loading the card. If the initial text load or this position reload fails, return focus to the
reader or use **播放 / 下一段** to retry; loading alone does not save progress.

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
| `.epub` | OCF/ZIP central directory → OPF manifest and spine → XHTML | Non-linear spine items are skipped; stylesheets and fonts are never inflated, and only illustrations the manifest declares are read |
| illustrations | Carried into the flow as their own item | Referenced from the package manifest; a marker the paragraph splitter turns into an image item |
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
- HTTP routes back the reading centre, reader card and annotation archive. Their registrations
  in [`index.mjs`](index.mjs) are the authoritative route and payload definitions. They use
  `ctx.inject(['webServer'], …)` rather than the plugin's `inject` array, because `webServer`
  is optional and published late and a headless profile would otherwise keep the plugin
  pending forever.
- `reading_notes` exposes annotation management; answer capture uses optional session services.
  See the [archive implementation reference](docs/superpowers/specs/2026-11-17-notes-markdown-design.md).

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

The bundle registers a `currentColor` book through `settings.section.icon`, matching the section ID.
The shell replaces its fallback gear; no navigation DOM observer or extra CSS pseudo-icon is used.
Book counts appear only in the filter toolbar. Successful loading adds no duplicate status row;
failed loading still shows an actionable error.

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

## Markdown annotations and Obsidian

Archiving is **off by default**; the suggested directory is not enabled until you explicitly save a path.
Without an archive, 问 AI only fills the composer draft; 记一笔 still saves its excerpt to JSON.
In Settings → 阅读中心 → 批注归档, click **选择…**. Native Hosts open the OS chooser;
browse Hosts open an inline folder browser with home/parent navigation. Choose the current folder,
then **保存** to apply. The default view is two compact rows; export, open and disable are under **更多**. Canceling keeps the current path/configuration. You can also type an
absolute or `~/...` path (suggested: `~/Documents/ReadingNotes`, or a dedicated folder inside your
vault). If the chooser is unavailable, manual entry remains supported. Use **停用归档** to disable.
Saving a path migrates existing notes, even into an existing Obsidian vault or when the original
book has moved. Unrelated handwritten files are not overwritten; existing managed notes receive
the normal bounded update described below. One annotation becomes one `.md` file in its book's folder.
Keep the hidden `.dsh-read-book.json` ownership file in each book directory.

Files contain YAML properties, the quote, your submitted question and AI answer. File names use
one-based paragraph numbers; `paragraph` metadata remains zero-based. The `created` property is
UTC ISO time; filenames use local time. 记一笔 saves the selected excerpt; add your own reflections
outside the plugin's marked question/answer region. Normal updates regenerate plugin-owned YAML
properties (including multiline values), but preserve custom properties and text outside that region.
Keep the ownership properties and region markers intact so the file can still be identified and updated.
**Export all** asks for confirmation: it regenerates managed files from JSON, replacing manual edits
inside those files, but never deletes unrelated files.
Deleting an annotation also removes its generated file; disabling/switching the archive leaves old files intact.

Archive-enabled questions include an HTML comment `<!--dshr-ID-->` in the composer. It is visible
to you and the model, hidden by Markdown reading view, and required to associate the response.
Only committed assistant text after that question's admission in the matching turn is copied (not reasoning or tool outputs).
Unsent drafts remain `pending`; successful replies become `answered`; canceled/failed replies
retain partial text as `interrupted`. Turns over 10 minutes remain pending until recovery on restart
or session reopen. Text over 2 Mi characters is marked truncated, not complete. Historical untagged
Q&A is not automatically scraped. Hosts without session projection support can still save/export
notes but cannot automatically capture answers. JSON keeps captured questions and answers too,
so re-export does not require re-reading a conversation. Markdown failures leave JSON intact and
are shown in settings. The `reading_notes` tool exposes the same management operations to agents.
Tool export returns `confirmationRequired` without writing until the user explicitly agrees to overwrite
manual edits and the agent supplies the boolean `confirmOverwrite: true`. See the
[implementation reference](docs/superpowers/specs/2026-11-17-notes-markdown-design.md)
for ownership checks and batch-export internals.

## Security

The reader API only ever reads files whose extension is in the supported book list, and the
`/read` command enforces the same whitelist — an explicit path to a non-book file is rejected
rather than decoded as text. It is not a generic file-read endpoint, which matters because
DSH's web server can be exposed beyond loopback. Configuration, progress and notes/answers
are written under `$DSH_HOME/dsh-read/`. An explicitly configured Markdown archive also receives
generated notes and per-book ownership metadata. Only matching plugin-generated identities can
be updated/deleted; symlinks and hardlinks are refused.

## Search within the current book

Open a book with `/read`, then choose **书内搜索** in its reader card. Search covers the
whole parsed book, including paragraphs the card has not loaded. It works with every
supported text/container format (including unpacked EPUB); illustrations are skipped.

- Matching is a literal substring, case-insensitive for English, within a single paragraph.
  Leading/trailing query whitespace is trimmed; internal whitespace is preserved. No regular
  expressions, cross-paragraph, semantic, or cross-book search. Queries allow up to 100 Unicode
  characters. Non-overlapping occurrences have individual results.
- Each page shows up to 20 matches, with bounded context, highlighted text, paragraph number,
  and an available chapter heading. **上一页 / 下一页** replaces the page rather than growing
  an unbounded list; there is no expensive exact total count. A query waits 250 ms after typing;
  changing it cancels the older request, and late responses are discarded.
- Opening search pauses playback and captures the original paragraph, revealed characters,
  loaded window, and scroll position. Typing, paging, and clicking results only preview;
  they never save reading progress. Clicking a result loads and highlights its original passage.
- **返回原位置** (or Escape in the search field) restores that position and remains paused.
  **从此处继续阅读** closes search and resumes from the preview; normal 1.2-second debounced
  progress saving then applies. Previewing or closing search never creates an unread book's
  progress record. Changing/resetting progress in Settings invalidates the search snapshot.
- Empty queries, no matches, parse failures, and target-loading errors have explicit feedback.
  Failed searches and previews can be retried. Changing the card's session or unmounting discards
  the temporary preview and preserves the original cursor for existing in-window restoration.

Search calls only the local reader HTTP API; it never invokes an AI tool/model or adds book text
to the conversation. Queries and excerpts render as React text nodes with `mark` highlights.
`book_search` still finds books by filename only.

The host endpoint is `GET /dsh-read/api/search?path=…&query=…&cursor=…&limit=…`.
`path` uses the existing book-format allowlist, `cursor` is an opaque token tied to the parsed
book identity/query, and `limit` defaults to 20 and is capped at 50. The reply contains `query`,
`results`, and nullable `nextCursor`; match ranges and snippet highlights use UTF-16 offsets.
The endpoint does not read or write progress and returns only bounded snippets, never full text.
Long scans yield between chunks and honor request cancellation.

Reproduce the generated 10.6 MiB / 50,050-paragraph benchmark with
`node scripts/benchmark-search.mjs`; pass an output path to save its JSON report. The script
checks 20 samples per cached scenario against the agreed 500 ms P95 threshold. See the
[measured performance and browser validation](docs/search-performance.md) for environment,
input/render timing definitions, results, and practical limits.

## Development

Install the standalone test dependency without the Harness peer packages, as CI does:

```bash
npm install --ignore-scripts --legacy-peer-deps --no-package-lock
npm test
```

No linter or formatter is configured. For syntax-only checks, use `node --check <file>` on
changed JavaScript files and `git diff --check` for whitespace errors.

No build step; Zod validates Host session-projection state. The tests build minimal EPUB and MOBI containers in memory
and read them back through the real parsers, drive the host's `/read` command and HTTP routes
against a fake cordis context, and verify the browser bundle's loader contract — including a
replay of the `command/run` + `command/done` fold that produces the reader node.

### GitHub Releases

`package.json` is the release version source. Bump its SemVer version and merge to `main`;
after both Node 22 and Node 24 CI tests pass, CI creates `v<version>` at the tested commit
and publishes a GitHub Release with automatically generated release notes. No manual tag,
npm publishing, build step, or extra secret is required. Only the release job receives
`contents: write` through the repository's `GITHUB_TOKEN`; repository rules must allow it
to create tags and releases. Pull requests never publish.

The first successful main run also publishes the current version if missing (initially
`v0.3.0`). Already published versions are skipped, including later commits without a version
bump. Prerelease versions such as `0.4.0-rc.1` are marked as prereleases, not latest.

If publishing fails after tag creation, re-run the failed CI job for the **same commit**.
A matching lightweight or annotated tag is reused; a tag pointing elsewhere or an existing
draft release fails for manual review, without overwriting either. API/permission failures
fail the job rather than being treated as a missing release. Release jobs are serialized
without cancelling an active publisher. To ship a fix, bump the version again instead of
moving a published tag.

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
