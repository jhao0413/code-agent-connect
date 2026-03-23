import fs from 'node:fs/promises';
import path from 'node:path';
import { streamAgentTurn } from './providers.js';
import { chunkText, expandHomePath, sleep, toErrorMessage } from './utils.js';
import { WeixinClient } from './weixin-client.js';
import type {
  AgentEvent,
  Config,
  Session,
  StreamAgentTurnParams,
  WeixinCredential,
  WeixinGetUpdatesResponse,
  WeixinMessage,
  WeixinTextMessageParams,
  WeixinTypingParams,
} from './types.js';
import type { StateStore } from './storage.js';

function parseCommandText(text: string): { rawCommand: string; rawArgs: string } {
  const match = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return {
    rawCommand: match?.[1] || text.trim(),
    rawArgs: match?.[2] || '',
  };
}

function unwrapQuotedArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === '\'') && trimmed.at(-1) === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function buildHelpText(config: Config): string {
  return [
    'code-agent-connect (Weixin iLink Bot)',
    '',
    'Commands:',
    '/start - Show help',
    '/help - Show help',
    '/new - Start a fresh logical session',
    `/use <${config.agents.enabled.join('|')}> - Switch active agent`,
    '/set_working_dir <path> - Set the session working directory',
    '/status - Show the current session state',
    '',
    'Current Weixin support:',
    '- Text input',
    '- Long-running replies with typing status',
    '- No media input yet',
  ].join('\n');
}

function getMessageText(message: WeixinMessage): string {
  for (const item of message.item_list || []) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text.trim();
    }
  }
  return '';
}

export interface WeixinServiceClient {
  getUpdates?(getUpdatesBuf: string): Promise<WeixinGetUpdatesResponse>;
  sendTextMessage(message: WeixinTextMessageParams): Promise<void>;
  getTypingTicket?(ilinkUserId: string, contextToken?: string): Promise<string>;
  sendTyping?(params: WeixinTypingParams): Promise<void>;
}

