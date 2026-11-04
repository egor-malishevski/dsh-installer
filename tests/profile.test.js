import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { roles } from '../lib/config.js';
import { generateProfile } from '../lib/profile.js';

const config = { roles: structuredClone(roles), apiKey: 'private-key-test', apiUrl: 'https://private.example/v1', mcps: [] };
const options = { targetHome: '/home/example "quoted"', sharedMcpTools: { oracle: ['mcp__jira__jira_get_issue'] } };

test('generates fresh profile with exact routes and scoped shared grants', () => {
  const files = generateProfile(config, options);
  assert.equal(files.length, 2);
  assert.ok(files.every(file => file.secret === false));
  const pkg = JSON.parse(files[0].content);
  assert.equal(pkg.dependencies['dsh-integrations'], 'link:../../bundles/dsh-integrations');
  assert.equal(pkg.dependencies['dsh-web-search-multi'], 'link:../../plugins/dsh-web-search-multi');
  assert.ok(pkg.dsh.profile.bundles.indexOf('dsh-web-search-multi') < pkg.dsh.profile.bundles.indexOf('dsh-integrations'));
  const content = files[1].content;
  assert.doesNotMatch(content, /private-key-test|private\.example|alfagen/i);
  const json = content.replace(/!!js ("(?:\\.|[^"\\])*")/, '$1');
  const rows = JSON.parse(json);
  assert.deepEqual(rows.find(row => row.id === 'agent-default-model').config, { provider: 'cliproxy', model: 'claude-opus-5-5' });
  const provider = rows.find(row => row.id === 'llm-pi-ai').config.providers.cliproxy;
  assert.equal(provider.baseURL, 'http://127.0.0.1:18317/v1');
  assert.match(provider.headers.Authorization, /installer\/cliproxy-key/);
  assert.equal(provider.models[0].id, 'claude-opus-5-5');
  for (const model of provider.models) assert.deepEqual(model.input, ['text', 'image'], model.id);
  const slim = rows.find(row => row.id === 'oh-my-dsh-slim').config;
  assert.deepEqual(slim.orchestrator, { effort: 'high' });
  assert.deepEqual(slim.roles.oracle.sharedMcpTools, ['mcp__jira__jira_get_issue']);
  assert.equal(slim.roles.explorer.provider, 'cliproxy');
  assert.equal(slim.roles.librarian.effort, undefined);
  assert.equal(slim.roles.observer, undefined);
});

test('rejects invalid shared grants and relay ports', () => {
  assert.throws(() => generateProfile(config, { targetHome: '/home/a', sharedMcpTools: { oracle: ['mcp__jira__*'] } }));
  assert.throws(() => generateProfile(config, { targetHome: '/home/a', sharedMcpTools: { oracle: ['mcp__jira__foo__bar'] } }));
  assert.throws(() => generateProfile({ ...config, roles: { ...config.roles, main: { model: 'other/custom' } } }, { targetHome: '/home/a' }));
  assert.throws(() => generateProfile(config, { targetHome: '/home/a', relayPort: 0 }));
});

test('native profile loader and slim schema accept generated patch', { skip: !process.env.DSH_HOST_MODULES || !process.env.OMDS_HOST_SCHEMA || !process.env.OMDS_PLUGIN_DIR }, async t => {
  const root = pathToFileURL(process.env.DSH_HOST_MODULES.replace(/\/$/, '') + '/').href;
  const { readProfilePatches } = await import(root + '@deepseek-ai/dsh-app-boot/lib/index.js');
  const { buildConfigSchema } = await import(pathToFileURL(path.join(process.env.OMDS_PLUGIN_DIR, 'lib/config-settings.js')).href);
  const { default: z } = await import(pathToFileURL(process.env.OMDS_HOST_SCHEMA).href);
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-profile-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  await mkdir(home);
  const patchPath = path.join(dir, 'cordis.patch.yml');
  await writeFile(patchPath, generateProfile(config, options)[1].content);
  const patches = readProfilePatches('fixture', { dir, home, patchPath, overlays: [] }, { layers: [] });
  const provider = patches.find(row => row.id === 'llm-pi-ai').config.providers.cliproxy;
  assert.match(provider.headers.Authorization.__jsExpr, /installer\/cliproxy-key/);
  assert.deepEqual(patches.find(row => row.id === 'agent-default-model').config, { provider: 'cliproxy', model: 'claude-opus-5-5' });
  const slim = patches.find(row => row.id === 'oh-my-dsh-slim').config;
  const schema = z(JSON.parse(JSON.stringify(buildConfigSchema(z))));
  const parsed = schema(structuredClone(slim));
  assert.ok(parsed);
  const normalized = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value]));
  assert.equal(normalized.roles.oracle.model, 'gpt-6.1-sol');
  assert.deepEqual(normalized.roles.oracle.sharedMcpTools, ['mcp__jira__jira_get_issue']);
  assert.equal(slim.roles.oracle.sharedMcpTools[0], 'mcp__jira__jira_get_issue');
});
