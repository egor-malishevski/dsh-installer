import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProfile } from '../lib/update.js';
import { models as catalog } from '../lib/profile.js';
import { createServer } from '../server.js';

const base = { assertStoppedFn: async () => ({ ok: true }) };
const roleNames = ['oracle', 'designer', 'fixer', 'explorer', 'librarian'];
const aliasIds = [...roleNames.map(r => `fallback-${r}`), 'fallback-main'];
const pkg = { name: 'dsh-profile-desktop', private: true };
const aliasModels = aliasIds.map(id => ({ id, name: id, input: ['text'] }));
const patch = () => [
  { id: 'agent-default-model', name: 'm', config: { provider: 'cliproxy', model: 'fallback-main' } },
  { id: 'llm-pi-ai', name: 'p', config: { providers: { cliproxy: { baseURL: 'http://127.0.0.1:1/v1', models: [...catalog.map(m => structuredClone(m)), ...aliasModels, { id: 'custom-keep', name: 'c' }] } } } },
  { id: 'agent-preset-registry', name: 'r', config: { default: 'oh-my-dsh-slim' } },
  { id: 'oh-my-dsh-slim', name: 's', config: { orchestrator: { effort: 'high' }, roles: Object.fromEntries(roleNames.map(r => [r, { provider: 'cliproxy', model: `fallback-${r}`, effort: 'low', sharedMcpTools: ['mcp__x__y'], keepMe: true }])) } },
];

async function fixture(t, { version = '0.8.7', entries = patch() } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mig-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, '.dsh/profiles/desktop');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(entries));
  await mkdir(join(home, '.dsh/plugins/oh-my-dsh-slim/node_modules/dep'), { recursive: true });
  await symlink('/nonexistent-target', join(home, '.dsh/plugins/oh-my-dsh-slim/node_modules/dep/link'));
  await writeFile(join(home, '.dsh/plugins/oh-my-dsh-slim/package.json'), JSON.stringify({ name: 'oh-my-dsh-slim', version }));
  await mkdir(join(home, '.dsh/plugins/zstd-render'), { recursive: true });
  await writeFile(join(home, '.dsh/plugins/zstd-render/index.js'), 'const ALIASES = { x: 1 };\n');
  return home;
}
const readPatch = async home => JSON.parse(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'));
const applyWith = async (home, opts, extra = {}) => {
  const p = await updateProfile({ home, ...opts, ...base });
  return updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, ...opts, ...base, ...extra });
};

test('opt-out keeps every alias and role model', async t => {
  const home = await fixture(t);
  const p = await updateProfile({ home, ...base });
  assert.ok(!JSON.stringify(p.actions).includes('NATIVE_FALLBACK_MIGRATION'));
  const done = await applyWith(home, {});
  assert.equal(done.ok, true);
  const rows = await readPatch(home);
  const slim = rows.find(r => r.id === 'oh-my-dsh-slim');
  for (const r of roleNames) assert.equal(slim.config.roles[r].model, `fallback-${r}`);
  const ids = rows.find(r => r.id === 'llm-pi-ai').config.providers.cliproxy.models.map(m => m.id);
  for (const id of aliasIds) assert.ok(ids.includes(id));
});

test('opt-in migrates roles, removes five unused aliases, keeps main alias, relay and unknown data', async t => {
  const home = await fixture(t);
  const p = await updateProfile({ home, migrateNativeFallbacks: true, ...base });
  assert.deepEqual(p.conflicts, []);
  const action = p.actions.find(a => a.reason === 'PROFILE_PATCH_MERGE');
  assert.ok(action.details.includes('NATIVE_FALLBACK_MIGRATION'));
  const done = await updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, migrateNativeFallbacks: true, ...base });
  assert.equal(done.ok, true);
  const rows = await readPatch(home);
  const slim = rows.find(r => r.id === 'oh-my-dsh-slim');
  for (const r of roleNames) {
    const role = slim.config.roles[r];
    assert.ok(!role.model.startsWith('fallback-')); assert.ok(role.fallbacks.length >= 1 && role.fallbacks.length <= 3);
    assert.equal(role.keepMe, true); assert.deepEqual(role.sharedMcpTools, ['mcp__x__y']); assert.equal(role.effort, 'low');
  }
  assert.equal(rows.find(r => r.id === 'agent-default-model').config.model, 'fallback-main');
  const ids = rows.find(r => r.id === 'llm-pi-ai').config.providers.cliproxy.models.map(m => m.id);
  for (const r of roleNames) assert.ok(!ids.includes(`fallback-${r}`));
  assert.ok(ids.includes('fallback-main') && ids.includes('custom-keep'));
  assert.equal(await readFile(join(home, '.dsh/plugins/zstd-render/index.js'), 'utf8'), 'const ALIASES = { x: 1 };\n');
  // The same transaction upgraded the plugin tree; repeating is a no-op without a new backup.
  assert.equal(JSON.parse(await readFile(join(home, '.dsh/plugins/oh-my-dsh-slim/package.json'), 'utf8')).version, '0.8.7-native.1');
  const backups = await readdir(join(home, '.dsh/backups'));
  const again = await applyWith(home, { migrateNativeFallbacks: true });
  assert.equal(again.ok, true); assert.equal(again.canApply, false);
  assert.deepEqual(await readdir(join(home, '.dsh/backups')), backups);
});