export interface WeixinBridgeServiceOptions {
  client?: WeixinServiceClient;
  streamAgentTurnImpl?: (params: StreamAgentTurnParams) => AsyncGenerator<AgentEvent>;
  typingIntervalMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class WeixinBridgeService {
  config: Config;
  store: StateStore;
  client?: WeixinServiceClient;
  streamAgentTurnImpl: (params: StreamAgentTurnParams) => AsyncGenerator<AgentEvent>;
  typingIntervalMs: number;
  fetchImpl: typeof globalThis.fetch;

  constructor(config: Config, store: StateStore, options: WeixinBridgeServiceOptions = {}) {
    this.config = config;
    this.store = store;
    this.client = options.client;
    this.streamAgentTurnImpl = options.streamAgentTurnImpl || streamAgentTurn;
    this.typingIntervalMs = options.typingIntervalMs || 5000;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  sessionOwnerKey(accountId: string, userId: string): string {
    return `weixin:${accountId}:${userId}`;
  }

  getSessionWorkingDir(session: Session): string {
    return session.workingDir || this.config.bridge.workingDir;
  }

  async preparePromptSession(session: Session, agent: string): Promise<{ session: Session; workingDir: string; upstreamSessionId: string | null }> {
    const workingDir = this.getSessionWorkingDir(session);
    const providerWorkingDir = session.providerWorkingDirs[agent];
    let upstreamSessionId = session.providerSessionIds[agent];

    if (upstreamSessionId && providerWorkingDir && providerWorkingDir !== workingDir) {
      session.providerSessionIds[agent] = null;
      session.providerWorkingDirs[agent] = null;
      session = await this.store.saveSession(session);
      upstreamSessionId = null;
    }

    return {
      session,
      workingDir,
      upstreamSessionId,
    };
  }

  async resolveWorkingDir(session: Session, rawPath: string): Promise<string> {
    const baseDir = this.getSessionWorkingDir(session);
    const expanded = expandHomePath(rawPath);
    const candidate = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(baseDir, expanded);
    const resolved = path.resolve(candidate);
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) {
      throw new Error(`${resolved} is not a directory`);
    }
    return resolved;
  }

  createClient(credential: WeixinCredential): WeixinServiceClient {
    return new WeixinClient({
      baseUrl: credential.baseUrl || this.config.weixin.baseUrl,
      token: credential.token,
      channelVersion: this.config.weixin.channelVersion,
      skRouteTag: this.config.weixin.skRouteTag,
      fetchImpl: this.fetchImpl,
      proxyUrl: this.config.network?.proxyUrl,
    });
  }

  getClient(credential?: WeixinCredential): WeixinServiceClient {
    if (this.client) {
      return this.client;
    }
    if (!credential) {
      throw new Error('Weixin credential is required');
    }
    return this.createClient(credential);
  }

  async sendText(accountId: string, toUserId: string, contextToken: string, text: string): Promise<void> {
    const credential = this.store.getWeixinCredential(accountId) || this.store.getActiveWeixinCredential();
    const client = this.getClient(credential || undefined);

    for (const chunk of chunkText(text, 2000)) {
      await client.sendTextMessage({
        toUserId,
        contextToken,
        text: chunk,
      });
    }
  }

  async ensureTypingTicket(accountId: string, userId: string, contextToken: string): Promise<string | null> {
    const cached = this.store.getWeixinTypingTicket(accountId, userId);
    const maxAgeMs = 24 * 60 * 60 * 1000;
    if (cached && (Date.now() - Date.parse(cached.savedAt)) < maxAgeMs) {
      return cached.ticket;
    }

    const credential = this.store.getWeixinCredential(accountId) || this.store.getActiveWeixinCredential();
    const client = this.getClient(credential || undefined);
    if (!client.getTypingTicket) {
      return null;
    }

    const ticket = await client.getTypingTicket(userId, contextToken);
    await this.store.setWeixinTypingTicket(accountId, userId, {
      ticket,
      savedAt: new Date().toISOString(),
    });
    return ticket;
  }

  async sendTyping(accountId: string, userId: string, contextToken: string, status: number): Promise<void> {
    const credential = this.store.getWeixinCredential(accountId) || this.store.getActiveWeixinCredential();
    const client = this.getClient(credential || undefined);
    if (!client.sendTyping) {
      return;
    }

    const ticket = await this.ensureTypingTicket(accountId, userId, contextToken);
    if (!ticket) {
      return;
    }

    await client.sendTyping({
      ilinkUserId: userId,
      typingTicket: ticket,
      status,
    });
  }

  async run(): Promise<void> {
    await this.store.init();

    while (true) {
      const credential = this.store.getActiveWeixinCredential();
      if (!credential) {
        await sleep(5000);
        continue;
      }

      const cursor = this.store.getWeixinCursor(credential.accountId);
      try {
        const response = await this.getClient(credential).getUpdates?.(cursor?.getUpdatesBuf || '');
        if (!response) {
          await sleep(1000);
          continue;
        }

        if ((response.ret === -14) || (response.errcode === -14)) {
          await this.store.clearWeixinCredential(credential.accountId);
          console.error('[weixin] session expired; run `code-agent-connect weixin login` again.');
          await sleep(2000);
          continue;
        }

        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          console.error('[weixin] polling failed:', JSON.stringify(response));
          await sleep(2000);
          continue;
        }

        if (typeof response.get_updates_buf === 'string') {
          await this.store.setWeixinCursor(
            credential.accountId,
            response.get_updates_buf,
            response.longpolling_timeout_ms,
          );
        }

        for (const message of response.msgs || []) {
          await this.handleMessage(message);
        }
      } catch (error) {
        console.error('[weixin] polling failed:', toErrorMessage(error));
        await sleep(2000);
      }
    }
  }

