import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { normalizeApiUrl, roles } from '../lib/config.js';

test('URL normalization rejects credentials and insecure external destinations', () => {
  assert.equal(normalizeApiUrl('https://example.org/v1/v1/'), 'https://example.org/v1');
  assert.equal(normalizeApiUrl('http://localhost:8080'), 'http://localhost:8080/v1');
  for (const url of ['http://example.org', 'https://user:pass@example.org', 'https://example.org/?q=1', 'file:///tmp/a']) assert.throws(() => normalizeApiUrl(url));
});
test('local API requires capability and same origin, validates without installing', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-server-')));
  const instance = createServer({ home, inspectEnvironmentFn: async () => ({ ok: true, blockers: [], checks: [], runtimePaths: {} }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => instance.server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const base = instance.origin;
  const auth = { 'X-DSH-Setup-Token': instance.token };
  assert.equal((await fetch(base + '/api/bootstrap')).status, 403);
  assert.equal((await fetch(base + '/api/bootstrap', { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => http.get(base + '/api/bootstrap', { headers: { ...auth, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(base + '/api/bootstrap', { method: 'OPTIONS', headers: auth })).status, 403);
  const bootstrap = await (await fetch(base + '/api/bootstrap', { headers: auth })).json();
  assert.equal(bootstrap.defaults.mcps.length, 11);
  assert.ok(bootstrap.defaults.mcps.some(mcp => mcp.id === 'gitlab'));
  const config = { apiUrl: 'https://example.org', apiKey: 'private', mcps: [], roles };
  const options = { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) };
  const validated = await fetch(base + '/api/validate', options);
  assert.equal(validated.status, 200);
  assert.equal((await validated.json()).apiUrl, 'https://example.org/v1');
  assert.equal((await fetch(base + '/api/install', options)).status, 200);
  const both = { ...config, mcps: [{ id: 'gitlab', values: { url: 'https://git.example', token: 'private' } }, { id: 'bitbucket', values: { url: 'https://git.example', username: 'user', token: 'private' } }] };
  assert.equal((await fetch(base + '/api/validate', { ...options, body: JSON.stringify({ config: both }) })).status, 200);
  assert.equal((await fetch(base + '/api/validate', { ...options, body: 'x'.repeat(262145) })).status, 413);
});


test('repeated preflight reports selected MCP Node requirement', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-server-')));
  let calls = 0;
  const instance = createServer({ home, inspectEnvironmentFn: async () => ({ ok: true, blockers: [], checks: [], runtimePaths: { npx: process.execPath, npxPath: '/usr/bin', nodeVersion: ++calls === 1 ? 'v24.0.0' : 'v20.0.0' } }), assertStoppedFn: async () => ({ ok: true }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => instance.server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { apiUrl: 'https://example.org', apiKey: 'private', mcps: [{ id: 'memory', values: {} }], roles };
  const response = await fetch(instance.origin + '/api/install', { method: 'POST', headers: { 'X-DSH-Setup-Token': instance.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).blockers.join(' '), /Node.js 24/);
});

test('occupied preview port is replaced consistently in installed files and response', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-server-')));
  const instance = createServer({ home, inspectEnvironmentFn: async () => ({ ok: true, blockers: [], checks: [], runtimePaths: {} }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const occupied = createNetServer();
  t.after(async () => { if (occupied.listening) await new Promise(resolve => occupied.close(resolve)); await new Promise(resolve => instance.server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const config = { apiUrl: 'https://example.org', apiKey: 'private', mcps: [], roles };
  const options = { method: 'POST', headers: { 'X-DSH-Setup-Token': instance.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) };
  const preview = await (await fetch(instance.origin + '/api/validate', options)).json();
  await new Promise((resolve, reject) => occupied.once('error', reject).listen(preview.preview.relayPort, '127.0.0.1', resolve));
  const response = await fetch(instance.origin + '/api/install', options);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.notEqual(result.relayPort, preview.preview.relayPort);
  const patch = JSON.parse(await readFile(join(home, '.dsh/bundles/dsh-integrations/cordis.patch.yml'), 'utf8'));
  assert.equal(patch[0].insert[0].config.port, result.relayPort);
  assert.match(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'), new RegExp(`127\\.0\\.0\\.1:${result.relayPort}/v1`));
});
