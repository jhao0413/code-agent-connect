import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/storage.js';
import { WeixinClient } from '../src/weixin-client.js';
import { runWeixinLogin } from '../src/weixin-login.js';
import { WeixinBridgeService } from '../src/weixin-service.js';

function weixinOnlyConfigText() {
  return `
[platforms.telegram]
enabled = false

[platforms.weixin]
enabled = true
channel_version = "1.0.2"
sk_route_tag = "1001"

[bridge]
default_agent = "claude"
working_dir = "/tmp"

[agents]
enabled = ["claude"]

[agents.claude]
extra_args = []
`;
}

test('loadConfig supports platform sections for Telegram and Weixin', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-weixin-config-'));
  const configPath = path.join(tempDir, 'config.toml');
  await fs.writeFile(configPath, weixinOnlyConfigText(), 'utf8');

  const config = await loadConfig(configPath);
  assert.equal(config.platforms.telegram.enabled, false);
  assert.equal(config.platforms.weixin.enabled, true);
  assert.equal(config.platforms.weixin.channelVersion, '1.0.2');
  assert.equal(config.platforms.weixin.skRouteTag, '1001');
  assert.equal(config.weixin.enabled, true);
  assert.equal(config.weixin.channelVersion, '1.0.2');
});

test('StateStore persists Weixin credentials, cursor, context tokens, and typing tickets', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-weixin-state-'));
  const store = new StateStore(stateDir);
  await store.init();

  await store.saveWeixinCredential({
    token: 'ilinkbot_token',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    accountId: 'bot@im.bot',
    userId: 'owner@im.wechat',
    savedAt: '2026-03-22T04:25:12.345Z',
  });
  await store.setWeixinCursor('bot@im.bot', 'cursor-1', 35000);
  await store.setWeixinContextToken('bot@im.bot', 'user@im.wechat', 'context-1');
  await store.setWeixinTypingTicket('bot@im.bot', 'user@im.wechat', {
    ticket: 'typing-ticket-1',
    savedAt: '2026-03-22T04:25:12.345Z',
  });

  const reloaded = new StateStore(stateDir);
  await reloaded.init();

  assert.equal(reloaded.getActiveWeixinCredential()?.token, 'ilinkbot_token');
  assert.deepEqual(reloaded.getWeixinCursor('bot@im.bot'), {
    getUpdatesBuf: 'cursor-1',
    longpollingTimeoutMs: 35000,
  });
  assert.equal(reloaded.getWeixinContextToken('bot@im.bot', 'user@im.wechat'), 'context-1');
  assert.equal(reloaded.getWeixinTypingTicket('bot@im.bot', 'user@im.wechat')?.ticket, 'typing-ticket-1');
});

test('WeixinClient sends authenticated text message payloads', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new WeixinClient({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'ilinkbot_123',
    channelVersion: '1.0.2',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
      } as Response;
    },
  });

  await client.sendTextMessage({
    toUserId: 'user@im.wechat',
    contextToken: 'context-1',
    text: 'hello from bot',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  assert.equal(calls[0].init.method, 'POST');

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(headers.Authorization, 'Bearer ilinkbot_123');
  assert.match(Buffer.from(headers['X-WECHAT-UIN'], 'base64').toString('utf8'), /^\d+$/);

  const payload = JSON.parse(String(calls[0].init.body));
  assert.equal(payload.base_info.channel_version, '1.0.2');
  assert.equal(payload.msg.to_user_id, 'user@im.wechat');
  assert.equal(payload.msg.context_token, 'context-1');
  assert.equal(payload.msg.message_type, 2);
  assert.equal(payload.msg.message_state, 2);
  assert.equal(payload.msg.item_list[0].text_item.text, 'hello from bot');
});

