import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const hosted = process.env.DSH_HOST_MODULES && process.env.OMDS_HOST_SCHEMA;
const url = p => pathToFileURL(p).href;

test('installed profile resolves and parses in the packaged host without activating plugins', { skip: hosted ? false : 'DSH_HOST_MODULES and OMDS_HOST_SCHEMA are required' }, async t => {
  const source = process.env.DSH_INSTALLER_SOURCE || path.resolve(import.meta.dirname, '..');
  const { roles } = await import(url(path.join(source, 'lib/config.js')));
  const { buildInstallPlan } = await import(url(path.join(source, 'lib/plan.js')));
  const { installPlan } = await import(url(path.join(source, 'lib/install.js')));
  const { gitlabGrants } = await import(url(path.join(source, 'lib/gitlab.js')));
  const modules = process.env.DSH_HOST_MODULES;
  const asar = modules.slice(0, modules.indexOf('/dsh/node_modules'));
  const anchor = path.join(asar, 'dsh/package.json');
  const bootFile = path.join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js');
  const boot = await import(url(bootFile));
  const requireHost = createRequire(bootFile);
  const yaml = await import(url(requireHost.resolve('yaml')));
  const atomic = await import(url(requireHost.resolve('@deepseek-ai/dsh-atomic-write')));
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-installed-host-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = { apiUrl: 'https://example.org/v1', apiKey: 'fake-relay-secret', roles: structuredClone(roles), mcps: [
    { id: 'gitlab', values: { url: 'https://git.example.org', token: 'fake-gitlab-secret' } },
    { id: 'jira', values: { url: 'https://jira.example.org', token: 'fake-jira-secret' } },
    { id: 'memory', values: {} },
    { id: 'figma', values: { apiKey: 'fake-figma-secret' } },
    { id: 'context7', values: {} },
  ] };
  const plan = await buildInstallPlan(config, { targetHome: home, relayPort: 19123, runtimePaths: { npx: '/usr/bin/true', uvx: '/usr/bin/true', nodeVersion: '24.0.0', npxPath: '/usr/bin:/bin' } });
  assert.ok(!plan.requirements.some(r => r.startsWith('BLOCKER:')));
  await installPlan(plan, { checkEnvironment: async () => true, checkStopped: async () => true });
  const dshHome = path.join(home, '.dsh');
  const dir = path.join(dshHome, 'profiles/desktop');
  const integrationDir = path.join(dshHome, 'bundles/dsh-integrations');
  const slimDir = path.join(dshHome, 'plugins/oh-my-dsh-slim');
  const searchDir = path.join(dshHome, 'plugins/dsh-web-search-exa-parallel');
  for (const [name, target] of [['dsh-integrations', integrationDir], ['dsh-web-search-exa-parallel', searchDir], ['oh-my-dsh-slim', slimDir]]) {
    assert.equal(await realpath(path.join(dir, 'node_modules', name)), await realpath(target));
  }
  const bundleNames = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-search-exa-parallel', 'dsh-integrations', 'oh-my-dsh-slim'];
  for (const name of bundleNames) assert.ok(boot.resolveBundleDir('test', name, anchor, dir));
  const profile = boot.loadProfile('test', 'desktop', anchor, dshHome);
  assert.deepEqual(profile.skippedBundles, []);
  assert.deepEqual(profile.layers.map(layer => layer.packageName), bundleNames);
  const patches = boot.readProfilePatches('test', { dir, home: dshHome, patchPath: path.join(dir, 'cordis.patch.yml'), installAnchor: anchor, overlays: [] }, profile);
  const integration = profile.layers.find(layer => layer.packageName === 'dsh-integrations');
  const rows = integration.patches.flatMap(p => p.insert || []);
  assert.deepEqual(rows.filter(r => r.id.startsWith('mcp-')).map(r => r.id), ['mcp-gitlab', 'mcp-jira', 'mcp-memory', 'mcp-figma', 'mcp-context7']);
  assert.ok(!rows.some(r => r.id === 'web-search-account' || r.id === 'web-search-exa-parallel'));
  const composed = boot.composeEntries([patches]);
  assert.equal(composed.filter(r => r.id === 'web-search-exa-parallel').length, 1);
  assert.equal(composed.find(r => r.id === 'web').config.searchProvider, 'exa-parallel');
  assert.equal(composed.find(r => r.id === 'web').config.fetchProvider, 'http');
  assert.equal(typeof rows.find(r => r.id === 'mcp-figma').config.env.FIGMA_API_KEY.__jsExpr, 'string');
  for (const id of ['gitlab', 'jira']) {
    const env = rows.find(r => r.id === `mcp-${id}`).config.env;
    assert.equal(typeof env[id === 'gitlab' ? 'GITLAB_PERSONAL_ACCESS_TOKEN' : 'JIRA_PERSONAL_TOKEN'].__jsExpr, 'string');
  }
  assert.deepEqual(patches.find(r => r.id === 'agent-default-model').config, { provider: 'cliproxy', model: 'claude-opus-5-5' });
  const slim = patches.find(r => r.id === 'oh-my-dsh-slim').config;
  assert.deepEqual(slim.orchestrator, { effort: 'high' });
  assert.deepEqual(slim.roles, {
    oracle: { provider: 'cliproxy', model: 'gpt-6.1-sol', effort: 'high', sharedMcpTools: [...gitlabGrants.oracle, 'mcp__jira__jira_get_issue', 'mcp__jira__jira_search'] },
    designer: { provider: 'cliproxy', model: 'claude-sonnet-5-5', effort: 'medium', sharedMcpTools: ['mcp__jira__jira_get_issue', 'mcp__jira__jira_search', 'mcp__figma__get_figma_data'] },
    fixer: { provider: 'cliproxy', model: 'claude-sonnet-5-5', effort: 'medium', sharedMcpTools: [...gitlabGrants.fixer, 'mcp__jira__jira_get_issue', 'mcp__jira__jira_search'] },
    explorer: { provider: 'cliproxy', model: 'claude-haiku-5-5', effort: 'low', sharedMcpTools: ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs'] },
    librarian: { provider: 'cliproxy', model: 'grok-4.7', sharedMcpTools: [...gitlabGrants.librarian, 'mcp__context7__resolve-library-id', 'mcp__context7__query-docs'] },
  });
  const patchPath = path.join(integrationDir, 'cordis.patch.yml');
  const publicText = (await readFile(patchPath, 'utf8')) + (await readFile(path.join(dir, 'cordis.patch.yml'), 'utf8'));
  const store = path.join(dshHome, '.credentials.yaml');
  assert.deepEqual(yaml.parse(await readFile(store, 'utf8')), { version: 1, refs: { CLIPROXY_API_KEY: config.apiKey } });
  assert.equal((await stat(store)).mode & 0o777, 0o600);
  assert.equal(publicText.includes(config.apiKey), false);
  assert.equal(publicText.includes('Authorization'), false);
  for (const [file, token] of [['gitlab-token', config.mcps[0].values.token], ['jira-token', config.mcps[1].values.token], ['figma-api-key', config.mcps[3].values.apiKey]]) {
    const secretPath = path.join(dshHome, 'secrets/installer', file);
    assert.equal(await readFile(secretPath, 'utf8'), token + '\n');
    assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.equal(publicText.includes(token), false);
  }
  const { createEditor } = await import(url(path.join(integrationDir, 'lib/editor.js')));
  const editor = createEditor({ path: patchPath, recoveryDir: path.join(home, 'recovery'), yaml, atomic, getHmr: () => undefined, isActive: () => false });
  assert.deepEqual(await editor.statusRows(), [{ id: 'mcp-gitlab', serverName: 'gitlab' }, { id: 'mcp-jira', serverName: 'jira' }, { id: 'mcp-memory', serverName: 'memory' }, { id: 'mcp-figma', serverName: 'figma' }, { id: 'mcp-context7', serverName: 'context7' }]);
  const description = await editor.describe();
  assert.equal(description.ok, true);
  assert.equal(description.canSave, false);
  assert.equal(description.entries.some(row => row.id === 'mcp-gitlab'), true);
  assert.equal(JSON.stringify(description).includes('fake-gitlab-secret'), false);
  // Set the same packaged argv anchor used by the native launcher; imports alone never apply plugins.
  const previousArgv = process.argv[1];
  process.argv[1] = path.join(asar.replace('/Resources/', '/resources/'), 'dsh/node_modules/@deepseek-ai/dsh/package.json');
  t.after(() => { process.argv[1] = previousArgv; });
  const adapter = await import(url(path.join(integrationDir, 'lib/mcp-client.js')));
  const integrationModule = await import(url(path.join(integrationDir, 'lib/index.js')));
  const statusModule = await import(url(path.join(integrationDir, 'lib/mcp-status.js')));
  const linkedStatusModule = await import(url(path.join(dir, 'node_modules/dsh-integrations/lib/mcp-status.js')));
  assert.equal(statusModule, linkedStatusModule);
  const statusToken = statusModule.begin('mcp-gitlab', 'gitlab');
  const generation = statusModule.beginGeneration('mcp-gitlab', statusToken);
  assert.equal(statusModule.transition('mcp-gitlab', statusToken, generation, 'connected'), true);
  const observed = await integrationModule.editorRequest(editor, 'status', {}, undefined, { principal: { kind: 'owner' } });
  assert.equal(observed.value.entries.find(row => row.id === 'mcp-gitlab').state, 'connected');
  statusModule.dispose('mcp-gitlab', statusToken);
  const slimModule = await import(url(path.join(slimDir, 'lib/index.js')));
  const searchManifest = JSON.parse(await readFile(path.join(searchDir, 'package.json'), 'utf8'));
  assert.equal(searchManifest.exports['.'], './lib/index.js');
  assert.equal(searchManifest.exports['./client'], undefined);
  const integrationManifest = JSON.parse(await readFile(path.join(integrationDir, 'package.json'), 'utf8'));
  assert.equal(integrationManifest.exports['./web-search-account'], undefined);
  assert.equal(typeof adapter.apply, 'function');
  assert.equal(typeof integrationModule.apply, 'function');
  assert.ok(slimModule.Config);
  const { default: z } = await import(url(process.env.OMDS_HOST_SCHEMA));
  const schema = z(JSON.parse(JSON.stringify(slimModule.Config)));
  assert.ok(schema(structuredClone(slim)));
});
