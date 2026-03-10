import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentBinEnvName, loadConfig } from '../src/config.js';

function configText() {
  return `
[telegram]
bot_token = "123"
allowed_user_ids = ["42"]

[bridge]
default_agent = "claude"
working_dir = "/tmp"

[network]
proxy_url = "http://127.0.0.1:7890"

[agents]
enabled = ["claude", "codex", "neovate"]

[agents.claude]
extra_args = []

[agents.codex]
extra_args = []

[agents.neovate]
extra_args = []
`;
}

test('loadConfig returns normalized config', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-config-'));
  const configPath = path.join(tempDir, 'config.toml');
  await fs.writeFile(configPath, configText(), 'utf8');

  const config = await loadConfig(configPath);
  assert.equal(config.telegram.botToken, '123');
  assert.deepEqual(config.telegram.allowedUserIds, ['42']);
  assert.equal(config.bridge.defaultAgent, 'claude');
  assert.equal(config.bridge.replyChunkChars, 500);
  assert.equal(config.network.proxyUrl, 'http://127.0.0.1:7890');
});

test('loadConfig rejects unsupported default agent', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-config-'));
  const configPath = path.join(tempDir, 'config.toml');
  await fs.writeFile(
    configPath,
    configText().replace('default_agent = "claude"', 'default_agent = "bad-agent"'),
    'utf8',
  );

  await assert.rejects(() => loadConfig(configPath), /bridge\.default_agent/);
});

test('agent bin environment variable names are stable', () => {
  assert.equal(agentBinEnvName('claude'), 'CAC_CLAUDE_BIN');
});
