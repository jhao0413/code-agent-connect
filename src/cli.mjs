#!/usr/bin/env node

import os from 'node:os';
import { applyRuntimeEnvironment, defaultLaunchAgentDir, defaultSystemdUserDir, loadConfig } from './config.mjs';
import { BridgeService } from './bridge-service.mjs';
import { StateStore } from './storage.mjs';
import { runDoctor } from './doctor.mjs';
import { getLingerStatus, installService, LAUNCHD_LABEL, uninstallService } from './service-manager.mjs';

function printHelp() {
  console.log(
    [
      'code-agent-connect',
      '',
      'Usage:',
      '  code-agent-connect serve [--config /path/to/config.toml]',
      '  code-agent-connect doctor [--config /path/to/config.toml]',
      '  code-agent-connect service install [--config /path/to/config.toml]',
      '  code-agent-connect service uninstall [--config /path/to/config.toml]',
    ].join('\n'),
  );
}

function parseArguments(argv) {
  const args = [...argv];
  let configPath;
  const filtered = [];

  while (args.length > 0) {
    const current = args.shift();
    if (current === '--config') {
      configPath = args.shift();
      continue;
    }
    filtered.push(current);
  }

  return { filtered, configPath };
}

async function main() {
  const { filtered, configPath } = parseArguments(process.argv.slice(2));
  const [command = 'help', subcommand] = filtered;

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'serve') {
    const config = await loadConfig(configPath);
    applyRuntimeEnvironment(config);
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

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
