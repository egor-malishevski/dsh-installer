import path from 'node:path';

const specialists = ['oracle', 'designer', 'fixer', 'explorer', 'librarian'];
const claudeEfforts = { off: null, low: 'low', medium: 'medium', high: 'high' };
const gptEfforts = { low: 'low', medium: 'medium', high: 'high' };
const models = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input: ['text', 'image'], reasoningEfforts: claudeEfforts },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', input: ['text', 'image'], reasoningEfforts: claudeEfforts },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', input: ['text', 'image'], reasoningEfforts: claudeEfforts },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', input: ['text'] },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', input: ['text'], reasoningEfforts: gptEfforts },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', input: ['text'], reasoningEfforts: gptEfforts },
  { id: 'grok-4.7', name: 'Grok 4.7', input: ['text'] },
  { id: 'grok-4.7-build-fast', name: 'Grok 4.7 Build Fast', input: ['text'] },
];

function route(value) {
  if (typeof value !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error('Invalid model route.');
  const [provider, model] = value.split('/');
  return { provider, model };
}

export function generateProfile(config, { targetHome, relayPort = 18317, sharedMcpTools = {} } = {}) {
  if (typeof targetHome !== 'string' || !path.isAbsolute(targetHome)) throw new Error('An absolute target home is required.');
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new Error('Invalid relay port.');
  if (!sharedMcpTools || typeof sharedMcpTools !== 'object' || Array.isArray(sharedMcpTools)) throw new Error('Invalid shared MCP tools.');
  for (const [role, tools] of Object.entries(sharedMcpTools)) {
    if (!specialists.includes(role) || !Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !/^mcp__(?!.*__.*__)[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(tool))) throw new Error('Invalid shared MCP tools.');
  }
  const roleOverrides = Object.fromEntries(specialists.map(name => {
    const role = config.roles[name];
    return [name, { ...route(role.model), ...(role.effort ? { effort: role.effort } : {}), ...(sharedMcpTools[name]?.length ? { sharedMcpTools: [...sharedMcpTools[name]] } : {}) }];
  }));
  const secretPath = path.join(targetHome, '.dsh/secrets/installer/cliproxy-key');
  const main = route(config.roles.main.model);
  if (!['cliproxy', 'deepseek-account'].includes(main.provider)) throw new Error('Invalid main model provider.');
  const expression = `'Bearer ' + process.getBuiltinModule('fs').readFileSync(${JSON.stringify(secretPath)}, 'utf8').trim()`;
  const placeholder = '__INSTALLER_AUTHORIZATION_EXPRESSION__';
  const entries = [
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: main },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { cliproxy: { displayName: 'CLIProxyAPI', api: 'openai-completions', baseURL: `http://127.0.0.1:${relayPort}/v1`, headers: { Authorization: placeholder }, models } } } },
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'oh-my-dsh-slim' } },
    { id: 'oh-my-dsh-slim', name: 'oh-my-dsh-slim', config: { orchestrator: { ...(config.roles.orchestrator.effort ? { effort: config.roles.orchestrator.effort } : {}) }, roles: roleOverrides } },
  ];
  const yaml = JSON.stringify(entries, null, 2).replace(JSON.stringify(placeholder), `!!js ${JSON.stringify(expression)}`) + '\n';
  const pkg = { name: 'dsh-profile-desktop', private: true, dependencies: { '@deepseek-ai/dsh-base': '0.2.1-rc.5', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5', 'dsh-integrations': 'link:../../bundles/dsh-integrations', 'oh-my-dsh-slim': 'link:../../plugins/oh-my-dsh-slim' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-integrations', 'oh-my-dsh-slim'] } } };
  return [
    { path: '.dsh/profiles/desktop/package.json', content: JSON.stringify(pkg, null, 2) + '\n', secret: false },
    { path: '.dsh/profiles/desktop/cordis.patch.yml', content: yaml, secret: false },
  ];
}
