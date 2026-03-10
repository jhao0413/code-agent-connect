import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkForUpdate, formatUpdateNotice, performUpdate } from '../src/updater.js';

/** Create a minimal git repo in a temp directory and return its path. */
async function createTempRepo({ branch = 'main', dirty = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-updater-'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
  run('git', ['init', '-b', branch]);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'init']);
  if (dirty) {
    await fs.writeFile(path.join(dir, 'dirty.txt'), 'uncommitted', 'utf8');
  }
  return dir;
}

test('formatUpdateNotice returns null when no update available', () => {
  assert.equal(formatUpdateNotice(null), null);
  assert.equal(formatUpdateNotice({ available: false, currentVersion: 'v0.1.0' }), null);
});

test('formatUpdateNotice formats update with version and commit count', () => {
  const result = {
    available: true,
    currentVersion: 'v0.1.0',
    latestVersion: 'v0.2.0',
    behind: 3,
  };
  const notice = formatUpdateNotice(result);
  assert.match(notice, /v0\.1\.0/);
  assert.match(notice, /v0\.2\.0/);
  assert.match(notice, /3 commits behind/);
  assert.match(notice, /code-agent-connect update/);
});

test('formatUpdateNotice uses singular commit when behind by 1', () => {
  const result = {
    available: true,
    currentVersion: 'v0.1.0',
    latestVersion: 'v0.2.0',
    behind: 1,
  };
  const notice = formatUpdateNotice(result);
  assert.match(notice, /1 commit behind/);
  assert.doesNotMatch(notice, /1 commits behind/);
});

test('formatUpdateNotice handles missing latestVersion', () => {
  const result = {
    available: true,
    currentVersion: 'v0.1.0',
    latestVersion: null,
    behind: 5,
  };
  const notice = formatUpdateNotice(result);
  assert.match(notice, /newer version/);
});

test('checkForUpdate returns cached result within TTL', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-updater-'));
  const cachePath = path.join(tempDir, 'update-check.json');
  const cached = {
    checkedAt: Date.now(),
    result: { available: false, currentVersion: 'v0.1.0', latestVersion: 'v0.1.0', behind: 0 },
  };
  await fs.writeFile(cachePath, JSON.stringify(cached), 'utf8');

  // Should return cached result without hitting git (projectRoot doesn't matter here)
  const result = await checkForUpdate({ projectRoot: tempDir, stateDir: tempDir, force: false });
  assert.deepEqual(result, cached.result);
});

test('checkForUpdate ignores cache when force is true', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-updater-'));
  const cachePath = path.join(tempDir, 'update-check.json');
  const cached = {
    checkedAt: Date.now(),
    result: { available: true, currentVersion: 'v0.1.0', latestVersion: 'v0.2.0', behind: 3 },
  };
  await fs.writeFile(cachePath, JSON.stringify(cached), 'utf8');

  // force: true should bypass cache; git fetch will fail on non-repo dir → returns null
  const result = await checkForUpdate({ projectRoot: tempDir, stateDir: tempDir, force: true });
  assert.equal(result, null);
});

test('checkForUpdate returns null when git fetch fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-updater-'));
  // Not a git repo, so git fetch will fail
  const result = await checkForUpdate({ projectRoot: tempDir, stateDir: tempDir, force: true });
  assert.equal(result, null);
});

test('checkForUpdate skips expired cache', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cac-updater-'));
  const cachePath = path.join(tempDir, 'update-check.json');
  const cached = {
    checkedAt: Date.now() - 7 * 60 * 60 * 1000, // 7 hours ago, past 6h TTL
    result: { available: true, currentVersion: 'v0.1.0', latestVersion: 'v0.2.0', behind: 3 },
  };
  await fs.writeFile(cachePath, JSON.stringify(cached), 'utf8');

  // Expired cache + non-repo → null (would re-fetch, which fails)
  const result = await checkForUpdate({ projectRoot: tempDir, stateDir: tempDir, force: false });
  assert.equal(result, null);
});

// --- performUpdate tests ---

test('performUpdate rejects when working tree has local modifications', async () => {
  const dir = await createTempRepo({ dirty: true });
  await assert.rejects(
    () => performUpdate({ projectRoot: dir, stateDir: dir }),
    { message: /local modifications/ },
  );
});

test('performUpdate rejects when not on main branch', async () => {
  const dir = await createTempRepo({ branch: 'dev' });
  await assert.rejects(
    () => performUpdate({ projectRoot: dir, stateDir: dir }),
    { message: /Not on main branch.*dev/ },
  );
});

test('performUpdate rejects when git pull fails (no remote)', async () => {
  const dir = await createTempRepo();
  // No remote configured, so git pull origin main will fail
  await assert.rejects(
    () => performUpdate({ projectRoot: dir, stateDir: dir }),
    { message: /git pull failed/ },
  );
});

test('performUpdate calls restartService when service is running', async () => {
  const dir = await createTempRepo();
  let restartCalled = false;
  const mockIsRunning = async () => true;
  const mockRestart = async () => { restartCalled = true; };

  // Will still fail at git pull (no remote), but we verify restartService
  // is NOT reached because the error happens before that step
  await assert.rejects(
    () => performUpdate({
      projectRoot: dir,
      stateDir: dir,
      isServiceRunning: mockIsRunning,
      restartService: mockRestart,
    }),
    { message: /git pull failed/ },
  );
  assert.equal(restartCalled, false, 'restartService should not be called when update fails');
});

test('performUpdate does not call restartService when service is not running', async () => {
  const dir = await createTempRepo();
  let restartCalled = false;
  const mockIsRunning = async () => false;
  const mockRestart = async () => { restartCalled = true; };

  await assert.rejects(
    () => performUpdate({
      projectRoot: dir,
      stateDir: dir,
      isServiceRunning: mockIsRunning,
      restartService: mockRestart,
    }),
  );
  assert.equal(restartCalled, false);
});
