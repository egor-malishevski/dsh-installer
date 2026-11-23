import { existsSync } from 'node:fs';
import { isAbsolute, join, delimiter, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { gitlabGrants, gitlabPackage, gitlabServer } from './gitlab.js';

const packages = {
  bitbucket: ['@nexus2520/bitbucket-mcp-server@4.0.0', 'bitbucket-mcp-server'],
  kibana: ['@tocharianou/mcp-server-kibana@0.11.1', 'mcp-server-kibana'],
  gitlab: [`${gitlabPackage.name}@${gitlabPackage.version}`, gitlabPackage.bin],
  figma: ['figma-developer-mcp@0.13.2', 'figma-developer-mcp'],
};
const bb = ['get_pull_request', 'get_pull_request_diff', 'get_file_content', 'grep', 'search_code', 'search_repositories'];
// Verified against agent-device listMcpCommandMetadata. Scout/observe + minimal
// interaction for native QA. Intentionally omits install/reinstall/install-from-source,
// settings, batch, swipe/click/gesture/longpress, record/trace/push/replay/test, etc.
const agentDeviceScout = ['devices', 'boot', 'open', 'snapshot', 'screenshot', 'logs', 'appstate', 'find'];
const agentDeviceInteract = ['apps', 'press', 'fill', 'type', 'get', 'is', 'wait', 'close', 'scroll', 'back', 'alert', 'keyboard'];
const agentDeviceTesterTools = [...agentDeviceScout, ...agentDeviceInteract];
export const AGENT_DEVICE_SCOUT_TOOLS = Object.freeze([...agentDeviceScout]);
export const AGENT_DEVICE_INTERACT_TOOLS = Object.freeze([...agentDeviceInteract]);
export const AGENT_DEVICE_TESTER_TOOLS = Object.freeze([...agentDeviceTesterTools]);
const grants = {
  bitbucket: { oracle: bb, fixer: bb, librarian: ['get_file_content', 'search_code', 'search_repositories'] },
  jira: {
    oracle: ['jira_get_issue', 'jira_search'],
    fixer: ['jira_get_issue', 'jira_search'],
    designer: ['jira_get_issue', 'jira_search'],
    tester: ['jira_get_issue'],
  },
  confluence: {
    oracle: ['confluence_search', 'confluence_get_page', 'confluence_get_page_children'],
    fixer: ['confluence_search', 'confluence_get_page', 'confluence_get_page_children'],
    designer: ['confluence_search', 'confluence_get_page', 'confluence_get_page_children'],
    librarian: ['confluence_search', 'confluence_get_page', 'confluence_get_page_children'],
    tester: ['confluence_search', 'confluence_get_page'],
  },
  kibana: { oracle: ['get_status', 'check_dashboard_health'] },
  figma: { designer: ['get_figma_data'] },
  'agent-device': { tester: agentDeviceTesterTools },
};
const googleTools = ['get_sheet_data', 'get_sheet_formulas', 'list_sheets', 'get_multiple_sheet_data', 'get_multiple_spreadsheet_summary', 'get_spreadsheet_info', 'list_spreadsheets', 'list_folders', 'search_spreadsheets', 'find_in_spreadsheet'];
const MCP_IDS = ['bitbucket', 'gitlab', 'kibana', 'jira', 'confluence', 'google-sheets', 'figma', 'agent-device'];

function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('MCP URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('MCP URL must use HTTPS without credentials, query, or fragment.');
  return url.toString().replace(/\/$/, '');
}
function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be an absolute path.`);
  return value;
}

/** Resolve agent-device.mjs without hardcoding developer home/nvm paths. */
export function detectAgentDeviceCli({ cliPath, pathEnv = process.env.PATH || '', home = homedir(), requireFrom = process.cwd() } = {}) {
  const candidates = [];
  if (typeof cliPath === 'string' && cliPath.trim()) candidates.push(cliPath.trim());
  try {
    const req = createRequire(join(requireFrom, 'package.json'));
    candidates.push(req.resolve('agent-device/bin/agent-device.mjs'));
  } catch { /* optional */ }
  try {
    const req = createRequire(join(requireFrom, 'package.json'));
    const pkg = dirname(req.resolve('agent-device/package.json'));
    candidates.push(join(pkg, 'bin/agent-device.mjs'));
  } catch { /* optional */ }
  for (const dir of String(pathEnv).split(delimiter).filter(Boolean)) {
    candidates.push(join(dir, 'agent-device.mjs'));
    // Global npm layout: <prefix>/bin/agent-device → sibling lib/node_modules/...
    const parent = dirname(dir);
    candidates.push(join(parent, 'lib/node_modules/agent-device/bin/agent-device.mjs'));
  }
  if (typeof home === 'string' && home) {
    candidates.push(join(home, '.local/lib/node_modules/agent-device/bin/agent-device.mjs'));
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isAbsolute(candidate) && !candidate.includes('\0') && existsSync(candidate)) return candidate;
  }
  return null;
}

function androidPlatformTools(home) {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    home ? join(home, 'Library/Android/sdk') : null,
    home ? join(home, 'Android/Sdk') : null,
  ].filter(Boolean);
  for (const root of roots) {
    const tools = join(root, 'platform-tools');
    if (existsSync(tools)) return tools;
  }
  return null;
}

function agentDevicePathEnv(nodeBinDir, home) {
  const parts = [nodeBinDir, '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const platformTools = androidPlatformTools(home);
  if (platformTools) parts.push(platformTools);
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

export function generateMcps(config, { targetHome, runtimePaths = {}, agentDeviceCli, workspaceDir } = {}) {
  absolute(targetHome, 'Target home');
  if (!Array.isArray(config?.mcps)) throw new Error('MCP selections are required.');
  const rows = [], files = [], requirements = [], sharedMcpTools = {}, secretExpressions = {};
  const seen = new Set();
  const data = (...parts) => join(targetHome, '.dsh', 'data', ...parts);
  const secret = (name, value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
    const path = `.dsh/secrets/installer/${name}`;
    const marker = `__DSH_SECRET_${name}__`;
    files.push({ path, content: value.trim() + '\n', secret: true });
    secretExpressions[marker] = `process.getBuiltinModule('fs').readFileSync(${JSON.stringify(join(targetHome, path))},'utf8').trim()`;
    return marker;
  };
  for (const selection of config.mcps) {
    const { id, values = {} } = selection;
    if (seen.has(id) || !MCP_IDS.includes(id)) throw new Error('Invalid MCP selection.');
    seen.add(id);

    // Optional agent-device: tester grants always when selected; server row only if CLI found.
    if (id === 'agent-device') {
      const cli = agentDeviceCli !== undefined
        ? agentDeviceCli
        : detectAgentDeviceCli({ cliPath: values.cliPath, home: targetHome });
      const roleGrants = grants[id];
      for (const [role, tools] of Object.entries(roleGrants || {})) {
        if (!tools.length) continue;
        (sharedMcpTools[role] ||= []).push(...tools.map(tool => `mcp__${id}__${tool}`));
      }
      if (!cli) {
        requirements.push('WARNING: agent-device CLI not found; tester tool grants were recorded but mcp-agent-device server row was skipped.');
        continue;
      }
      const adapter = join(targetHome, '.dsh/bundles/dsh-integrations/lib/agent-device-mcp-adapter.mjs');
      const nodeBin = dirname(process.execPath);
      const stateDir = workspaceDir
        ? join(absolute(workspaceDir, 'Workspace'), '.agent-device')
        : join(targetHome, '.dsh/data/agent-device');
      rows.push({
        id: 'mcp-agent-device',
        name: 'dsh-integrations/mcp-client',
        config: {
          transport: 'stdio',
          serverName: 'agent-device',
          command: process.execPath,
          args: [adapter, cli, 'mcp'],
          env: {
            PATH: agentDevicePathEnv(nodeBin, targetHome),
            AGENT_DEVICE_STATE_DIR: stateDir,
            AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
          },
          toolCallTimeoutMs: 300000,
        },
      });
      continue;
    }

    const runtime = packages[id] ? 'npx' : ['jira', 'confluence', 'google-sheets'].includes(id) ? 'uvx' : null;
    if (runtime && (typeof runtimePaths[runtime] !== 'string' || !isAbsolute(runtimePaths[runtime]) || runtimePaths[runtime].includes('\0'))) {
      requirements.push(`BLOCKER: ${runtime} is required for ${id}.`);
      continue;
    }
    let command = runtime && runtimePaths[runtime], args = [], env = {}, timeout;
    if (packages[id]) {
      args = ['--yes', `--package=${packages[id][0]}`, packages[id][1]];
      requirements.push(`WARNING: ${packages[id][0]} may require network access on first launch.`);
    }
    if (id === 'bitbucket') env = { BITBUCKET_BASE_URL: httpsUrl(values.url), BITBUCKET_USERNAME: values.username, BITBUCKET_TOKEN: secret('bitbucket-token', values.token) };
    if (id === 'kibana') env = { KIBANA_URL: httpsUrl(values.url), KIBANA_USERNAME: values.username, KIBANA_PASSWORD: secret('kibana-password', values.password) };
    if (id === 'figma') {
      args.push('--stdio');
      env = { FIGMA_API_KEY: secret('figma-api-key', values.apiKey) };
      timeout = 120000;
    }
    if (id === 'gitlab') env = gitlabServer({ url: values.url, executable: command, tokenReference: secret('gitlab-token', values.token) }).config.env;
    if (id === 'jira' || id === 'confluence') {
      const prefix = id.toUpperCase();
      args = ['mcp-atlassian@0.23.1'];
      env = { [`${prefix}_URL`]: httpsUrl(values.url), [`${prefix}_PERSONAL_TOKEN`]: secret(`${id}-token`, values.token), [`${prefix}_SSL_VERIFY`]: 'true' };
      timeout = 120000;
      requirements.push('WARNING: mcp-atlassian@0.23.1 may require network access on first launch.');
    }
    if (id === 'google-sheets') {
      args = ['--with', 'mcp<2', 'mcp-google-sheets@0.6.3'];
      const token = values.tokenPath ? absolute(values.tokenPath, 'Google token path') : data('google', 'token.json');
      env = { CREDENTIALS_PATH: absolute(values.credentialsPath, 'Google credentials path'), TOKEN_PATH: token, SERVICE_ACCOUNT_PATH: '', ENABLED_TOOLS: googleTools.join(',') };
      if (!values.tokenPath) files.push({ path: '.dsh/data/google/.gitkeep', content: '', secret: false });
      timeout = 120000;
      requirements.push('WARNING: mcp-google-sheets@0.6.3 may require network access on first launch.');
    }
    rows.push({ id: `mcp-${id}`, name: 'dsh-integrations/mcp-client', config: { transport: 'stdio', serverName: id, command, args, env, ...(timeout ? { toolCallTimeoutMs: timeout } : {}) } });
    const roleGrants = id === 'gitlab' ? gitlabGrants : grants[id];
    for (const [role, tools] of Object.entries(roleGrants || {})) {
      if (!tools.length) continue;
      (sharedMcpTools[role] ||= []).push(...tools.map(tool => id === 'gitlab' ? tool : `mcp__${id}__${tool}`));
    }
  }
  return { rows, files, sharedMcpTools, requirements, secretExpressions };
}
