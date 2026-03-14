import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { RunCommandResult } from './types.js';

export function expandHomePath(input: string): string {
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

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function readJson<T>(filePath: string, fallbackValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFileAtomic(filePath, serialized);
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function coerceStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry: unknown) => {
    if (typeof entry === 'string') {
      return entry;
    }
    if (typeof entry === 'number') {
      return String(entry);
    }
    throw new Error(`${label} must contain only strings or integers`);
  });
}

export function chunkText(text: string, maxLength = 3500): string[] {
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isExecutable(filePath: string): boolean {
  try {
    if (os.platform() === 'win32') {
      fssync.accessSync(filePath, fssync.constants.F_OK);
    } else {
      fssync.accessSync(filePath, fssync.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function which(command: string, envPath = process.env.PATH || ''): string | null {
  if (!command) {
    return null;
  }
  const extensions =
    os.platform() === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  if (path.isAbsolute(command)) {
    if (isExecutable(command)) return command;
    for (const ext of extensions) {
      if (isExecutable(command + ext)) return command + ext;
    }
    return null;
  }
  const pathEntries = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, command + ext);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function normalizeSpawn(command: string, args: string[]): [string, string[]] {
  if (os.platform() === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return ['cmd.exe', ['/c', command, ...args]];
  }
  return [command, args];
}

export async function isWritableDirectory(dirPath: string): Promise<boolean> {
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

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunCommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let errored = false;
  const code = await new Promise<number>((resolve) => {
    child.once('error', (error: unknown) => {
      errored = true;
      stderr += error instanceof Error ? error.message : String(error);
      resolve(127);
    });
    child.once('close', (closeCode: number | null) => resolve(closeCode ?? 0));
  });

  return { code, stdout, stderr, errored };
}

export function formatCheckResult(ok: boolean, label: string, detail = ''): string {
  const prefix = ok ? '[OK]  ' : '[FAIL]';
  return `${prefix} ${label}${detail ? `: ${detail}` : ''}`;
}

export function escapeSystemdValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function escapePlistValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