test('still-referenced alias is kept and reported', async t => {
  const entries = patch();
  entries.push({ id: 'other', config: { model: 'cliproxy/fallback-oracle' } });
  const home = await fixture(t, { entries });
  const p = await updateProfile({ home, migrateNativeFallbacks: true, ...base });
  assert.ok(p.actions.some(a => a.reason === 'ALIAS_STILL_REFERENCED'));
});

test('toggling the option between preview and apply is STALE_PLAN', async t => {
  const home = await fixture(t);
  const p = await updateProfile({ home, ...base });
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, migrateNativeFallbacks: true, ...base }), { code: 'STALE_PLAN' });
});

test('unsupported payload capability is a conflict and nothing is written', async t => {
  const home = await fixture(t);
  const payloadRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mig-payload-')));
  t.after(() => rm(payloadRoot, { recursive: true, force: true }));
  await mkdir(join(payloadRoot, 'plugins/oh-my-dsh-slim'), { recursive: true });
  await writeFile(join(payloadRoot, 'plugins/oh-my-dsh-slim/package.json'), JSON.stringify({ name: 'oh-my-dsh-slim', version: '0.8.7' }));
  const before = await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8');
  const p = await updateProfile({ home, payloadRoot, migrateNativeFallbacks: true, ...base });
  assert.ok(p.conflicts.includes('NATIVE_CAPABILITY_UNSUPPORTED')); assert.equal(p.canApply, false);
  const r = await updateProfile({ home, dryRun: false, planHash: p.planHash, payloadRoot, migrateNativeFallbacks: true, acknowledgeManagedFiles: true, ...base });
  assert.equal(r.ok, false);
  assert.equal(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'), before);
});

test('unknown installed tree version blocks migration without mutation', async t => {
  const home = await fixture(t, { version: '0.9.0' });
  const before = await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8');
  const p = await updateProfile({ home, migrateNativeFallbacks: true, ...base });
  assert.ok(p.conflicts.includes('TREE_VERSION_MISMATCH')); assert.ok(p.conflicts.includes('NATIVE_CAPABILITY_UNSUPPORTED'));
  const r = await updateProfile({ home, dryRun: false, planHash: p.planHash, migrateNativeFallbacks: true, acknowledgeManagedFiles: true, ...base });
  assert.equal(r.ok, false);
  assert.equal(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(join(home, '.dsh/plugins/oh-my-dsh-slim/package.json'), 'utf8')).version, '0.9.0');
});

test('later failure restores migration and plugin updates together', async t => {
  const home = await fixture(t);
  const patchPath = join(home, '.dsh/profiles/desktop/cordis.patch.yml');
  const before = await readFile(patchPath, 'utf8');
  const p = await updateProfile({ home, migrateNativeFallbacks: true, ...base });
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, migrateNativeFallbacks: true, ...base, afterWrite: async rel => { if (rel.endsWith('cordis.patch.yml') && rel.includes('profiles')) throw new Error('boom'); } }), e => e.code === 'UPDATE_FAILED' && !!e.backupPath);
  assert.equal(await readFile(patchPath, 'utf8'), before);
  assert.equal(JSON.parse(await readFile(join(home, '.dsh/plugins/oh-my-dsh-slim/package.json'), 'utf8')).version, '0.8.7');
});

test('HTTP /api/update forwards migrateNativeFallbacks and rejects non-boolean', async t => {
  const home = await fixture(t);
  const instance = createServer({ home, ...base, inspectEnvironmentFn: async () => ({ ok: true, blockers: [], checks: [], runtimePaths: {} }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.server.close(resolve)));
  const post = body => fetch(instance.origin + '/api/update', { method: 'POST', headers: { 'X-DSH-Setup-Token': instance.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const preview = await (await post({ dryRun: true, migrateNativeFallbacks: true })).json();
  assert.ok(preview.actions.some(a => (a.details || []).includes('NATIVE_FALLBACK_MIGRATION')));
  assert.equal((await post({ dryRun: true, migrateNativeFallbacks: 'yes' })).status, 409);
  const stale = await post({ dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true });
  assert.equal((await stale.json()).code, 'STALE_PLAN');
});
