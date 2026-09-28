# dsh-read

在**对话流里**直接阅读你硬盘上的 EPUB / MOBI / 纯文本书籍，像 AI 回复一样逐字流出。

`dsh-read` 给 DeepSeek Harness 加了一条 `/read` 命令。输入 `/read` 加一本书，正文就会以卡片的
形式出现在对话流里，逐字显现，可以调速度、暂停，有章节目录，也能按书记住读到哪儿。

```
你   ▸ /read ~/Books/三体.epub

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

## 功能

- **阅读中心在「设置」里。** 侧栏底部的「设置」→ 左侧「阅读」：在这里管理书库，指向一个目录、
  看到每本书和读到哪里、点「开始阅读」。对话头部因此只剩「对话」和「轨迹」两个属于会话本身的
  视图。
- **阅读发生在对话页里，不是在旁边。** 「开始阅读」跑的就是输入框里那条 `/read` 命令，所以
  阅读器是会话记录里一个真正的 Chat node；设置面板随即关闭，让你直接看到那张卡片。
- **插图在正文原位。** 书里的插图会成为阅读流里独立的一项：出现在书放它的位置，播放时会停留一下
而不是直接跳过。图片按「书 + 序号」取，所以阅读器只能拿到该书自己的包声明过的资源。
- **像回复一样流出。** 段落逐字显现，当前段落带光标。
- **阅读区固定。** 卡片直接占满对话可视区，而不是随正文越长越高 —— 所以段落不断出现时整个对话
  不会跟着抖动，正文在卡片内部滚动。窗口缩放、输入区高度变化都能跟上：它读的是 DSH 本身就在
  对话滚动容器上维护的那两个 CSS 变量。
- **速度 / 暂停 / 跳转。** 默认「慢 / 中 / 快」三档（10 / 20 / 60 字/秒）；想要更细的节奏就切到
  「自定义」，这时才出现 10–160 字/秒 的拖放条。另有播放暂停、上一段、下一段、从头重读、章节目录
  下拉；选过的速度会记住。
- **界面按需出现。** 阅读时标题栏、章节行和底部控制栏一起收起，鼠标移入卡片（或键盘聚焦到
  控件）才滑出来，只留下顶部那条细进度线。
- **进度。** 卡片里有实时百分比，「阅读」设置页里每本书也列出同一个百分比；按书保存，重新打开
  自动续读。
- **零 token。** `/read` 完全不经过模型：命令的生命周期是直接写日志的，没有任何 turn 包裹它，
  正文也从不进入上下文。
- **EPUB / MOBI / 文本。** EPUB 走 OCF/ZIP 目录 + OPF spine，MOBI 走 PalmDB / PalmDOC 记录，
  `.txt` / `.md` 走编码嗅探——非 UTF-8 的中文小说会回退到 GB18030 / GBK / Big5。
- **自然语言找书。** `book_search` 工具让 Agent 按书名帮你找书，找到后再用 `/read` 打开。

## 安装

`dsh plugin add` 本质是 pnpm 的薄转发器，接受任何 pnpm 来源说明符——包括 GitHub 仓库。
不需要先发布到 npm：

```bash
# 直接从 GitHub 安装
dsh plugin --profile web add github:mic1on/dsh-read

# 锁定到某个 tag，便于复现
dsh plugin --profile web add github:mic1on/dsh-read#v0.1.0

