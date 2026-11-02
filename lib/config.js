import path from 'node:path';

const field = (key, label, { secret = false, required = true, placeholder = '' } = {}) => ({ key, label, secret, required, placeholder });
const url = field('url', 'Server URL', { placeholder: 'https://example.com' });
const token = field('token', 'Token', { secret: true });
const user = field('username', 'Username');
export const mcps = [
  { id: 'bitbucket', label: 'Bitbucket', description: 'Connect to Bitbucket.', fields: [url, user, token] },
  { id: 'gitlab', label: 'GitLab', description: 'Alternative to Bitbucket. Use a token with read permissions as described in the server documentation.', fields: [url, token] },
  { id: 'kibana', label: 'Kibana', description: 'Connect to Kibana.', fields: [url, user, field('password', 'Password', { secret: true })] },
  { id: 'jira', label: 'Jira', description: 'Connect to Jira.', fields: [url, token] },
  { id: 'confluence', label: 'Confluence', description: 'Connect to Confluence.', fields: [url, token] },
  { id: 'obscura', label: 'Obscura', description: 'Requires a separately installed compatible binary.', fields: [field('binaryPath', 'Binary path')] },
  { id: 'memory', label: 'Memory', description: 'Create a new local memory store.', fields: [] },
  { id: 'google-sheets', label: 'Google Sheets', description: 'Connect using Google OAuth credentials and a token file.', fields: [field('credentialsPath', 'OAuth credentials JSON path'), field('tokenPath', 'OAuth token JSON path', { required: false })] },
  { id: 'sequential-thinking', label: 'Sequential thinking', description: 'Local reasoning tools.', fields: [] },
];
export const roles = {
  orchestrator: { model: '', effort: 'high' },
  oracle: { model: 'cliproxy/gpt-6.1-sol', effort: 'high' },
  designer: { model: 'cliproxy/claude-sonnet-5-5', effort: 'medium' },
  fixer: { model: 'cliproxy/claude-sonnet-5-5', effort: 'medium' },
  explorer: { model: 'deepseek-account/deepseek-flash', effort: 'low' },
  librarian: { model: 'cliproxy/grok-4.7', effort: '' },
  main: { model: 'cliproxy/claude-opus-5-5', effort: '' },
};
export function normalizeApiUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('API URL is required.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('API URL is invalid.'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('API URL must not contain credentials, query, or fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw new Error('Use HTTPS, or HTTP for localhost only.');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/(?:\/v1)+$/, '') + '/v1';
  return parsed.toString().replace(/\/$/, '');
}
export function normalizeGitLabUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('GitLab URL is invalid.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('GitLab URL is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/', '/api/v4', '/api/v4/'].includes(parsed.pathname)) throw new Error('GitLab URL must be an HTTPS origin or its /api/v4 endpoint, without credentials, query, or fragment.');
  parsed.pathname = '/api/v4';
  return parsed.toString();
}
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuration is required.');
  const apiUrl = normalizeApiUrl(config.apiUrl);
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 16384 || /[\x00-\x1f\x7f]/.test(config.apiKey)) throw new Error('API key must be nonempty and contain no control characters.');
  if (!Array.isArray(config.mcps) || !config.roles || typeof config.roles !== 'object' || Array.isArray(config.roles)) throw new Error('MCP and role selections are required.');
  if (config.mcps.length > mcps.length || Object.keys(config.roles).some(name => !Object.hasOwn(roles, name))) throw new Error('Invalid MCP or role selections.');
  const seen = new Set();
  for (const selection of config.mcps) {
    const spec = mcps.find(m => m.id === selection?.id);
    if (!spec || seen.has(spec.id) || Object.keys(selection).some(key => !['id', 'values'].includes(key)) || !selection.values || typeof selection.values !== 'object' || Array.isArray(selection.values) || Object.keys(selection.values).some(key => !spec.fields.some(f => f.key === key))) throw new Error('Invalid MCP selection.');
    seen.add(spec.id);
    for (const f of spec.fields) {
      const value = selection.values[f.key];
      if (value === undefined && !Object.hasOwn(selection.values, f.key) && !f.required) continue;
      if (typeof value !== 'string' || (f.required && !value.trim()) || value.length > 65536 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${spec.label}: ${f.label} is invalid.`);
      if (['binaryPath', 'credentialsPath', 'tokenPath'].includes(f.key) && value && !path.isAbsolute(value)) throw new Error(`${spec.label}: ${f.label} must be an absolute path.`);
      if (f.key === 'url' && spec.id !== 'gitlab') {
        let parsed;
        try { parsed = new URL(value); } catch { throw new Error(`${spec.label}: Server URL is invalid.`); }
        if (value !== value.trim() || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${spec.label}: Server URL must use HTTPS without credentials, query, or fragment.`);
      }
    }
    if (spec.id === 'gitlab') normalizeGitLabUrl(selection.values.url);
  }
  for (const name of Object.keys(roles)) {
    const role = config.roles[name];
    if (!role || typeof role !== 'object' || Array.isArray(role) || Object.keys(role).some(key => !['model', 'effort'].includes(key)) || typeof role.model !== 'string' || typeof role.effort !== 'string' || role.model.length > 200 || !['', 'off', 'low', 'medium', 'high'].includes(role.effort)) throw new Error(`Invalid ${name} role.`);
    if (name === 'orchestrator') {
      if (role.model !== '') throw new Error('Orchestrator model override is not supported; use an empty model to inherit.');
    } else if (!/^(?:cliproxy|deepseek-account)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(role.model)) throw new Error(`Invalid ${name} model route.`);
    if (name === 'main' && role.effort !== '') throw new Error('Main role effort is not supported; leave it empty.');
    if (role.model === 'cliproxy/grok-4.7' && role.effort !== '') throw new Error(`Invalid ${name} effort for Grok.`);
  }
  return { apiUrl };
}
