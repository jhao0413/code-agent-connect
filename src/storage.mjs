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

function emptyProviderWorkingDirs() {
  return {
    claude: null,
    codex: null,
    neovate: null,
  };
}

function normalizeSession(session) {
  if (!session) {
    return session;
  }

  const providerSessionIds = {
    ...emptyProviderSessionIds(),
    ...(session.providerSessionIds || {}),
  };
  const providerWorkingDirs = {
    ...emptyProviderWorkingDirs(),
    ...(session.providerWorkingDirs || {}),
  };

  // Older sessions only stored a single workingDir. Reuse it as a best-effort
  // provider cwd hint so future cwd changes can decide whether a provider
  // session should be resumed or restarted.
  if (session.workingDir && !session.providerWorkingDirs) {
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
    return session ? cloneJson(normalizeSession(session)) : null;
  }

  getActiveSession(userId) {
    const sessionId = this.activeSessions[userId];
    return sessionId ? this.getSessionById(sessionId) : null;
  }

  async createSession(userId, activeAgent, workingDir = null) {
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

  async ensureActiveSession(userId, activeAgent, workingDir = null) {
    return this.getActiveSession(userId) || this.createSession(userId, activeAgent, workingDir);
  }

  async saveSession(session) {
    const updated = normalizeSession({
      ...session,
      updatedAt: nowIso(),
    });
    this.sessions[updated.id] = cloneJson(updated);
    await this.persistSessions();
    return cloneJson(updated);
  }

  async replaceActiveSession(userId, activeAgent, workingDir = null) {
    return this.createSession(userId, activeAgent, workingDir);
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

  async setWorkingDir(userId, activeAgent, workingDir) {
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

  async appendTranscript(sessionId, entry) {
    const filePath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    const record = {
      timestamp: nowIso(),
      ...entry,
    };
    await appendLine(filePath, JSON.stringify(record));
  }
}
