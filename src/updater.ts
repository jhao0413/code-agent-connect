import path from 'node:path';
import { readJson, runCommand, writeJsonAtomic } from './utils.js';
import type { UpdateCheckResult } from './types.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_FILE = 'update-check.json';

/**
 * Check for available updates by comparing local HEAD with remote tags.
 * Returns null on any failure — must never break normal operation.
 *
 * Note: assumes the git remote is named "origin" and the primary branch is "main".
 */
export async function checkForUpdate({ projectRoot, stateDir, force = false }: { projectRoot: string; stateDir: string; force?: boolean }): Promise<UpdateCheckResult | null> {
  const cachePath = path.join(stateDir, CACHE_FILE);

  if (!force) {
    const cached = await readJson<{ checkedAt: number; result: UpdateCheckResult } | null>(cachePath, null);
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached.result;
    }
  }

  // Fetch latest tags from remote
  const fetchResult = await runCommand('git', ['fetch', '--tags', '--quiet'], { cwd: projectRoot });
  if (fetchResult.code !== 0) {
    return null;
  }

  // Count commits behind origin/main
  const revList = await runCommand('git', ['rev-list', 'HEAD..origin/main', '--count'], { cwd: projectRoot });
  if (revList.code !== 0) {
    return null;
  }
  const behind = parseInt(revList.stdout.trim(), 10) || 0;

  // Get remote latest tag version
  const remoteTag = await runCommand('git', ['describe', '--tags', '--abbrev=0', 'origin/main'], { cwd: projectRoot });
  const latestVersion = remoteTag.code === 0 ? remoteTag.stdout.trim() : null;

  // Get local tag version, fall back to package.json
  let currentVersion: string;
  const localTag = await runCommand('git', ['describe', '--tags', '--abbrev=0', 'HEAD'], { cwd: projectRoot });
  if (localTag.code === 0 && localTag.stdout.trim()) {
    currentVersion = localTag.stdout.trim();
  } else {
    const pkg = await readJson<{ version?: string }>(path.join(projectRoot, 'package.json'), {});
    currentVersion = pkg.version ? `v${pkg.version}` : 'unknown';
  }

  const available = behind > 0;
  const result: UpdateCheckResult = { available, currentVersion, latestVersion, behind };

  // Cache the result
  try {
    await writeJsonAtomic(cachePath, { checkedAt: Date.now(), result });
  } catch {
    // Ignore cache write failures
  }

  return result;
}

/**
 * Format a human-readable update notice. Returns null if no update available.
 */
export function formatUpdateNotice(result: UpdateCheckResult | null): string | null {
  if (!result || !result.available) {
    return null;
  }

  const parts = [`Update available: ${result.currentVersion} → ${result.latestVersion || 'newer version'}`];
  if (result.behind > 0) {
    parts[0] += ` (${result.behind} commit${result.behind === 1 ? '' : 's'} behind)`;
  }
  parts.push("Run `code-agent-connect update` to update.");
  return parts.join('\n');
}

/**
 * Perform the actual update: git pull, npm install, npm run build.
 * Throws on failure at any step.
 */
export async function performUpdate({ projectRoot, stateDir, isServiceRunning, restartService }: {
  projectRoot: string;
  stateDir: string;
  isServiceRunning?: () => Promise<boolean>;
  restartService?: () => Promise<void>;
}): Promise<void> {
  // Check for local modifications
  const status = await runCommand('git', ['status', '--porcelain'], { cwd: projectRoot });
  if (status.code !== 0) {
    throw new Error(`git status failed: ${status.stderr.trim()}`);
  }
  if (status.stdout.trim()) {
    throw new Error(
      'Working tree has local modifications. Please run `git stash` or commit your changes first.',
    );
  }

  // Confirm on main branch
  const branch = await runCommand('git', ['branch', '--show-current'], { cwd: projectRoot });
  if (branch.code !== 0) {
    throw new Error(`Failed to detect current branch: ${branch.stderr.trim()}`);
  }
  const currentBranch = branch.stdout.trim();
  if (currentBranch !== 'main') {
    throw new Error(`Not on main branch (current: ${currentBranch}). Switch to main first.`);
  }

  // git pull --ff-only
  console.log('Pulling latest changes...');
  const pull = await runCommand('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: projectRoot });
  if (pull.code !== 0) {
    throw new Error(`git pull failed: ${pull.stderr.trim()}`);
  }

  // npm install --omit=dev
  console.log('Installing dependencies...');
  const install = await runCommand('npm', ['install', '--omit=dev'], { cwd: projectRoot });
  if (install.code !== 0) {
    throw new Error(`npm install failed: ${install.stderr.trim()}`);
  }

  // npm run build
  console.log('Building...');
  const build = await runCommand('npm', ['run', 'build'], { cwd: projectRoot });
  if (build.code !== 0) {
    throw new Error(`npm run build failed: ${build.stderr.trim()}`);
  }

  // Read new version
  const pkg = await readJson<{ version?: string }>(path.join(projectRoot, 'package.json'), {});
  const newVersion = pkg.version ? `v${pkg.version}` : 'unknown';
  console.log(`Updated to ${newVersion}`);

  // Restart service if running
  if (isServiceRunning && restartService) {
    const running = await isServiceRunning();
    if (running) {
      console.log('Restarting background service...');
      await restartService();
      console.log('Service restarted.');
    }
  }

  // Clear update cache so the next check fetches fresh data
  const cachePath = path.join(stateDir, CACHE_FILE);
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(cachePath);
  } catch {
    // Ignore — file may not exist
  }
}
