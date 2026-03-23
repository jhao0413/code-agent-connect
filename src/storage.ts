import crypto from 'node:crypto';
import path from 'node:path';
import {
  appendLine,
  cloneJson,
  ensureDir,
  nowIso,
  readJson,
  writeJsonAtomic,
} from './utils.js';
import type {
  PlatformName,
  Session,
  TelegramState,
  TranscriptEntry,
  WeixinCredential,
  WeixinCursorState,
  WeixinTypingTicketState,
} from './types.js';

function emptyProviderSessionIds(): Record<string, string | null> {
  return {
    claude: null,
    codex: null,
    neovate: null,
    opencode: null,
  };
}

function emptyProviderWorkingDirs(): Record<string, string | null> {
  return {
    claude: null,
    codex: null,
    neovate: null,
    opencode: null,
  };
}

function normalizeSession(session: Session): Session {
  if (!session) {
    return session;
  }

  const providerSessionIds: Record<string, string | null> = {
    ...emptyProviderSessionIds(),
    ...(session.providerSessionIds || {}),
  };
  const providerWorkingDirs: Record<string, string | null> = {
    ...emptyProviderWorkingDirs(),
    ...(session.providerWorkingDirs || {}),
  };

  // Older sessions only stored a single workingDir. Reuse it as a best-effort
  // provider cwd hint so future cwd changes can decide whether a provider
  // session should be resumed or restarted.
  if (session.workingDir && !(session as unknown as Record<string, unknown>).providerWorkingDirs) {
    for (const [agent, sessionId] of Object.entries(providerSessionIds)) {
      if (sessionId && !providerWorkingDirs[agent]) {
        providerWorkingDirs[agent] = session.workingDir;
      }
    }
  }

  return {
    ...session,
    userId: session.userId || session.telegramUserId,
    workingDir: session.workingDir || null,
    providerSessionIds,
    providerWorkingDirs,
  };
}

export class StateStore {
  initialized: boolean;
  stateDir: string;
  sessionsFile: string;
  activeFile: string;
  telegramFile: string;
  weixinCredentialsFile: string;
  weixinCursorsFile: string;
  weixinContextTokensFile: string;
  weixinTypingTicketsFile: string;
  transcriptsDir: string;
  sessions: Record<string, Session>;
  activeSessions: Record<string, string>;
  telegramState: TelegramState;
  weixinCredentials: {
    activeAccountId: string | null;
    accounts: Record<string, WeixinCredential>;
  };
  weixinCursors: Record<string, WeixinCursorState>;
  weixinContextTokens: Record<string, string>;
  weixinTypingTickets: Record<string, WeixinTypingTicketState>;

  constructor(stateDir: string) {
    this.initialized = false;
    this.stateDir = stateDir;
    this.sessionsFile = path.join(stateDir, 'sessions.json');
    this.activeFile = path.join(stateDir, 'active-session.json');
    this.telegramFile = path.join(stateDir, 'telegram-state.json');
    this.weixinCredentialsFile = path.join(stateDir, 'weixin-credentials.json');
    this.weixinCursorsFile = path.join(stateDir, 'weixin-cursors.json');
    this.weixinContextTokensFile = path.join(stateDir, 'weixin-context-tokens.json');
    this.weixinTypingTicketsFile = path.join(stateDir, 'weixin-typing-tickets.json');
    this.transcriptsDir = path.join(stateDir, 'transcripts');
    this.sessions = {};
    this.activeSessions = {};
    this.telegramState = { offset: 0 };
    this.weixinCredentials = { activeAccountId: null, accounts: {} };
    this.weixinCursors = {};
    this.weixinContextTokens = {};
    this.weixinTypingTickets = {};
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await ensureDir(this.stateDir);
    await ensureDir(this.transcriptsDir);
    this.sessions = await readJson(this.sessionsFile, {});
    this.activeSessions = await readJson(this.activeFile, {});
    this.telegramState = await readJson(this.telegramFile, { offset: 0 });
    this.weixinCredentials = await readJson(this.weixinCredentialsFile, { activeAccountId: null, accounts: {} });
    this.weixinCursors = await readJson(this.weixinCursorsFile, {});
    this.weixinContextTokens = await readJson(this.weixinContextTokensFile, {});
    this.weixinTypingTickets = await readJson(this.weixinTypingTicketsFile, {});
    this.initialized = true;
  }

