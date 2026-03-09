import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function expandHomePath(input) {
  if (!input) {
    return input;
  }
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeFileAtomic(filePath, content) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFileAtomic(filePath, serialized);
}

export async function appendLine(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function coerceStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry) => {
    if (typeof entry === 'string') {
      return entry;
    }
    if (typeof entry === 'number') {
      return String(entry);
    }
    throw new Error(`${label} must contain only strings or integers`);
  });
}

export function chunkText(text, maxLength = 3500) {
  if (!text) {
    return [];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let boundary = remaining.lastIndexOf('\n', maxLength);
    if (boundary < maxLength * 0.4) {
      boundary = remaining.lastIndexOf(' ', maxLength);
    }
    if (boundary < maxLength * 0.4) {
      boundary = maxLength;
    }
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isExecutable(filePath) {
  try {
    fssync.accessSync(filePath, fssync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function which(command, envPath = process.env.PATH || '') {
  if (!command) {
    return null;
  }
  if (path.isAbsolute(command)) {
    return isExecutable(command) ? command : null;
  }
  const pathEntries = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function isWritableDirectory(dirPath) {
  try {
    await ensureDir(dirPath);
    const tempPath = path.join(dirPath, `.tmp-${process.pid}-${Date.now()}`);
    await fs.writeFile(tempPath, 'ok', 'utf8');
    await fs.rm(tempPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let errored = false;
  const code = await new Promise((resolve) => {
    child.once('error', (error) => {
      errored = true;
      stderr += error instanceof Error ? error.message : String(error);
      resolve(127);
    });
    child.once('close', (closeCode) => resolve(closeCode ?? 0));
  });

  return { code, stdout, stderr, errored };
}

export function formatCheckResult(ok, label, detail = '') {
  const prefix = ok ? '[OK]  ' : '[FAIL]';
  return `${prefix} ${label}${detail ? `: ${detail}` : ''}`;
}

export function escapeSystemdValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
