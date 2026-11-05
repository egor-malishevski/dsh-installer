import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProfile, relayCleanupConflict } from '../lib/update.js';
import { models } from '../lib/profile.js';
import { createServer } from '../server.js';
import { createHash } from 'node:crypto';
import { parsePatch } from '../lib/yaml-patch.js';

const roles = ['oracle', 'designer', 'fixer', 'explorer', 'librarian'];
const aliases = ['fallback-main', ...roles.map(r => `fallback-${r}`)];
const stopped = async () => ({ ok: true });
const opts = { cleanupLegacyFallbacks: true, mainModel: 'gpt-6.1-sol', assertStoppedFn: stopped };
const rows = () => [
  { id: 'agent-default-model', config: { provider: 'cliproxy', model: 'fallback-main' } },
  { id: 'llm-pi-ai', config: { providers: { cliproxy: { models: [...models, ...aliases.map(id => ({ id, name: id }))] } } } },
  { id: 'agent-preset-registry', config: { default: 'oh-my-dsh-slim' } },
  { id: 'oh-my-dsh-slim', config: { roles: Object.fromEntries(roles.map(r => [r, { provider: 'cliproxy', model: `fallback-${r}` }])) } },
];
async function fixture(t, text = JSON.stringify(rows())) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-cleanup-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.dsh/profiles/desktop');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'desktop' }));
  await writeFile(join(dir, 'cordis.patch.yml'), text);
  return home;
}
const patchPath = home => join(home, '.dsh/profiles/desktop/cordis.patch.yml');

test('cleanup migrates and removes all aliases in one transaction and is idempotent', async t => {
  const home = await fixture(t);
  const preview = await updateProfile({ home, ...opts, migrateNativeFallbacks: false });
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.actions.some(a => a.details?.includes('NATIVE_FALLBACK_MIGRATION') && a.details.includes('LEGACY_FALLBACK_CLEANUP') && a.details.includes('MAIN_MODEL_SELECTED')));
  const done = await updateProfile({ home, ...opts, migrateNativeFallbacks: false, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
  assert.equal(done.ok, true);
  const result = JSON.parse(await readFile(patchPath(home), 'utf8'));
  assert.equal(result[0].config.model, 'gpt-6.1-sol');
  assert.ok(!JSON.stringify(result).includes('fallback-'));
  for (const role of Object.values(result.find(r => r.id === 'oh-my-dsh-slim').config.roles)) assert.ok(role.fallbacks.length);
  const again = await updateProfile({ home, ...opts });
  assert.equal(again.canApply, false);
});

test('block YAML cleanup preserves opaque source and rejects opaque references', async t => {
  const catalog = [...models, ...aliases.map(id => ({ id, name: id }))];
  const modelLines = catalog.map(m => `          - id: ${m.id}\n            name: ${JSON.stringify(m.name)}${m.input ? `\n            input: ${JSON.stringify(m.input)}` : ''}${m.reasoningEfforts ? `\n            reasoningEfforts: ${JSON.stringify(m.reasoningEfforts)}` : ''}`).join('\n');
  const roleLines = roles.map(r => `      ${r}: {provider: cliproxy, model: fallback-${r}}`).join('\n');
  const source = `- id: agent-default-model\n  config: {provider: cliproxy, model: fallback-main}\n- id: llm-pi-ai\n  config:\n    providers:\n      cliproxy:\n        models:\n${modelLines}\n- id: agent-preset-registry\n  config: {default: oh-my-dsh-slim}\n- id: oh-my-dsh-slim\n  note: !!js/function "return 42"\n  config:\n    roles:\n${roleLines}\n`;
  const home = await fixture(t, source);
  const preview = await updateProfile({ home, ...opts });
  assert.deepEqual(preview.conflicts, []);
  const done = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
  assert.equal(done.ok, true);
  const output = await readFile(patchPath(home), 'utf8');
  assert.ok(output.includes('note: !!js/function "return 42"'));
  assert.ok(!JSON.stringify(parsePatch(output).rows).includes('fallback-'));
  const referencedHome = await fixture(t, source.replace('return 42', 'return fallback-main'));
  const blocked = await updateProfile({ home: referencedHome, ...opts });
  assert.ok(blocked.conflicts.includes('CLEANUP_ALIAS_REFERENCED'));
  assert.equal(await readFile(patchPath(referencedHome), 'utf8'), source.replace('return 42', 'return fallback-main'));
});

test('unknown relay workaround conflicts atomically', async t => {
  const home = await fixture(t);
  const relay = join(home, '.dsh/plugins/zstd-render');
  await mkdir(relay, { recursive: true });
  await writeFile(join(relay, 'index.js'), 'const ALIASES = {};');
  const before = await readFile(patchPath(home), 'utf8');
  const preview = await updateProfile({ home, ...opts });
  assert.ok(preview.conflicts.includes('RELAY_HASH_MISMATCH'));
  const done = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
  assert.equal(done.ok, false);
  assert.equal(await readFile(patchPath(home), 'utf8'), before);
  assert.equal(await readFile(join(relay, 'index.js'), 'utf8'), 'const ALIASES = {};');
});

test('known staged relay is replaced only after acknowledgement', async t => {
  let legacy;
  try { legacy = await readFile(new URL('../../cliproxy-fallback/index.js', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('staged relay fixture not available'); throw error; }
  assert.equal(createHash('sha256').update(legacy).digest('hex'), 'e3ba9001109984f51a5b2b428f31b0a03ca655c9fe41f56729a241c34b05bfbe');
  const home = await fixture(t);
  const relay = join(home, '.dsh/plugins/zstd-render');
  await mkdir(relay, { recursive: true });
  await writeFile(join(relay, 'index.js'), legacy);
  const preview = await updateProfile({ home, ...opts });
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.actions.some(a => a.reason === 'RELAY_FALLBACK_REMOVED' && a.needsAck));
  const denied = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash });
  assert.deepEqual(denied.conflicts, ['ACK_REQUIRED']);
  assert.deepEqual(await readFile(join(relay, 'index.js')), legacy);
  const done = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
  assert.equal(done.ok, true);
  assert.deepEqual(await readFile(join(relay, 'index.js')), await readFile(new URL('../payload/plugins/zstd-render/index.js', import.meta.url)));
});

