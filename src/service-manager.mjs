import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  escapePlistValue,
  escapeSystemdValue,
  fileExists,
  runCommand,
} from './utils.mjs';
import { resolveAgentBinary } from './config.mjs';

export const SERVICE_NAME = 'code-agent-connect.service';
export const LAUNCHD_LABEL = 'com.code-agent-connect';

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
  if (os.platform() === 'darwin') {
    return installLaunchAgent(config);
  }

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
  if (os.platform() === 'darwin') {
    return uninstallLaunchAgent(config);
  }

  await resolveSystemctl();

  const unitPath = path.join(config.systemdUserDir, SERVICE_NAME);
  await runCommand('systemctl', ['--user', 'disable', '--now', 'code-agent-connect.service']);
  await fs.rm(unitPath, { force: true });

  const result = await runCommand('systemctl', ['--user', 'daemon-reload']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'systemctl --user daemon-reload failed');
  }
}

export function renderLaunchAgentPlist({ config, projectRoot, nodePath, resolvedBins, environmentPath }) {
  const esc = escapePlistValue;
  const distCliPath = path.join(projectRoot, 'dist', 'cli.mjs');

  const envEntries = [`      <key>PATH</key>\n      <string>${esc(environmentPath)}</string>`];
  if (config.network?.proxyUrl) {
    envEntries.push(`      <key>HTTP_PROXY</key>\n      <string>${esc(config.network.proxyUrl)}</string>`);
    envEntries.push(`      <key>HTTPS_PROXY</key>\n      <string>${esc(config.network.proxyUrl)}</string>`);
    envEntries.push(`      <key>ALL_PROXY</key>\n      <string>${esc(config.network.proxyUrl)}</string>`);
    envEntries.push(`      <key>NODE_USE_ENV_PROXY</key>\n      <string>1</string>`);
  }
  if (config.network?.noProxy) {
    envEntries.push(`      <key>NO_PROXY</key>\n      <string>${esc(config.network.noProxy)}</string>`);
  }
  for (const [agent, binaryPath] of Object.entries(resolvedBins)) {
    if (!binaryPath) continue;
    envEntries.push(`      <key>CAC_${agent.toUpperCase()}_BIN</key>\n      <string>${esc(binaryPath)}</string>`);
  }

  const stdoutPath = path.join(config.stateDir, 'stdout.log');
  const stderrPath = path.join(config.stateDir, 'stderr.log');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${esc(LAUNCHD_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${esc(nodePath)}</string>`,
    `    <string>${esc(distCliPath)}</string>`,
    '    <string>serve</string>',
    '    <string>--config</string>',
    `    <string>${esc(config.configPath)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>WorkingDirectory</key>',
    `  <string>${esc(projectRoot)}</string>`,
    '  <key>StandardOutPath</key>',
    `  <string>${esc(stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${esc(stderrPath)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...envEntries,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export async function installLaunchAgent(config) {
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

  const agentDir = config.launchAgentDir;
  const plistPath = path.join(agentDir, `${LAUNCHD_LABEL}.plist`);
  const plistContent = renderLaunchAgentPlist({
    config,
    projectRoot,
    nodePath: process.execPath,
    resolvedBins,
    environmentPath: process.env.PATH || '',
  });

  await ensureDir(agentDir);
  await ensureDir(config.stateDir);
  await fs.writeFile(plistPath, plistContent, 'utf8');

  const result = await runCommand('launchctl', ['load', '-w', plistPath]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'launchctl load failed');
  }

  return { plistPath };
}

export async function uninstallLaunchAgent(config) {
  const plistPath = path.join(config.launchAgentDir, `${LAUNCHD_LABEL}.plist`);
  await runCommand('launchctl', ['unload', plistPath]);
  await fs.rm(plistPath, { force: true });
}
