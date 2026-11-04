import { access, lstat, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.js';
import { generateProfile, metadataSeed } from './profile.js';

const payload = fileURLToPath(new URL('../payload/', import.meta.url));

async function payloadFiles(directory = '', files = []) {
  const base = path.join(payload, directory);
  for (const name of (await readdir(base)).sort()) {
    const relative = path.join(directory, name);
    const full = path.join(payload, relative);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error('Unsafe payload');
    if (stat.isDirectory()) await payloadFiles(relative, files);
    else if (stat.isFile()) files.push({ path: path.join('.dsh', relative), content: await readFile(full), secret: false });
    else throw new Error('Unsafe payload');
  }
  return files;
}

export async function buildInstallPlan(config, { targetHome, runtimePaths = {}, relayPort, availableModels } = {}) {
  const { apiUrl } = validateConfig(config);
  if (typeof targetHome !== 'string' || !path.isAbsolute(targetHome)) throw new Error('An absolute target home is required.');
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new Error('An explicit relay port is required.');
  const { generateMcps } = await import('./mcps.js');
  const generated = await generateMcps(config, { targetHome, runtimePaths });
  if (!generated || !Array.isArray(generated.rows) || !Array.isArray(generated.files) || !generated.sharedMcpTools || !Array.isArray(generated.requirements) || !generated.secretExpressions) throw new Error('Invalid generated MCP configuration.');
  if (config.mcps.some(m => ['memory', 'sequential-thinking'].includes(m.id)) && (!runtimePaths.npxPath || !/^v?(?:2[4-9]|[3-9]\d|\d{3,})\./.test(runtimePaths.nodeVersion || ''))) generated.requirements.push('BLOCKER: A verified Node.js 24 or newer for npx is required.');
  for (const row of generated.rows) {
    if (row.config.command === runtimePaths.npx && runtimePaths.npxPath) row.config.env.PATH = runtimePaths.npxPath;
    try { await access(row.config.command, constants.X_OK); }
    catch { generated.requirements.push(`BLOCKER: Executable for ${row.id} is unavailable.`); }
  }
  const relay = { id: 'zstd-render', name: path.join(targetHome, '.dsh/plugins/zstd-render/index.js'), config: { port: relayPort, upstream: apiUrl.replace(/\/v1$/, '') } };
  const models = { id: 'cliproxy-models', name: path.join(targetHome, '.dsh/plugins/cliproxy-models/index.js'), config: { provider: 'cliproxy', intervalMs: 300000, timeoutMs: 5000, seed: metadataSeed(availableModels) } };
  const rows = [relay, models, ...generated.rows, { id: 'dsh-integrations', name: 'dsh-integrations' }];
  // Override settings without inserting the search bundle a second time.
  const webSearch = [{ id: 'web-search-exa-parallel', name: 'dsh-web-search-exa-parallel' }, { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'exa-parallel', fetchProvider: 'http' } }];
  let patch = JSON.stringify([{ insert: rows }, ...webSearch], null, 2);
  for (const [marker, expression] of Object.entries(generated.secretExpressions)) {
    if (typeof expression !== 'string' || !marker || !patch.includes(JSON.stringify(marker))) throw new Error('Invalid generated secret expression.');
    patch = patch.split(JSON.stringify(marker)).join(`!!js ${JSON.stringify(expression)}`);
  }
  const files = [
    ...await payloadFiles(),
    { path: '.dsh/bundles/dsh-integrations/cordis.patch.yml', content: patch + '\n', secret: false },
    ...generateProfile(config, { targetHome, relayPort, sharedMcpTools: generated.sharedMcpTools, availableModels }),
    { path: '.dsh/secrets/installer/cliproxy-key', content: config.apiKey.trim() + '\n', secret: true },
    ...generated.files,
  ];
  for (const [name, target] of [['dsh-integrations', '.dsh/bundles/dsh-integrations'], ['dsh-web-search-exa-parallel', '.dsh/plugins/dsh-web-search-exa-parallel'], ['oh-my-dsh-slim', '.dsh/plugins/oh-my-dsh-slim']]) {
    const linkPath = `.dsh/profiles/desktop/node_modules/${name}`;
    files.push({ type: 'symlink', path: linkPath, target: path.relative(path.dirname(linkPath), target) });
  }
  return { targetHome, files, requirements: generated.requirements, apiUrl };
}