  async persistSessions(): Promise<void> {
    await writeJsonAtomic(this.sessionsFile, this.sessions);
  }

  async persistActiveSessions(): Promise<void> {
    await writeJsonAtomic(this.activeFile, this.activeSessions);
  }

  async persistTelegramState(): Promise<void> {
    await writeJsonAtomic(this.telegramFile, this.telegramState);
  }

  async persistWeixinCredentials(): Promise<void> {
    await writeJsonAtomic(this.weixinCredentialsFile, this.weixinCredentials);
  }

  async persistWeixinCursors(): Promise<void> {
    await writeJsonAtomic(this.weixinCursorsFile, this.weixinCursors);
  }

  async persistWeixinContextTokens(): Promise<void> {
    await writeJsonAtomic(this.weixinContextTokensFile, this.weixinContextTokens);
  }

  async persistWeixinTypingTickets(): Promise<void> {
    await writeJsonAtomic(this.weixinTypingTicketsFile, this.weixinTypingTickets);
  }

  getTelegramOffset(): number {
    return Number(this.telegramState.offset || 0);
  }

  async setTelegramOffset(offset: number): Promise<void> {
    this.telegramState.offset = offset;
    await this.persistTelegramState();
  }

  getSessionById(sessionId: string): Session | null {
    const session = this.sessions[sessionId];
    return session ? cloneJson(normalizeSession(session)) : null;
  }

  getActiveSession(userId: string): Session | null {
    const sessionId = this.activeSessions[userId];
    return sessionId ? this.getSessionById(sessionId) : null;
  }

  listActiveSessions(): Array<{ ownerId: string; session: Session }> {
    const entries: Array<{ ownerId: string; session: Session }> = [];
    for (const [ownerId, sessionId] of Object.entries(this.activeSessions)) {
      const session = this.getSessionById(sessionId);
      if (session) {
        entries.push({ ownerId, session });
      }
    }
    return entries;
  }