test('runWeixinLogin stores confirmed credentials and resets the account cursor', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-weixin-login-'));
  const store = new StateStore(stateDir);
  await store.init();
  await store.saveWeixinCredential({
    token: 'old-token',
    baseUrl: 'https://old.example.com',
    accountId: 'bot@im.bot',
    userId: 'owner@im.wechat',
    savedAt: '2026-03-20T00:00:00.000Z',
  });
  await store.setWeixinCursor('bot@im.bot', 'cursor-old', 35000);
  const staleOwnerKey = 'weixin:bot@im.bot:user@im.wechat';
  const staleSession = await store.createSession(staleOwnerKey, 'claude', '/bad/working-dir', 'weixin');
  staleSession.providerSessionIds.claude = 'stale-provider-session';
  staleSession.providerWorkingDirs.claude = '/bad/working-dir';
  await store.saveSession(staleSession);

  const output: string[] = [];
  const renderedQrContents: string[] = [];
  await runWeixinLogin({
    store,
    client: {
      async getBotQrcode() {
        return {
          qrcode: 'qrc-1',
          qrcodeImgContent: 'https://weixin.qq.com/x/AbCdEf',
        };
      },
      async getQrcodeStatus() {
        return {
          status: 'confirmed',
          botToken: 'new-token',
          accountId: 'bot@im.bot',
          userId: 'owner@im.wechat',
          baseUrl: 'https://ilinkai.weixin.qq.com',
        };
      },
    },
    sleepImpl: async () => {},
    renderQrCode: (content, writeLine) => {
      renderedQrContents.push(content);
      writeLine('[QR]');
    },
    writeLine: (line) => {
      output.push(line);
    },
  });

  assert.equal(store.getActiveWeixinCredential()?.token, 'new-token');
  assert.equal(store.getWeixinCursor('bot@im.bot')?.getUpdatesBuf, '');
  assert.equal(store.getActiveSession(staleOwnerKey), null);
  assert.equal(store.getSessionById(staleSession.id), null);
  assert.deepEqual(renderedQrContents, ['https://weixin.qq.com/x/AbCdEf']);
  assert.match(output.join('\n'), /\[QR\]/);
  assert.match(output.join('\n'), /https:\/\/weixin\.qq\.com\/x\/AbCdEf/);
});

test('runWeixinLogin rerenders the terminal QR code after expiration', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-weixin-login-expired-'));
  const store = new StateStore(stateDir);
  await store.init();

  const renderedQrContents: string[] = [];
  let pollCount = 0;

  await runWeixinLogin({
    store,
    client: {
      async getBotQrcode() {
        return pollCount === 0
          ? {
              qrcode: 'qrc-1',
              qrcodeImgContent: 'https://weixin.qq.com/x/first',
            }
          : {
              qrcode: 'qrc-2',
              qrcodeImgContent: 'https://weixin.qq.com/x/second',
            };
      },
      async getQrcodeStatus() {
        pollCount += 1;
        if (pollCount === 1) {
          return { status: 'expired' };
        }
        return {
          status: 'confirmed',
          botToken: 'new-token',
          accountId: 'bot@im.bot',
          userId: 'owner@im.wechat',
          baseUrl: 'https://ilinkai.weixin.qq.com',
        };
      },
    },
    sleepImpl: async () => {},
    renderQrCode: (content) => {
      renderedQrContents.push(content);
    },
    writeLine: () => {},
  });

  assert.deepEqual(renderedQrContents, [
    'https://weixin.qq.com/x/first',
    'https://weixin.qq.com/x/second',
  ]);
});

