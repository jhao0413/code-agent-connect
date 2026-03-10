import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { markdownToTelegramHtml } from './markdown.js';
import { streamAgentTurn } from './providers.js';
import { TelegramClient } from './telegram-client.js';
import { chunkText, expandHomePath, sleep, toErrorMessage } from './utils.js';
import type { Attachment, AgentEvent, Config, ImageInfo, Session, StreamAgentTurnParams, TelegramCommand } from './types.js';
import type { StateStore } from './storage.js';

function stripBotSuffix(command: string): string {
  return command.replace(/@.+$/u, '');
}

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

function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[mimeType] || '.bin';
}

function normalizeSessionState(session: Session): Session {
  session.providerSessionIds = {
    claude: null,
    codex: null,
    neovate: null,
    opencode: null,
    ...(session.providerSessionIds || {}),
  };
  session.providerWorkingDirs = {
    claude: null,
    codex: null,
    neovate: null,
    opencode: null,
    ...(session.providerWorkingDirs || {}),
  };
  return session;
}

const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const DEFAULT_IMAGE_PROMPT = 'Please analyze the attached image and explain what you see.';

interface TelegramMessage {
  chat?: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
  document?: { file_id: string; mime_type?: string; file_size?: number; file_name?: string };
  media_group_id?: string;
  sticker?: unknown;
  animation?: unknown;
  video?: unknown;
  voice?: unknown;
  video_note?: unknown;
  audio?: unknown;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Extract image info from a Telegram message, if any.
 * Returns { fileId, mimeType, fileSize, width, height, sourceName } or null.
 */
export function extractImageInfo(message: TelegramMessage): ImageInfo | null {
  // Photo array: pick the largest resolution
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) =>
      (b.width * b.height > a.width * a.height ? b : a),
    );
    return {
      fileId: largest.file_id,
      mimeType: 'image/jpeg', // Telegram always converts photos to JPEG
      fileSize: largest.file_size || 0,
      width: largest.width,
      height: largest.height,
      sourceName: 'photo',
    };
  }

  // Document with image/* MIME
  if (message.document && typeof message.document.mime_type === 'string') {
    const mime = message.document.mime_type;
    if (mime.startsWith('image/')) {
      return {
        fileId: message.document.file_id,
        mimeType: mime,
        fileSize: message.document.file_size || 0,
        width: undefined,
        height: undefined,
        sourceName: message.document.file_name || 'document',
      };
    }
  }

  return null;
}

/**
 * Determine if a message contains unsupported media that should be rejected.
 * Returns a rejection message string, or null if the message is acceptable.
 */
export function getUnsupportedMediaRejection(message: TelegramMessage): string | null {
  if (message.media_group_id) {
    return 'Album (multi-image) messages are not supported yet. Please send images one at a time.';
  }
  if (message.document && message.document.mime_type && !message.document.mime_type.startsWith('image/')) {
    return `Unsupported file type: ${message.document.mime_type}. Only image files (PNG, JPEG, WebP, GIF) are accepted.`;
  }
  if (message.sticker) {
    return 'Sticker messages are not supported. Please send a photo or image file.';
  }
  if (message.animation) {
    return 'Animation/GIF messages sent as animations are not supported. Please send the image as a file.';
  }
  if (message.video) {
    return 'Video messages are not supported.';
  }
  if (message.voice) {
    return 'Voice messages are not supported.';
  }
  if (message.video_note) {
    return 'Video note messages are not supported.';
  }
  if (message.audio) {
    return 'Audio messages are not supported.';
  }
  return null;
}

function buildHelpText(config: Config): string {
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
    'Image support:',
    '- Send a photo or image file to analyze it (codex agent)',
    '- Add a caption to use as your prompt, or omit for auto-analysis',
    '- One image per message; albums are not supported',
    '- Other agents: use /use codex to switch before sending images',
    '',
    'Any other private message is forwarded to the active agent.',
  ].join('\n');
}

