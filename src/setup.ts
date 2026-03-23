import os from 'node:os';
import { VALID_AGENTS, defaultConfigPath } from './config.js';
import { fileExists, which, writeFileAtomic } from './utils.js';
import { Prompt } from './prompt.js';
import { generateConfigToml, type ConfigData } from './toml-writer.js';

const INSTALL_HINTS: Record<string, string> = {
  claude: os.platform() === 'win32'
    ? 'https://claude.ai/download  (or: npm install -g @anthropic-ai/claude-code)'
    : 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm install -g @openai/codex',
  neovate: 'npm i @neovate/code -g',
  opencode: 'npm i -g opencode-ai',
};

interface DetectedAgent {
  name: string;
  path: string | null;
}

function detectAgents(): DetectedAgent[] {
  return VALID_AGENTS.map((name) => ({ name, path: which(name) }));
}

export async function runSetup(): Promise<void> {
  const prompt = new Prompt();
  await prompt.init();

  try {
    // Step 0: check existing config
    const configPath = defaultConfigPath();
    if (await fileExists(configPath)) {
      const overwrite = await prompt.confirm(`Config already exists at ${configPath}. Overwrite?`, false);
      if (!overwrite) {
        console.log('Aborted.');
        return;
      }
    }

    // Step 1: detect agents
    console.log('\nDetecting agents...');
    const detected = detectAgents();
    const maxLen = Math.max(...detected.map((a) => a.name.length));
    for (const agent of detected) {
      const padded = agent.name.padEnd(maxLen);
      if (agent.path) {
        console.log(`  ✓ ${padded}  → ${agent.path}`);
      } else {
        console.log(`  ✗ ${padded}  — install: ${INSTALL_HINTS[agent.name]}`);
      }
    }

    // Step 2: choose which agents to enable
    const installed = detected.filter((a) => a.path);
    const defaultEnabled = installed.map((a) => a.name);

    let enabledAgents: string[];
    if (installed.length === 0) {
      console.log('\nNo agents detected. You can still configure them manually.');
      const raw = await prompt.ask(`Enter agents to enable (${VALID_AGENTS.join(', ')})`);
      enabledAgents = raw.split(',').map((s) => s.trim()).filter((s) => VALID_AGENTS.includes(s));
      if (enabledAgents.length === 0) {
        console.log('No valid agents selected. Aborted.');
        return;
      }
    } else {
      console.log(`\nAgents to enable: ${defaultEnabled.join(', ')}`);
      const ok = await prompt.confirm('Use these?', true);
      if (ok) {
        enabledAgents = defaultEnabled;
      } else {
        const raw = await prompt.ask(`Enter agents to enable (${VALID_AGENTS.join(', ')})`);
        enabledAgents = raw.split(',').map((s) => s.trim()).filter((s) => VALID_AGENTS.includes(s));
        if (enabledAgents.length === 0) {
          console.log('No valid agents selected. Aborted.');
          return;
        }
      }
    }

    // default agent
    let defaultAgent: string;
    if (enabledAgents.includes('claude')) {
      defaultAgent = 'claude';
    } else {
      defaultAgent = enabledAgents[0];
    }
    console.log(`Default agent: ${defaultAgent}`);

    // Step 3: platform config
    console.log('');
    const telegramEnabled = await prompt.confirm('Enable Telegram?', true);
    let botToken = '';
    let allowedUserIds: string[] = [];
    if (telegramEnabled) {
      botToken = await prompt.ask('Telegram bot_token');
      if (!botToken) {
        console.log('bot_token is required when Telegram is enabled. Aborted.');
        return;
      }

      const userIdsRaw = await prompt.ask('Telegram allowed_user_ids (comma-separated)');
      if (!userIdsRaw) {
        console.log('allowed_user_ids is required when Telegram is enabled. Aborted.');
        return;
      }
      allowedUserIds = userIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const weixinEnabled = await prompt.confirm('Enable Weixin iLink Bot?', false);
    if (!telegramEnabled && !weixinEnabled) {
      console.log('At least one platform must be enabled. Aborted.');
      return;
    }

    // Step 4: working directory
    const workingDir = await prompt.ask('Working directory', process.cwd());

    // Step 5: proxy (optional)
    const proxyUrl = await prompt.ask('Proxy URL (optional, e.g. http://127.0.0.1:7890, leave blank to skip)');

    // Build agent bins map
    const agentBins: Record<string, string> = {};
    for (const agent of enabledAgents) {
      const found = detected.find((d) => d.name === agent);
      if (found?.path) {
        agentBins[agent] = found.path;
      }
    }

    // Step 6: summary and write
    const data: ConfigData = {
      telegramEnabled,
      botToken: botToken || undefined,
      allowedUserIds,
      weixinEnabled,
      weixinChannelVersion: '1.0.0',
      defaultAgent,
      workingDir,
      enabledAgents,
      agentBins,
      proxyUrl: proxyUrl || undefined,
    };

    const toml = generateConfigToml(data);
    console.log(`\n--- ${configPath} ---`);
    console.log(toml);

    const ok = await prompt.confirm('Write config?', true);
    if (!ok) {
      console.log('Aborted.');
      return;
    }

    await writeFileAtomic(configPath, toml);
    console.log(`Config written to ${configPath}`);
    if (weixinEnabled) {
      console.log('Run `code-agent-connect weixin login` to authorize the Weixin account.');
    }
    console.log('Run `code-agent-connect doctor` to verify.');
  } finally {
    prompt.close();
  }
}
