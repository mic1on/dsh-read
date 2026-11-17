# 批注 Markdown 实施计划

依据已确认设计，2026-11-17。当前技能目录无 writing-plans，直接记录可执行计划。

## API 验证结论与设计勘误

- 当前 DSH 的 `session/event(session,event)` 是 post-commit emit；durable `user/message` 在已打开 turn 内提交，`assistant/message.data.turn` 精确指向 turn，`turn/end.data.reason.kind` 区分完成/中断。
- 用 `sessionProjections.register` 注册纯 JSON 的 host-only fold，`stateOf(session)` 读取；只在 user/message 与 turn/end 的持久事件边界触发归档 IO，不扫每个 token。
- `sessionQuery.readSession(id)` 读取已知 pending 批注关联的会话，重启恢复无需猜测/解压磁盘格式。无该可选服务时仍保存批注，已打开会话恢复时补齐。
- 问 AI 目前仅填草稿、并不写 notes.json：启用归档后，须先创建 question 批注取得锚点，再填草稿；提交的真实用户问题由持久 user/message 回写。Markdown 关闭时保留原草稿行为。
- JSON 必须同步保存 question/answer/answerState/sessionId/turn，否则全量导出会丢回答；普通更新只替换 Markdown 中插件标记的问答区域，保留用户额外正文；明确的全量导出才重建插件文件。
- `<!--dshr-id-->` 在 Markdown 阅读视图不显示，但输入框与模型仍可见；不是零宽/零 token 元数据。
- 首次配置目录执行只补缺不覆盖的迁移，兼容已含 `.obsidian` 的 vault；显式「立即导出全部」才覆盖同 book_path+note_id 的已验证插件文件。只管理本插件生成的文件。
- 初次回答超过 10 分钟仍可由重启恢复补齐；中断记录保留 partial text，标 interrupted，不伪装成 answered。

## 步骤

1. 独立 MarkdownVault：YAML 转义、1 基文件名、冲突避让、标记身份、限定区域更新、原子写、安全边界/符号链接测试。
2. NotesStore：序列化 JSON/config 变更、防并发丢写、UUID 新 ID、双写错误分离、迁移、导出、删除、实际问题/回答持久化。
3. Answer projection：仅认 user source 锚点、会话/turn 关联、多个 assistant text 拼接、工具和 reasoning 排除、完成/中断、重放幂等、已知 session 恢复、卸载清理。
4. 客户端：保持现有主题修复；独立归档设置块、禁用/迁移/覆盖提示、先存锚点再填草稿、失败时不阻止提问并明确提示。
5. 共用 reading_notes 操作供 HTTP 和模型工具调用；元数据/图标、发布文件清单、中英文 README、公开类型更新。
6. 自动测试（基线 74/74）：新增 store/projection/vault tests、客户端异步交互、host routes；syntax + npm pack dry run + 变更审查。
7. 用插件管理器安装/更新当前 profile；若替换包要求重启，明确告知，不自行关闭当前用户会话。只在既有 GUI URL 验证，不启动替代服务。

## 验证后修正

- 归档设置保持两行；更多操作按需展开。
- 目录选择先查询宿主 directoryPicker capability；native 调 pickDirectory，browse 用 listDirectory 在设置块内浏览，取消不保存，卸载/取消会终止正在读取的请求。
- JSON 中记录 Markdown dirty 状态以重启补写；删除失败可按同 ID 安全重试。
- 中途加入该轮的问题只获取自己提问后的 assistant 正文；fork 继承与 reasoning/tool 文本不归档。
- CI 需安装 Zod（不自动安装 Harness peers），集成测试校验真实投影 schema。
