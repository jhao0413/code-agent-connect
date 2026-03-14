# code-agent-connect

[中文](README.zh-CN.md)

Minimal Telegram bridge for local `claude`, `codex`, `neovate`, and `opencode` CLIs.

## Quick Start

```bash
# 1. Install
npm install -g code-agent-connect

# 2. Interactive setup (creates ~/.code-agent-contect/config.toml)
code-agent-connect setup

# 3. Verify setup
code-agent-connect doctor

# 4. Run (foreground)
code-agent-connect serve

# 5. Or install as background service — macOS / Linux only
code-agent-connect service install

# Linux only: enable startup after reboot
sudo loginctl enable-linger "$USER"
```

## Status & Roadmap

### Current support

| Feature | claude | codex | neovate | opencode |
|---------|--------|-------|---------|----------|
| Text input | ✅ | ✅ | ✅ | ✅ |
| Image input | ❌ | ✅ | ❌ | ❌ |
| New session (`/new`) | ✅ | ✅ | ✅ | ✅ |
| Switch agent (`/use`) | ✅ | ✅ | ✅ | ✅ |
| Set working dir (`/set_working_dir`) | ✅ | ✅ | ✅ | ✅ |
| View session info (`/status`) | ✅ | ✅ | ✅ | ✅ |

Image input (sending a photo in Telegram) is currently only supported by `codex`. Other agents do not yet accept image messages.

### Planned

- **More agents** — support additional code agent CLIs as they mature
- **Interactive prompts** — surface agent-side `askUserQuestion` calls back to Telegram so you can respond to agent choices without touching the terminal
- **Model switching** — a Telegram command to list and switch the active model for the current agent session

## Scope

- Telegram private chat only
- One active logical session per Telegram user
- Four local agents: `claude`, `codex`, `neovate`, `opencode`
- Foreground `serve` runtime on macOS, Linux, and Windows
- `systemd --user` on Linux and `launchd` on macOS for restart and boot-time startup
- No webhook, no group chat, no Telegram-side permission buttons

## Requirements

- macOS, Linux, or Windows 10/11
- Node.js 20+
- Telegram bot token
- Installed local CLIs:
  - `claude`
  - `codex`
  - `neovate`
  - `opencode`

> **Windows note**: `serve`, `doctor`, `setup`, and `check-update` all work natively on Windows 10/11 with Node.js 20+. The `service install/uninstall` commands are not supported — use a third-party process manager such as [pm2](https://pm2.keymetrics.io/) or [NSSM](https://nssm.cc/) for auto-start.

## Configure

Run `code-agent-connect setup` for an interactive wizard, or manually create `~/.code-agent-contect/config.toml` and fill in:

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

`serve`, `doctor`, and the generated service (`systemd --user` on Linux, `launchd` on macOS) will then propagate the proxy to Telegram access and to the agent CLIs.

## Commands

```bash
code-agent-connect setup               # Interactive config setup wizard
code-agent-connect serve               # Start the bridge (foreground)
code-agent-connect doctor              # Check config, binaries, Telegram token, and service status
code-agent-connect service install     # Install as background service (systemd/launchd — macOS/Linux only)
code-agent-connect service uninstall   # Remove the background service
code-agent-connect check-update        # Check if a newer version is available on npm
```

## Telegram commands

- `/start`
- `/help`
- `/new`
- `/set_working_dir /path/to/project`
- `/use claude|codex|neovate|opencode`
- `/status`

Any other private text message is sent to the active agent.

Each Telegram logical session keeps its own working directory. `/set_working_dir` updates that directory for the current session and resets the active agent session when the directory changes, so subsequent turns run from the new location. The command accepts absolute paths, `~/...`, and relative paths; relative paths are resolved from the current session working directory.

## Keeping It Running

`code-agent-connect` is a regular foreground Node process. On macOS and Linux, `service install` sets up a background daemon that auto-restarts and survives reboot:

- **Linux**: `systemd --user` service
- **macOS**: `launchd` launch agent

Install the service:

```bash
code-agent-connect service install
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

## Updating

```bash
npm update -g code-agent-connect
```

## Development

```bash
git clone https://github.com/jhao0413/code-agent-connect.git
cd code-agent-connect
npm install
npm run build
npm test

# Run directly without global install
node dist/cli.js serve
node dist/cli.js doctor
```