for (const source of ["const target = 'fallback-oracle';", "const target = 'fallback-custom';", 'custom plain relay']) {
  test(`unknown relay bytes conflict atomically: ${source}`, async t => {
    const home = await fixture(t);
    const relay = join(home, '.dsh/plugins/zstd-render');
    await mkdir(relay, { recursive: true });
    await writeFile(join(relay, 'index.js'), source);
    const before = await readFile(patchPath(home), 'utf8');
    const preview = await updateProfile({ home, ...opts });
    assert.ok(preview.conflicts.includes('RELAY_HASH_MISMATCH'));
    const denied = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
    assert.equal(denied.ok, false);
    assert.equal(await readFile(patchPath(home), 'utf8'), before);
    assert.equal(await readFile(join(relay, 'index.js'), 'utf8'), source);
    await assert.rejects(lstat(join(home, '.dsh/backups')), { code: 'ENOENT' });
    await assert.rejects(updateProfile({ home, ...opts, cleanupLegacyFallbacks: false, dryRun: false, planHash: preview.planHash }), { code: 'STALE_PLAN' });
  });
}

const originalHash = '77058099982aa362047ff7e565dbc7641783ad507c62bbfbc2fa719479c4cccd';
const relayRow = (home, upstream) => ({ id: 'zstd-render', name: join(home, '.dsh/plugins/zstd-render/index.js'), config: { upstream } });

