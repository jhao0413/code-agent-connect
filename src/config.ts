import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseToml } from './toml.js';
import {
  coerceStringArray,
  expandHomePath,
  isStringArray,
  which,
} from './utils.js';
import type { AgentConfig, Config, NetworkConfig } from './types.js';

export const VALID_AGENTS = ['claude', 'codex', 'neovate', 'opencode'];

export function defaultConfigPath(): string {
  return expandHomePath(process.env.CAC_CONFIG_PATH || '~/.code-agent-contect/config.toml');
}

export function defaultStateDir(): string {
  if (process.env.CAC_STATE_DIR) return expandHomePath(process.env.CAC_STATE_DIR);
  if (os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'code-agent-connect');
  }
  return expandHomePath('~/.local/state/code-agent-connect');
}

export function defaultSystemdUserDir(): string {
  return expandHomePath('~/.config/systemd/user');
}

export function defaultLaunchAgentDir(): string {
  return expandHomePath('~/Library/LaunchAgents');
}

export function agentBinEnvName(agent: string): string {
  return `CAC_${agent.toUpperCase()}_BIN`;
}

function normalizeAgentConfig(raw: unknown, label: string): AgentConfig {
  const value = (raw || {}) as Record<string, unknown>;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  const extraArgs = (value.extra_args as unknown[]) ?? [];
  if (!Array.isArray(extraArgs)) {
    throw new Error(`${label}.extra_args must be an array`);
  }

  return {
    bin: typeof value.bin === 'string' && value.bin.trim() ? expandHomePath(value.bin.trim()) : undefined,
    model: typeof value.model === 'string' && value.model.trim() ? value.model.trim() : undefined,
    extraArgs: extraArgs.map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error(`${label}.extra_args must contain only strings`);
      }
      return entry;
    }),
  };
}

function normalizeNetworkConfig(raw: unknown): NetworkConfig {
  const value = (raw || {}) as Record<string, unknown>;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('network must be a table');
  }

  const proxyUrl = typeof value.proxy_url === 'string' && value.proxy_url.trim()
    ? value.proxy_url.trim()
    : undefined;
  const noProxy = typeof value.no_proxy === 'string' && value.no_proxy.trim()
    ? value.no_proxy.trim()
    : undefined;

  return {
    proxyUrl,
    noProxy,
  };
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<Config> {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = parseToml(raw);

  const telegram = (parsed.telegram || {}) as Record<string, unknown>;
  const bridge = (parsed.bridge || {}) as Record<string, unknown>;
  const agents = (parsed.agents || {}) as Record<string, unknown>;
  const network = parsed.network || {};

  if (!telegram.bot_token || typeof telegram.bot_token !== 'string') {
    throw new Error('telegram.bot_token is required');
  }

  if (!Array.isArray(telegram.allowed_user_ids) || telegram.allowed_user_ids.length === 0) {
    throw new Error('telegram.allowed_user_ids must be a non-empty array');
  }

  const allowedUserIds = coerceStringArray(telegram.allowed_user_ids, 'telegram.allowed_user_ids');
  const defaultAgent = (bridge.default_agent as string) || 'claude';
  if (!VALID_AGENTS.includes(defaultAgent)) {
    throw new Error(`bridge.default_agent must be one of: ${VALID_AGENTS.join(', ')}`);
  }

  if (!bridge.working_dir || typeof bridge.working_dir !== 'string') {
    throw new Error('bridge.working_dir is required');
  }

  const enabledAgents = (agents.enabled as string[]) ?? VALID_AGENTS;
  if (!isStringArray(enabledAgents)) {
    throw new Error('agents.enabled must be an array of strings');
  }
  for (const agent of enabledAgents) {
    if (!VALID_AGENTS.includes(agent)) {
      throw new Error(`Unsupported agent in agents.enabled: ${agent}`);
    }
  }
  if (!enabledAgents.includes(defaultAgent)) {
    throw new Error('bridge.default_agent must be included in agents.enabled');
  }

  const replyChunkChars = Number((bridge.reply_chunk_chars as number) ?? 500);
  const replyFlushMs = Number((bridge.reply_flush_ms as number) ?? 1500);
  const pollTimeoutSeconds = Number((bridge.poll_timeout_seconds as number) ?? 30);
  const maxInputImageMb = Number((bridge.max_input_image_mb as number) ?? 20);
  const allowImageDocuments = bridge.allow_image_documents !== false;

  if (!Number.isInteger(replyChunkChars) || replyChunkChars <= 0) {
    throw new Error('bridge.reply_chunk_chars must be a positive integer');
  }
  if (!Number.isInteger(replyFlushMs) || replyFlushMs <= 0) {
    throw new Error('bridge.reply_flush_ms must be a positive integer');
  }
  if (!Number.isInteger(pollTimeoutSeconds) || pollTimeoutSeconds <= 0 || pollTimeoutSeconds > 50) {
    throw new Error('bridge.poll_timeout_seconds must be an integer between 1 and 50');
  }
  if (!Number.isFinite(maxInputImageMb) || maxInputImageMb <= 0) {
    throw new Error('bridge.max_input_image_mb must be a positive number');
  }

  return {
    configPath,
    stateDir: defaultStateDir(),
    systemdUserDir: defaultSystemdUserDir(),
    ...(os.platform() === 'darwin' ? { launchAgentDir: defaultLaunchAgentDir() } : {}),
    telegram: {
      botToken: telegram.bot_token,
      allowedUserIds,
    },
    bridge: {
      defaultAgent,
      workingDir: expandHomePath(bridge.working_dir),
      replyChunkChars,
      replyFlushMs,
      pollTimeoutSeconds,
      maxInputImageMb,
      allowImageDocuments,
    },
    network: normalizeNetworkConfig(network),
    agents: {
      enabled: enabledAgents,
      claude: normalizeAgentConfig(agents.claude, 'agents.claude'),
      codex: normalizeAgentConfig(agents.codex, 'agents.codex'),
      neovate: normalizeAgentConfig(agents.neovate, 'agents.neovate'),
      opencode: normalizeAgentConfig(agents.opencode, 'agents.opencode'),
    },
  };
}

export function resolveAgentBinary(config: Config, agent: string): string | null {
  const envOverride = process.env[agentBinEnvName(agent)];
  if (typeof envOverride === 'string' && envOverride.trim()) {
    return expandHomePath(envOverride.trim());
  }

  const configured = (config.agents[agent] as AgentConfig)?.bin;
  if (configured) {
    return configured;
  }

  return which(agent);
}

export function applyRuntimeEnvironment(config: Config): void {
  if (config.network?.proxyUrl) {
    process.env.HTTP_PROXY = config.network.proxyUrl;
    process.env.HTTPS_PROXY = config.network.proxyUrl;
    process.env.ALL_PROXY = config.network.proxyUrl;
    process.env.http_proxy = config.network.proxyUrl;
    process.env.https_proxy = config.network.proxyUrl;
    process.env.all_proxy = config.network.proxyUrl;
  }

  if (config.network?.noProxy) {
    process.env.NO_PROXY = config.network.noProxy;
    process.env.no_proxy = config.network.noProxy;
  }
}
