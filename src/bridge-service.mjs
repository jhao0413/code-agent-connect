import fs from 'node:fs/promises';
import path from 'node:path';
import { streamAgentTurn } from './providers.mjs';
import { TelegramClient } from './telegram-client.mjs';
import { chunkText, expandHomePath, sleep, toErrorMessage } from './utils.mjs';

function stripBotSuffix(command) {
  return command.replace(/@.+$/u, '');
}

function parseCommandText(text) {
  const match = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return {
    rawCommand: match?.[1] || text.trim(),
    rawArgs: match?.[2] || '',
  };
}

function unwrapQuotedArg(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === '\'') && trimmed.at(-1) === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function normalizeSessionState(session) {
  session.providerSessionIds = {
    claude: null,
    codex: null,
    neovate: null,
    ...(session.providerSessionIds || {}),
  };
  session.providerWorkingDirs = {
    claude: null,
    codex: null,
    neovate: null,
    ...(session.providerWorkingDirs || {}),
  };
  return session;
}

function buildHelpText(config) {
  return [
    'code-agent-connect',
    '',
    'Commands:',
    '/start - Show help',
    '/help - Show help',
    '/new - Start a fresh logical session',
    `/use <${config.agents.enabled.join('|')}> - Switch active agent`,
    '/set_working_dir <path> - Set the session working directory',
    '/status - Show the current session state',
    '',
    'Any other private message is forwarded to the active agent.',
  ].join('\n');
}

export function buildTelegramCommands(config) {
  return [
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
      description: `Switch agent: ${config.agents.enabled.join('|')}`,
    },
    {
      command: 'set_working_dir',
      description: 'Set the session working directory',
    },
    {
      command: 'status',
      description: 'Show current session and active agent',
    },
  ];
}

export class BridgeService {
  constructor(config, store, options = {}) {
    this.config = config;
    this.store = store;
    this.streamAgentTurnImpl = options.streamAgentTurnImpl || streamAgentTurn;
    this.typingIntervalMs = options.typingIntervalMs || 4000;
    this.telegram = new TelegramClient(config.telegram.botToken, {
      fetchImpl: options.fetchImpl || globalThis.fetch,
      proxyUrl: config.network?.proxyUrl,
    });
  }

  async sendText(chatId, text) {
    for (const chunk of chunkText(text, 3500)) {
      await this.telegram.sendMessage(chatId, chunk);
    }
  }

  getSessionWorkingDir(session) {
    return session.workingDir || this.config.bridge.workingDir;
  }

  async preparePromptSession(session, agent) {
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

  async resolveWorkingDir(session, rawPath) {
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

  async run() {
    await this.store.init();
    await this.syncTelegramCommands();
    let offset = this.store.getTelegramOffset();

    while (true) {
      let updates = [];
      try {
        updates = await this.telegram.getUpdates({
          offset,
          timeoutSeconds: this.config.bridge.pollTimeoutSeconds,
        });
      } catch (error) {
        console.error('[bridge] Telegram polling failed:', toErrorMessage(error));
        await sleep(2000);
        continue;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        await this.store.setTelegramOffset(offset);
        await this.handleUpdate(update);
      }
    }
  }

  async syncTelegramCommands() {
    try {
      await this.telegram.setMyCommands(buildTelegramCommands(this.config));
      console.log('[bridge] Telegram bot commands synced');
    } catch (error) {
      console.warn('[bridge] Failed to sync Telegram bot commands:', toErrorMessage(error));
    }
  }

  async handleUpdate(update) {
    const message = update.message;
    if (!message || message.chat?.type !== 'private') {
      return;
    }

    const userId = String(message.from?.id || '');
    const chatId = message.chat.id;
    if (!userId || !chatId) {
      return;
    }

    if (!this.config.telegram.allowedUserIds.includes(userId)) {
      await this.sendText(chatId, 'You are not allowed to use this bot.');
      return;
    }

    const text = (message.text || '').trim();
    if (!text) {
      await this.sendText(chatId, 'Only text messages are supported in v1.');
      return;
    }

    const session = await this.store.ensureActiveSession(
      userId,
      this.config.bridge.defaultAgent,
      this.config.bridge.workingDir,
    );

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, userId, session, text);
      return;
    }

    await this.handlePrompt(chatId, session, text);
  }