  async handleMessage(message: WeixinMessage): Promise<void> {
    if (message.message_type !== 1) {
      return;
    }
    if (!message.from_user_id || !message.to_user_id || !message.context_token) {
      return;
    }

    const text = getMessageText(message);
    if (!text) {
      await this.sendText(
        message.to_user_id,
        message.from_user_id,
        message.context_token,
        'Only text messages are supported in Weixin right now.',
      );
      return;
    }

    await this.store.setWeixinContextToken(message.to_user_id, message.from_user_id, message.context_token);

    const ownerKey = this.sessionOwnerKey(message.to_user_id, message.from_user_id);
    const session = await this.store.ensureActiveSession(
      ownerKey,
      this.config.bridge.defaultAgent,
      this.config.bridge.workingDir,
      'weixin',
    );

    if (text.startsWith('/')) {
      await this.handleCommand(message.to_user_id, message.from_user_id, message.context_token, ownerKey, session, text);
      return;
    }

    await this.handlePrompt(message.to_user_id, message.from_user_id, message.context_token, session, text);
  }

  async handleCommand(
    accountId: string,
    userId: string,
    contextToken: string,
    ownerKey: string,
    session: Session,
    text: string,
  ): Promise<void> {
    const { rawCommand, rawArgs } = parseCommandText(text);
    const command = rawCommand;

    if (command === '/start' || command === '/help') {
      await this.sendText(accountId, userId, contextToken, buildHelpText(this.config));
      return;
    }

    if (command === '/new') {
      const nextSession = await this.store.replaceActiveSession(
        ownerKey,
        session.activeAgent,
        this.getSessionWorkingDir(session),
        'weixin',
      );
      await this.sendText(
        accountId,
        userId,
        contextToken,
        [
          'Started a new session.',
          `Session: ${nextSession.id}`,
          `Agent: ${nextSession.activeAgent}`,
          `Working dir: ${this.getSessionWorkingDir(nextSession)}`,
        ].join('\n'),
      );
      return;
    }

    if (command === '/use') {
      const nextAgent = rawArgs.trim().split(/\s+/u)[0];
      if (!nextAgent || !this.config.agents.enabled.includes(nextAgent)) {
        await this.sendText(accountId, userId, contextToken, `Usage: /use <${this.config.agents.enabled.join('|')}>`);
        return;
      }
      const nextSession = await this.store.setActiveAgent(ownerKey, nextAgent);
      await this.sendText(accountId, userId, contextToken, `Active agent: ${nextSession.activeAgent}`);
      return;
    }

    if (command === '/set_working_dir' || command === '/cd') {
      const requestedPath = unwrapQuotedArg(rawArgs);
      if (!requestedPath) {
        await this.sendText(accountId, userId, contextToken, 'Usage: /set_working_dir <path>');
        return;
      }

      try {
        const workingDir = await this.resolveWorkingDir(session, requestedPath);
        const resetCurrentAgent = this.getSessionWorkingDir(session) !== workingDir;
        const nextSession = await this.store.setWorkingDir(ownerKey, session.activeAgent, workingDir);
        const details = [
          'Updated session working directory.',
          `Session: ${nextSession.id}`,
          `Working dir: ${this.getSessionWorkingDir(nextSession)}`,
        ];
        if (resetCurrentAgent) {
          details.push(`Current ${session.activeAgent} session: reset`);
        }
        await this.sendText(accountId, userId, contextToken, details.join('\n'));
      } catch (error) {
        await this.sendText(accountId, userId, contextToken, `Failed to set working directory: ${toErrorMessage(error)}`);
      }
      return;
    }

    if (command === '/status') {
      const providerSessionId = session.providerSessionIds[session.activeAgent] || '(none)';
      await this.sendText(
        accountId,
        userId,
        contextToken,
        [
          `Session: ${session.id}`,
          `Agent: ${session.activeAgent}`,
          `Working dir: ${this.getSessionWorkingDir(session)}`,
          `Provider session: ${providerSessionId}`,
        ].join('\n'),
      );
      return;
    }

    await this.sendText(accountId, userId, contextToken, 'Unknown command. Send /help for the supported commands.');
  }

