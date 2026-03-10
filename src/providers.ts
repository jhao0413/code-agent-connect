import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveAgentBinary } from './config.js';
import { toErrorMessage } from './utils.js';
import type { AgentConfig, AgentEvent, Attachment, CommandSpec, Config, ParserState, StreamAgentTurnParams } from './types.js';

export function parseClaudeLine(line: string, state: ParserState = {}): AgentEvent[] {
  const data = JSON.parse(line);
  const events: AgentEvent[] = [];

  if (data.type === 'system' && data.subtype === 'init' && data.session_id) {
    state.sessionId = data.session_id;
    events.push({ type: 'session_started', sessionId: data.session_id });
  }

  if (
    data.type === 'stream_event' &&
    data.event?.type === 'content_block_delta' &&
    data.event?.delta?.type === 'text_delta' &&
    data.event.delta.text
  ) {
    state.partialText = `${state.partialText || ''}${data.event.delta.text}`;
    events.push({ type: 'partial_text', text: data.event.delta.text });
  }

  if (data.type === 'result' && data.subtype === 'success' && typeof data.result === 'string') {
    state.finalText = data.result;
    state.emittedFinal = true;
    events.push({ type: 'final_text', text: data.result });
  }

  if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
    const text = data.message.content
      .filter((entry: { type: string }) => entry.type === 'text')
      .map((entry: { text: string }) => entry.text)
      .join('');
    if (text) {
      state.assistantText = text;
    }
  }

  if (data.type === 'error' || data.is_error) {
    events.push({ type: 'error', message: data.message || data.result || 'Claude command failed' });
  }

  return events;
}

export function parseCodexLine(line: string, state: ParserState = {}): AgentEvent[] {
  const data = JSON.parse(line);
  const events: AgentEvent[] = [];

  if (data.type === 'thread.started' && data.thread_id) {
    state.sessionId = data.thread_id;
    events.push({ type: 'session_started', sessionId: data.thread_id });
  }

  if (data.type === 'item.completed' && data.item?.type === 'agent_message' && data.item.text) {
    const prefix = state.finalText ? '\n\n' : '';
    state.partialText = `${state.partialText || ''}${prefix}${data.item.text}`;
    state.finalText = `${state.finalText || ''}${prefix}${data.item.text}`;
    events.push({ type: 'partial_text', text: `${prefix}${data.item.text}` });
  }

  if (data.type === 'turn.completed' && state.finalText) {
    state.emittedFinal = true;
    events.push({ type: 'final_text', text: state.finalText });
  }

  if (data.type === 'error' || data.type === 'turn.failed') {
    events.push({ type: 'error', message: data.message || 'Codex command failed' });
  }

  return events;
}

export function parseNeovateLine(line: string, state: ParserState = {}): AgentEvent[] {
  const data = JSON.parse(line);
  const events: AgentEvent[] = [];

  if (data.type === 'system' && data.subtype === 'init' && data.sessionId) {
    state.sessionId = data.sessionId;
    events.push({ type: 'session_started', sessionId: data.sessionId });
  }

  if (data.type === 'message' && data.role === 'assistant' && data.text) {
    state.messageText = data.text;
  }

  if (data.type === 'result' && data.subtype === 'success') {
    const text = data.content || state.messageText;
    if (text) {
      state.finalText = text;
      state.emittedFinal = true;
      events.push({ type: 'final_text', text });
    }
  }

  if (data.type === 'error' || data.isError) {
    events.push({ type: 'error', message: data.message || data.content || 'Neovate command failed' });
  }

  return events;
}

export function parseOpencodeLine(line: string, state: ParserState = {}): AgentEvent[] {
  const data = JSON.parse(line);
  const events: AgentEvent[] = [];

  if (data.type === 'step_start' && data.sessionID) {
    state.sessionId = data.sessionID;
    events.push({ type: 'session_started', sessionId: data.sessionID });
  }

  if (data.type === 'text' && data.part?.type === 'text' && data.part.text) {
    state.partialText = `${state.partialText || ''}${data.part.text}`;
    events.push({ type: 'partial_text', text: data.part.text });
  }

  if (data.type === 'step_finish') {
    if (state.partialText) {
      state.finalText = state.partialText;
      state.emittedFinal = true;
      events.push({ type: 'final_text', text: state.partialText });
    }
  }

  if (data.type === 'error' || data.is_error) {
    events.push({ type: 'error', message: data.message || data.part?.text || 'OpenCode command failed' });
  }

  return events;
}

function getParser(agent: string): (line: string, state: ParserState) => AgentEvent[] {
  if (agent === 'claude') {
    return parseClaudeLine;
  }
  if (agent === 'codex') {
    return parseCodexLine;
  }
  if (agent === 'neovate') {
    return parseNeovateLine;
  }
  if (agent === 'opencode') {
    return parseOpencodeLine;
  }
  throw new Error(`Unsupported agent: ${agent}`);
}

