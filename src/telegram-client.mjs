import { runCommand } from './utils.mjs';

const TELEGRAM_MAX_LENGTH = 4096;

export class TelegramClient {
  constructor(botToken, options = {}) {
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

  async call(method, payload = {}) {
    if (this.proxyUrl) {
      return this.callWithCurl(method, payload);
    }
    return this.callWithFetch(method, payload);
  }

  async callWithFetch(method, payload = {}) {
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

    const body = await response.json();
    if (!body.ok) {
      throw new Error(`Telegram API ${method} error: ${body.description || 'unknown error'}`);
    }
    return body.result;
  }

  async callWithCurl(method, payload = {}) {
    const timeoutSeconds = Math.max(10, Number(payload.timeout || 0) + 10);
    const args = [
      '-sS',
      '--max-time',
      String(timeoutSeconds),
      '--proxy',
      this.proxyUrl,
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

    let body;
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

  async getMe() {
    return this.call('getMe');
  }

  async getUpdates({ offset, timeoutSeconds }) {
    return this.call('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    });
  }

  async setMyCommands(commands) {
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

  async sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  async sendMessage(chatId, text) {
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
    });
  }
}
