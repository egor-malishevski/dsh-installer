import { isAbsolute, join } from 'node:path';
import { gitlabGrants, gitlabPackage, gitlabServer } from './gitlab.js';

const packages = {
  bitbucket: ['@nexus2520/bitbucket-mcp-server@4.0.0', 'bitbucket-mcp-server'],
  kibana: ['@tocharianou/mcp-server-kibana@0.11.1', 'mcp-server-kibana'],
  memory: ['@modelcontextprotocol/server-memory@2.0.1', 'mcp-server-memory'],
  'sequential-thinking': ['@modelcontextprotocol/server-sequential-thinking@2.0.0', 'mcp-server-sequential-thinking'],
  gitlab: [`${gitlabPackage.name}@${gitlabPackage.version}`, gitlabPackage.bin],
};
const bb = ['get_pull_request', 'get_pull_request_diff', 'get_file_content', 'grep', 'search_code', 'search_repositories'];
const grants = {
  bitbucket: { oracle: bb, fixer: bb, librarian: ['get_file_content', 'search_code', 'search_repositories'] },
  jira: { oracle: ['jira_get_issue', 'jira_search'], fixer: ['jira_get_issue', 'jira_search'], designer: ['jira_get_issue', 'jira_search'] },
  confluence: Object.fromEntries(['oracle', 'fixer', 'designer', 'librarian'].map(role => [role, ['confluence_search', 'confluence_get_page', 'confluence_get_page_children']])),
  kibana: { oracle: ['get_status', 'check_dashboard_health'] },
};
const googleTools = ['get_sheet_data', 'get_sheet_formulas', 'list_sheets', 'get_multiple_sheet_data', 'get_multiple_spreadsheet_summary', 'get_spreadsheet_info', 'list_spreadsheets', 'list_folders', 'search_spreadsheets', 'find_in_spreadsheet'];

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

export function generateMcps(config, { targetHome, runtimePaths = {} } = {}) {
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
    if (seen.has(id) || !['bitbucket', 'gitlab', 'kibana', 'jira', 'confluence', 'obscura', 'memory', 'google-sheets', 'sequential-thinking'].includes(id)) throw new Error('Invalid MCP selection.');
    seen.add(id);
    const runtime = packages[id] ? 'npx' : ['jira', 'confluence', 'google-sheets'].includes(id) ? 'uvx' : null;
    if (runtime && (typeof runtimePaths[runtime] !== 'string' || !isAbsolute(runtimePaths[runtime]) || runtimePaths[runtime].includes('\0'))) {
      requirements.push(`BLOCKER: ${runtime} is required for ${id}.`);
      continue;
    }
    if (id === 'memory' || id === 'sequential-thinking') {
      if (runtimePaths.nodeVersion == null) requirements.push(`WARNING: Node.js 24 or newer must be verified for ${id}.`);
      else {
        const match = String(runtimePaths.nodeVersion).match(/^v?(\d+)(?:\.|$)/);
        if (!match) requirements.push(`WARNING: Node.js 24 or newer must be verified for ${id}.`);
        else if (Number(match[1]) < 24) requirements.push(`BLOCKER: Node.js 24 or newer is required for ${id}.`);
      }
    }
    let command = runtime && runtimePaths[runtime], args = [], env = {}, timeout;
    if (packages[id]) {
      args = ['--yes', `--package=${packages[id][0]}`, packages[id][1]];
      requirements.push(`WARNING: ${packages[id][0]} may require network access on first launch.`);
    }
    if (id === 'bitbucket') env = { BITBUCKET_BASE_URL: httpsUrl(values.url), BITBUCKET_USERNAME: values.username, BITBUCKET_TOKEN: secret('bitbucket-token', values.token) };
    if (id === 'kibana') env = { KIBANA_URL: httpsUrl(values.url), KIBANA_USERNAME: values.username, KIBANA_PASSWORD: secret('kibana-password', values.password) };
    if (id === 'gitlab') env = gitlabServer({ url: values.url, executable: command, tokenReference: secret('gitlab-token', values.token) }).config.env;
    if (id === 'memory') {
      env = { MEMORY_FILE_PATH: data('memory', 'data.jsonl') };
      files.push({ path: '.dsh/data/memory/data.jsonl', content: '', secret: false });
    }
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
    if (id === 'obscura') {
      command = absolute(values.binaryPath, 'Obscura binary path');
      args = ['--storage-dir', data('obscura'), 'mcp'];
      files.push({ path: '.dsh/data/obscura/.gitkeep', content: '', secret: false });
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
