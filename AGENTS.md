# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the runtime modules for the Node.js CLI bridge, including `cli.mjs`, `bridge-service.mjs`, `doctor.mjs`, `service-manager.mjs`, and shared config/storage helpers. `test/` mirrors that layout with `*.test.mjs` files using Node's built-in test runner. `scripts/build.mjs` creates `dist/` by copying `src/`, so make source changes in `src/` and treat `dist/` as generated output. Keep reference material in `docs/`, and use `config.example.toml` as the template for local configuration.

## Build, Test, and Development Commands
`npm test` runs the full test suite with `node --test`. `npm run build` refreshes `dist/` from the current `src/` tree. Use `node dist/cli.mjs doctor --config /path/to/config.toml` to validate config, binaries, and runtime prerequisites, and `node dist/cli.mjs serve --config /path/to/config.toml` to start the bridge locally. Rebuild before testing CLI behavior from `dist/`.

## Coding Style & Naming Conventions
Use ES modules and modern Node.js 20 APIs only. Follow the existing style: two-space indentation, trailing commas in multiline literals, and small focused modules. Prefer `camelCase` for variables/functions, `PascalCase` for classes, and kebab-free filenames ending in `.mjs`. Keep TOML keys snake_case to match the config schema exposed to users.

## Testing Guidelines
Add or update tests in `test/` whenever behavior changes in `src/`. Name files `feature.test.mjs` and write descriptive test titles such as `test('loadConfig rejects unsupported default agent', ...)`. Cover config validation, service wiring, and Telegram command behavior when those paths change. Run `npm test` before opening a PR.

## Commit & Pull Request Guidelines
This checkout does not include Git history, so no local commit convention can be derived. Use short imperative commit subjects such as `Add proxy validation to doctor`, and keep unrelated changes out of the same commit. PRs should explain the user-visible change, list validation steps (`npm test`, `npm run build`), and include terminal output snippets when CLI or service behavior changes.

## Security & Configuration Tips
Do not commit real bot tokens, user IDs, or personal config files. Keep secrets in your local TOML config or environment, and only commit sanitized examples. When editing service or proxy behavior, verify both `doctor` and `serve` paths because proxy settings are propagated to Telegram access and spawned agent CLIs.
