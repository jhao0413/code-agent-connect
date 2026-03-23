import { sleep } from './utils.js';
import { renderTerminalQrCode } from './terminal-qrcode.js';
import type { WeixinCredential, WeixinQrcodeResponse, WeixinQrcodeStatusResponse } from './types.js';
import type { StateStore } from './storage.js';

export interface WeixinLoginClient {
  getBotQrcode(): Promise<WeixinQrcodeResponse>;
  getQrcodeStatus(qrcode: string): Promise<WeixinQrcodeStatusResponse>;
}

interface RunWeixinLoginOptions {
  store: StateStore;
  client: WeixinLoginClient;
  sleepImpl?: (ms: number) => Promise<void>;
  writeLine?: (line: string) => void;
  renderQrCode?: (content: string, writeLine: (line: string) => void) => void;
}

function toCredential(status: WeixinQrcodeStatusResponse): WeixinCredential {
  if (!status.botToken || !status.accountId || !status.userId || !status.baseUrl) {
    throw new Error('Weixin login did not return a complete credential set');
  }

  return {
    token: status.botToken,
    baseUrl: status.baseUrl,
    accountId: status.accountId,
    userId: status.userId,
    savedAt: new Date().toISOString(),
  };
}

export async function runWeixinLogin({
  store,
  client,
  sleepImpl = sleep,
  writeLine = console.log,
  renderQrCode = (content, sink) => {
    const rendered = renderTerminalQrCode(content);
    for (const line of rendered.split(/\r?\n/u)) {
      sink(line);
    }
  },
}: RunWeixinLoginOptions): Promise<WeixinCredential> {
  let qrcode = await client.getBotQrcode();

  const showQrCode = (content: string, label: string): void => {
    writeLine(label);
    try {
      renderQrCode(content, writeLine);
    } catch (error) {
      writeLine(`Failed to render QR code in terminal: ${error instanceof Error ? error.message : String(error)}`);
    }
    writeLine(content);
  };

  showQrCode(qrcode.qrcodeImgContent, 'Scan this QR code in WeChat and confirm the login:');

  while (true) {
    const status = await client.getQrcodeStatus(qrcode.qrcode);

    if (status.status === 'confirmed') {
      const credential = toCredential(status);
      await store.clearWeixinRuntime(credential.accountId);
      await store.saveWeixinCredential(credential);
      await store.setWeixinCursor(credential.accountId, '', undefined);
      writeLine(`Weixin login confirmed for ${credential.accountId}`);
      return credential;
    }

    if (status.status === 'expired') {
      qrcode = await client.getBotQrcode();
      showQrCode(qrcode.qrcodeImgContent, 'QR code expired. Scan the refreshed QR code:');
      continue;
    }

    await sleepImpl(1000);
  }
}
