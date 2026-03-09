import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/storage.mjs';

test('StateStore persists sessions and offsets', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-state-'));
  const store = new StateStore(stateDir);
  await store.init();

  const session = await store.createSession('42', 'claude');
  session.providerSessionIds.claude = 'session-123';
  await store.saveSession(session);
  await store.setTelegramOffset(10);

  const reloaded = new StateStore(stateDir);
  await reloaded.init();

  const restored = reloaded.getActiveSession('42');
  assert.equal(restored.activeAgent, 'claude');
  assert.equal(restored.providerSessionIds.claude, 'session-123');
  assert.equal(reloaded.getTelegramOffset(), 10);
});
