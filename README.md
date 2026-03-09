# code-agent-connect

Minimal Telegram bridge for local `claude`, `codex`, and `neovate` CLIs.

## Scope

- Telegram private chat only
- One active logical session per Telegram user
- Three local agents: `claude`, `codex`, `neovate`
- `systemd --user` for restart and boot-time startup
- No webhook, no group chat, no image/file input, no Telegram-side permission buttons

## Requirements

- Linux
- Node.js 20+
- Telegram bot token
- Installed local CLIs:
  - `claude`
  - `codex`
  - `neovate`

## Configure

Copy `config.example.toml` to `~/.code-agent-contect/config.toml` and fill in:

- `telegram.bot_token`
- `telegram.allowed_user_ids`
- `bridge.working_dir`
- Optional `network.proxy_url` if Telegram or the agent CLIs must go through a proxy
- Optional `bin` / `model` overrides under `[agents.*]`

The service resolves binaries in this order:

1. `CAC_<AGENT>_BIN` environment variable
2. `bin` in `config.toml`
3. `PATH`

If you use a local proxy such as Clash, set:

```toml
[network]
proxy_url = "http://127.0.0.1:7890"
```

`serve`, `doctor`, and the generated `systemd --user` service will then propagate the proxy to Telegram access and to the three agent CLIs.

## Commands

```bash
npm run build
node dist/cli.mjs doctor
node dist/cli.mjs serve
node dist/cli.mjs service install
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

`code-agent-connect` is a regular foreground Node process. Long-term uptime is handled by `systemd --user`.

Install the service:

```bash
npm run build
node dist/cli.mjs service install
```

Make it survive reboot and login/logout the same way as a normal `systemd` user service:

```bash
sudo loginctl enable-linger "$USER"
```

Inspect logs:

```bash
journalctl --user -u code-agent-connect -f
```

## Development

```bash
npm test
npm run build
```
