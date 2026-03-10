#!/usr/bin/env node

import os from 'node:os';
import { applyRuntimeEnvironment, defaultLaunchAgentDir, defaultStateDir, defaultSystemdUserDir, loadConfig } from './config.js';
import { BridgeService } from './bridge-service.js';
import { StateStore } from './storage.js';
import { runDoctor } from './doctor.js';
import { getLingerStatus, getProjectRoot, installService, isServiceRunning, LAUNCHD_LABEL, restartService, uninstallService } from './service-manager.js';
import { checkForUpdate, formatUpdateNotice, performUpdate } from './updater.js';
import type { Config } from './types.js';

function printHelp(): void {
  console.log(
    [
      'code-agent-connect',
      '',
      'Usage:',
      '  code-agent-connect serve [--config /path/to/config.toml]',
      '  code-agent-connect doctor [--config /path/to/config.toml]',
      '  code-agent-connect service install [--config /path/to/config.toml]',
      '  code-agent-connect service uninstall [--config /path/to/config.toml]',
      '  code-agent-connect update [--config /path/to/config.toml]',
      '  code-agent-connect check-update',
    ].join('\n'),
  );
}

function parseArguments(argv: string[]): { filtered: string[]; configPath: string | undefined } {
  const args = [...argv];
  let configPath: string | undefined;
  const filtered: string[] = [];

  while (args.length > 0) {
    const current = args.shift()!;
    if (current === '--config') {
      configPath = args.shift();
      continue;
    }
    filtered.push(current);
  }

  return { filtered, configPath };
}

/**
 * Try to load config and apply proxy env vars.
 * Returns the config object if successful, null otherwise (update/check-update can work without config).
 */
async function tryLoadConfig(configPath: string | undefined): Promise<Config | null> {
  try {
    const config = await loadConfig(configPath);
    applyRuntimeEnvironment(config);
    return config;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { filtered, configPath } = parseArguments(process.argv.slice(2));
  const [command = 'help', subcommand] = filtered;

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'serve') {
    const config = await loadConfig(configPath);
    applyRuntimeEnvironment(config);

    // Non-blocking update check
    const projectRoot = getProjectRoot();
    checkForUpdate({ projectRoot, stateDir: config.stateDir }).then((result) => {
      const notice = formatUpdateNotice(result);
      if (notice) {
        console.error(notice);
      }
    }).catch(() => {
      // Silently ignore update check failures
    });

    const store = new StateStore(config.stateDir);
    const bridge = new BridgeService(config, store);
    await bridge.run();
    return;
  }

  if (command === 'doctor') {
    const config = await loadConfig(configPath);
    applyRuntimeEnvironment(config);
    const result = await runDoctor(config);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === 'service' && subcommand === 'install') {
    const config = await loadConfig(configPath);
    applyRuntimeEnvironment(config);
    const result = await installService(config);
    if (os.platform() === 'darwin') {
      console.log(`Installed launch agent at ${result.plistPath}`);
    } else {
      const linger = await getLingerStatus();
      console.log(`Installed user service at ${result.unitPath}`);
      if (!linger.available || !linger.enabled) {
        console.log(`Enable boot-time startup with: sudo loginctl enable-linger ${process.env.USER}`);
      }
    }
    return;
  }

  if (command === 'service' && subcommand === 'uninstall') {
    if (os.platform() === 'darwin') {
      await uninstallService({ launchAgentDir: defaultLaunchAgentDir() });
      console.log(`Removed ${LAUNCHD_LABEL} launch agent`);
    } else {
      await uninstallService({ systemdUserDir: defaultSystemdUserDir() });
      console.log('Removed code-agent-connect.service');
    }
    return;
  }

  if (command === 'update') {
    const config = await tryLoadConfig(configPath);
    const projectRoot = getProjectRoot();
    const stateDir = config?.stateDir ?? defaultStateDir();

    const result = await checkForUpdate({ projectRoot, stateDir, force: true });
    if (!result || !result.available) {
      console.log('Already up to date.');
      return;
    }

    console.log(formatUpdateNotice(result));
    console.log('');
    await performUpdate({ projectRoot, stateDir, isServiceRunning, restartService });
    return;
  }

  if (command === 'check-update') {
    const config = await tryLoadConfig(configPath);
    const projectRoot = getProjectRoot();
    const stateDir = config?.stateDir ?? defaultStateDir();

    const result = await checkForUpdate({ projectRoot, stateDir, force: true });
    if (!result) {
      console.log('Unable to check for updates.');
      return;
    }
    if (!result.available) {
      console.log(`Already up to date (${result.currentVersion}).`);
      return;
    }
    console.log(formatUpdateNotice(result));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
