import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { runCommand } from './utils.js';
import type { TelegramClientOptions, TelegramCommand } from './types.js';

const TELEGRAM_MAX_LENGTH = 4096;

export class TelegramClient {
  baseUrl: string;
  fetchImpl: typeof globalThis.fetch;
  proxyUrl: string | undefined;

  constructor(botToken: string, options: TelegramClientOptions = {}) {
    if (!botToken) {
      throw new Error('Telegram bot token is required');
    }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('global fetch is not available');
    }
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.fetchImpl = fetchImpl;
    this.proxyUrl = options.proxyUrl;
  }

  async call(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.proxyUrl) {
      return this.callWithCurl(method, payload);
    }
    return this.callWithFetch(method, payload);
  }

  async callWithFetch(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed with status ${response.status}`);
    }

    const body = await response.json() as { ok: boolean; result: unknown; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram API ${method} error: ${body.description || 'unknown error'}`);
    }
    return body.result;
  }

  async callWithCurl(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const timeoutSeconds = Math.max(10, Number((payload.timeout as number) || 0) + 10);
    const args = [
      '-sS',
      '--max-time',
      String(timeoutSeconds),
      '--proxy',
      this.proxyUrl!,
      '-H',
      'content-type: application/json',
      '-X',
      'POST',
      '--data',
      JSON.stringify(payload),
      `${this.baseUrl}/${method}`,
    ];

    const result = await runCommand('curl', args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `curl ${method} failed with code ${result.code}`);
    }

    let body: { ok: boolean; result: unknown; description?: string };
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Telegram API ${method} returned invalid JSON`);
    }

    if (!body.ok) {
      throw new Error(`Telegram API ${method} error: ${body.description || 'unknown error'}`);
    }
    return body.result;
  }

  async getMe(): Promise<unknown> {
    return this.call('getMe');
  }

  async getUpdates({ offset, timeoutSeconds }: { offset: number; timeoutSeconds: number }): Promise<unknown[]> {
    return this.call('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    }) as Promise<unknown[]>;
  }

  async setMyCommands(commands: TelegramCommand[]): Promise<unknown> {
    if (!Array.isArray(commands)) {
      throw new Error('setMyCommands requires an array of commands');
    }
    return this.call('setMyCommands', {
      commands,
      scope: {
        type: 'all_private_chats',
      },
    });
  }

  async sendChatAction(chatId: number | string, action = 'typing'): Promise<unknown> {
    return this.call('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  get fileBaseUrl(): string {
    // File downloads use https://api.telegram.org/file/bot<token>/
    return this.baseUrl.replace('/bot', '/file/bot');
  }

  async getFile(fileId: string): Promise<{ file_path?: string }> {
    return this.call('getFile', { file_id: fileId }) as Promise<{ file_path?: string }>;
  }

  async downloadFile(filePath: string, destinationPath: string): Promise<void> {
    const url = `${this.fileBaseUrl}/${filePath}`;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    if (this.proxyUrl) {
      return this.downloadFileWithCurl(url, destinationPath);
    }
    return this.downloadFileWithFetch(url, destinationPath);
  }

  async downloadFileWithFetch(url: string, destinationPath: string): Promise<void> {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}`);
    }
    const fileHandle = await fs.open(destinationPath, 'w');
    try {
      await pipeline(response.body as unknown as NodeJS.ReadableStream, fileHandle.createWriteStream());
    } finally {
      await fileHandle.close();
    }
  }

  async downloadFileWithCurl(url: string, destinationPath: string): Promise<void> {
    const args = [
      '-sS',
      '--max-time', '120',
      '--proxy', this.proxyUrl!,
      '-o', destinationPath,
      url,
    ];
    const result = await runCommand('curl', args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `curl file download failed with code ${result.code}`);
    }
  }

  async sendMessage(chatId: number | string, text: string, { parseMode }: { parseMode?: string } = {}): Promise<unknown> {
    if (!text || !text.trim()) {
      return null;
    }
    if (text.length > TELEGRAM_MAX_LENGTH) {
      throw new Error(`sendMessage text too long: ${text.length}`);
    }
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(parseMode && { parse_mode: parseMode }),
    });
  }
}
