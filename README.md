# dsh-hermes-feishu

DeepSeek Harness 的飞书 / Lark 通道。出站图文卡片、入站长连接、语音收发、媒体上传，都在这一个插件里。

A Feishu/Lark channel for DeepSeek Harness: WebSocket inbound messaging, Markdown tables rendered as native Feishu table components, 13 Feishu tools, a web settings page, voice input/output, media upload and a model fallback chain.

---

## 这个插件解决什么

现成的飞书桥大多只把文本丢过去，缓存下来的效果是：表格变成一串竖线，代码块被吞，标题层级全塌成一段。这里的做法是把内容按类型拆开走不同的发送通道：

- **普通文本** → 飞书 `text` 消息
- **Markdown** → Schema 2.0 交互卡片，`wide_screen_mode`
- **Markdown 表格** → 飞书原生 `table` 组件（`columns` + `rows`），不是 markdown 文本
- **`##` 及更深的标题** → 转成粗体（飞书卡片不认多级标题，硬发会退化成纯文本）
- **代码块** → 单独成行，避免被飞书吞掉

入站方向走 WebSocket 长连接。agent 正在跑任务时新到的消息不会排队等，而是插进当前这一轮继续执行。

## 安装

```bash
dsh plugin --profile web add github:lishuaibing521/dsh-hermes-feishu
```

装完重启 dsh web：

```bash
powershell -ExecutionPolicy Bypass -File <你的 dsh 目录>/start-dsh-hidden.ps1 -Target web
```

manifest 依赖 `dsh.bundle.patch`，`dsh plugin add` 靠它识别这是个可安装的 bundle。

## 配置

凭据走环境变量，放在 `~/.dsh/.env`：

| 变量 | 说明 |
| --- | --- |
| `FEISHU_PLUGIN_APP_ID` | 飞书应用 App ID |
| `FEISHU_PLUGIN_APP_SECRET` | 飞书应用 App Secret |
| `FEISHU_PLUGIN_DOMAIN` | `feishu`（国内）或 `lark`（国际），默认 `feishu` |
| `FEISHU_PLUGIN_CHAT_ID` | 默认发送目标（`oc_` 群 或 `ou_` 用户） |
| `FEISHU_PLUGIN_BOT_NAME` | 卡片标题里的机器人名 |
| `FEISHU_PLUGIN_DM_POLICY` | 单聊准入：`open` / `allowlist` / `disabled`（默认 `allowlist`） |
| `FEISHU_PLUGIN_GROUP_POLICY` | 群聊准入：`open` / `allowlist` / `disabled`（默认 `allowlist`） |
| `FEISHU_PLUGIN_ALLOW_FROM` | 准入白名单，逗号分隔的 `open_id`；`*` 表示放行所有人 |

> ⚠️ **变量名不能用 `DSH_` 前缀**。dsh 把 `DSH_*` 一律当成只能由启动环境设置的 bootstrap 变量，写进 `.env` 会让 dsh 直接启动失败。同样的限制还覆盖 `XDG_`、`DYLD_`、`BASH_FUNC_` 前缀，以及 `PATH` / `HOME` / `NODE_OPTIONS` / `GIT_*` 这些具体名字。

飞书那边需要开两样：应用的**机器人能力**，以及**事件订阅里的长连接模式**。只开出站能力也能用工具发消息，但收不到入站消息。

改完配置**不需要重启**——设置页保存即刻生效；只有 App ID / Secret / 域名这类和长连接绑定的项需要重启 dsh web。

## 发送方准入（默认拒绝）

⚠️ **装完必须先配白名单，否则机器人不会响应任何消息**（出厂默认就是拒绝）。

这个插件的入站消息会驱动一个能读写本机文件、执行 shell 的 agent。所以「谁能给机器人发消息」等于「谁能操作你这台机器」，不能用「能发消息就放行」这种默认：

| 策略 | 行为 |
| --- | --- |
| `allowlist`（默认） | 只有 `allowFrom` 里的用户能驱动 agent；**留空 = 谁都不放行** |
| `open` | 任何人都能驱动（仅在你完全清楚后果时使用） |
| `disabled` | 该类会话一律忽略 |

单聊和群聊分别由 `dmPolicy` / `groupPolicy` 控制，默认都是 `allowlist`。

**怎么拿到自己的 `open_id`**：先随便发一条消息，机器人会静默拒绝，同时插件日志里有一行

```
[deny] 发送方不在白名单（dmPolicy=allowlist） chat=oc_xxx open_id=ou_xxx user_id=xxx — 要放行就把该 open_id 填进 allowFrom
```

