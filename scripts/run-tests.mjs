import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function collectTestFiles(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

const testDir = path.resolve(process.cwd(), 'test');
const files = await collectTestFiles(testDir);

if (files.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.once('close', (code) => {
  process.exit(code ?? 1);
});
