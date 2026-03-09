import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommandSpec,
  parseClaudeLine,
  parseCodexLine,
  parseNeovateLine,
} from '../src/providers.mjs';

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

  const neovate = buildCommandSpec(config, 'neovate', 'prompt', '/tmp/work', null);
  assert.equal(neovate.command, '/bin/neovate');
  assert.deepEqual(neovate.args.slice(0, 6), ['-q', '--output-format', 'stream-json', '--approval-mode', 'autoEdit', '--cwd']);
});