test('original relay policy requires unambiguous explicit HTTP upstream', () => {
  const home = '/example-home';
  const valid = relayRow(home, 'https://example.test');
  assert.equal(relayCleanupConflict(originalHash, [valid], false, home), null);
  for (const value of [undefined, '', 'ftp://example.test', 'not-a-url', ' https://example.test']) {
    assert.equal(relayCleanupConflict(originalHash, [relayRow(home, value)], false, home), 'RELAY_UPSTREAM_REQUIRED');
  }
  assert.equal(relayCleanupConflict(originalHash, [], false, home), 'RELAY_UPSTREAM_REQUIRED');
  assert.equal(relayCleanupConflict(originalHash, [valid, valid], false, home), 'RELAY_UPSTREAM_REQUIRED');
  for (const name of [valid.name, `${home}/.dsh/plugins/zstd-render/../zstd-render/index.js`]) {
    assert.equal(relayCleanupConflict(originalHash, [valid, { id: 'second-relay', name, config: { port: 18318 } }], false, home), 'RELAY_UPSTREAM_REQUIRED');
  }
  assert.equal(relayCleanupConflict(originalHash, [valid], true, home), 'RELAY_UPSTREAM_REQUIRED');
  assert.equal(relayCleanupConflict('unknown', [valid], false, home), 'RELAY_HASH_MISMATCH');
});

test('original relay cleanup requires explicit upstream and acknowledgement', async t => {
  const source = process.env.DSH_RELAY_ORIGINAL_FIXTURE;
  if (!source) return t.skip('set DSH_RELAY_ORIGINAL_FIXTURE to the original relay');
  const original = await readFile(source);
  assert.equal(createHash('sha256').update(original).digest('hex'), originalHash);
  const home = await fixture(t);
  const relay = join(home, '.dsh/plugins/zstd-render');
  await mkdir(relay, { recursive: true });
  await writeFile(join(relay, 'index.js'), original);
  const before = await readFile(patchPath(home), 'utf8');
  const blocked = await updateProfile({ home, ...opts });
  assert.ok(blocked.conflicts.includes('RELAY_UPSTREAM_REQUIRED'));
  const denied = await updateProfile({ home, ...opts, dryRun: false, planHash: blocked.planHash, acknowledgeManagedFiles: true });
  assert.equal(denied.ok, false);
  assert.equal(await readFile(patchPath(home), 'utf8'), before);
  assert.deepEqual(await readFile(join(relay, 'index.js')), original);
  await assert.rejects(lstat(join(home, '.dsh/backups')), { code: 'ENOENT' });
  const normal = await updateProfile({ home, cleanupLegacyFallbacks: false });
  assert.ok(!normal.conflicts.includes('RELAY_UPSTREAM_REQUIRED'));
  assert.ok(normal.actions.some(a => a.reason === 'ORIGINAL_RELAY_PRESERVED'));
  assert.ok(!normal.actions.some(a => a.path.endsWith('/zstd-render/index.js') && a.op === 'replace'));
  const profile = rows();
  profile.push(relayRow(home, 'https://example.test'));
  await writeFile(patchPath(home), JSON.stringify(profile));
  const preview = await updateProfile({ home, ...opts });
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.actions.some(a => a.reason === 'RELAY_FALLBACK_REMOVED' && a.needsAck));
  const noAck = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash });
  assert.deepEqual(noAck.conflicts, ['ACK_REQUIRED']);
  const done = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
  assert.equal(done.ok, true);
  assert.deepEqual(await readFile(join(relay, 'index.js')), await readFile(new URL('../payload/plugins/zstd-render/index.js', import.meta.url)));
  assert.deepEqual(JSON.parse(await readFile(patchPath(home), 'utf8')).find(r => r.id === 'zstd-render'), relayRow(home, 'https://example.test'));
});