test('WeixinBridgeService routes text prompts through the agent and replies with typing', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-weixin-service-'));
  const store = new StateStore(stateDir);
  await store.init();

  const sentMessages: Array<{ toUserId: string; contextToken: string; text: string }> = [];
  const typingCalls: Array<{ ilinkUserId: string; typingTicket: string; status: number }> = [];
  const service = new WeixinBridgeService({
    telegram: {
      botToken: '',
      allowedUserIds: [],
      enabled: false,
    },
    weixin: {
      enabled: true,
      channelVersion: '1.0.2',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    },
    platforms: {
      telegram: {
        enabled: false,
        botToken: '',
        allowedUserIds: [],
      },
      weixin: {
        enabled: true,
        channelVersion: '1.0.2',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
    },
    bridge: {
      defaultAgent: 'claude',
      workingDir: '/tmp',
      replyChunkChars: 500,
      replyFlushMs: 1500,
      pollTimeoutSeconds: 30,
      maxInputImageMb: 20,
      allowImageDocuments: true,
    },
    network: {},
    agents: {
      enabled: ['claude'],
      claude: { bin: undefined, model: undefined, extraArgs: [] },
      codex: { bin: undefined, model: undefined, extraArgs: [] },
      neovate: { bin: undefined, model: undefined, extraArgs: [] },
      opencode: { bin: undefined, model: undefined, extraArgs: [] },
    },
  }, store, {
    client: {
      async sendTextMessage(message) {
        sentMessages.push(message);
      },
      async getTypingTicket() {
        return 'typing-ticket-1';
      },
      async sendTyping(params) {
        typingCalls.push(params);
      },
    },
    streamAgentTurnImpl: async function* () {
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield { type: 'session_started', sessionId: 'session-1' };
      yield { type: 'final_text', text: 'Hello from Weixin bridge' };
    },
    typingIntervalMs: 10,
  });

  await service.handleMessage({
    from_user_id: 'user@im.wechat',
    to_user_id: 'bot@im.bot',
    session_id: 'user@im.wechat#bot@im.bot',
    message_type: 1,
    message_state: 2,
    context_token: 'context-1',
    item_list: [
      {
        type: 1,
        text_item: {
          text: 'hi',
        },
      },
    ],
  });

  assert.deepEqual(sentMessages, [
    {
      toUserId: 'user@im.wechat',
      contextToken: 'context-1',
      text: 'Hello from Weixin bridge',
    },
  ]);
  assert.ok(typingCalls.some((call) => call.status === 1));
  assert.ok(typingCalls.some((call) => call.status === 2));
  assert.equal(store.getWeixinContextToken('bot@im.bot', 'user@im.wechat'), 'context-1');
  assert.equal(store.getActiveSession('weixin:bot@im.bot:user@im.wechat')?.activeAgent, 'claude');
});

test('WeixinBridgeService reports thrown provider errors instead of rejecting the prompt', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-weixin-errors-'));
  const store = new StateStore(stateDir);
  await store.init();

  const sentMessages: Array<{ toUserId: string; contextToken: string; text: string }> = [];
  const service = new WeixinBridgeService({
    telegram: {
      botToken: '',
      allowedUserIds: [],
      enabled: false,
    },
    weixin: {
      enabled: true,
      channelVersion: '1.0.2',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    },
    platforms: {
      telegram: {
        enabled: false,
        botToken: '',
        allowedUserIds: [],
      },
      weixin: {
        enabled: true,
        channelVersion: '1.0.2',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      },
    },
    bridge: {
      defaultAgent: 'claude',
      workingDir: '/tmp',
      replyChunkChars: 500,
      replyFlushMs: 1500,
      pollTimeoutSeconds: 30,
      maxInputImageMb: 20,
      allowImageDocuments: true,
    },
    network: {},
    agents: {
      enabled: ['claude'],
      claude: { bin: undefined, model: undefined, extraArgs: [] },
      codex: { bin: undefined, model: undefined, extraArgs: [] },
      neovate: { bin: undefined, model: undefined, extraArgs: [] },
      opencode: { bin: undefined, model: undefined, extraArgs: [] },
    },
  }, store, {
    client: {
      async sendTextMessage(message) {
        sentMessages.push(message);
      },
      async getTypingTicket() {
        return 'typing-ticket-1';
      },
      async sendTyping() {},
    },
    streamAgentTurnImpl: async function* () {
      throw new Error('provider boom');
    },
    typingIntervalMs: 10,
  });

  await assert.doesNotReject(() => service.handleMessage({
    from_user_id: 'user@im.wechat',
    to_user_id: 'bot@im.bot',
    session_id: 'user@im.wechat#bot@im.bot',
    message_type: 1,
    message_state: 2,
    context_token: 'context-1',
    item_list: [
      {
        type: 1,
        text_item: {
          text: 'hi',
        },
      },
    ],
  }));

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].toUserId, 'user@im.wechat');
  assert.equal(sentMessages[0].contextToken, 'context-1');
  assert.match(sentMessages[0].text, /provider boom/);
});
