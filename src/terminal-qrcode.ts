import { createRequire } from 'node:module';

type QrCodeTerminalModule = {
  generate(input: string, options: { small?: boolean }, callback: (output: string) => void): void;
};

const require = createRequire(import.meta.url);
const qrcodeTerminal = require('qrcode-terminal') as QrCodeTerminalModule;

export function renderTerminalQrCode(content: string): string {
  let rendered = '';
  qrcodeTerminal.generate(content, { small: true }, (output) => {
    rendered = output;
  });
  if (!rendered) {
    throw new Error('Failed to render terminal QR code');
  }
  return rendered;
}
