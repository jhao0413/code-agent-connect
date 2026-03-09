import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeService } from '../src/bridge-service.mjs';

function createConfig() {
  return {
    telegram: {
      botToken: 'token',
      allowedUserIds: ['42'],
    },
    bridge: {
      defaultAgent: 'claude',
      workingDir: '/tmp',
      replyChunkChars: 500,
      replyFlushMs: 1500,
      pollTimeoutSeconds: 30,
    },
    network: {},
    agents: {
      enabled: ['claude', 'codex', 'neovate'],
    },
  };
}

function createStore() {
  return {
    appendTranscriptCalls: [],
    saveSessionCalls: [],
    async appendTranscript(sessionId, entry) {
      this.appendTranscriptCalls.push({ sessionId, entry });
    },
    async saveSession(session) {
      this.saveSessionCalls.push(session);
      return session;
    },
  };
}

test('handlePrompt sends Telegram typing while waiting for the agent', async () => {
  const store = createStore();
  let typingCalls = 0;
  const sentMessages = [];

  const service = new BridgeService(createConfig(), store, {
    streamAgentTurnImpl: async function* () {
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield { type: 'partial_text', text: 'Hello from agent' };
      yield { type: 'final_text', text: 'Hello from agent' };
    },
    typingIntervalMs: 10,
  });

  service.telegram = {
    async sendChatAction(chatId, action) {
      typingCalls += 1;
      assert.equal(chatId, 123);
      assert.equal(action, 'typing');
    },
    async sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
  };

  const session = {
    id: 'session-1',
    activeAgent: 'claude',
    providerSessionIds: {
      claude: null,
      codex: null,
      neovate: null,
    },
  };

  await service.handlePrompt(123, session, 'hi');

  assert.ok(typingCalls >= 1);
  assert.deepEqual(sentMessages, [{ chatId: 123, text: 'Hello from agent' }]);
});
