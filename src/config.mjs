import fs from 'node:fs/promises';
import path from 'node:path';
import { parseToml } from './toml.mjs';
import {
  coerceStringArray,
  expandHomePath,
  isStringArray,
  which,
} from './utils.mjs';

export const VALID_AGENTS = ['claude', 'codex', 'neovate'];

export function defaultConfigPath() {
  return expandHomePath(process.env.CAC_CONFIG_PATH || '~/.code-agent-contect/config.toml');
}

export function defaultStateDir() {
  return expandHomePath(process.env.CAC_STATE_DIR || '~/.local/state/code-agent-connect');
}

export function defaultSystemdUserDir() {
  return expandHomePath('~/.config/systemd/user');
}

export function agentBinEnvName(agent) {
  return `CAC_${agent.toUpperCase()}_BIN`;
}

function normalizeAgentConfig(raw, label) {
  const value = raw || {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  const extraArgs = value.extra_args ?? [];
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

function normalizeNetworkConfig(raw) {
  const value = raw || {};
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

export async function loadConfig(configPath = defaultConfigPath()) {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = parseToml(raw);

  const telegram = parsed.telegram || {};
  const bridge = parsed.bridge || {};
  const agents = parsed.agents || {};
  const network = parsed.network || {};

  if (!telegram.bot_token || typeof telegram.bot_token !== 'string') {
    throw new Error('telegram.bot_token is required');
  }

  if (!Array.isArray(telegram.allowed_user_ids) || telegram.allowed_user_ids.length === 0) {
    throw new Error('telegram.allowed_user_ids must be a non-empty array');
  }

  const allowedUserIds = coerceStringArray(telegram.allowed_user_ids, 'telegram.allowed_user_ids');
  const defaultAgent = bridge.default_agent || 'claude';
  if (!VALID_AGENTS.includes(defaultAgent)) {
    throw new Error(`bridge.default_agent must be one of: ${VALID_AGENTS.join(', ')}`);
  }

  if (!bridge.working_dir || typeof bridge.working_dir !== 'string') {
    throw new Error('bridge.working_dir is required');
  }

  const enabledAgents = agents.enabled ?? VALID_AGENTS;
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

  const replyChunkChars = Number(bridge.reply_chunk_chars ?? 500);
  const replyFlushMs = Number(bridge.reply_flush_ms ?? 1500);
  const pollTimeoutSeconds = Number(bridge.poll_timeout_seconds ?? 30);

  if (!Number.isInteger(replyChunkChars) || replyChunkChars <= 0) {
    throw new Error('bridge.reply_chunk_chars must be a positive integer');
  }
  if (!Number.isInteger(replyFlushMs) || replyFlushMs <= 0) {
    throw new Error('bridge.reply_flush_ms must be a positive integer');
  }
  if (!Number.isInteger(pollTimeoutSeconds) || pollTimeoutSeconds <= 0 || pollTimeoutSeconds > 50) {
    throw new Error('bridge.poll_timeout_seconds must be an integer between 1 and 50');
  }

  return {
    configPath,
    stateDir: defaultStateDir(),
    systemdUserDir: defaultSystemdUserDir(),
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
    },
    network: normalizeNetworkConfig(network),
    agents: {
      enabled: enabledAgents,
      claude: normalizeAgentConfig(agents.claude, 'agents.claude'),
      codex: normalizeAgentConfig(agents.codex, 'agents.codex'),
      neovate: normalizeAgentConfig(agents.neovate, 'agents.neovate'),
    },
  };
}

export function resolveAgentBinary(config, agent) {
  const envOverride = process.env[agentBinEnvName(agent)];
  if (typeof envOverride === 'string' && envOverride.trim()) {
    return expandHomePath(envOverride.trim());
  }

  const configured = config.agents[agent]?.bin;
  if (configured) {
    return configured;
  }

  return which(agent);
}

export function applyRuntimeEnvironment(config) {
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
