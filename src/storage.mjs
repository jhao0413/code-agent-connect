import crypto from 'node:crypto';
import path from 'node:path';
import {
  appendLine,
  cloneJson,
  ensureDir,
  nowIso,
  readJson,
  writeJsonAtomic,
} from './utils.mjs';

function emptyProviderSessionIds() {
  return {
    claude: null,
    codex: null,
    neovate: null,
  };
}

export class StateStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.sessionsFile = path.join(stateDir, 'sessions.json');
    this.activeFile = path.join(stateDir, 'active-session.json');
    this.telegramFile = path.join(stateDir, 'telegram-state.json');
    this.transcriptsDir = path.join(stateDir, 'transcripts');
    this.sessions = {};
    this.activeSessions = {};
    this.telegramState = { offset: 0 };
  }

  async init() {
    await ensureDir(this.stateDir);
    await ensureDir(this.transcriptsDir);
    this.sessions = await readJson(this.sessionsFile, {});
    this.activeSessions = await readJson(this.activeFile, {});
    this.telegramState = await readJson(this.telegramFile, { offset: 0 });
  }

  async persistSessions() {
    await writeJsonAtomic(this.sessionsFile, this.sessions);
  }

  async persistActiveSessions() {
    await writeJsonAtomic(this.activeFile, this.activeSessions);
  }

  async persistTelegramState() {
    await writeJsonAtomic(this.telegramFile, this.telegramState);
  }

  getTelegramOffset() {
    return Number(this.telegramState.offset || 0);
  }

  async setTelegramOffset(offset) {
    this.telegramState.offset = offset;
    await this.persistTelegramState();
  }

  getSessionById(sessionId) {
    const session = this.sessions[sessionId];
    return session ? cloneJson(session) : null;
  }

  getActiveSession(userId) {
    const sessionId = this.activeSessions[userId];
    return sessionId ? this.getSessionById(sessionId) : null;
  }

  async createSession(userId, activeAgent) {
    const session = {
      id: crypto.randomUUID(),
      telegramUserId: userId,
      activeAgent,
      providerSessionIds: emptyProviderSessionIds(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.sessions[session.id] = session;
    this.activeSessions[userId] = session.id;
    await this.persistSessions();
    await this.persistActiveSessions();
    return cloneJson(session);
  }

  async ensureActiveSession(userId, activeAgent) {
    return this.getActiveSession(userId) || this.createSession(userId, activeAgent);
  }

  async saveSession(session) {
    const updated = {
      ...session,
      updatedAt: nowIso(),
    };
    this.sessions[updated.id] = cloneJson(updated);
    await this.persistSessions();
    return cloneJson(updated);
  }

  async replaceActiveSession(userId, activeAgent) {
    return this.createSession(userId, activeAgent);
  }

  async setActiveAgent(userId, agent) {
    const session = this.getActiveSession(userId);
    if (!session) {
      return this.createSession(userId, agent);
    }
    session.activeAgent = agent;
    await this.saveSession(session);
    return session;
  }

  async appendTranscript(sessionId, entry) {
    const filePath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    const record = {
      timestamp: nowIso(),
      ...entry,
    };
    await appendLine(filePath, JSON.stringify(record));
  }
}
