# dsh-read 批注 Markdown 化设计

日期：2026-11-17
状态：已与用户逐节确认

## 背景与问题

`dsh-read` 的伴读功能（划词「问 AI」/「记一笔」）目前把批注存为
`$DSH_HOME/dsh-read/notes.json`，而「问 AI」产生的完整问答（引用、问题、AI 回答）
只存在于 `$DSH_HOME/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd` 的压缩会话
日志里。三类数据分散两处、均不可直接阅读、无导出能力：

| 数据 | 现状位置 | 可读性 |
| --- | --- | --- |
| 记一笔 / 问 AI 留痕 | `~/.dsh/dsh-read/notes.json` | JSON，Obsidian 无法当笔记浏览 |
| 问 AI 的完整问答 | `session.v4.jsonl.zstd` | zstd 压缩 JSONL，埋在事件流里 |
| 阅读进度 | `~/.dsh/dsh-read/progress.json` | 与本设计无关，不动 |

## 目标

1. 划词批注（问 AI / 记一笔）在落 `notes.json` 的同时，写成 Obsidian vault 里
   人类可直接阅读的 Markdown 文件；不装 Obsidian 也只是普通 .md 文件。
2. 「问 AI」后 AI 的回答在生成完成后**自动回填**到对应批注文件，形成完整问答记录。
3. 存量 `notes.json` 批注自动迁移；vault 路径用户在设置页配置。
4. vault 未配置时功能整体关闭，行为与现状完全一致（零回归默认）。

非目标：

- 不做应用内批注浏览中心（vault 即浏览层）。
- 不生成 MOC/索引页（Obsidian 自带文件夹浏览与搜索）。
- 不改动阅读进度存储。
- 不做 pending 文件的 UI 管理列表。

## 已确认的决策

| 决策点 | 定案 |
| --- | --- |
| 存储形态 | JSON + Markdown 双写；notes.json 仍是内部事实源（卡片段落标记依赖它），Markdown 是对外呈现层 |
| 文件粒度 | 每条批注一个 .md 文件（曾考虑一书一文件日志式，因回填/删除需大文件内定位而否决） |
| 目录组织 | 一书一目录 |
| AI 回答 | 自动回填：监听会话事件，按消息内锚点匹配回写 |
| vault 路径 | 设置页配置，默认 `~/Documents/ReadingNotes`，存 `config.json` 的 `notesVaultPath` |
| 文件格式 | YAML frontmatter + 正文小节 |
| 旧数据 | 首次启用时自动迁移 |
| 锚点形态 | HTML 注释 `<!--dshr-xxx-->`（Obsidian 阅读视图不渲染、对模型透明） |
| 回填粒度 | 整个 assistant turn 的文本拼接 |
| 文件名段落号 | 1 基（与阅读器 UI 一致）；frontmatter 存 0 基真实值 |

## 文件布局与格式

```
<vault>/                          ← config.json 的 notesVaultPath
├── 苏东坡传/                     ← 目录名 = 书名（去扩展名，净化非法字符）
│   ├── 2026-11-17-0842-第64段-分。在我的头脑里.md
│   └── ...
└── 大秦帝国/
    └── ...
```

文件名：`YYYY-MM-DD-HHmm-第N段-摘要.md`，N 为 1 基段落号，摘要取引用前 12
字符（截断、去尾部标点）。同名冲突追加 `-2`、`-3`。书名含 `/ : * ? " < > |`
等字符时替换为 `-`；不同路径的两本同名书，目录名追加书路径短哈希后缀。

单文件内容：

```markdown
---
book: 苏东坡传
book_path: /Users/miclon/Desktop/books/苏东坡传.epub
paragraph: 63
paragraph_display: 64
progress: 3.7%
kind: note            # note | question
note_id: mwjywe65-1   # notes.json 中的 id，回填与删除的关联键
created: 2026-11-17 08:42:05
answer_state: pending # question 专用：pending → answered
---

# 分。在我的头脑里，苏东坡的意象之特别清楚明显……

> 分。在我的头脑里，苏东坡的意象之特别清楚明显，其理由有二：第一个理由是，……
> （引用原文，截断至 400 字符，与 notes.json 一致）

## 问题

半个时辰指多久

## AI 回答

（问 AI 回填后出现；记一笔无此小节）
```

frontmatter 值含 YAML 特殊字符时按标准 YAML 转义；book_path 含冒号加引号。
`progress` 为批注时刻该书已保存进度百分比，无进度记录时省略该字段。

## 问 AI 的锚点与回填机制

1. **发问**：`askAboutSelection()` 仍把草稿放进输入框（用户可补充后发送）。草稿
   的引用块内联追加 HTML 注释锚点：`「原文」<!--dshr-mwjywe65-1-->`。锚点对
   Obsidian 阅读视图不可见、对模型语义透明。
