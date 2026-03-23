export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

export function tomlStringArray(arr: string[]): string {
  return `[${arr.map(tomlString).join(', ')}]`;
}

export interface ConfigData {
  telegramEnabled: boolean;
  botToken?: string;
  allowedUserIds?: string[];
  weixinEnabled: boolean;
  weixinChannelVersion?: string;
  weixinBaseUrl?: string;
  weixinSkRouteTag?: string;
  defaultAgent: string;
  workingDir: string;
  enabledAgents: string[];
  agentBins: Record<string, string>;
  proxyUrl?: string;
}

export function generateConfigToml(data: ConfigData): string {
  const lines: string[] = [
    '[platforms.telegram]',
    `enabled = ${data.telegramEnabled ? 'true' : 'false'}`,
    `bot_token = ${tomlString(data.botToken || '')}`,
    `allowed_user_ids = ${tomlStringArray(data.allowedUserIds || [])}`,
    '',
    '[platforms.weixin]',
    `enabled = ${data.weixinEnabled ? 'true' : 'false'}`,
    `channel_version = ${tomlString(data.weixinChannelVersion || '1.0.0')}`,
  ];

  if (data.weixinBaseUrl) {
    lines.push(`base_url = ${tomlString(data.weixinBaseUrl)}`);
  }
  if (data.weixinSkRouteTag) {
    lines.push(`sk_route_tag = ${tomlString(data.weixinSkRouteTag)}`);
  }

  lines.push(
    '',
    '[bridge]',
    `default_agent = ${tomlString(data.defaultAgent)}`,
    `working_dir = ${tomlString(data.workingDir)}`,
  );

  if (data.proxyUrl) {
    lines.push('', '[network]', `proxy_url = ${tomlString(data.proxyUrl)}`);
  }

  lines.push(
    '',
    '[agents]',
    `enabled = ${tomlStringArray(data.enabledAgents)}`,
  );

  for (const agent of data.enabledAgents) {
    lines.push('', `[agents.${agent}]`);
    const bin = data.agentBins[agent];
    if (bin) {
      lines.push(`bin = ${tomlString(bin)}`);
    }
    lines.push('model = ""');
  }

  lines.push('');
  return lines.join('\n');
}
