import test from 'node:test';
import assert from 'node:assert/strict';
import { renderServiceUnit } from '../src/service-manager.js';

test('renderServiceUnit includes resolved env vars and exec start', () => {
  const unit = renderServiceUnit({
    config: {
      configPath: '/home/jhao/.code-agent-contect/config.toml',
      network: {
        proxyUrl: 'http://127.0.0.1:7890',
      },
    },
    projectRoot: '/home/jhao/Projects/code-agent-connect',
    nodePath: '/usr/bin/node',
    resolvedBins: {
      claude: '/home/jhao/.local/bin/claude',
      codex: '/home/jhao/.nvm/bin/codex',
      neovate: '/home/jhao/.nvm/bin/neovate',
    },
    environmentPath: '/usr/bin:/bin',
  });

  assert.match(unit, /Environment="CAC_CLAUDE_BIN=\/home\/jhao\/\.local\/bin\/claude"/);
  assert.match(unit, /Environment="HTTP_PROXY=http:\/\/127\.0\.0\.1:7890"/);
  assert.match(unit, /Environment="NODE_USE_ENV_PROXY=1"/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/jhao\/Projects\/code-agent-connect\/dist\/cli\.js" "serve" "--config" "\/home\/jhao\/\.code-agent-contect\/config\.toml"/);
});