  async handlePrompt(
    accountId: string,
    userId: string,
    contextToken: string,
    session: Session,
    prompt: string,
  ): Promise<void> {
    await this.store.appendTranscript(session.id, {
      direction: 'in',
      agent: session.activeAgent,
      text: prompt,
    });

    const agent = session.activeAgent;
    const prepared = await this.preparePromptSession(session, agent);
    session = prepared.session;
    let aggregateText = '';
    let finalText = '';
    let sentLength = 0;
    let lastFlushAt = Date.now();
    const errors: string[] = [];

    const sendTyping = async (status: number): Promise<void> => {
      try {
        await this.sendTyping(accountId, userId, contextToken, status);
      } catch (error) {
        errors.push(`Weixin typing failed: ${toErrorMessage(error)}`);
      }
    };

    const flush = async ({ force = false } = {}): Promise<void> => {
      const unsentLength = aggregateText.length - sentLength;
      if (unsentLength <= 0) {
        return;
      }
      if (!force) {
        const staleFor = Date.now() - lastFlushAt;
        if (
          unsentLength < this.config.bridge.replyChunkChars &&
          staleFor < this.config.bridge.replyFlushMs
        ) {
          return;
        }
      }
      const delta = aggregateText.slice(sentLength);
      sentLength = aggregateText.length;
      lastFlushAt = Date.now();
      await this.sendText(accountId, userId, contextToken, delta);
    };

    let flushChain = Promise.resolve();
    const queueFlush = (options: { force?: boolean } = {}): Promise<void> => {
      flushChain = flushChain
        .then(() => flush(options))
        .catch((error) => {
          errors.push(`Weixin send failed: ${toErrorMessage(error)}`);
        });
      return flushChain;
    };

    await sendTyping(1);
    const timer = setInterval(() => {
      void queueFlush();
    }, Math.max(250, Math.min(this.config.bridge.replyFlushMs, 1000)));
    const typingTimer = setInterval(() => {
      void sendTyping(1);
    }, this.typingIntervalMs);

    try {
      try {
        for await (const event of this.streamAgentTurnImpl({
          config: this.config,
          agent,
          prompt,
          workingDir: prepared.workingDir,
          upstreamSessionId: prepared.upstreamSessionId,
        })) {
          if (event.type === 'session_started' && event.sessionId) {
            session.providerSessionIds[agent] = event.sessionId;
            session.providerWorkingDirs[agent] = prepared.workingDir;
            await this.store.saveSession(session);
          }

          if (event.type === 'partial_text' && event.text) {
            aggregateText += event.text;
            if (aggregateText.length - sentLength >= this.config.bridge.replyChunkChars) {
              await queueFlush({ force: true });
            }
          }

          if (event.type === 'final_text' && event.text) {
            finalText = event.text;
          }

          if (event.type === 'error' && event.message) {
            errors.push(event.message);
          }
        }
      } catch (error) {
        errors.push(toErrorMessage(error));
      }
    } finally {
      clearInterval(timer);
      clearInterval(typingTimer);
      await flushChain;
      await sendTyping(2);
    }

    if (finalText) {
      if (!aggregateText) {
        aggregateText = finalText;
      } else if (finalText.startsWith(aggregateText)) {
        aggregateText = finalText;
      } else if (sentLength === 0) {
        aggregateText = finalText;
      } else if (finalText !== aggregateText) {
        await this.store.appendTranscript(session.id, {
          direction: 'system',
          agent,
          type: 'final_text_mismatch',
          partialText: aggregateText,
          finalText,
        });
      }
    }

    if (aggregateText.length > sentLength) {
      await this.sendText(accountId, userId, contextToken, aggregateText.slice(sentLength));
      sentLength = aggregateText.length;
    }

    if (!aggregateText && errors.length === 0) {
      await this.sendText(accountId, userId, contextToken, 'The agent finished without returning text output.');
    }

    if (errors.length > 0) {
      await this.sendText(accountId, userId, contextToken, `Agent error:\n${errors[0]}`);
    }

    await this.store.appendTranscript(session.id, {
      direction: 'out',
      agent,
      text: aggregateText,
      errors,
    });
  }
}