function buildClaudeArgs(agentConfig: AgentConfig, prompt: string, upstreamSessionId: string | null): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    'acceptEdits',
  ];
  if (agentConfig.model) {
    args.push('--model', agentConfig.model);
  }
  if (upstreamSessionId) {
    args.push('--resume', upstreamSessionId);
  }
  args.push(...agentConfig.extraArgs);
  args.push(prompt);
  return args;
}

function buildCodexArgs(agentConfig: AgentConfig, prompt: string, _workingDir: string, upstreamSessionId: string | null, attachments: Attachment[] = []): string[] {
  const args = ['exec'];
  if (upstreamSessionId) {
    args.push('resume', upstreamSessionId);
  }
  // `codex exec resume` does not accept `--cd`; rely on the spawned process cwd instead.
  args.push('--json', '--full-auto', '--skip-git-repo-check');
  if (agentConfig.model) {
    args.push('--model', agentConfig.model);
  }
  for (const att of attachments) {
    if (att.kind === 'image' && att.localPath) {
      args.push('--image', att.localPath);
    }
  }
  args.push(...agentConfig.extraArgs);
  args.push(prompt);
  return args;
}

function buildNeovateArgs(agentConfig: AgentConfig, prompt: string, workingDir: string, upstreamSessionId: string | null): string[] {
  const args = [
    '-q',
    '--output-format',
    'stream-json',
    '--approval-mode',
    'autoEdit',
    '--cwd',
    workingDir,
  ];
  if (agentConfig.model) {
    args.push('--model', agentConfig.model);
  }
  if (upstreamSessionId) {
    args.push('--resume', upstreamSessionId);
  }
  args.push(...agentConfig.extraArgs);
  args.push(prompt);
  return args;
}

function buildOpencodeArgs(agentConfig: AgentConfig, prompt: string, upstreamSessionId: string | null): string[] {
  const args = ['run', '--format', 'json'];
  if (agentConfig.model) {
    args.push('--model', agentConfig.model);
  }
  if (upstreamSessionId) {
    args.push('--session', upstreamSessionId);
  }
  args.push(...agentConfig.extraArgs);
  args.push(prompt);
  return args;
}

export function buildCommandSpec(config: Config, agent: string, prompt: string, workingDir: string, upstreamSessionId: string | null, attachments: Attachment[] = []): CommandSpec {
  const command = resolveAgentBinary(config, agent);
  if (!command) {
    throw new Error(`Cannot resolve ${agent} binary`);
  }

  const agentConfig = config.agents[agent] as AgentConfig;
  if (agent === 'claude') {
    return { command, args: buildClaudeArgs(agentConfig, prompt, upstreamSessionId), cwd: workingDir };
  }
  if (agent === 'codex') {
    return { command, args: buildCodexArgs(agentConfig, prompt, workingDir, upstreamSessionId, attachments), cwd: workingDir };
  }
  if (agent === 'neovate') {
    return { command, args: buildNeovateArgs(agentConfig, prompt, workingDir, upstreamSessionId), cwd: workingDir };
  }
  if (agent === 'opencode') {
    return { command, args: buildOpencodeArgs(agentConfig, prompt, upstreamSessionId), cwd: workingDir };
  }
  throw new Error(`Unsupported agent: ${agent}`);
}

const IMAGE_UNSUPPORTED_AGENTS = new Set(['claude', 'neovate', 'opencode']);

export async function* streamAgentTurn({ config, agent, prompt, attachments = [], workingDir, upstreamSessionId }: StreamAgentTurnParams): AsyncGenerator<AgentEvent> {
  const hasImages = attachments.length > 0 && attachments.some((a) => a.kind === 'image');

  if (hasImages && IMAGE_UNSUPPORTED_AGENTS.has(agent)) {
    yield {
      type: 'final_text',
      text: `Image input is not yet supported for ${agent}. Please switch to codex with /use codex to process images.`,
    };
    return;
  }

  const spec = buildCommandSpec(config, agent, prompt, workingDir, upstreamSessionId, attachments);
  const parser = getParser(agent);
  const parserState: ParserState = {};

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const closePromise = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: number | null) => resolve(code ?? 0));
  });

  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let parsedEvents: AgentEvent[];
      try {
        parsedEvents = parser(line, parserState);
      } catch (error) {
        yield {
          type: 'error',
          message: `Failed to parse ${agent} output: ${toErrorMessage(error)}`,
        };
        continue;
      }
      for (const event of parsedEvents) {
        yield event;
      }
    }

    const exitCode = await closePromise;
    if (!parserState.emittedFinal && parserState.finalText) {
      yield { type: 'final_text', text: parserState.finalText };
    } else if (!parserState.emittedFinal && parserState.assistantText) {
      yield { type: 'final_text', text: parserState.assistantText };
    } else if (!parserState.emittedFinal && parserState.messageText) {
      yield { type: 'final_text', text: parserState.messageText };
    }

    if (exitCode !== 0) {
      yield {
        type: 'error',
        message: stderr.trim() || `${agent} exited with code ${exitCode}`,
      };
    }
  } catch (error) {
    child.kill('SIGTERM');
    yield {
      type: 'error',
      message: `${agent} execution failed: ${toErrorMessage(error)}`,
    };
  }
}