  async createSession(
    userId: string,
    activeAgent: string,
    workingDir: string | null = null,
    platform: PlatformName = 'telegram',
  ): Promise<Session> {
    const session = normalizeSession({
      id: crypto.randomUUID(),
      userId,
      telegramUserId: userId,
      platform,
      activeAgent,
      workingDir,
      providerSessionIds: emptyProviderSessionIds(),
      providerWorkingDirs: emptyProviderWorkingDirs(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    this.sessions[session.id] = session;
    this.activeSessions[userId] = session.id;
    await this.persistSessions();
    await this.persistActiveSessions();
    return cloneJson(session);
  }

  async ensureActiveSession(
    userId: string,
    activeAgent: string,
    workingDir: string | null = null,
    platform: PlatformName = 'telegram',
  ): Promise<Session> {
    return this.getActiveSession(userId) || this.createSession(userId, activeAgent, workingDir, platform);
  }

  async saveSession(session: Session): Promise<Session> {
    const updated = normalizeSession({
      ...session,
      updatedAt: nowIso(),
    });
    this.sessions[updated.id] = cloneJson(updated);
    await this.persistSessions();
    return cloneJson(updated);
  }

  async replaceActiveSession(
    userId: string,
    activeAgent: string,
    workingDir: string | null = null,
    platform: PlatformName = 'telegram',
  ): Promise<Session> {
    return this.createSession(userId, activeAgent, workingDir, platform);
  }

  async setActiveAgent(userId: string, agent: string): Promise<Session> {
    const session = this.getActiveSession(userId);
    if (!session) {
      return this.createSession(userId, agent);
    }
    session.activeAgent = agent;
    await this.saveSession(session);
    return session;
  }

  async setWorkingDir(userId: string, activeAgent: string, workingDir: string): Promise<Session> {
    const session = this.getActiveSession(userId);
    if (!session) {
      return this.createSession(userId, activeAgent, workingDir);
    }
    if (session.workingDir !== workingDir) {
      session.providerSessionIds[activeAgent] = null;
      session.providerWorkingDirs[activeAgent] = null;
    }
    session.workingDir = workingDir;
    await this.saveSession(session);
    return session;
  }

  async appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void> {
    const filePath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    const record = {
      timestamp: nowIso(),
      ...entry,
    };
    await appendLine(filePath, JSON.stringify(record));
  }

  getActiveWeixinCredential(): WeixinCredential | null {
    const accountId = this.weixinCredentials.activeAccountId;
    if (!accountId) {
      return null;
    }
    return cloneJson(this.weixinCredentials.accounts[accountId] || null);
  }

  getWeixinCredential(accountId: string): WeixinCredential | null {
    return cloneJson(this.weixinCredentials.accounts[accountId] || null);
  }

  async saveWeixinCredential(credential: WeixinCredential): Promise<void> {
    this.weixinCredentials.accounts[credential.accountId] = cloneJson(credential);
    this.weixinCredentials.activeAccountId = credential.accountId;
    await this.persistWeixinCredentials();
  }

  async clearWeixinRuntime(accountId: string): Promise<void> {
    delete this.weixinCursors[accountId];
    await this.persistWeixinCursors();

    const ownerPrefix = `weixin:${accountId}:`;
    for (const key of Object.keys(this.weixinContextTokens)) {
      if (key.startsWith(`${accountId}:`)) {
        delete this.weixinContextTokens[key];
      }
    }
    await this.persistWeixinContextTokens();

    for (const key of Object.keys(this.weixinTypingTickets)) {
      if (key.startsWith(`${accountId}:`)) {
        delete this.weixinTypingTickets[key];
      }
    }
    await this.persistWeixinTypingTickets();

    const removedSessionIds = new Set<string>();
    for (const [ownerId, sessionId] of Object.entries(this.activeSessions)) {
      if (ownerId.startsWith(ownerPrefix)) {
        removedSessionIds.add(sessionId);
        delete this.activeSessions[ownerId];
      }
    }
    for (const sessionId of removedSessionIds) {
      delete this.sessions[sessionId];
    }
    for (const [sessionId, session] of Object.entries(this.sessions)) {
      const ownerId = session.userId || session.telegramUserId || '';
      if (ownerId.startsWith(ownerPrefix)) {
        delete this.sessions[sessionId];
      }
    }
    await this.persistSessions();
    await this.persistActiveSessions();
  }

  async clearWeixinCredential(accountId: string): Promise<void> {
    delete this.weixinCredentials.accounts[accountId];
    if (this.weixinCredentials.activeAccountId === accountId) {
      this.weixinCredentials.activeAccountId = null;
    }
    await this.persistWeixinCredentials();
    await this.clearWeixinRuntime(accountId);
  }

  getWeixinCursor(accountId: string): WeixinCursorState | null {
    return cloneJson(this.weixinCursors[accountId] || null);
  }

  async setWeixinCursor(accountId: string, getUpdatesBuf: string, longpollingTimeoutMs?: number): Promise<void> {
    this.weixinCursors[accountId] = {
      getUpdatesBuf,
      longpollingTimeoutMs,
    };
    await this.persistWeixinCursors();
  }

  weixinContextTokenKey(accountId: string, userId: string): string {
    return `${accountId}:${userId}`;
  }

  getWeixinContextToken(accountId: string, userId: string): string | null {
    return this.weixinContextTokens[this.weixinContextTokenKey(accountId, userId)] || null;
  }

  async setWeixinContextToken(accountId: string, userId: string, contextToken: string): Promise<void> {
    this.weixinContextTokens[this.weixinContextTokenKey(accountId, userId)] = contextToken;
    await this.persistWeixinContextTokens();
  }

  getWeixinTypingTicket(accountId: string, userId: string): WeixinTypingTicketState | null {
    return cloneJson(this.weixinTypingTickets[this.weixinContextTokenKey(accountId, userId)] || null);
  }

  async setWeixinTypingTicket(accountId: string, userId: string, ticket: WeixinTypingTicketState): Promise<void> {
    this.weixinTypingTickets[this.weixinContextTokenKey(accountId, userId)] = cloneJson(ticket);
    await this.persistWeixinTypingTickets();
  }
}
