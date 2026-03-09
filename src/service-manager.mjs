import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  escapeSystemdValue,
  fileExists,
  runCommand,
} from './utils.mjs';
import { resolveAgentBinary } from './config.mjs';

export const SERVICE_NAME = 'code-agent-connect.service';

export function getProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function quoteExecArg(value) {
  return `"${escapeSystemdValue(value)}"`;
}

export function renderServiceUnit({ config, projectRoot, nodePath, resolvedBins, environmentPath }) {
  const envLines = [
    `Environment="PATH=${escapeSystemdValue(environmentPath)}"`,
  ];

  if (config.network?.proxyUrl) {
    envLines.push(`Environment="HTTP_PROXY=${escapeSystemdValue(config.network.proxyUrl)}"`);
    envLines.push(`Environment="HTTPS_PROXY=${escapeSystemdValue(config.network.proxyUrl)}"`);
    envLines.push(`Environment="ALL_PROXY=${escapeSystemdValue(config.network.proxyUrl)}"`);
    envLines.push('Environment="NODE_USE_ENV_PROXY=1"');
  }
  if (config.network?.noProxy) {
    envLines.push(`Environment="NO_PROXY=${escapeSystemdValue(config.network.noProxy)}"`);
  }

  for (const [agent, binaryPath] of Object.entries(resolvedBins)) {
    if (!binaryPath) {
      continue;
    }
    envLines.push(
      `Environment="${escapeSystemdValue(`CAC_${agent.toUpperCase()}_BIN`)}=${escapeSystemdValue(binaryPath)}"`,
    );
  }

  const distCliPath = path.join(projectRoot, 'dist', 'cli.mjs');
  const execStart = [nodePath, distCliPath, 'serve', '--config', config.configPath]
    .map((value) => quoteExecArg(value))
    .join(' ');

  return [
    '[Unit]',
    'Description=code-agent-connect Telegram bridge',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    ...envLines,
    `WorkingDirectory=${projectRoot}`,
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

async function resolveSystemctl() {
  const result = await runCommand('systemctl', ['--user', '--version']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'systemctl --user is not available');
  }
}

export async function getLingerStatus(username = os.userInfo().username) {
  const result = await runCommand('loginctl', ['show-user', username, '--property=Linger', '--value']);
  if (result.code !== 0) {
    return { available: false, enabled: false };
  }
  return {
    available: true,
    enabled: result.stdout.trim().toLowerCase() === 'yes',
  };
}

export async function installService(config) {
  await resolveSystemctl();

  const projectRoot = getProjectRoot();
  const distCliPath = path.join(projectRoot, 'dist', 'cli.mjs');
  if (!(await fileExists(distCliPath))) {
    throw new Error('dist/cli.mjs is missing. Run `npm run build` first.');
  }

  const resolvedBins = {};
  for (const agent of config.agents.enabled) {
    const binaryPath = resolveAgentBinary(config, agent);
    if (!binaryPath) {
      throw new Error(`Cannot resolve ${agent} binary while installing the service`);
    }
    resolvedBins[agent] = binaryPath;
  }

  const unitDir = config.systemdUserDir;
  const unitPath = path.join(unitDir, SERVICE_NAME);
  const unitContent = renderServiceUnit({
    config,
    projectRoot,
    nodePath: process.execPath,
    resolvedBins,
    environmentPath: process.env.PATH || '',
  });

  await ensureDir(unitDir);
  await fs.writeFile(unitPath, unitContent, 'utf8');

  let commandResult = await runCommand('systemctl', ['--user', 'daemon-reload']);
  if (commandResult.code !== 0) {
    throw new Error(commandResult.stderr.trim() || 'systemctl --user daemon-reload failed');
  }

  commandResult = await runCommand('systemctl', ['--user', 'enable', '--now', 'code-agent-connect.service']);
  if (commandResult.code !== 0) {
    throw new Error(commandResult.stderr.trim() || 'systemctl --user enable --now failed');
  }

  return { unitPath };
}

export async function uninstallService(config) {
  await resolveSystemctl();

  const unitPath = path.join(config.systemdUserDir, SERVICE_NAME);
  await runCommand('systemctl', ['--user', 'disable', '--now', 'code-agent-connect.service']);
  await fs.rm(unitPath, { force: true });

  const result = await runCommand('systemctl', ['--user', 'daemon-reload']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'systemctl --user daemon-reload failed');
  }
}
