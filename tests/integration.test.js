import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer } from '../server.js';
import { roles } from '../lib/config.js';
import { models } from '../lib/profile.js';
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
  assert.equal(await readFile(join(home, '.dsh/secrets/installer/cliproxy-key'), 'utf8'), config.apiKey + '\n');
  assert.equal(await readlink(join(home, '.dsh/profiles/desktop/node_modules/dsh-integrations')), '../../../bundles/dsh-integrations');
  const integrationPatch = JSON.parse(await readFile(join(home, '.dsh/bundles/dsh-integrations/cordis.patch.yml'), 'utf8'));
  assert.equal(integrationPatch[0].insert[0].config.port, port);
  const profile = await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8');
  assert.ok(profile.includes(`127.0.0.1:${port}/v1`));
  const retry = await fetch(instance.origin + '/api/install', { method: 'POST', headers, body: JSON.stringify({ config }) });
  assert.equal(retry.status, 409);
  assert.equal(await readFile(join(home, '.dsh/secrets/installer/cliproxy-key'), 'utf8'), config.apiKey + '\n');
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
  assert.equal(await readFile(join(home, '.dsh/secrets/installer/cliproxy-key'), 'utf8'), 'private-test-secret\n');
});
