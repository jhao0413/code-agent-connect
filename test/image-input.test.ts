import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractImageInfo,
  getUnsupportedMediaRejection,
  BridgeService,
} from '../src/bridge-service.js';
import { buildCommandSpec } from '../src/providers.js';
import { StateStore } from '../src/storage.js';

// ---------- extractImageInfo ----------

test('extractImageInfo picks the largest photo from message.photo', () => {
  const message = {
    photo: [
      { file_id: 'small', width: 90, height: 90, file_size: 1000 },
      { file_id: 'large', width: 800, height: 600, file_size: 50000 },
      { file_id: 'medium', width: 320, height: 240, file_size: 10000 },
    ],
  };
  const info = extractImageInfo(message);
  assert.equal(info.fileId, 'large');
  assert.equal(info.mimeType, 'image/jpeg');
  assert.equal(info.width, 800);
  assert.equal(info.height, 600);
  assert.equal(info.sourceName, 'photo');
});

test('extractImageInfo accepts image/* document', () => {
  const message = {
    document: {
      file_id: 'doc-123',
      mime_type: 'image/png',
      file_size: 200000,
      file_name: 'screenshot.png',
    },
  };
  const info = extractImageInfo(message);
  assert.equal(info.fileId, 'doc-123');
  assert.equal(info.mimeType, 'image/png');
  assert.equal(info.sourceName, 'screenshot.png');
});

test('extractImageInfo rejects non-image document', () => {
  const message = {
    document: {
      file_id: 'doc-456',
      mime_type: 'application/pdf',
      file_name: 'report.pdf',
    },
  };
  const info = extractImageInfo(message);
  assert.equal(info, null);
});

test('extractImageInfo returns null for plain text message', () => {
  const info = extractImageInfo({ text: 'hello' });
  assert.equal(info, null);
});

// ---------- getUnsupportedMediaRejection ----------

test('getUnsupportedMediaRejection rejects albums', () => {
  const msg = getUnsupportedMediaRejection({ media_group_id: '123' });
  assert.ok(msg);
  assert.ok(msg.includes('Album'));
});

test('getUnsupportedMediaRejection rejects non-image document', () => {
  const msg = getUnsupportedMediaRejection({
    document: { mime_type: 'application/pdf' },
  });
  assert.ok(msg);
  assert.ok(msg.includes('application/pdf'));
});

test('getUnsupportedMediaRejection rejects sticker', () => {
  assert.ok(getUnsupportedMediaRejection({ sticker: {} }));
});

test('getUnsupportedMediaRejection rejects video', () => {
  assert.ok(getUnsupportedMediaRejection({ video: {} }));
});

test('getUnsupportedMediaRejection rejects voice', () => {
  assert.ok(getUnsupportedMediaRejection({ voice: {} }));
});

test('getUnsupportedMediaRejection returns null for text message', () => {
  assert.equal(getUnsupportedMediaRejection({ text: 'hello' }), null);
});

test('getUnsupportedMediaRejection returns null for photo message', () => {
  assert.equal(getUnsupportedMediaRejection({
    photo: [{ file_id: 'x', width: 100, height: 100 }],
  }), null);
});

// ---------- buildCommandSpec with image attachments ----------

test('buildCommandSpec adds --image flag for codex with attachments', () => {
  const config = {
    agents: {
      codex: { bin: '/bin/codex', model: '', extraArgs: [] },
    },
  };
  const attachments = [
    { kind: 'image', localPath: '/tmp/att/image.jpg', mimeType: 'image/jpeg' },
  ];
  const spec = buildCommandSpec(config, 'codex', 'analyze this', '/tmp/work', null, attachments);
  const imageIdx = spec.args.indexOf('--image');
  assert.ok(imageIdx >= 0, '--image flag should be present');
  assert.equal(spec.args[imageIdx + 1], '/tmp/att/image.jpg');
  assert.equal(spec.args.at(-1), 'analyze this');
});

test('buildCommandSpec does not add --image for codex without attachments', () => {
  const config = {
    agents: {
      codex: { bin: '/bin/codex', model: '', extraArgs: [] },
    },
  };
  const spec = buildCommandSpec(config, 'codex', 'hello', '/tmp/work', null, []);
  assert.ok(!spec.args.includes('--image'));
});

