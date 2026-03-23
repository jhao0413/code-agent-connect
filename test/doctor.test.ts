import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../src/doctor.js';
import { StateStore } from '../src/storage.js';

test('runDoctor reports invalid persisted session working directories', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-doctor-'));
  const configPath = path.join(tempDir, 'config.toml');
  const missingDir = path.join(tempDir, 'missing-session-dir');
  await fs.writeFile(configPath, '# test config\n', 'utf8');

  const store = new StateStore(tempDir);
  await store.init();
  await store.saveWeixinCredential({
    token: 'token-1',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    accountId: 'bot@im.bot',
    userId: 'owner@im.wechat',
    savedAt: '2026-03-22T04:25:12.345Z',
  });
  await store.createSession('weixin:bot@im.bot:user@im.wechat', 'claude', missingDir, 'weixin');

  const result = await runDoctor({
    configPath,
    stateDir: tempDir,
    systemdUserDir: tempDir,
    telegram: {
      enabled: false,
      botToken: '',
      allowedUserIds: [],
    },
    weixin: {
      enabled: true,
      channelVersion: '1.0.0',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      skRouteTag: undefined,
    },
    platforms: {
      telegram: {
        enabled: false,
        botToken: '',
        allowedUserIds: [],
      },
      weixin: {
        enabled: true,
        channelVersion: '1.0.0',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        skRouteTag: undefined,
      },
    },
    bridge: {
      defaultAgent: 'claude',
      workingDir: tempDir,
      replyChunkChars: 500,
      replyFlushMs: 1500,
      pollTimeoutSeconds: 30,
      maxInputImageMb: 20,
      allowImageDocuments: true,
    },
    network: {
      proxyUrl: undefined,
      noProxy: undefined,
    },
    agents: {
      enabled: [],
      claude: { bin: undefined, model: undefined, extraArgs: [] },
      codex: { bin: undefined, model: undefined, extraArgs: [] },
      neovate: { bin: undefined, model: undefined, extraArgs: [] },
      opencode: { bin: undefined, model: undefined, extraArgs: [] },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.output, /Active session working directory exists/);
  assert.match(result.output, new RegExp(missingDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
