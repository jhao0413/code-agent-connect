# code-agent-connect

[中文](README.zh-CN.md)

Minimal Telegram bridge for local `claude`, `codex`, and `neovate` CLIs.

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/anthropics/code-agent-connect.git
cd code-agent-connect
npm install
npm run build

# 2. Create config
mkdir -p ~/.code-agent-contect
cp config.example.toml ~/.code-agent-contect/config.toml
# Edit config.toml: fill in bot_token, allowed_user_ids, working_dir

# 3. Verify setup
node dist/cli.mjs doctor

# 4. Run (foreground)
node dist/cli.mjs serve

# 5. Or install as background service (auto-restart + boot-time startup)
node dist/cli.mjs service install

# Linux only: enable startup after reboot
sudo loginctl enable-linger "$USER"
```

## Scope

- Telegram private chat only
- One active logical session per Telegram user
- Three local agents: `claude`, `codex`, `neovate`
- Foreground `serve` runtime on macOS and Linux
- `systemd --user` on Linux and `launchd` on macOS for restart and boot-time startup
- No webhook, no group chat, no image/file input, no Telegram-side permission buttons

## Requirements

- macOS or Linux
- Node.js 20+
- Telegram bot token
- Installed local CLIs:
  - `claude`
  - `codex`
  - `neovate`

Windows is not supported at the moment.

## Configure

Copy `config.example.toml` to `~/.code-agent-contect/config.toml` and fill in:

- `telegram.bot_token`
- `telegram.allowed_user_ids`
- `bridge.working_dir`
- Optional `network.proxy_url` if Telegram or the agent CLIs must go through a proxy
- Optional `bin` / `model` overrides under `[agents.*]`

If you use a local proxy such as Clash, set:

```toml
[network]
proxy_url = "http://127.0.0.1:7890"
```

`serve`, `doctor`, and the generated service (`systemd --user` on Linux, `launchd` on macOS) will then propagate the proxy to Telegram access and to the three agent CLIs.

## Commands

```bash
npm run build                        # Compile TypeScript to dist/
node dist/cli.mjs serve              # Start the bridge (foreground)
node dist/cli.mjs doctor             # Check config, binaries, Telegram token, and service status
node dist/cli.mjs service install    # Install as background service (systemd/launchd)
node dist/cli.mjs service uninstall  # Remove the background service
```

## Telegram commands

- `/start`
- `/help`
- `/new`
- `/set_working_dir /path/to/project`
- `/use claude|codex|neovate`
- `/status`

Any other private text message is sent to the active agent.

Each Telegram logical session keeps its own working directory. `/set_working_dir` updates that directory for the current session and resets the active agent session when the directory changes, so subsequent turns run from the new location. The command accepts absolute paths, `~/...`, and relative paths; relative paths are resolved from the current session working directory.

## Keeping It Running

`code-agent-connect` is a regular foreground Node process on macOS and Linux. `service install` sets up a background daemon that auto-restarts and survives reboot:

- **Linux**: `systemd --user` service
- **macOS**: `launchd` launch agent

Install the service:

```bash
npm run build
node dist/cli.mjs service install
```

### Linux only

Make it survive reboot and login/logout:

```bash
sudo loginctl enable-linger "$USER"
```

Inspect logs:

```bash
journalctl --user -u code-agent-connect -f
```

### macOS only

The launch agent starts at login automatically (`RunAtLoad` + `KeepAlive`). No extra step is needed.

Inspect logs:

```bash
tail -f ~/.local/state/code-agent-connect/stdout.log
tail -f ~/.local/state/code-agent-connect/stderr.log
```

## Development

```bash
npm test
npm run build
```