test('buildCommandSpec adds --image for codex resume with attachments', () => {
  const config = {
    agents: {
      codex: { bin: '/bin/codex', model: '', extraArgs: [] },
    },
  };
  const attachments = [
    { kind: 'image', localPath: '/tmp/att/image.png', mimeType: 'image/png' },
  ];
  const spec = buildCommandSpec(config, 'codex', 'analyze', '/tmp/work', 'session-42', attachments);
  assert.deepEqual(spec.args.slice(0, 3), ['exec', 'resume', 'session-42']);
  assert.ok(spec.args.includes('--image'));
});

// ---------- Provider image rejection ----------

test('streamAgentTurn rejects images for claude', async () => {
  // We import streamAgentTurn dynamically to test the rejection path
  const { streamAgentTurn } = await import('../src/providers.js');
  const events = [];
  for await (const event of streamAgentTurn({
    config: {
      agents: { claude: { bin: '/bin/claude', model: '', extraArgs: [] } },
    },
    agent: 'claude',
    prompt: 'analyze',
    attachments: [{ kind: 'image', localPath: '/tmp/img.jpg', mimeType: 'image/jpeg' }],
    workingDir: '/tmp',
    upstreamSessionId: null,
  })) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'final_text');
  assert.ok(events[0].text.includes('/use codex'));
});

test('streamAgentTurn rejects images for neovate', async () => {
  const { streamAgentTurn } = await import('../src/providers.js');
  const events = [];
  for await (const event of streamAgentTurn({
    config: {
      agents: { neovate: { bin: '/bin/neovate', model: '', extraArgs: [] } },
    },
    agent: 'neovate',
    prompt: 'analyze',
    attachments: [{ kind: 'image', localPath: '/tmp/img.jpg', mimeType: 'image/jpeg' }],
    workingDir: '/tmp',
    upstreamSessionId: null,
  })) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.ok(events[0].text.includes('/use codex'));
});

// ---------- BridgeService handleUpdate with images ----------

function makeTestService(store, overrides = {}) {
  const config = {
    telegram: {
      botToken: 'token',
      allowedUserIds: ['42'],
    },
    bridge: {
      defaultAgent: 'codex',
      workingDir: '/tmp/work',
      replyChunkChars: 500,
      replyFlushMs: 1500,
      pollTimeoutSeconds: 30,
      maxInputImageMb: 20,
      allowImageDocuments: true,
    },
    network: {},
    stateDir: store.stateDir,
    agents: {
      enabled: ['claude', 'codex', 'neovate'],
    },
  };

  const sentMessages = [];
  const service = new BridgeService(config, store, {
    streamAgentTurnImpl: overrides.streamAgentTurnImpl || (async function* ({ prompt, attachments }) {
      yield { type: 'final_text', text: `echo:${prompt}:${attachments.length}` };
    }),
  });

  service.telegram = {
    async sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
    async sendChatAction() {},
    async getFile(fileId) {
      if (overrides.getFile) return overrides.getFile(fileId);
      return { file_id: fileId, file_path: `photos/${fileId}.jpg`, file_size: 1000 };
    },
    async downloadFile(filePath, destPath) {
      if (overrides.downloadFile) return overrides.downloadFile(filePath, destPath);
      // Create a small dummy file
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, 'fake-image-data');
    },
  };

  return { config, service, sentMessages };
}

test('handleUpdate processes photo message with caption', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-img-'));
  const store = new StateStore(stateDir);
  await store.init();

  const { service, sentMessages } = makeTestService(store);

  await service.handleUpdate({
    update_id: 1,
    message: {
      chat: { id: 100, type: 'private' },
      from: { id: 42 },
      caption: 'What is in this image?',
      photo: [
        { file_id: 'sm', width: 90, height: 90, file_size: 500 },
        { file_id: 'lg', width: 800, height: 600, file_size: 5000 },
      ],
    },
  });

  assert.ok(sentMessages.length > 0);
  assert.ok(sentMessages.some((m) => m.text.includes('echo:What is in this image?:1')));
});

