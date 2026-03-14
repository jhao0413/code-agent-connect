#!/usr/bin/env node

/**
 * Release script: bump version, commit, tag, push, and create GitHub Release.
 *
 * Usage: node scripts/release.mjs <version>
 * Example: node scripts/release.mjs 0.2.0
 *
 * Requires: gh CLI (https://cli.github.com/) installed and authenticated.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(projectRoot, 'package.json');

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: projectRoot, stdio: 'inherit' });
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/release.mjs <version>');
    console.error('Example: node scripts/release.mjs 0.2.0');
    process.exit(1);
  }

  const cleanVersion = version.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(cleanVersion)) {
    console.error(`Invalid version format: ${version}`);
    process.exit(1);
  }
  const tag = `v${cleanVersion}`;

  // Update package.json version
  const raw = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.version = cleanVersion;
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`Updated package.json version to ${cleanVersion}`);

  // Commit and tag
  run('git', ['add', 'package.json']);
  run('git', ['commit', '-m', `release: ${tag}`]);
  run('git', ['tag', tag]);

  // Push
  run('git', ['push', 'origin', 'main', '--tags']);

  // Create GitHub Release
  run('gh', ['release', 'create', tag, '--title', tag, '--generate-notes']);

  console.log(`\nReleased ${tag}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