export function buildTelegramCommands(config: Config): TelegramCommand[] {
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

export interface BridgeServiceOptions {
  streamAgentTurnImpl?: (params: StreamAgentTurnParams) => AsyncGenerator<AgentEvent>;
  typingIntervalMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class BridgeService {
  config: Config;
  store: StateStore;
  streamAgentTurnImpl: (params: StreamAgentTurnParams) => AsyncGenerator<AgentEvent>;
  typingIntervalMs: number;
  telegram: TelegramClient;

  constructor(config: Config, store: StateStore, options: BridgeServiceOptions = {}) {
    this.config = config;
    this.store = store;
    this.streamAgentTurnImpl = options.streamAgentTurnImpl || streamAgentTurn;
    this.typingIntervalMs = options.typingIntervalMs || 4000;
    this.telegram = new TelegramClient(config.telegram.botToken, {
      fetchImpl: options.fetchImpl || globalThis.fetch,
      proxyUrl: config.network?.proxyUrl,
    });
  }

  async sendText(chatId: number | string, text: string): Promise<void> {
    for (const chunk of chunkText(text, 3500)) {
      const html = markdownToTelegramHtml(chunk);
      try {
        await this.telegram.sendMessage(chatId, html, { parseMode: 'HTML' });
      } catch {
        await this.telegram.sendMessage(chatId, chunk);
      }
    }
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

  attachmentsDir(): string {
    return path.join(this.config.stateDir, 'attachments');
  }

  async downloadAttachment(imageInfo: ImageInfo): Promise<Attachment> {
    const fileResult = await this.telegram.getFile(imageInfo.fileId);
    if (!fileResult.file_path) {
      throw new Error('Telegram getFile returned no file_path');
    }

    const turnId = crypto.randomUUID();
    const ext = path.extname(fileResult.file_path) || mimeToExt(imageInfo.mimeType);
    const localDir = path.join(this.attachmentsDir(), turnId);
    const localPath = path.join(localDir, `image${ext}`);

    await this.telegram.downloadFile(fileResult.file_path, localPath);

    // Verify actual file size on disk
    const maxMb = this.config.bridge.maxInputImageMb ?? 20;
    const stat = await fs.stat(localPath);
    if (stat.size > maxMb * 1024 * 1024) {
      await fs.rm(localDir, { recursive: true, force: true });
      throw new Error(`Image too large after download (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum: ${maxMb} MB.`);
    }

    return {
      kind: 'image',
      mimeType: imageInfo.mimeType,
      telegramFileId: imageInfo.fileId,
      localPath,
      localDir,
      sourceName: imageInfo.sourceName,
      width: imageInfo.width,
      height: imageInfo.height,
      sizeBytes: stat.size,
    };
  }

  async cleanupAttachments(attachments: Attachment[]): Promise<void> {
    for (const att of attachments) {
      if (att.localDir) {
        try {
          await fs.rm(att.localDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  async run(): Promise<void> {
    await this.store.init();
    await this.syncTelegramCommands();
    let offset = this.store.getTelegramOffset();

    while (true) {
      let updates: TelegramUpdate[] = [];
      try {
        updates = await this.telegram.getUpdates({
          offset,
          timeoutSeconds: this.config.bridge.pollTimeoutSeconds,
        }) as TelegramUpdate[];
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

  async syncTelegramCommands(): Promise<void> {
    try {
      await this.telegram.setMyCommands(buildTelegramCommands(this.config));
      console.log('[bridge] Telegram bot commands synced');
    } catch (error) {
      console.warn('[bridge] Failed to sync Telegram bot commands:', toErrorMessage(error));
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || message.chat?.type !== 'private') {
      return;
    }

    const userId = String(message.from?.id || '');
    const chatId = message.chat!.id;
    if (!userId || !chatId) {
      return;
    }

    if (!this.config.telegram.allowedUserIds.includes(userId)) {
      await this.sendText(chatId, 'You are not allowed to use this bot.');
      return;
    }

    // Reject known unsupported media types early
    const rejection = getUnsupportedMediaRejection(message);
    if (rejection) {
      await this.sendText(chatId, rejection);
      return;
    }

    // Extract image info if present
    const imageInfo = extractImageInfo(message);

    // Determine text: caption for image messages, text for pure text, or default prompt
    const text = (message.caption || message.text || '').trim();

    if (!text && !imageInfo) {
      await this.sendText(chatId, 'Only text and image messages are supported.');
      return;
    }

    const session = await this.store.ensureActiveSession(
      userId,
      this.config.bridge.defaultAgent,
      this.config.bridge.workingDir,
    );

    // Commands only from pure text messages (not captions)
    if (!imageInfo && text.startsWith('/')) {
      await this.handleCommand(chatId, userId, session, text);
      return;
    }

    // Build attachment if we have an image
    let attachments: Attachment[] = [];
    if (imageInfo) {
      const maxMb = this.config.bridge.maxInputImageMb ?? 20;
      const maxBytes = maxMb * 1024 * 1024;

      // Check MIME type
      if (!ALLOWED_IMAGE_MIMES.has(imageInfo.mimeType)) {
        await this.sendText(chatId, `Unsupported image format: ${imageInfo.mimeType}. Allowed: PNG, JPEG, WebP, GIF.`);
        return;
      }

      // Check allow_image_documents config
      if (imageInfo.sourceName !== 'photo' && !(this.config.bridge.allowImageDocuments ?? true)) {
        await this.sendText(chatId, 'Image document uploads are disabled. Please send as a photo.');
        return;
      }

      // Check file size (when reported by Telegram)
      if (imageInfo.fileSize > maxBytes) {
        await this.sendText(chatId, `Image too large (${(imageInfo.fileSize / 1024 / 1024).toFixed(1)} MB). Maximum: ${maxMb} MB.`);
        return;
      }

      try {
        await this.telegram.sendChatAction(chatId, 'typing');
        const attachment = await this.downloadAttachment(imageInfo);
        attachments = [attachment];
      } catch (error) {
        await this.sendText(chatId, `Failed to download image: ${toErrorMessage(error)}`);
        return;
      }
    }

    const prompt = text || DEFAULT_IMAGE_PROMPT;
    await this.handlePrompt(chatId, session, prompt, attachments);
  }

  async handleCommand(chatId: number | string, userId: string, session: Session, text: string): Promise<void> {
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

  async handlePrompt(chatId: number | string, session: Session, prompt: string, attachments: Attachment[] = []): Promise<void> {
    normalizeSessionState(session);
    await this.store.appendTranscript(session.id, {
      direction: 'in',
      agent: session.activeAgent,
      text: prompt,
      ...(attachments.length > 0 && {
        attachments: attachments.map((a) => ({
          kind: a.kind,
          mimeType: a.mimeType,
          sourceName: a.sourceName,
          sizeBytes: a.sizeBytes,
          width: a.width,
          height: a.height,
        })),
      }),
    });

    const agent = session.activeAgent;
    const prepared = await this.preparePromptSession(session, agent);
    session = prepared.session;
    let aggregateText = '';
    let finalText = '';
    let sentLength = 0;
    let lastFlushAt = Date.now();
    const errors: string[] = [];
    let typingActive = true;

    const sendTyping = async (): Promise<void> => {
      if (!typingActive) {
        return;
      }
      try {
        await this.telegram.sendChatAction(chatId, 'typing');
      } catch (error) {
        errors.push(`Telegram typing failed: ${toErrorMessage(error)}`);
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
      await this.sendText(chatId, delta);
    };

    let flushChain = Promise.resolve();
    const queueFlush = (options: { force?: boolean } = {}): Promise<void> => {
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
        attachments,
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
      await this.cleanupAttachments(attachments);
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