2. **Host 监听**：插件 `apply(ctx)` 内通过已声明的 `agents` 服务订阅会话事件流。
   发现带 `<!--dshr-...-->` 锚点的 user 消息后，等待其所在 turn 的 assistant
   回答完成事件。
3. **回填**：提取该 turn 全部 assistant 文本（拼接），按锚点中的 note_id 定位
   vault 中对应 .md（读 frontmatter 的 `note_id` 字段匹配，不靠文件名），追加
   `## AI 回答` 小节，frontmatter `answer_state` 改为 `answered`。同一 turn 多个
   锚点各自独立匹配。
4. **降级**：回答超过 10 分钟未完成（会话切走、模型未回），文件停留 pending，
   不报错不重试；下次 DSH 启动时扫描一次 pending 文件尽力补齐。用户发送前删掉
   锚点 → 永远 pending，引用与问题仍完整保留。

## 设置页

「阅读」设置页新增「批注导出」块：

- 目录输入框（回填当前值）+「更改」：写入 `config.json` 的 `notesVaultPath`；
  清空即关闭功能。
- 状态行：`已启用 · N 本书 · M 条批注` 或 `未启用`。
- 「立即导出全部」：以 `notes.json` 为准全量生成，覆盖同 note_id 的文件，
  **不删除** vault 中 notes.json 没有的文件（用户手写笔记永不被清）。
- 「在 Finder 中打开」：`open <vault>`。

## 数据流与一致性

- **写入**：`addNote()` 先写 `notes.json`（现状），成功且 vault 已配置时写 .md。
  .md 写失败不阻塞（见错误处理），两写非事务。
- **删除**：`removeNote()` 删 `notes.json` 条目，同时按 note_id 找到并删除对应
  .md；.md 已被用户手动移走时静默跳过。
- **迁移**：设置路径且 vault 目录为空、`notes.json` 非空时，自动全量生成一次。
  只在「目录为空」时触发，避免误覆盖既有 vault。
- **对账基准**：任何冲突以 `notes.json` 为准；Markdown 允许用户自由手改，手改
  内容若与全量导出重合（同 note_id）会被覆盖——「立即导出全部」按钮文案会提示。

## 错误处理

| 场景 | 行为 |
| --- | --- |
| vault 目录被删/不可写 | 批注仍成功（notes.json 保底），阅读卡片状态条提示「Markdown 保存失败：<原因>」；不阻塞阅读 |
| 书名含非法路径字符 | 替换为 `-` |
| 同名书不同路径 | 目录名追加路径短哈希后缀 |
| 用户发送前删锚点 | 文件停留 pending，不回填 |
| 回答超时（>10 分钟） | pending，下次启动尽力补齐一次 |
| 迁移时部分文件写失败 | 继续迁移其余项，状态行报告失败数 |

## 安全与边界

- 写入严格限制在 `notesVaultPath` 目录内；路径拼接后做前缀校验，拒绝越界。
- 不读 vault 内任何其他文件内容（Finder 打开、按 note_id 定位除外，且定位仅读
  frontmatter 的 note_id 字段）。
- vault 目录与书库目录互不影响，无隐式耦合。

## 实现拆分（供实施计划参考）

1. `lib/notes-markdown.mjs`（新）：纯函数层——frontmatter 生成/转义、文件名净化
   与冲突、书目录名、单文件渲染、回填小节插入。全部无 IO，可独立单测。
2. `index.mjs` 扩展：`addNote`/`removeNote` 双写；vault 路径解析（config +
   `~` 展开）；迁移；全量导出；启动时 pending 扫描。
3. 会话事件监听与回填（`index.mjs`，agents 服务）。
4. `lib/client.js`：设置页「批注导出」块；阅读卡片状态条提示 .md 写入失败。
5. 路由：`POST /dsh-read/api/vault`（设置路径）、`POST /dsh-read/api/export`
   （全量导出）、现有 `/notes` 响应附带 `mdPath` 与 `mdError` 字段。

## 测试策略

沿用 `node --test` 无依赖风格：

- `lib/notes-markdown.mjs` 纯函数：frontmatter 转义（冒号、引号、多行）、文件名
  净化（非法字符、超长摘要、冲突递增）、单文件渲染、回填小节插入位置。
- Host 路由：`/notes` 双写、vault 未配置时行为不变、迁移幂等（重复触发不重复
  生成）、全量导出不删额外文件、删除同步删 .md。
- 锚点与回填：假 agents 事件流驱动——正常回填、超时降级、锚点被删、同 turn
  多锚点。
