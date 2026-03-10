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
import type { Session, TelegramState, TranscriptEntry } from './types.js';

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
    workingDir: session.workingDir || null,
    providerSessionIds,
    providerWorkingDirs,
  };
}

export class StateStore {
  stateDir: string;
  sessionsFile: string;
  activeFile: string;
  telegramFile: string;
  transcriptsDir: string;
  sessions: Record<string, Session>;
  activeSessions: Record<string, string>;
  telegramState: TelegramState;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.sessionsFile = path.join(stateDir, 'sessions.json');
    this.activeFile = path.join(stateDir, 'active-session.json');
    this.telegramFile = path.join(stateDir, 'telegram-state.json');
    this.transcriptsDir = path.join(stateDir, 'transcripts');
    this.sessions = {};
    this.activeSessions = {};
    this.telegramState = { offset: 0 };
  }

  async init(): Promise<void> {
    await ensureDir(this.stateDir);
    await ensureDir(this.transcriptsDir);
    this.sessions = await readJson(this.sessionsFile, {});
    this.activeSessions = await readJson(this.activeFile, {});
    this.telegramState = await readJson(this.telegramFile, { offset: 0 });
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

  async createSession(userId: string, activeAgent: string, workingDir: string | null = null): Promise<Session> {
    const session = normalizeSession({
      id: crypto.randomUUID(),
      telegramUserId: userId,
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

  async ensureActiveSession(userId: string, activeAgent: string, workingDir: string | null = null): Promise<Session> {
    return this.getActiveSession(userId) || this.createSession(userId, activeAgent, workingDir);
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

  async replaceActiveSession(userId: string, activeAgent: string, workingDir: string | null = null): Promise<Session> {
    return this.createSession(userId, activeAgent, workingDir);
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
}
