import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  buildCommandSpec,
  parseClaudeLine,
  parseCodexLine,
  parseNeovateLine,
  parseOpencodeLine,
  streamAgentTurn,
} from '../src/providers.js';

test('parseClaudeLine handles real stream-json output', () => {
  const state = {};

  const initEvents = parseClaudeLine(
    '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"761ef4dd-31dd-442d-8783-ba8272bc0cb7"}',
    state,
  );
  assert.deepEqual(initEvents, [{ type: 'session_started', sessionId: '761ef4dd-31dd-442d-8783-ba8272bc0cb7' }]);

  const deltaEvents = parseClaudeLine(
    '{"type":"stream_event","event":{"delta":{"text":"OK.","type":"text_delta"},"index":0,"type":"content_block_delta"}}',
    state,
  );
  assert.deepEqual(deltaEvents, [{ type: 'partial_text', text: 'OK.' }]);

  const resultEvents = parseClaudeLine(
    '{"type":"result","subtype":"success","result":"OK.","session_id":"761ef4dd-31dd-442d-8783-ba8272bc0cb7"}',
    state,
  );
  assert.deepEqual(resultEvents, [{ type: 'final_text', text: 'OK.' }]);
});

test('parseCodexLine handles real jsonl output', () => {
  const state = {};

  assert.deepEqual(
    parseCodexLine('{"type":"thread.started","thread_id":"019cd144-49ea-73c2-8391-85d717718690"}', state),
    [{ type: 'session_started', sessionId: '019cd144-49ea-73c2-8391-85d717718690' }],
  );

  assert.deepEqual(
    parseCodexLine('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}', state),
    [{ type: 'partial_text', text: 'OK' }],
  );

  assert.deepEqual(
    parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}', state),
    [{ type: 'final_text', text: 'OK' }],
  );
});

test('parseNeovateLine handles real stream-json output', () => {
  const state = {};

  assert.deepEqual(
    parseNeovateLine('{"type":"system","subtype":"init","sessionId":"e92c215c"}', state),
    [{ type: 'session_started', sessionId: 'e92c215c' }],
  );

  assert.deepEqual(parseNeovateLine(
    '{"parentUuid":"5a9d8a0d","uuid":"ef2faef9","role":"assistant","content":[{"type":"text","text":"OK"}],"text":"OK","type":"message","sessionId":"e92c215c"}',
    state,
  ), []);

  assert.deepEqual(parseNeovateLine(
    '{"type":"result","subtype":"success","isError":false,"content":"OK","sessionId":"e92c215c"}',
    state,
  ), [{ type: 'final_text', text: 'OK' }]);
});

test('buildCommandSpec uses configured binaries and correct flags', () => {
  const config = {
    agents: {
      claude: { bin: '/bin/claude', model: 'model-a', extraArgs: ['--foo'] },
      codex: { bin: '/bin/codex', model: 'model-b', extraArgs: ['--bar'] },
      neovate: { bin: '/bin/neovate', model: 'model-c', extraArgs: ['--baz'] },
      opencode: { bin: '/bin/opencode', model: 'model-d', extraArgs: ['--qux'] },
    },
  };

  const claude = buildCommandSpec(config, 'claude', 'prompt', '/tmp/work', 'session-1');
  assert.deepEqual(claude.args.slice(0, 8), [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    'acceptEdits',
    '--model',
  ]);
  assert.equal(claude.args.at(-1), 'prompt');

  const codex = buildCommandSpec(config, 'codex', 'prompt', '/tmp/work', 'session-2');
  assert.equal(codex.command, '/bin/codex');
  assert.deepEqual(codex.args.slice(0, 3), ['exec', 'resume', 'session-2']);
  assert.equal(codex.cwd, '/tmp/work');
  assert.equal(codex.args.includes('--cd'), false);

  const freshCodex = buildCommandSpec(config, 'codex', 'prompt', '/tmp/work', null);
  assert.deepEqual(freshCodex.args.slice(0, 4), ['exec', '--json', '--full-auto', '--skip-git-repo-check']);
  assert.equal(freshCodex.args.includes('--cd'), false);

  const neovate = buildCommandSpec(config, 'neovate', 'prompt', '/tmp/work', null);
  assert.equal(neovate.command, '/bin/neovate');
  assert.deepEqual(neovate.args.slice(0, 6), ['-q', '--output-format', 'stream-json', '--approval-mode', 'autoEdit', '--cwd']);
});

test('parseOpencodeLine handles JSON event stream', () => {
  const state = {};

  assert.deepEqual(
    parseOpencodeLine('{"type":"step_start","sessionID":"ses_abc123","part":{"type":"step-start"}}', state),
    [{ type: 'session_started', sessionId: 'ses_abc123' }],
  );

  assert.deepEqual(
    parseOpencodeLine('{"type":"text","sessionID":"ses_abc123","part":{"type":"text","text":"Hello"}}', state),
    [{ type: 'partial_text', text: 'Hello' }],
  );

  assert.deepEqual(
    parseOpencodeLine('{"type":"text","sessionID":"ses_abc123","part":{"type":"text","text":" world"}}', state),
    [{ type: 'partial_text', text: ' world' }],
  );

  assert.deepEqual(
    parseOpencodeLine('{"type":"step_finish","sessionID":"ses_abc123","part":{"type":"step-finish"}}', state),
    [{ type: 'final_text', text: 'Hello world' }],
  );
});

test('buildCommandSpec builds correct opencode args', () => {
  const config = {
    agents: {
      opencode: { bin: '/bin/opencode', model: 'anthropic/claude-sonnet', extraArgs: ['--verbose'] },
    },
  };

  const spec = buildCommandSpec(config, 'opencode', 'prompt', '/tmp/work', 'ses_abc');
  assert.equal(spec.command, '/bin/opencode');
  assert.deepEqual(spec.args, ['run', '--format', 'json', '--model', 'anthropic/claude-sonnet', '--session', 'ses_abc', '--verbose', 'prompt']);
  assert.equal(spec.cwd, '/tmp/work');

  const fresh = buildCommandSpec(config, 'opencode', 'prompt', '/tmp/work', null);
  assert.deepEqual(fresh.args, ['run', '--format', 'json', '--model', 'anthropic/claude-sonnet', '--verbose', 'prompt']);
});

test('streamAgentTurn turns synchronous spawn failures into error events', async () => {
  const config = {
    agents: {
      enabled: ['claude'],
      claude: { bin: process.execPath, model: undefined, extraArgs: [] },
      codex: { bin: undefined, model: undefined, extraArgs: [] },
      neovate: { bin: undefined, model: undefined, extraArgs: [] },
      opencode: { bin: undefined, model: undefined, extraArgs: [] },
    },
  };
  const missingDir = path.join(os.tmpdir(), `cac-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const events = [];

  for await (const event of streamAgentTurn({
    config: config as never,
    agent: 'claude',
    prompt: 'hi',
    workingDir: missingDir,
    upstreamSessionId: null,
  })) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].message || '', /(ENOENT|execution failed|spawn)/);
});