test('original relay accepts unrelated opaque YAML but rejects tagged relay evidence', async t => {
  const source = process.env.DSH_RELAY_ORIGINAL_FIXTURE;
  if (!source) return t.skip('set DSH_RELAY_ORIGINAL_FIXTURE to the original relay');
  const original = await readFile(source);
  assert.equal(createHash('sha256').update(original).digest('hex'), originalHash);
  const home = await fixture(t);
  const relay = join(home, '.dsh/plugins/zstd-render');
  await mkdir(relay, { recursive: true });
  await writeFile(join(relay, 'index.js'), original);
  const base = rows().map(row => {
    if (row.id === 'agent-default-model') row.config.model = 'gpt-6.1-sol';
    if (row.id === 'llm-pi-ai') row.config.providers.cliproxy.models = models;
    if (row.id === 'oh-my-dsh-slim') row.config.roles = {};
    return `- ${JSON.stringify(row)}`;
  }).join('\n');
  const name = JSON.stringify(join(relay, 'index.js'));
  const yaml = (nameTag = '', upstreamTag = '') => `${base}\n- id: auth\n  secret: !!js/function "return 42"\n- id: zstd-render\n  name: ${nameTag}${name}\n  config:\n    upstream: ${upstreamTag}"https://example.test"\n`;
  const secondRelay = (tag, moduleName) => `- id: second-relay\n  name: ${tag}${JSON.stringify(moduleName)}\n  config: {port: 18318}\n`;
  for (const text of [yaml('!!js/function '), yaml('', '!!js/function '), yaml() + secondRelay('', join(relay, 'index.js')), yaml() + secondRelay('', `${relay}/../zstd-render/index.js`), yaml() + secondRelay('!!js/function ', join(relay, 'index.js'))]) {
    await writeFile(patchPath(home), text);
    const preview = await updateProfile({ home, ...opts });
    assert.ok(preview.conflicts.includes('RELAY_UPSTREAM_REQUIRED'));
    const denied = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
    assert.equal(denied.ok, false);
    assert.equal(await readFile(patchPath(home), 'utf8'), text);
    assert.deepEqual(await readFile(join(relay, 'index.js')), original);
    await assert.rejects(lstat(join(home, '.dsh/backups')), { code: 'ENOENT' });
  }
  const text = yaml();
  await writeFile(patchPath(home), text);
  const preview = await updateProfile({ home, ...opts });
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.actions.some(a => a.reason === 'RELAY_FALLBACK_REMOVED' && a.needsAck));
  const done = await updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
  assert.equal(done.ok, true);
  assert.equal(await readFile(patchPath(home), 'utf8'), text);
  assert.deepEqual(await readFile(join(relay, 'index.js')), await readFile(new URL('../payload/plugins/zstd-render/index.js', import.meta.url)));
});

test('options are hashed, validated, and stop guard remains enforced', async t => {
  const home = await fixture(t);
  const preview = await updateProfile({ home, ...opts });
  await assert.rejects(updateProfile({ home, ...opts, mainModel: 'other', dryRun: false, planHash: preview.planHash }), { code: 'STALE_PLAN' });
  await assert.rejects(updateProfile({ home, ...opts, cleanupLegacyFallbacks: 'true' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(updateProfile({ home, ...opts, mainModel: null }), { code: 'INVALID_REQUEST' });
  await assert.rejects(updateProfile({ home, ...opts, dryRun: false, planHash: preview.planHash, assertStoppedFn: async () => ({ ok: false }) }), { code: 'APP_RUNNING' });
});

test('HTTP forwards cleanup options and rejects invalid types', async t => {
  const home = await fixture(t);
  const instance = createServer({ home, assertStoppedFn: stopped, inspectEnvironmentFn: async () => ({ ok: true, checks: [] }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.server.close(resolve)));
  const post = body => fetch(instance.origin + '/api/update', { method: 'POST', headers: { 'X-DSH-Setup-Token': instance.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const preview = await (await post({ dryRun: true, cleanupLegacyFallbacks: true, mainModel: 'gpt-6.1-sol' })).json();
  assert.deepEqual(preview.conflicts, []);
  assert.equal((await post({ dryRun: true, cleanupLegacyFallbacks: null })).status, 409);
  assert.equal((await post({ dryRun: true, mainModel: 3 })).status, 409);
});