  async handleCommand(chatId, userId, session, text) {
    normalizeSessionState(session);
    const { rawCommand, rawArgs } = parseCommandText(text);
    const command = stripBotSuffix(rawCommand);

    if (command === '/start' || command === '/help') {
      await this.sendText(chatId, buildHelpText(this.config));
      return;
    }

    if (command === '/new') {
      const nextSession = await this.store.replaceActiveSession(
        userId,
        session.activeAgent,
        this.getSessionWorkingDir(session),
      );
      await this.sendText(
        chatId,
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
        await this.sendText(chatId, `Usage: /use <${this.config.agents.enabled.join('|')}>`);
        return;
      }
      const nextSession = await this.store.setActiveAgent(userId, nextAgent);
      await this.sendText(chatId, `Active agent: ${nextSession.activeAgent}`);
      return;
    }

    if (command === '/set_working_dir' || command === '/cd') {
      const requestedPath = unwrapQuotedArg(rawArgs);
      if (!requestedPath) {
        await this.sendText(chatId, 'Usage: /set_working_dir <path>');
        return;
      }

      try {
        const workingDir = await this.resolveWorkingDir(session, requestedPath);
        const resetCurrentAgent = this.getSessionWorkingDir(session) !== workingDir;
        const nextSession = await this.store.setWorkingDir(userId, session.activeAgent, workingDir);
        const details = [
          'Updated session working directory.',
          `Session: ${nextSession.id}`,
          `Working dir: ${this.getSessionWorkingDir(nextSession)}`,
        ];
        if (resetCurrentAgent) {
          details.push(`Current ${session.activeAgent} session: reset`);
        }
        await this.sendText(
          chatId,
          details.join('\n'),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendText(chatId, `Failed to set working directory: ${message}`);
      }
      return;
    }

    if (command === '/status') {
      const providerSessionId = session.providerSessionIds[session.activeAgent] || '(none)';
      await this.sendText(
        chatId,
        [
          `Session: ${session.id}`,
          `Agent: ${session.activeAgent}`,
          `Working dir: ${this.getSessionWorkingDir(session)}`,
          `Provider session: ${providerSessionId}`,
        ].join('\n'),
      );
      return;
    }

    await this.sendText(chatId, 'Unknown command. Send /help for the supported commands.');
  }

  async handlePrompt(chatId, session, prompt) {
    normalizeSessionState(session);
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
    const errors = [];
    let typingActive = true;

    const sendTyping = async () => {
      if (!typingActive) {
        return;
      }
      try {
        await this.telegram.sendChatAction(chatId, 'typing');
      } catch (error) {
        errors.push(`Telegram typing failed: ${toErrorMessage(error)}`);
      }
    };

    const flush = async ({ force = false } = {}) => {
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
      await this.sendText(chatId, delta);
    };

    let flushChain = Promise.resolve();
    const queueFlush = (options = {}) => {
      flushChain = flushChain
        .then(() => flush(options))
        .catch((error) => {
          errors.push(`Telegram send failed: ${toErrorMessage(error)}`);
        });
      return flushChain;
    };
    const timer = setInterval(() => {
      void queueFlush();
    }, Math.max(250, Math.min(this.config.bridge.replyFlushMs, 1000)));
    const typingTimer = setInterval(() => {
      void sendTyping();
    }, this.typingIntervalMs);

    try {
      await sendTyping();
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
    } finally {
      typingActive = false;
      clearInterval(timer);
      clearInterval(typingTimer);
      await flushChain;
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
      await this.sendText(chatId, aggregateText.slice(sentLength));
      sentLength = aggregateText.length;
    }

    if (!aggregateText && errors.length === 0) {
      await this.sendText(chatId, 'The agent finished without returning text output.');
    }

    if (errors.length > 0) {
      await this.sendText(chatId, `Agent error:\n${errors[0]}`);
    }

    await this.store.appendTranscript(session.id, {
      direction: 'out',
      agent,
      text: aggregateText,
      errors,
    });
  }
}