test('handleUpdate generates default prompt for image without caption', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-img-'));
  const store = new StateStore(stateDir);
  await store.init();

  const { service, sentMessages } = makeTestService(store);

  await service.handleUpdate({
    update_id: 2,
    message: {
      chat: { id: 100, type: 'private' },
      from: { id: 42 },
      photo: [
        { file_id: 'pic', width: 400, height: 300, file_size: 3000 },
      ],
    },
  });

  assert.ok(sentMessages.some((m) => m.text.includes('echo:Please analyze the attached image')));
  assert.ok(sentMessages.some((m) => m.text.includes(':1')));
});

test('handleUpdate rejects album messages', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-img-'));
  const store = new StateStore(stateDir);
  await store.init();

  const { service, sentMessages } = makeTestService(store);

  await service.handleUpdate({
    update_id: 3,
    message: {
      chat: { id: 100, type: 'private' },
      from: { id: 42 },
      media_group_id: 'group-1',
      photo: [{ file_id: 'p1', width: 100, height: 100 }],
    },
  });

  assert.ok(sentMessages.some((m) => m.text.includes('Album')));
});

test('handleUpdate rejects sticker messages', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-img-'));
  const store = new StateStore(stateDir);
  await store.init();

  const { service, sentMessages } = makeTestService(store);

  await service.handleUpdate({
    update_id: 4,
    message: {
      chat: { id: 100, type: 'private' },
      from: { id: 42 },
      sticker: { file_id: 's1' },
    },
  });

  assert.ok(sentMessages.some((m) => m.text.includes('Sticker')));
});

test('handleUpdate cleans up attachment files after provider completes', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-img-'));
  const store = new StateStore(stateDir);
  await store.init();

  let capturedAttachments = [];
  const { service } = makeTestService(store, {
    streamAgentTurnImpl: async function* ({ attachments }) {
      capturedAttachments = attachments;
      // Verify file exists during provider execution
      for (const att of attachments) {
        const exists = await fs.access(att.localPath).then(() => true).catch(() => false);
        assert.ok(exists, 'Attachment file should exist during provider execution');
      }
      yield { type: 'final_text', text: 'done' };
    },
  });

  await service.handleUpdate({
    update_id: 5,
    message: {
      chat: { id: 100, type: 'private' },
      from: { id: 42 },
      photo: [{ file_id: 'cleanup-test', width: 100, height: 100, file_size: 100 }],
    },
  });

  // After handleUpdate, attachment dir should be cleaned up
  assert.ok(capturedAttachments.length === 1);
  const dirExists = await fs.access(capturedAttachments[0].localDir).then(() => true).catch(() => false);
  assert.ok(!dirExists, 'Attachment directory should be cleaned up after provider completes');
});

test('handleUpdate reports download failure to user', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-img-'));
  const store = new StateStore(stateDir);
  await store.init();

  const { service, sentMessages } = makeTestService(store, {
    getFile() {
      throw new Error('Telegram API error: file too old');
    },
  });

  await service.handleUpdate({
    update_id: 6,
    message: {
      chat: { id: 100, type: 'private' },
      from: { id: 42 },
      photo: [{ file_id: 'expired', width: 100, height: 100, file_size: 100 }],
    },
  });

  assert.ok(sentMessages.some((m) => m.text.includes('Failed to download image')));
});

test('transcript records attachment metadata without file content', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-img-'));
  const store = new StateStore(stateDir);
  await store.init();

  const { service } = makeTestService(store);

  await service.handleUpdate({
    update_id: 7,
    message: {
      chat: { id: 100, type: 'private' },
      from: { id: 42 },
      caption: 'describe this',
      photo: [{ file_id: 'tr-test', width: 200, height: 150, file_size: 2000 }],
    },
  });

  const session = store.getActiveSession('42');
  const transcriptPath = path.join(stateDir, 'transcripts', `${session.id}.jsonl`);
  const lines = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n');
  const inEntry = JSON.parse(lines[0]);

  assert.equal(inEntry.direction, 'in');
  assert.equal(inEntry.text, 'describe this');
  assert.ok(Array.isArray(inEntry.attachments));
  assert.equal(inEntry.attachments[0].kind, 'image');
  assert.equal(inEntry.attachments[0].mimeType, 'image/jpeg');
  // Should NOT contain localPath (file content reference)
  assert.equal(inEntry.attachments[0].localPath, undefined);
});
