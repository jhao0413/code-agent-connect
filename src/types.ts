export type AgentName = 'claude' | 'codex' | 'neovate' | 'opencode';

export interface AgentConfig {
  bin: string | undefined;
  model: string | undefined;
  extraArgs: string[];
}

export interface NetworkConfig {
  proxyUrl: string | undefined;
  noProxy: string | undefined;
}

export interface Config {
  configPath: string;
  stateDir: string;
  systemdUserDir: string;
  launchAgentDir?: string;
  telegram: {
    botToken: string;
    allowedUserIds: string[];
  };
  bridge: {
    defaultAgent: string;
    workingDir: string;
    replyChunkChars: number;
    replyFlushMs: number;
    pollTimeoutSeconds: number;
    maxInputImageMb: number;
    allowImageDocuments: boolean;
  };
  network: NetworkConfig;
  agents: {
    enabled: string[];
    claude: AgentConfig;
    codex: AgentConfig;
    neovate: AgentConfig;
    opencode: AgentConfig;
    [key: string]: AgentConfig | string[];
  };
}

export interface Session {
  id: string;
  telegramUserId: string;
  activeAgent: string;
  workingDir: string | null;
  providerSessionIds: Record<string, string | null>;
  providerWorkingDirs: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramState {
  offset: number;
}

export interface AgentEvent {
  type: 'session_started' | 'partial_text' | 'final_text' | 'error';
  sessionId?: string;
  text?: string;
  message?: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
}

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  errored: boolean;
}

export interface CheckResult {
  ok: boolean;
  output: string;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  behind: number;
}

export interface ImageInfo {
  fileId: string;
  mimeType: string;
  fileSize: number;
  width: number | undefined;
  height: number | undefined;
  sourceName: string;
}

export interface Attachment {
  kind: 'image';
  mimeType: string;
  telegramFileId: string;
  localPath: string;
  localDir: string;
  sourceName: string;
  width: number | undefined;
  height: number | undefined;
  sizeBytes: number;
}

export interface TelegramClientOptions {
  fetchImpl?: typeof globalThis.fetch;
  proxyUrl?: string;
}

export interface StreamAgentTurnParams {
  config: Config;
  agent: string;
  prompt: string;
  attachments?: Attachment[];
  workingDir: string;
  upstreamSessionId: string | null;
}

export interface LingerStatus {
  available: boolean;
  enabled: boolean;
}

export interface RenderServiceParams {
  config: Config;
  projectRoot: string;
  nodePath: string;
  resolvedBins: Record<string, string>;
  environmentPath: string;
}

export interface TranscriptEntry {
  direction: string;
  agent?: string;
  text?: string;
  type?: string;
  partialText?: string;
  finalText?: string;
  errors?: string[];
  attachments?: Array<{
    kind: string;
    mimeType: string;
    sourceName: string;
    sizeBytes: number;
    width?: number;
    height?: number;
  }>;
}

// Parser state for agent output parsers
export interface ParserState {
  sessionId?: string;
  partialText?: string;
  finalText?: string;
  emittedFinal?: boolean;
  assistantText?: string;
  messageText?: string;
}

export interface TelegramCommand {
  command: string;
  description: string;
}
