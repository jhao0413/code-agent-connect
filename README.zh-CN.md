# code-agent-connect

[English](README.md)

轻量级 Telegram 桥接服务，连接本地 `claude`、`codex`、`neovate` 和 `opencode` CLI。

## 快速开始

```bash
# 1. 安装
npm install -g code-agent-connect

# 2. 交互式配置（生成 ~/.code-agent-contect/config.toml）
code-agent-connect setup

# 3. 检查环境
code-agent-connect doctor

# 4. 前台运行
code-agent-connect serve

# 5. 或安装为后台服务（仅 macOS / Linux）
code-agent-connect service install

# 仅 Linux：启用重启后自动运行
sudo loginctl enable-linger "$USER"
```

## 支持情况与计划

### 当前支持

| 功能 | claude | codex | neovate | opencode |
|------|--------|-------|---------|----------|
| 文本输入 | ✅ | ✅ | ✅ | ✅ |
| 图片输入 | ❌ | ✅ | ❌ | ❌ |
| 新开会话（`/new`） | ✅ | ✅ | ✅ | ✅ |
| 切换 agent（`/use`） | ✅ | ✅ | ✅ | ✅ |
| 设置工作目录（`/set_working_dir`） | ✅ | ✅ | ✅ | ✅ |
| 查看会话信息（`/status`） | ✅ | ✅ | ✅ | ✅ |

图片输入（在 Telegram 中发送图片）目前仅 `codex` 支持，其他 agent 暂不接受图片消息。

### 后续计划

- **更多 agent** — 随着其他 code agent CLI 成熟，持续扩展支持
- **交互式提示** — 将 agent 端的 `askUserQuestion` 调用透传回 Telegram，让你直接在对话中回应 agent 的选择，无需切回终端
- **模型切换** — 提供 Telegram 命令，用于查看和切换当前 agent 会话所使用的模型

## 功能范围

- 仅支持 Telegram 私聊
- 每个 Telegram 用户一个活跃会话
- 四个本地 agent：`claude`、`codex`、`neovate`、`opencode`
- macOS、Linux、Windows 上均支持前台 `serve` 模式
- Linux 上通过 `systemd --user`、macOS 上通过 `launchd` 实现自动重启和开机自启
- 不支持 webhook、群聊、Telegram 端权限按钮

## 环境要求

- macOS、Linux 或 Windows 10/11
- Node.js 20+
- Telegram bot token
- 已安装的本地 CLI：
  - `claude`
  - `codex`
  - `neovate`
  - `opencode`

> **Windows 说明**：`serve`、`doctor`、`setup`、`check-update` 在 Windows 10/11 + Node.js 20+ 上均可正常使用。`service install/uninstall` 不支持 Windows，可使用 [pm2](https://pm2.keymetrics.io/) 或 [NSSM](https://nssm.cc/) 等第三方工具实现开机自启。

## 配置

运行 `code-agent-connect setup` 进行交互式配置，或手动创建 `~/.code-agent-contect/config.toml` 并填写：

- `telegram.bot_token`
- `telegram.allowed_user_ids`
- `bridge.working_dir`
- 可选：`network.proxy_url`（Telegram 或 agent CLI 需要走代理时使用）
- 可选：`[agents.*]` 下的 `bin` / `model` 覆盖配置

如果使用 Clash 等本地代理，设置：

```toml
[network]
proxy_url = "http://127.0.0.1:7890"
```

`serve`、`doctor` 及生成的后台服务（Linux 上为 `systemd --user`，macOS 上为 `launchd`）会自动将代理传播到 Telegram 访问和 agent CLI。

## 命令

```bash
code-agent-connect setup               # 交互式配置向导
code-agent-connect serve               # 启动桥接服务（前台运行）
code-agent-connect doctor              # 检查配置、二进制文件、Telegram token 及服务状态
code-agent-connect service install     # 安装为后台服务（systemd/launchd，仅 macOS/Linux）
code-agent-connect service uninstall   # 卸载后台服务
code-agent-connect check-update        # 检查 npm 上是否有新版本
```

## Telegram 命令

- `/start`
- `/help`
- `/new`
- `/set_working_dir /path/to/project`
- `/use claude|codex|neovate|opencode`
- `/status`

其他私聊文本消息会被发送给当前活跃的 agent。

每个 Telegram 会话维护独立的工作目录。`/set_working_dir` 更新当前会话的工作目录，目录变更时会重置活跃的 agent 会话，后续交互将在新目录下执行。支持绝对路径、`~/...` 和相对路径；相对路径基于当前会话工作目录解析。

## 保持运行

`code-agent-connect` 是普通的前台 Node 进程。在 macOS 和 Linux 上，`service install` 会安装后台守护服务，支持自动重启和开机自启：

- **Linux**：`systemd --user` 服务
- **macOS**：`launchd` launch agent

安装服务：

```bash
code-agent-connect service install
```

### 仅 Linux

启用重启后自动运行：

```bash
sudo loginctl enable-linger "$USER"
```

查看日志：

```bash
journalctl --user -u code-agent-connect -f
```

### 仅 macOS

Launch agent 在登录时自动启动（`RunAtLoad` + `KeepAlive`），无需额外操作。

查看日志：

```bash
tail -f ~/.local/state/code-agent-connect/stdout.log
tail -f ~/.local/state/code-agent-connect/stderr.log
```

## 更新

```bash
npm update -g code-agent-connect
```

## 开发

```bash
git clone https://github.com/jhao0413/code-agent-connect.git
cd code-agent-connect
npm install
npm run build
npm test

# 不全局安装，直接运行
node dist/cli.js serve
node dist/cli.js doctor
```
