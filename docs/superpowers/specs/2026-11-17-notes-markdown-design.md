# dsh-read 批注 Markdown 化设计

日期：2026-11-17
状态：已实现；本文维护归档实现约束，使用说明统一见 [README](../../../README.md#markdown-annotations-and-obsidian)。

## 背景与目标

改动前，摘录保存在插件 JSON 中，完整问答仅存在于宿主压缩会话日志，不能直接作为
Obsidian 笔记阅读。现在 Markdown 是可读呈现层，JSON 仍是内部事实源；不依赖 Obsidian 安装。

- 每条批注一个文件、按书分目录，避免一书一文件时回填和删除都要定位大文件内部内容。
- 本归档改动不做应用内批注浏览中心、MOC/索引页或 pending 管理列表；后续的当前书籍回看见
  [批注回看设计](2026-11-18-annotation-review-design.md)。
- 不改变阅读进度的存储格式，书库目录与归档目录互不耦合。
- 不为了归档向会话插入重复消息。

## 配置与数据所有权

[`NotesStore`](../../../lib/notes-store.mjs) 负责插件 JSON/config 的串行变更。
`notesVaultPath` 保存在 `config.json`，经 `expandNotesPath()` 校验和展开；未配置时不写 Markdown。
建议路径只是设置占位提示，不是默认启用值。公共操作及 HTTP 请求字段以
[`readingNotesOperation()` 和路由注册](../../../index.mjs) 为准；模型工具参数以
[`reading_notes` 定义](../../../lib/notes-tool.mjs) 为准，不在文档维护第二份参数表。

JSON 同时保留摘录、实际问题、回答及关联状态，因此重导不需要重新读取会话。
公开批注类型见 [`ReadingNote`](../../../index.d.ts)，内部写入字段以 `NotesStore.add()`、
`capture()` 为准。Markdown 生成属性和格式以
[`metadata()`、`renderNote()`、`filename()`](../../../lib/notes-markdown.mjs) 为唯一来源，
不手抄一份容易与渲染器漂移的 YAML 示例。新文件标题由书名和显示段落号组成；
`progress` 是数值百分比，无记录时省略。

## 会话关联与恢复

[`lib/notes-answers.mjs`](../../../lib/notes-answers.mjs) 的 fold 只处理持久提交的事件，
不在逐 token 发布时执行归档 IO。

1. 客户端启用归档时先保存 question 批注取得 ID，再在草稿引用后附锚点；未启用时保持原有
   同步填草稿行为。实际问题来自用户提交事件，而非草稿或选区。保存失败不会阻止填入无锚点草稿，
   但会明确提示本次提问不能自动归档。
2. Host 通过可选的 `sessionProjections` 与 `sessions` 服务注册 host-only fold，
   在 `session/event` 的 user admission 和 turn completion 边界读取投影快照。
   `agents` 仍用于启动阅读，不是回答归档的投影服务。
3. 只接受来源为用户的新增消息中的锚点；忽略 fork 继承事件及替换事件。
   回答按 session、turn、message ID 绑定，后续复制锚点不能覆盖原问答。
   同一轮中的每个问题只拼接其加入后提交的 assistant text，不包含 reasoning、工具结果或 provider attempts。
4. `NotesStore.capture()` 先落 JSON，再更新 Markdown。成功且正文非空、未截断的完成记录才标记 answered；
   中断、空正文或截断记录不冒充完整回答。实时超时与输出长度限制见源码常量及判断，用户可见行为见 README。
5. `session/created` 和热安装时的已挂载会话通过投影恢复。冷恢复使用可选
   `sessionQuery.readSession(id)`，只读取 JSON 中已知未完成问题关联的会话；不枚举或自行解压其他会话日志。
   没有查询服务时仍可在会话打开时恢复可用投影记录；没有投影服务时不自动捕获新回答。

卸载时先停止监听，等待已排队任务结束，再释放投影。对应回归覆盖见
[`test/notes-answers.test.mjs`](../../../test/notes-answers.test.mjs)。

## 双写、迁移与更新边界

- **写入**：JSON 先提交，Markdown 失败不撤销 JSON；两写不是事务。`mdDirty` 用于记录待补写的镜像，
  恢复时重试。错误通过 `mdError` 或归档状态返回；卡片显示保存错误，设置显示归档错误。
- **迁移**：每次保存非空归档路径都会遍历已有 JSON 批注，不要求 vault 为空，因此兼容 `.obsidian`。
  缺失文件新建；已验证文件走普通更新，而非“只补缺完全不碰已有文件”。
  原书已移动也不阻止这些已存摘录导出。
- **普通更新**：重建插件生成的 frontmatter 属性及其缩进续行，保留自定义属性；只替换唯一成对的
  AI 区域分隔符内正文，保留其外正文。区域缺失或重复时拒绝更新，不猜测用户意图。
- **全量导出**：显式覆盖模式从 JSON 重新渲染已验证插件文件。用户确认规则由 README 的使用说明维护；
  直接 HTTP 导出路由是执行端，UI 负责先取得确认，模型工具在公共操作层要求布尔确认参数。
- **删除**：JSON 删除先提交，再按书路径和 note ID 删除匹配文件；文件不存在时跳过。
  Markdown 删除失败返回错误，可按同 ID 重试。
- **批量处理**：`writeAll()` 单次扫描书目录，并为每本书复用身份索引；缓存不代替目标读取和发布前校验。
  每条批注独立返回结果，失败不阻断后续项。

对应覆盖见 [`test/notes-store.test.mjs`](../../../test/notes-store.test.mjs) 和
[`test/notes-markdown.test.mjs`](../../../test/notes-markdown.test.mjs)。

## 文件身份与安全边界

[`MarkdownVault`](../../../lib/notes-markdown.mjs) 同时承担渲染和文件系统 IO；只有渲染辅助函数是纯函数。

- 书目录由隐藏 ownership manifest 标识；不会占用已有的用户目录，即使该目录为空。
  书名冲突使用书路径哈希避让，文件名冲突递增后缀，不覆盖无关文件。
- 只在已认领书目录中有界扫描 Markdown，以生成标记、绝对书路径和 note ID 联合验证文件身份。
  文件重命名后仍可在扫描范围内定位；复制出重复身份则拒绝更新或删除。
- 不解析任意 YAML。身份字段接受受限的双引号、单引号和普通标量；可识别但不支持或有歧义的
  身份语法失败关闭，避免误认或重复生成。管理属性的多行值整体替换，而不是留下旧缩进行。
- 扫描会读取候选 Markdown 内容以验证身份和保留手写正文，并非“只读 note_id 字段”。
  `.obsidian` 不遍历；扫描深度、条目数和单文件字节预算由实现限制。
- vault 根目录规范化后检查身份；不穿越其下符号链接，拒绝硬链接及非普通目标文件。
  写入用同目录临时文件原子发布，新文件独占发布，更新前重新验证目标内容与文件身份。
- 路径式 Node API 不能消除恶意进程并发替换祖先目录的全部竞态；实现对观察到的变化失败关闭，
  不宣称绝对无竞态。每个规范化根目录内的操作串行化。

## 客户端与验证入口

目录选择依实际 `directoryPicker` capability 分流 native 与 browse，不能把 browse 当作 native picker。
客户端取消/卸载时终止目录读取，并阻止过期归档响应覆盖新的选区或输入草稿。
两行设置布局、更多菜单及操作流程由 README 维护，不在设计文档复制 UI 指引。

测试使用 Node 内置 runner；投影 schema 使用 Zod，不再是整个测试环境无依赖。
依赖安装与检查命令见 [README 开发说明](../../../README.md#development)。
端到端契约覆盖位于 [`test/notes-integration.test.mjs`](../../../test/notes-integration.test.mjs)，
客户端异步交互覆盖位于 [`test/client.test.mjs`](../../../test/client.test.mjs)。
