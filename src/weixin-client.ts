import crypto from 'node:crypto';
import { runCommand, toErrorMessage } from './utils.js';
import type {
  WeixinGetUpdatesResponse,
  WeixinQrcodeResponse,
  WeixinQrcodeStatusResponse,
  WeixinTextMessageParams,
  WeixinTypingParams,
} from './types.js';

interface WeixinClientOptions {
  baseUrl?: string;
  token?: string;
  channelVersion?: string;
  skRouteTag?: string;
  fetchImpl?: typeof globalThis.fetch;
  proxyUrl?: string;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/+$/u, '');
}

export function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function buildBusinessHeaders(token: string, body: string, skRouteTag?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    ...(skRouteTag ? { SKRouteTag: skRouteTag } : {}),
  };
}

export class WeixinClient {
  baseUrl: string;
  token: string | undefined;
  channelVersion: string;
  skRouteTag: string | undefined;
  fetchImpl: typeof globalThis.fetch;
  proxyUrl: string | undefined;

  constructor(options: WeixinClientOptions = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('global fetch is not available');
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.channelVersion = options.channelVersion || '1.0.0';
    this.skRouteTag = options.skRouteTag;
    this.fetchImpl = fetchImpl;
    this.proxyUrl = options.proxyUrl;
  }

  requireToken(): string {
    if (!this.token) {
      throw new Error('Weixin bot token is required');
    }
    return this.token;
  }

  async getBotQrcode(): Promise<WeixinQrcodeResponse> {
    const data = await this.get('/ilink/bot/get_bot_qrcode?bot_type=3');
    if (typeof data.qrcode !== 'string' || typeof data.qrcode_img_content !== 'string') {
      throw new Error('Weixin get_bot_qrcode returned an invalid payload');
    }
    return {
      qrcode: data.qrcode,
      qrcodeImgContent: data.qrcode_img_content,
    };
  }

  async getQrcodeStatus(qrcode: string): Promise<WeixinQrcodeStatusResponse> {
    const data = await this.get(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      'iLink-App-ClientVersion': '1',
    });
    if (
      data.status !== 'wait' &&
      data.status !== 'scaned' &&
      data.status !== 'confirmed' &&
      data.status !== 'expired'
    ) {
      throw new Error('Weixin get_qrcode_status returned an invalid status');
    }

    return {
      status: data.status,
      botToken: typeof data.bot_token === 'string' ? data.bot_token : undefined,
      accountId: typeof data.ilink_bot_id === 'string' ? data.ilink_bot_id : undefined,
      userId: typeof data.ilink_user_id === 'string' ? data.ilink_user_id : undefined,
      baseUrl: typeof data.baseurl === 'string' ? data.baseurl : undefined,
    };
  }

  async getUpdates(getUpdatesBuf = ''): Promise<WeixinGetUpdatesResponse> {
    const data = await this.post('/ilink/bot/getupdates', {
      get_updates_buf: getUpdatesBuf,
      base_info: {
        channel_version: this.channelVersion,
      },
    });

    return {
      ret: Number(data.ret ?? 0),
      errcode: typeof data.errcode === 'number' ? data.errcode : undefined,
      errmsg: typeof data.errmsg === 'string' ? data.errmsg : undefined,
      msgs: Array.isArray(data.msgs) ? data.msgs as WeixinGetUpdatesResponse['msgs'] : undefined,
      get_updates_buf: typeof data.get_updates_buf === 'string' ? data.get_updates_buf : undefined,
      longpolling_timeout_ms: typeof data.longpolling_timeout_ms === 'number' ? data.longpolling_timeout_ms : undefined,
    };
  }

  async sendTextMessage(message: WeixinTextMessageParams): Promise<void> {
    const data = await this.post('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: message.toUserId,
        client_id: `code-agent-connect:${Date.now()}-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: message.contextToken,
        item_list: [
          {
            type: 1,
            text_item: {
              text: message.text,
            },
          },
        ],
      },
      base_info: {
        channel_version: this.channelVersion,
      },
    });

    this.ensureSuccess(data, 'sendmessage');
  }

  async getTypingTicket(ilinkUserId: string, contextToken?: string): Promise<string> {
    const data = await this.post('/ilink/bot/getconfig', {
      ilink_user_id: ilinkUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: {
        channel_version: this.channelVersion,
      },
    });

    this.ensureSuccess(data, 'getconfig');
    if (typeof data.typing_ticket !== 'string' || !data.typing_ticket) {
      throw new Error('Weixin getconfig returned no typing_ticket');
    }
    return data.typing_ticket;
  }

  async sendTyping(params: WeixinTypingParams): Promise<void> {
    const data = await this.post('/ilink/bot/sendtyping', {
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status,
      base_info: {
        channel_version: this.channelVersion,
      },
    });

    this.ensureSuccess(data, 'sendtyping');
  }

  ensureSuccess(data: Record<string, unknown>, label: string): void {
    const ret = Number(data.ret ?? 0);
    const errcode = Number(data.errcode ?? 0);
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`Weixin ${label} failed: ${JSON.stringify(data)}`);
    }
  }

  async get(pathname: string, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (this.proxyUrl) {
      return this.getWithCurl(pathname, extraHeaders);
    }
    return this.getWithFetch(pathname, extraHeaders);
  }

  async post(pathname: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = this.requireToken();
    const body = JSON.stringify(payload);
    const headers = buildBusinessHeaders(token, body, this.skRouteTag);

    if (this.proxyUrl) {
      return this.postWithCurl(pathname, body, headers);
    }
    return this.postWithFetch(pathname, body, headers);
  }

  async getWithFetch(pathname: string, extraHeaders: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'GET',
      headers: {
        ...(this.skRouteTag ? { SKRouteTag: this.skRouteTag } : {}),
        ...extraHeaders,
      },
    });

    if (!response.ok) {
      throw new Error(`Weixin GET ${pathname} failed with status ${response.status}`);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  async postWithFetch(
    pathname: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`Weixin POST ${pathname} failed with status ${response.status}`);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  async getWithCurl(pathname: string, extraHeaders: Record<string, string>): Promise<Record<string, unknown>> {
    const args = [
      '-sS',
      '--max-time',
      '40',
      '--proxy',
      this.proxyUrl!,
      ...(this.skRouteTag ? ['-H', `SKRouteTag: ${this.skRouteTag}`] : []),
      ...Object.entries(extraHeaders).flatMap(([key, value]) => ['-H', `${key}: ${value}`]),
      `${this.baseUrl}${pathname}`,
    ];

    const result = await runCommand('curl', args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `curl GET ${pathname} failed with code ${result.code}`);
    }

    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Weixin GET ${pathname} returned invalid JSON: ${toErrorMessage(error)}`);
    }
  }

  async postWithCurl(
    pathname: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const args = [
      '-sS',
      '--max-time',
      '40',
      '--proxy',
      this.proxyUrl!,
      '-X',
      'POST',
      ...Object.entries(headers).flatMap(([key, value]) => ['-H', `${key}: ${value}`]),
      '--data',
      body,
      `${this.baseUrl}${pathname}`,
    ];

    const result = await runCommand('curl', args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `curl POST ${pathname} failed with code ${result.code}`);
    }

    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Weixin POST ${pathname} returned invalid JSON: ${toErrorMessage(error)}`);
    }
  }
}
