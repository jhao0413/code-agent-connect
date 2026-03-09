import fs from 'node:fs/promises';
import { TelegramClient } from './telegram-client.mjs';
import {
  fileExists,
  formatCheckResult,
  isExecutable,
  isWritableDirectory,
  runCommand,
} from './utils.mjs';
import { getLingerStatus } from './service-manager.mjs';
import { resolveAgentBinary } from './config.mjs';

export async function runDoctor(config) {
  const lines = [];
  let failed = 0;

  const push = (ok, label, detail = '') => {
    if (!ok) {
      failed += 1;
    }
    lines.push(formatCheckResult(ok, label, detail));
  };

  push(await fileExists(config.configPath), 'Config file exists', config.configPath);

  try {
    const stats = await fs.stat(config.bridge.workingDir);
    push(stats.isDirectory(), 'Working directory exists', config.bridge.workingDir);
  } catch {
    push(false, 'Working directory exists', config.bridge.workingDir);
  }

  push(
    await isWritableDirectory(config.stateDir),
    'State directory is writable',
    config.stateDir,
  );

  for (const agent of config.agents.enabled) {
    const binaryPath = resolveAgentBinary(config, agent);
    push(!!binaryPath && isExecutable(binaryPath), `${agent} binary is executable`, binaryPath || 'not found');
  }

  try {
    const telegram = new TelegramClient(config.telegram.botToken, {
      proxyUrl: config.network?.proxyUrl,
    });
    const me = await telegram.getMe();
    push(
      true,
      'Telegram token is valid',
      `@${me.username || me.first_name || 'bot'}${config.network?.proxyUrl ? ' (proxy)' : ''}`,
    );
  } catch (error) {
    push(false, 'Telegram token is valid', error instanceof Error ? error.message : String(error));
  }

  const systemctlVersion = await runCommand('systemctl', ['--user', '--version']);
  push(systemctlVersion.code === 0, 'systemd user service is available', systemctlVersion.code === 0 ? 'systemctl --user' : systemctlVersion.stderr.trim());

  if (systemctlVersion.code === 0) {
    const enabled = await runCommand('systemctl', ['--user', 'is-enabled', 'code-agent-connect.service']);
    push(enabled.code === 0, 'Service is enabled', enabled.stdout.trim() || enabled.stderr.trim());

    const active = await runCommand('systemctl', ['--user', 'is-active', 'code-agent-connect.service']);
    push(active.code === 0, 'Service is active', active.stdout.trim() || active.stderr.trim());
  }

  const linger = await getLingerStatus();
  if (linger.available) {
    push(linger.enabled, 'systemd linger is enabled', linger.enabled ? 'enabled' : 'run: sudo loginctl enable-linger $USER');
  } else {
    push(false, 'systemd linger is enabled', 'loginctl not available');
  }

  return {
    ok: failed === 0,
    output: lines.join('\n'),
  };
}