# 本地开发目录（软链）
dsh plugin --profile web add -w link:/path/to/dsh-read
```

`--profile` 用你实际在跑的 profile（浏览器界面一般是 `web`），然后**重启 DSH**。浏览器端的
bundle 是在启动时合成的，光刷新页面不够。

本项目没有构建步骤、也没有 `prepare` 脚本：插件需要的一切都以源码形式随包发布，所以 git 安装
可以直接用。

## 使用

### 设置 → 「阅读中心」

打开侧栏底部的 **设置**，在左侧点 **阅读中心**（这一行的图标是一本书，而不是外壳的通用齿轮）。
它放在设置里而不是「对话 / 轨迹」旁边，是为了让对话头部只留属于该会话的两个视图。

- 顶部目录栏显示插件记住的书库根目录，并且**每次打开这个页面都会回填**。粘任意绝对路径后点
  「加载」切换 —— 这个目录会成为主书库根目录并被记住。
- 先列子目录，可以一层层走到书所在的目录。
- 每本书显示格式、大小和进度（`已读 5.9% · 第 124 / 2083 段`，或「未开始」）。
- **开始阅读 / 继续阅读** 会在当前选中的那个会话里跑同一条 `/read` 命令，然后关闭设置面板，
  你正好落在卡片上，并从保存的那一段续读。
- **设置进度** 会在书下面展开一个滑杆，把位置拖到任意处 —— 适合纸质书已经读过一半、想同步过来
  的情况，或者想跳着读。拖动时旁边实时显示第几段和百分比。从未打开过的书还不知道段落总数，
  页面会先解析一次再显示滑杆。
- **重置进度** 清掉某一本书的位置。

### `/read` 命令

阅读中心只是命令的便捷入口，两者做的完全是一件事。

```bash
/read ~/Books/三体.epub      # 直接给路径
/read /Volumes/library/Dune.mobi
/read 三体                   # 关键词，在书库根目录里解析
```

关键词会拿去匹配**书库根目录**下的文件名（「阅读」设置页管理其中主目录，其余目录仍参与搜索）。
默认根目录是 `~/Books`、`~/Documents/Books`、`~/Downloads`、`~/Documents`，只使用真实存在的
那些。也可以手工编辑：

```jsonc
// $DSH_HOME/dsh-read/config.json   （一般是 ~/.dsh/dsh-read/config.json）
{ "libraryRoots": ["/Volumes/books", "~/Calibre Library"] }
```

或者直接用自然语言让 Agent 找 —— 它会调 `book_search` 把路径给你：

> 帮我找一下《三体》
> → `book_search({ "query": "三体" })` → `/Users/you/Books/三体.epub`
> → 然后 `/read /Users/you/Books/三体.epub`

## 支持的格式

| 格式 | 解析方式 | 说明 |
| --- | --- | --- |
| `.epub` | OCF/ZIP 中央目录 → OPF manifest 与 spine → XHTML | 跳过 `linear="no"` 的 spine 项；样式表与字体不解压，只读 manifest 声明过的插图 |
| 插图 | 作为独立一项进入正文流 | 只认包 manifest 声明过的资源；转换时留下标记，切段时变成图片项 |
| 解压后的 `.epub` | 同一套 OCF 包，直接从磁盘读 | 用于 iBooks 及部分转换器留下的「书是一个文件夹」形态——靠 `META-INF/container.xml` 识别，列为书籍而不是目录 |
| `.mobi` | PalmDB 记录表 → PalmDOC LZ77 | 支持不压缩与 PalmDOC 两种压缩 |
| `.azw3` / `.azw` | 与 `.mobi` 相同，取 MOBI-7 正文 | 纯 KF8 文件会拒绝并提示转换 |
| `.txt`、`.md`、`.markdown`、`.text`、`.log` | 编码嗅探 | UTF-8、UTF-16、GB18030/GBK、Big5、Shift-JIS |

以下限制都是**明确报错**而不是静默失败：

- **HUFF/CDIC 压缩**（MOBI type 17480）未实现——请先转成 EPUB。
- **DRM 加密**的书直接拒绝。
- **ZIP64** EPUB 不支持。
- 超过 **256 MB** 的文件拒绝。

## 实现方式

和所有 DSH 插件一样，分两半。

**Host 侧**（`index.mjs`、`lib/`）跑在 DSH 的 node 进程里，负责所有实事：文件读取、ZIP 与
PalmDB 解析、HTML 转文本、段落/章节模型、书库搜索、进度落盘。

- `export const inject = ['agents', 'commands', 'tools']` —— cordis 里读取未声明的服务属性会直接
  抛错，而 `apply()` 里抛错会**连带整个 composition 一起挂掉**，所以服务必须事先声明。
  `webServer` 是刻意的例外。
- `ctx.commands.register({ name: 'read', … })` 解析出一本书，把它的元数据（路径、书名、格式、
  字数、段落数、章节目录）作为命令的 settled result 文本返回。
- `book_search` 模型工具只把**书库搜索**能力暴露给 Agent，其余什么都不给——它从不返回正文。
- 五条 JSON 路由支撑阅读中心和阅读卡片，并且是通过 `ctx.inject(['webServer'], …)` 注册的，**不能**
  放进插件自己的 `inject` 数组：它是可选且晚挂载的服务，否则 headless profile 下插件会永远等待。

| 路由 | 用途 |
| --- | --- |
| `GET\|POST /dsh-read/api/library` | 阅读中心的一层目录：子目录、书籍、以及每本书已保存的进度 |
| `POST /dsh-read/api/start` | 在活着的会话上执行 `/read <path>`，让阅读器出现在对话里；不带会话 ID 时落在唯一在跑的那个会话上 |
| `GET /dsh-read/api/open?path=` | 解析书籍，返回元数据与章节目录 |
| `GET /dsh-read/api/paragraphs?path=&from=&count=` | 取一页段落 |
| `GET\|POST /dsh-read/api/progress` | 读取 / 保存 / 清除阅读位置 |

`/library` **只解析已经有进度的那几本书**：百分比需要段落总数，那是唯一昂贵的字段，其余部分
都只是一次目录读取。

**Browser 侧**（`lib/client.js`）是手写的 ModuleLoader bundle——一个
`window.__ModuleLoader__.load({ id, factory })`，无需构建步骤。它只依赖 `react` 和注入的
`slots` / `uiConversation` 服务，用了四个插槽口：

```js
// 阅读中心：一个「设置」页，用 id 排在官方分区旁边
ctx.slots.register({ name: 'settings.section', id: 'dsh-read', order: 22, label: '阅读' }, LibraryView)

