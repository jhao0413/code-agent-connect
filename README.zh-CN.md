# code-agent-connect

轻量级 Telegram 桥接服务，连接本地 `claude`、`codex` 和 `neovate` CLI。

## 功能范围

- 仅支持 Telegram 私聊
- 每个 Telegram 用户一个活跃会话
- 三个本地 agent：`claude`、`codex`、`neovate`
- macOS 和 Linux 上以前台 `serve` 模式运行
- Linux 上通过 `systemd --user`、macOS 上通过 `launchd` 实现自动重启和开机自启
- 不支持 webhook、群聊、图片/文件输入、Telegram 端权限按钮

## 环境要求

- macOS 或 Linux
- Node.js 20+
- Telegram bot token
- 已安装的本地 CLI：
  - `claude`
  - `codex`
  - `neovate`

暂不支持 Windows。

## 配置

将 `config.example.toml` 复制到 `~/.code-agent-contect/config.toml` 并填写：

- `telegram.bot_token`
- `telegram.allowed_user_ids`
- `bridge.working_dir`
- 可选：`network.proxy_url`（Telegram 或 agent CLI 需要走代理时使用）
- 可选：`[agents.*]` 下的 `bin` / `model` 覆盖配置

二进制文件按以下优先级解析：

1. `CAC_<AGENT>_BIN` 环境变量
2. `config.toml` 中的 `bin` 配置
3. `PATH` 查找

如果使用 Clash 等本地代理，设置：

```toml
[network]
proxy_url = "http://127.0.0.1:7890"
```

`serve`、`doctor` 及生成的后台服务（Linux 上为 `systemd --user`，macOS 上为 `launchd`）会自动将代理传播到 Telegram 访问和三个 agent CLI。

## 命令

```bash
npm run build
node dist/cli.mjs serve
node dist/cli.mjs doctor
node dist/cli.mjs service install
```

## Telegram 命令

- `/start`
- `/help`
- `/new`
- `/set_working_dir /path/to/project`
- `/use claude|codex|neovate`
- `/status`

其他私聊文本消息会被发送给当前活跃的 agent。

每个 Telegram 会话维护独立的工作目录。`/set_working_dir` 更新当前会话的工作目录，目录变更时会重置活跃的 agent 会话，后续交互将在新目录下执行。支持绝对路径、`~/...` 和相对路径；相对路径基于当前会话工作目录解析。

## 保持运行

`code-agent-connect` 在 macOS 和 Linux 上都是普通的前台 Node 进程。`service install` 会安装后台守护服务，支持自动重启和开机自启：

- **Linux**：`systemd --user` 服务
- **macOS**：`launchd` launch agent

安装服务：

```bash
npm run build
node dist/cli.mjs service install
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

## 开发

```bash
npm test
npm run build
```
