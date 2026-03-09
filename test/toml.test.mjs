import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../src/toml.mjs';

test('parseToml supports sections, arrays, and comments', () => {
  const parsed = parseToml(`
    [telegram]
    bot_token = "abc"
    allowed_user_ids = ["1", 2] # inline comment

    [bridge]
    default_agent = "claude"
    reply_chunk_chars = 500
  `);

  assert.deepEqual(parsed.telegram.allowed_user_ids, ['1', 2]);
  assert.equal(parsed.bridge.default_agent, 'claude');
  assert.equal(parsed.bridge.reply_chunk_chars, 500);
});