// 把 /read 的持久化生命周期折叠成一个自定义 Chat node kind
ctx.uiConversation.events.register({ kind: 'dsh-read', target: 'chat', match, start, update, buildViewNode })

// 在对话流里渲染这个 node
ctx.slots.register({ name: 'conversation.chat.node', key: 'dsh-read' }, ReaderCard)

// 顶掉通用命令行——否则它会把元数据 JSON 原样打印出来
ctx.slots.register({ name: 'conversation.chat.commandview', key: 'read' }, () => null)
```

`match` 认领 `command/run`（`name === 'read'`）与 `command/done`；`update` 把 settled result
文本解析成卡片要渲染的书籍元数据。打字机节奏在卡片里：每一步一个 `setTimeout`，闭包捕获当前值，
所以调速度或暂停在下一个 tick 就生效。

`settings.section` 的公开契约里**没有图标字段**，外壳会给每个外部插件分区画一个通用齿轮。
所以 bundle 会按注册的 label 认出自己那一行，打上 `data-dsh-read-settings-nav` 标记，再把这个
齿轮换成 `currentColor` 的书本图标（与 `dsh-better-sidebar` 同一种 DOM 适配，销毁时撤回）。

「阅读」设置页 **刻意不持有任何阅读状态**。点「开始阅读」只做一件事：把 shell 当前选中的会话
（来自 `settings.section` 的标准 prop `useSessions`）POST 给 `/start`，由宿主在那里跑真正的
`/read` 命令；只有成功之后才 `close()` 关掉设置面板 —— 所以不会出现「说打开了但其实卡片没生成」
的情况。

### 为什么不去伪造一条 assistant 消息

对话流的 node 键域是**固定**的（`assistant-step`、`user`、`tool-call`、`command`、`steering` …）
—— 插件无法凭空造一条 assistant 消息，而且也不该造：伪造出来的消息会把正文塞进模型上下文，并被
持久化成「模型说过的话」。所以插件改为注册**自己的** node kind，去折叠 `/read` 本来就会写的
`command/run` + `command/done` 这对持久化事件。观感和行为都像流式回复，零 token，且完全可逆
—— 会话日志里唯一的痕迹就是你敲的那条命令。

因为每次 `/read` 都是独立的一条生命周期，同一个会话里可以并存多张阅读卡片，各自记住自己的位置。

## 安全

阅读接口只能读取扩展名在白名单内的文件，`/read` 命令执行同一套白名单——显式给一个非书籍文件会被
拒绝，而不是当文本解码出来。它不是一个通用的文件读取端点，这一点很重要，因为 DSH 的 Web 服务可能
被暴露到 loopback 之外。插件唯一会写的是阅读进度和书库根目录配置，且只写在 `$DSH_HOME/dsh-read/`
下。

## 开发

```bash
node --test "test/*.test.mjs"
```

无依赖、无构建。测试会在内存里现造最小的 EPUB 与 MOBI 容器并用真实解析器读回来，用假的 cordis
context 驱动 Host 的 `/read` 命令和 HTTP 路由，并验证浏览器 bundle 的加载契约——其中包括重放一次
`command/run` + `command/done` 折叠，确认它确实产出了阅读节点。

### 目录结构

```
index.mjs              Host 插件：/read 命令、书库搜索、路由
lib/book.mjs           书籍模型：段落、章节、LRU 缓存
lib/tool.mjs           book_search 模型工具
lib/html.mjs           XHTML/HTML → 文本
lib/formats/epub.mjs   ZIP 中央目录 + OPF spine
lib/formats/mobi.mjs   PalmDB + PalmDOC LZ77 + EXTH 元数据
lib/formats/text.mjs   纯文本编码嗅探
lib/client.js          浏览器 bundle：对话流里的阅读卡片
cordis.patch.yml       把 Host 插件挂进 composition
test/                  解析器、Host 命令与接口、客户端加载契约
```

## 许可证

MIT
