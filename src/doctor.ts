import fs from 'node:fs/promises';
import os from 'node:os';
import { TelegramClient } from './telegram-client.js';
import {
  fileExists,
  formatCheckResult,
  isExecutable,
  isWritableDirectory,
  runCommand,
} from './utils.js';
import { getLingerStatus, getProjectRoot, LAUNCHD_LABEL } from './service-manager.js';
import { resolveAgentBinary } from './config.js';
import { checkForUpdate } from './updater.js';
import type { CheckResult, Config } from './types.js';

export async function runDoctor(config: Config): Promise<CheckResult> {
  const lines: string[] = [];
  let failed = 0;

  const push = (ok: boolean, label: string, detail = ''): void => {
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
    const me = await telegram.getMe() as { username?: string; first_name?: string };
    push(
      true,
      'Telegram token is valid',
      `@${me.username || me.first_name || 'bot'}${config.network?.proxyUrl ? ' (proxy)' : ''}`,
    );
  } catch (error) {
    push(false, 'Telegram token is valid', error instanceof Error ? error.message : String(error));
  }

  if (os.platform() === 'darwin') {
    const launchctlList = await runCommand('launchctl', ['list', LAUNCHD_LABEL]);
    const loaded = launchctlList.code === 0;
    push(loaded, 'launchd agent is loaded', loaded ? LAUNCHD_LABEL : 'not loaded');

    if (loaded) {
      const hasPid = /^\s*"PID"\s*=/m.test(launchctlList.stdout);
      push(hasPid, 'Service is running', hasPid ? 'running' : 'not running');
    }
  } else {
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
  }

  // Update check (informational, does not affect exit code)
  const projectRoot = getProjectRoot();
  const updateResult = await checkForUpdate({ projectRoot, stateDir: config.stateDir, force: false });
  if (updateResult && updateResult.available) {
    lines.push(`[INFO] Update available: ${updateResult.currentVersion} -> ${updateResult.latestVersion || 'newer version'} (run 'code-agent-connect update')`);
  } else if (updateResult && !updateResult.available) {
    lines.push(`[OK]   Version is up to date: ${updateResult.currentVersion}`);
  }

  return {
    ok: failed === 0,
    output: lines.join('\n'),
  };
}
