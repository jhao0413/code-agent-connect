import test from 'node:test';
import assert from 'node:assert/strict';
import { runPersistentService } from '../src/service-runner.js';

test('runPersistentService retries after a crash without rejecting', async () => {
  const logs: string[] = [];
  const sleeps: number[] = [];
  let attempts = 0;

  await assert.doesNotReject(() => runPersistentService('weixin', async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('boom');
    }
  }, {
    retryDelayMs: 25,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => {
      logs.push(line);
    },
    shouldRestart: ({ attempt }) => attempt < 2,
  }));

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [25]);
  assert.ok(logs.some((line) => line.includes('[weixin] service crashed:')));
});
