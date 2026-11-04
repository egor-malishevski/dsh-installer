import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer } from '../server.js';
import { roles } from '../lib/config.js';
import { models } from '../lib/profile.js';
async function assertStore(home, key) {
  const file = join(home, '.dsh/.credentials.yaml');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, refs: { CLIPROXY_API_KEY: key } });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(stat(join(home, '.dsh/secrets/installer/cliproxy-key')), { code: 'ENOENT' });
}
const discoveryModelsFn = async () => models.map(m => ({ ...m, ...(m.reasoningEfforts ? { reasoningEfforts: Object.keys(m.reasoningEfforts) } : {}) }));

test('HTTP clean install commits payload without exposing the key, and refuses a retry', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-integration-')));
  const instance = createServer({ home, discoveryModelsFn, token: 'test-capability', inspectEnvironmentFn: async () => ({ ok: true, blockers: [], warnings: [], checks: [], runtimePaths: {} }), assertStoppedFn: async () => ({ ok: true }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => instance.server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const headers = { 'x-dsh-setup-token': instance.token, 'content-type': 'application/json' };
  const config = { apiUrl: 'https://example.com/v1', apiKey: 'private-test-secret', roles, mcps: [] };
  const bootstrap = await fetch(instance.origin + '/api/bootstrap', { headers });
  assert.equal(bootstrap.status, 200);
  let port;
  for (const endpoint of ['validate', 'install']) {
    const response = await fetch(instance.origin + '/api/' + endpoint, { method: 'POST', headers, body: JSON.stringify({ config }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(!text.includes(config.apiKey));
    if (endpoint === 'validate') port = JSON.parse(text).preview.relayPort;
  }
  await assertStore(home, config.apiKey);
  assert.equal(await readlink(join(home, '.dsh/profiles/desktop/node_modules/dsh-integrations')), '../../../bundles/dsh-integrations');
  const integrationPatch = JSON.parse(await readFile(join(home, '.dsh/bundles/dsh-integrations/cordis.patch.yml'), 'utf8'));
  assert.equal(integrationPatch[0].insert[0].config.port, port);
  assert.equal(await readlink(join(home, '.dsh/profiles/desktop/node_modules/dsh-web-search-exa-parallel')), '../../../plugins/dsh-web-search-exa-parallel');
  assert.deepEqual(integrationPatch[1], { id: 'web-search-exa-parallel', name: 'dsh-web-search-exa-parallel' });
  assert.deepEqual(integrationPatch[2].config, { searchProvider: 'exa-parallel', fetchProvider: 'http' });
  const profile = await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8');
  assert.ok(profile.includes(`127.0.0.1:${port}/v1`));
  const retry = await fetch(instance.origin + '/api/install', { method: 'POST', headers, body: JSON.stringify({ config }) });
  assert.equal(retry.status, 409);
  await assertStore(home, config.apiKey);
});

test('port occupied after validation selects a consistent replacement', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-integration-')));
  const instance = createServer({ home, discoveryModelsFn, token: 'test-capability', inspectEnvironmentFn: async () => ({ ok: true, blockers: [], checks: [], runtimePaths: {} }), assertStoppedFn: async () => ({ ok: true }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const occupant = createNetServer();
  t.after(async () => { if (occupant.listening) await new Promise(resolve => occupant.close(resolve)); await new Promise(resolve => instance.server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const options = { method: 'POST', headers: { 'x-dsh-setup-token': instance.token, 'content-type': 'application/json' }, body: JSON.stringify({ config: { apiUrl: 'https://example.com/v1', apiKey: 'private-test-secret', roles, mcps: [] } }) };
  const preview = await (await fetch(instance.origin + '/api/validate', options)).json();
  await new Promise((resolve, reject) => occupant.once('error', reject).listen(preview.preview.relayPort, '127.0.0.1', resolve));
  const response = await fetch(instance.origin + '/api/install', options);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.notEqual(result.relayPort, preview.preview.relayPort);
  assert.ok(Number.isInteger(result.relayPort) && result.relayPort > 0);
  const patch = JSON.parse(await readFile(join(home, '.dsh/bundles/dsh-integrations/cordis.patch.yml'), 'utf8'));
  assert.equal(patch[0].insert[0].config.port, result.relayPort);
  const profile = await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8');
  assert.ok(profile.includes(`127.0.0.1:${result.relayPort}/v1`));
  await assertStore(home, 'private-test-secret');
});

test('existing credentials store is left untouched and the response guides the user', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-integration-')));
  const original = '# my store\nversion: 1\nrefs:\n  OTHER: other-synthetic\n';
  await mkdir(join(home, '.dsh'));
  await writeFile(join(home, '.dsh/.credentials.yaml'), original, { mode: 0o600 });
  const instance = createServer({ home, discoveryModelsFn, token: 'test-capability', inspectEnvironmentFn: async () => ({ ok: true, blockers: [], warnings: [], checks: [], runtimePaths: {} }), assertStoppedFn: async () => ({ ok: true }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => instance.server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const headers = { 'x-dsh-setup-token': instance.token, 'content-type': 'application/json' };
  const config = { apiUrl: 'https://example.com/v1', apiKey: 'synthetic-existing-store-key', roles, mcps: [] };
  const response = await fetch(instance.origin + '/api/install', { method: 'POST', headers, body: JSON.stringify({ config }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.ok(!text.includes(config.apiKey));
  assert.match(JSON.parse(text).warnings.join('\n'), /Settings → Models → CLIProxyAPI.*Save/);
  assert.equal(await readFile(join(home, '.dsh/.credentials.yaml'), 'utf8'), original);
  assert.equal((await stat(join(home, '.dsh/.credentials.yaml'))).mode & 0o777, 0o600);
  await assert.rejects(stat(join(home, '.dsh/secrets/installer/cliproxy-key')), { code: 'ENOENT' });
  assert.ok(!(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8')).includes(config.apiKey));
});
