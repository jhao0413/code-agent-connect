import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTelegramCommands } from '../src/bridge-service.js';
import { BridgeService } from '../src/bridge-service.js';
import { StateStore } from '../src/storage.js';

test('buildTelegramCommands exposes the Telegram menu entries', () => {
  const commands = buildTelegramCommands({
    agents: {
      enabled: ['claude', 'codex', 'neovate'],
    },
  });

  assert.deepEqual(commands, [
    {
      command: 'start',
      description: 'Show help and available commands',
    },
    {
      command: 'help',
      description: 'Show help and usage tips',
    },
    {
      command: 'new',
      description: 'Start a fresh logical session',
    },
    {
      command: 'use',
      description: 'Switch agent: claude|codex|neovate',
    },
    {
      command: 'set_working_dir',
      description: 'Set the session working directory',
    },
    {
      command: 'status',
      description: 'Show current session and active agent',
    },
  ]);
});

test('StateStore working dir can be updated for the active session', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-bridge-'));
  const store = new StateStore(stateDir);
  await store.init();

  const session = await store.createSession('42', 'codex', '/tmp/original');
  session.providerSessionIds.claude = 'claude-session';
  session.providerSessionIds.codex = 'session-123';
  session.providerWorkingDirs.claude = '/tmp/original';
  session.providerWorkingDirs.codex = '/tmp/original';
  await store.saveSession(session);
  const updated = await store.setWorkingDir('42', 'codex', '/tmp/next');

  assert.equal(updated.id, session.id);
  assert.equal(updated.workingDir, '/tmp/next');
  assert.equal(updated.providerSessionIds.claude, 'claude-session');
  assert.equal(updated.providerSessionIds.codex, null);
  assert.equal(updated.providerWorkingDirs.claude, '/tmp/original');
  assert.equal(updated.providerWorkingDirs.codex, null);
  assert.equal(store.getActiveSession('42').workingDir, '/tmp/next');
});

test('BridgeService /set_working_dir accepts quoted relative paths with spaces', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-bridge-'));
  const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-work-'));
  const nextDir = path.join(workingRoot, 'repo with spaces');
  await fs.mkdir(nextDir);

  const store = new StateStore(stateDir);
  await store.init();
  const session = await store.createSession('42', 'codex', workingRoot);
  session.providerSessionIds.claude = 'claude-session';
  session.providerSessionIds.codex = 'session-123';
  session.providerWorkingDirs.claude = workingRoot;
  session.providerWorkingDirs.codex = workingRoot;
  await store.saveSession(session);
  const sentMessages = [];

  const service = new BridgeService({
    telegram: {
      botToken: 'token',
      allowedUserIds: ['42'],
    },
    bridge: {
      defaultAgent: 'codex',
      workingDir: workingRoot,
      replyChunkChars: 500,
      replyFlushMs: 1500,
      pollTimeoutSeconds: 30,
    },
    network: {},
    agents: {
      enabled: ['claude', 'codex', 'neovate'],
    },
  }, store);

  service.telegram = {
    async sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
  };

  await service.handleCommand(123, '42', session, '/set_working_dir "repo with spaces"');

  assert.equal(store.getActiveSession('42').workingDir, nextDir);
  assert.equal(store.getActiveSession('42').providerSessionIds.claude, 'claude-session');
  assert.equal(store.getActiveSession('42').providerSessionIds.codex, null);
  assert.deepEqual(sentMessages, [{
    chatId: 123,
    text: `Updated session working directory.\nSession: ${session.id}\nWorking dir: ${nextDir}\nCurrent codex session: reset`,
  }]);
});

test('BridgeService restarts only the mismatched agent session after a cwd change', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-bridge-'));
  const store = new StateStore(stateDir);
  await store.init();

  const session = await store.createSession('42', 'codex', '/tmp/next');
  session.providerSessionIds.codex = 'old-codex-session';
  session.providerSessionIds.claude = 'claude-session';
  session.providerWorkingDirs.codex = '/tmp/original';
  session.providerWorkingDirs.claude = '/tmp/original';
  await store.saveSession(session);

  const sentMessages = [];
  let callCount = 0;
  const service = new BridgeService({
    telegram: {
      botToken: 'token',
      allowedUserIds: ['42'],
    },
    bridge: {
      defaultAgent: 'codex',
      workingDir: '/tmp/default',
      replyChunkChars: 500,
      replyFlushMs: 1500,
      pollTimeoutSeconds: 30,
    },
    network: {},
    agents: {
      enabled: ['claude', 'codex', 'neovate'],
    },
  }, store, {
    streamAgentTurnImpl: async function* ({ upstreamSessionId, workingDir }) {
      callCount += 1;
      assert.equal(upstreamSessionId, null);
      assert.equal(workingDir, '/tmp/next');
      yield { type: 'session_started', sessionId: 'new-codex-session' };
      yield { type: 'final_text', text: 'done' };
    },
  });

  service.telegram = {
    async sendChatAction() {},
    async sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
  };

  await service.handlePrompt(123, store.getActiveSession('42'), 'hi');

  const updated = store.getActiveSession('42');
  assert.equal(callCount, 1);
  assert.equal(updated.providerSessionIds.codex, 'new-codex-session');
  assert.equal(updated.providerWorkingDirs.codex, '/tmp/next');
  assert.equal(updated.providerSessionIds.claude, 'claude-session');
  assert.equal(updated.providerWorkingDirs.claude, '/tmp/original');
  assert.deepEqual(sentMessages, [{
    chatId: 123,
    text: 'done',
  }]);
});