把那串 `ou_xxx` 填进设置页的「允许的发送方」，或写 `FEISHU_PLUGIN_ALLOW_FROM` 环境变量。

匹配时 `open_id` / `user_id` / `union_id` 任一命中即放行。白名单里写 `*` 表示放行所有人（等于关掉这道闸），只建议本地自用时用。

## Web 设置页

装好后在 dsh 的「设置 → 插件配置」里能看到六个分组：

- **飞书应用** — App ID / Secret / 服务区域（飞书 vs Lark）
- **Agent 与模型** — 主模型 + 备用模型链，两级联动下拉
- **进度气泡** — 思考内容与工具调用的实时显示，工具预览截断长度
- **媒体** — 图片生成 provider / 模型、图片识别 provider / 模型
- **语音** — STT provider / 语言、TTS provider / 音色 / 语速 / 音调 / 音量
- **联网搜索** — search provider、fetch provider

所有 provider 都是**运行时从已注册的插件动态读取**，只列已经配好的，不硬编码厂商名。密钥只在服务端读，不下发前端。

## 工具（13 个）

| 工具 | 作用 |
| --- | --- |
| `feishu_send_message` | 主发送入口，按内容自动判定 text / 卡片 |
| `feishu_send_card` | 强制发交互卡片（走表格渲染） |
| `feishu_send_file` | 发文件，按扩展名路由（ogg→语音、mp4→视频、pdf/doc/xls/ppt→对应类型） |
| `feishu_send_image` | 发图片（p2p / 群） |
| `feishu_send_voice` | 把文本合成为语音气泡发出去 |
| `feishu_reply` | 回复某条消息 |
| `feishu_edit_message` | 编辑已发消息（可用于进度更新） |
| `feishu_delete_message` | 撤回消息 |
| `feishu_download` | 下载消息里的图片 / 文件 |
| `feishu_transcribe` | 语音转文字 |
| `feishu_bot_info` | 查机器人身份 |
| `feishu_render_preview` | 只渲染不发送，调试卡片结构 |
| `feishu_parse_message` | 归一化一条入站消息 |

## 可靠性

- **模型故障转移** — 主模型请求失败时按备用链依次切换，走 dsh 原生的 `agent/request` waterfall，不重建 agent、不重放消息。
- **审批兜底** — 工具调用需要人工确认时发飞书卡片，点上「允许 / 拒绝」。没有这一层的话 dsh 会 fail-closed 直接拒绝，表现为任务莫名失败却没有任何提示。
- **进度气泡** — 思考内容和工具调用混在同一条气泡里实时更新，不会刷屏。**思考过程默认不显示**（`thinkingEnabled` 默认 `false`），要在「设置 → 插件配置 → 进度气泡」里打勾才显示。
- **会话持久化** — 会话映射落盘，dsh 重启后接得上，不会丢上下文。

## 测试

```bash
node test/run.mjs     # 渲染 / 入站 / 路由 / 音频解析
node test/load.mjs    # 插件加载与工具注册契约
node test/probe.mjs   # 真机：token / 机器人身份 / 会话 / 渲染链路
node test/e2e.mjs     # 端到端：构建 → 实发 → 读回 → 撤回
```

`probe` 和 `e2e` 会真连飞书，需要配好上面的环境变量。

## 已知约束

- `chat_id` 必须是机器人已经在的会话，否则发送报 `230002`。
- 音频时长解析只认 OGG/Opus；其他格式回 0（飞书对非 opus 文件走 `stream` 类型，不需要时长）。
- 语音识别和语音合成依赖独立的 dsh 插件（如 `dsh-baidu-stt` / `dsh-baidu-tts`）。没装的话对应下拉框会是空的，出站和入站的文字链路不受影响。
- 同一套飞书应用同时只能有一条长连接。如果已经在别的工具里跑着同一个应用，这里会连不上。
- **入站默认拒绝**：`dmPolicy` / `groupPolicy` 出厂都是 `allowlist` 且白名单为空，装完不配白名单机器人不会响应任何消息。这是刻意的——入站消息会驱动能读写文件、执行 shell 的 agent，默认放行等于把这台机器交给任何能给机器人发消息的人。

## 依赖

- `@deepseek-ai/schemastery` — 配置 schema
- `@larksuiteoapi/node-sdk` — 飞书协议

渲染、消息路由、卡片构建、媒体处理都是自己实现的，没有引第三方渲染库。

## License

MIT