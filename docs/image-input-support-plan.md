# 图片输入支持方案

## 摘要

- 当前项目只接受 `message.text`，没有 Telegram 文件下载、附件抽象、或 provider 级图片入口。
- 第一阶段按已确认范围实现：支持 Telegram `photo` 和 `image/* document` 输入，不做相册聚合；原生视觉先落到 `codex`，`claude` 和 `neovate` 在图片轮次明确提示切换到 `/use codex`。
- 第二阶段再把 `claude` 和 `neovate` 从“纯 CLI 文本桥接”升级为支持图片附件的 provider：
  - `claude` 走 Anthropic Agent SDK 多模态消息流
  - `neovate` 走其库层 `attachments?: ImagePart[]` 能力，而不是当前 quiet CLI
- 不做伪视觉降级，不把图片路径硬塞进文本 prompt 冒充多模态。

## 关键实现

### 1. Telegram 输入链路

- 扩展 Telegram update 解析：
  - `message.photo`：取最大尺寸的 `PhotoSize`
  - `message.document`：仅接受 `mime_type` 以 `image/` 开头的文件
  - 文本来源优先用 `message.caption`，无 caption 时生成默认 prompt：`Please analyze the attached image and explain what you see.`
- 在 `TelegramClient` 增加：
  - `getFile(fileId)`
  - `downloadFile(filePath, destinationPath)`
- 下载流程统一复用现有代理能力；若配置了 `network.proxy_url`，`getFile` 和二进制下载都走代理。
- 单轮输入只支持 1 张图片：
  - `photo` 天然只取 1 张
  - `document` 只取 1 个
  - `media_group_id` 相册第一阶段直接拒绝，并返回“相册多图暂不支持，请单张发送”
- 非图片 document、sticker、animation、video、voice 等维持明确拒绝提示，不静默吞掉。

### 2. 附件抽象与本地文件生命周期

- 在 bridge 层新增统一输入结构：
  - `attachments?: Array<{ kind: "image"; mimeType: string; telegramFileId: string; localPath: string; sourceName?: string; width?: number; height?: number; sizeBytes?: number }>`
- `handlePrompt` 改为接收 `prompt + attachments`，而不是只传文本。
- 下载文件落到状态目录下的临时附件目录，例如 `~/.local/state/code-agent-connect/attachments/<turn-id>/...`
- provider 子进程结束后删除该轮附件文件；transcript 只保留元数据，不保存原始图片字节。
- 加输入校验：
  - 仅允许 `image/png`、`image/jpeg`、`image/webp`、`image/gif`
  - 超过限制直接拒绝，默认限制 20 MB
- 新增配置项：
  - `[bridge] max_input_image_mb = 20`
  - `[bridge] allow_image_documents = true`

### 3. Provider 分阶段接入

- 第一阶段只改公共接口和 Codex provider：
  - `streamAgentTurn({ prompt, attachments, ... })`
  - `codex exec` / `codex exec resume` 在有图片时追加 `--image <local-file>`，支持续聊图片补充
- 第一阶段 `claude` / `neovate` 行为固定为：
  - 如果当前轮有图片，直接回复“当前 agent 的 Telegram 图片输入尚未接通，请切换到 `/use codex`”
  - 纯文本轮次保持原样
- 第二阶段 `claude`：
  - 不继续走当前 CLI 文本桥接
  - 参考现有旧项目中的多模态 prompt builder，把图片转成 base64 image blocks，经 Anthropic Agent SDK 发起 query/resume
  - 保持现有流式文本事件归一化接口不变
- 第二阶段 `neovate`：
  - 不依赖 quiet CLI 扩展未知参数
  - 新建库 API provider，直接构造 `attachments?: ImagePart[]`
  - 继续复用当前 bridge 层的统一附件结构和事件归一化输出

### 4. 用户体验与命令反馈

- `/help` 文案补充图片能力说明：
  - 支持单张照片或图片文件
  - 多图相册暂不支持
  - `claude` / `neovate` 图片轮次暂不支持，建议切换 `/use codex`
- `typing` 状态在图片下载和 agent 处理期间都保持开启。
- 图片轮如果 caption 为空，机器人不追问，直接按默认分析 prompt 发送。
- 图片轮如果图片下载失败、Telegram `getFile` 失败、或 MIME 不支持，直接返回具体失败原因。

## 测试计划

- Telegram 入口：
  - `photo` 消息能选中最大尺寸图并生成附件
  - `image/* document` 能生成附件
  - 非图片 document 被拒绝
  - `media_group_id` 相册被拒绝
  - 无文本仅图片时会生成默认 prompt
  - caption + image 时 caption 成为 prompt
- 下载与存储：
  - `getFile` 和下载请求在代理配置下可工作
  - 超限图片被拒绝
  - provider 完成或报错后临时附件被清理
  - transcript 只记录附件元数据
- Provider：
  - `codex exec` 首轮带图时拼出正确的 `--image`
  - `codex exec resume` 续聊带图时仍拼出正确的 `--image`
  - 当前 agent 为 `claude` / `neovate` 且收到图片时，返回明确引导而不是吞掉图片
- 回归：
  - 纯文本消息行为不变
  - `/use`、`/new`、`/status`、typing、命令菜单不受影响

## 假设与默认

- 第一阶段目标不是“三个 agent 同时真视觉”，而是先把 Telegram 图片输入管道和 Codex 原生视觉做稳。
- 第一阶段只支持单张图片每轮，不支持 Telegram 相册聚合。
- 图片原始内容不持久化，仅做短时本地文件中转；会话历史只保留元数据。
- `claude` 的图片支持实现路径明确选 SDK，不继续赌当前 CLI print 模式是否存在未公开多模态入口。
- `neovate` 的图片支持实现路径明确选库 API，不继续赌当前 quiet CLI 是否存在未公开附件参数。
