import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramCommands } from '../src/bridge-service.mjs';

test('buildTelegramCommands exposes the Telegram menu entries', () => {
  const commands = buildTelegramCommands({
    agents: {
      enabled: ['claude', 'codex', 'neovate'],
    },
  });

  assert.deepEqual(commands, [
    {
      command: 'start',
      description: 'Show help and available commands',
    },
    {
      command: 'help',
      description: 'Show help and usage tips',
    },
    {
      command: 'new',
      description: 'Start a fresh logical session',
    },
    {
      command: 'use',
      description: 'Switch agent: claude|codex|neovate',
    },
    {
      command: 'status',
      description: 'Show current session and active agent',
    },
  ]);
});
