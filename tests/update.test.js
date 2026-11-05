import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink, lstat, stat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProfile } from '../lib/update.js';
import { createServer } from '../server.js';

const ok = async () => ({ ok: true });
const base = { assertStoppedFn: ok };
const oldPkg = { name: 'dsh-profile-desktop', private: true, custom: 1, dependencies: { '@deepseek-ai/dsh-base': '0.2.1-rc.5', extra: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'experimental'], keep: true } } };
const oldPatch = [
  { id: 'agent-default-model', name: 'x', config: { provider: 'cliproxy', model: 'custom' }, unknown: 1 },
  { id: 'llm-pi-ai', name: 'y', config: { providers: { cliproxy: { baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'my-model', reasoningEfforts: { none: null } }] }, other: { a: 1 } } } },
  { id: 'oh-my-dsh-slim', name: 'z', config: { roles: { oracle: { effort: 'none' } } } },
  { id: 'extra-row', name: 'e' },
];

async function fixture(t, { pkg = oldPkg, patch = oldPatch } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh update-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.dsh/profiles/desktop'), { recursive: true });
  await writeFile(join(home, '.dsh/profiles/desktop/package.json'), JSON.stringify(pkg));
  await writeFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), JSON.stringify(patch));
  await writeFile(join(home, '.dsh/.credentials.yaml'), 'secret: 1\n');
  return home;
}
const snapshot = async dir => {
  const out = {};
  const walk = async rel => { for (const e of await readdir(join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { out[r + '/'] = 1; await walk(r); } else out[r] = e.isSymbolicLink() ? 'link' : (await readFile(join(dir, r))).toString('base64'); } };
  await walk('');
  return out;
};
const apply = async (home, extra = {}) => {
  const p = await updateProfile({ home, ...base });
  return updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, ...base, ...extra });
};

test('dry run writes nothing, needs no secret and works while app runs', async t => {
  const home = await fixture(t);
  const before = await snapshot(home);
  const result = await updateProfile({ home, assertStoppedFn: async () => ({ ok: false }) });
  assert.equal(result.ok, true); assert.equal(result.dryRun, true); assert.equal(result.backupPath, null);
  assert.ok(result.actions.some(a => a.path.endsWith('package.json') && a.op === 'replace'));
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(await snapshot(home), before);
});

test('merge preserves custom rows, models, bundles and unknown keys; adds missing deps', async t => {
  const home = await fixture(t);
  const result = await apply(home);
  assert.equal(result.ok, true); assert.equal(result.requiresRestart, true);
  const pkg = JSON.parse(await readFile(join(home, '.dsh/profiles/desktop/package.json'), 'utf8'));
  assert.equal(pkg.custom, 1); assert.equal(pkg.dependencies.extra, '1.0.0'); assert.equal(pkg.dsh.profile.keep, true);
  assert.ok(pkg.dsh.profile.bundles.includes('experimental') && pkg.dsh.profile.bundles.includes('oh-my-dsh-slim'));
  assert.equal(pkg.dependencies['oh-my-dsh-slim'], 'link:../../plugins/oh-my-dsh-slim');
  const patch = JSON.parse(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'));
  assert.ok(patch.some(r => r.id === 'extra-row')); assert.equal(patch[0].unknown, 1);
  assert.equal(patch.find(r => r.id === 'oh-my-dsh-slim').config.roles.oracle.effort, 'none');
  const models = patch.find(r => r.id === 'llm-pi-ai').config.providers.cliproxy.models;
  assert.deepEqual(models[0], oldPatch[1].config.providers.cliproxy.models[0]);
  assert.equal(models.length, 1); // populated list: removed catalog models are not re-added
  assert.ok(patch.find(r => r.id === 'llm-pi-ai').config.providers.other);
  assert.equal(await readFile(join(home, '.dsh/.credentials.yaml'), 'utf8'), 'secret: 1\n');
  const lst = await lstat(join(home, '.dsh/profiles/desktop/node_modules/oh-my-dsh-slim'));
  assert.ok(lst.isSymbolicLink());
  const [name] = await readdir(join(home, '.dsh/backups'));
  assert.match(name, /^installer-update-/);
  assert.equal((await lstat(join(home, '.dsh/backups', name))).mode & 0o777, 0o700);
  const manifest = await readFile(join(home, '.dsh/backups', name, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes('secret') && !manifest.includes('extra-row'));
});

test('equivalent local links are preserved while missing dependencies are repaired', async t => {
  const home = await fixture(t);
  const pkgPath = join(home, '.dsh/profiles/desktop/package.json');
  const pkg = structuredClone(oldPkg);
  pkg.dependencies['dsh-integrations'] = `link:${join(home, '.dsh/bundles/dsh-integrations')}`;
  pkg.dependencies['oh-my-dsh-slim'] = 'link:../../plugins/./other/../oh-my-dsh-slim';
  await writeFile(pkgPath, JSON.stringify(pkg));
  const before = await snapshot(home);
  const preview = await updateProfile({ home, ...base });
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(await snapshot(home), before);
  const result = await updateProfile({ home, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(result.ok, true);
  const repaired = JSON.parse(await readFile(pkgPath, 'utf8'));
  assert.equal(repaired.dependencies['dsh-integrations'], pkg.dependencies['dsh-integrations']);
  assert.equal(repaired.dependencies['oh-my-dsh-slim'], pkg.dependencies['oh-my-dsh-slim']);
  assert.equal(repaired.dependencies['dsh-web-search-exa-parallel'], 'link:../../plugins/dsh-web-search-exa-parallel');
  const unchanged = await readFile(pkgPath, 'utf8');
  const again = await updateProfile({ home, ...base });
  assert.deepEqual(again.conflicts, []);
  assert.ok(!again.actions.some(a => a.reason === 'PROFILE_MANIFEST_REPAIR'));
  assert.equal(await readFile(pkgPath, 'utf8'), unchanged);
});

test('invalid or foreign local links conflict without applying or backing up', async t => {
  const home = await fixture(t);
  const pkgPath = join(home, '.dsh/profiles/desktop/package.json');
  const invalid = ['file:../../plugins/oh-my-dsh-slim', 'https://example.com/plugin', 'link:', 'link:\0', null, 12,
    'link:../../../plugins/oh-my-dsh-slim', 'link:../../plugins/dsh-web-search-exa-parallel',
    'link:/Users/egor/.dsh/plugins/oh-my-dsh-slim', 'link:~/.dsh/plugins/oh-my-dsh-slim',
    'link:$HOME/.dsh/plugins/oh-my-dsh-slim', 'link:../../plugins/oh-my-dsh%2D-slim'];
  for (const value of invalid) {
    const pkg = structuredClone(oldPkg);
    pkg.dependencies['oh-my-dsh-slim'] = value;
    await writeFile(pkgPath, JSON.stringify(pkg));
    const before = await snapshot(home);
    const preview = await updateProfile({ home, ...base });
    assert.ok(preview.conflicts.includes('LINK_CONFLICT'), String(value));
    assert.equal(preview.canApply, false);
    const result = await updateProfile({ home, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true, ...base });
    assert.equal(result.ok, false);
    assert.deepEqual(await snapshot(home), before);
  }
});

test('legacy JSON credential store becomes YAML and other stores stay untouched', async t => {
  const home = await fixture(t);
  const store = join(home, '.dsh/.credentials.yaml');
  await writeFile(store, '{\n  "version": 1,\n  "refs": {\n    "CLIPROXY_API_KEY": "synthetic-key"\n  }\n}\n');
  const preview = await updateProfile({ home, ...base });
  assert.ok(preview.actions.some(action => action.reason === 'CREDENTIAL_STORE_YAML'));
  const done = await updateProfile({ home, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(done.ok, true);
  assert.equal(await readFile(store, 'utf8'), 'version: 1\nrefs:\n  CLIPROXY_API_KEY: "synthetic-key"\n');
  const readable = await fixture(t);
  const readableStore = join(readable, '.dsh/.credentials.yaml');
  await writeFile(readableStore, '{"version":1,"refs":{"CLIPROXY_API_KEY":"synthetic-key"},"records":{}}\n');
  const readablePreview = await updateProfile({ home: readable, ...base });
  assert.ok(readablePreview.actions.some(action => action.reason === 'CREDENTIAL_STORE_YAML'));
  const readableDone = await updateProfile({ home: readable, dryRun: false, planHash: readablePreview.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(readableDone.ok, true);
  assert.equal(await readFile(readableStore, 'utf8'), 'version: 1\nrefs:\n  CLIPROXY_API_KEY: "synthetic-key"\n');
  const custom = await fixture(t);
  const customStore = join(custom, '.dsh/.credentials.yaml');
  const original = 'version: 1\nrefs:\n  OTHER: "keep-me"\n';
  await writeFile(customStore, original);
  const again = await updateProfile({ home: custom, ...base });
  assert.ok(!again.actions.some(action => action.reason === 'CREDENTIAL_STORE_YAML'));
  await updateProfile({ home: custom, dryRun: false, planHash: again.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(await readFile(customStore, 'utf8'), original);
});

test('second apply is a no-op without a new backup', async t => {
  const home = await fixture(t);
  await apply(home);
  const backups = await readdir(join(home, '.dsh/backups'));
  const again = await apply(home);
  assert.equal(again.ok, true); assert.equal(again.requiresRestart, false);
  assert.deepEqual(await readdir(join(home, '.dsh/backups')), backups);
  assert.deepEqual(again.actions.filter(a => a.op !== 'skip'), []);
});

test('differing pin conflicts and existing lockfile refuses', async t => {
  const pinned = await fixture(t, { pkg: { ...oldPkg, dependencies: { '@deepseek-ai/dsh-base': '0.2.0' } } });
  const r = await updateProfile({ home: pinned, ...base });
  assert.ok(r.conflicts.includes('PIN_CONFLICT'));
  const ready = structuredClone(oldPkg);
  ready.dependencies['dsh-integrations'] = 'link:../../bundles/dsh-integrations';
  ready.dependencies['oh-my-dsh-slim'] = 'link:../../plugins/oh-my-dsh-slim';
  ready.dsh.profile.bundles.push('dsh-integrations', 'oh-my-dsh-slim');
  const locked = await fixture(t, { pkg: ready });
  await writeFile(join(locked, '.dsh/profiles/desktop/pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n\n  .:\n    dependencies:\n      dsh-integrations:\n        specifier: link:../../bundles/dsh-integrations\n        version: link:../../bundles/dsh-integrations\n");
  const preview = await updateProfile({ home: locked, ...base });
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.actions.some(a => a.reason === 'PNPM_LINK_LOCK_UPDATED'));
  const done = await updateProfile({ home: locked, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(done.ok, true);
  const lock = await readFile(join(locked, '.dsh/profiles/desktop/pnpm-lock.yaml'), 'utf8');
  assert.match(lock, /dsh-web-search-exa-parallel:\n {8}specifier: link:\.\.\/\.\.\/plugins\/dsh-web-search-exa-parallel/);
  assert.match(lock, /dsh-integrations:/);
  const malformed = await fixture(t);
  await writeFile(join(malformed, '.dsh/profiles/desktop/pnpm-lock.yaml'), 'x');
  assert.ok((await updateProfile({ home: malformed, ...base })).conflicts.includes('UNEXPECTED_LOCK'));
  const npm = await fixture(t);
  await writeFile(join(npm, '.dsh/profiles/desktop/package-lock.json'), '{}');
  assert.ok((await updateProfile({ home: npm, ...base })).conflicts.includes('UNEXPECTED_LOCK'));
  const before = await snapshot(malformed);
  const p = await updateProfile({ home: malformed, ...base });
  const applied = await updateProfile({ home: malformed, dryRun: false, planHash: p.planHash, ...base });
  assert.equal(applied.ok, false);
  assert.deepEqual(await snapshot(malformed), before);
});

test('symlinked parents and files are refused', async t => {
  const home = await fixture(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(home, '.dsh/plugins'), { recursive: true });
  await symlink(outside, join(home, '.dsh/plugins/oh-my-dsh-slim'));
  const r = await updateProfile({ home, ...base });
  assert.ok(r.conflicts.includes('UNSAFE_PATH'));
  assert.deepEqual(await readdir(outside), []);
  const linkHome = join(home, '..', 'dsh-update-link-' + process.pid);
  await symlink(home, linkHome);
  t.after(() => rm(linkHome, { force: true }));
  await assert.rejects(updateProfile({ home: linkHome, ...base }), { code: 'UNSAFE_PATH' });
});

test('stale plan hash, lock and running app block apply', async t => {
  const home = await fixture(t);
  const p = await updateProfile({ home, ...base });
  await writeFile(join(home, '.dsh/profiles/desktop/package.json'), JSON.stringify({ ...oldPkg, changed: 1 }));
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p.planHash, ...base }), { code: 'STALE_PLAN' });
  assert.ok(!(await readdir(home)).includes('.dsh-setup.lock'));
  const p2 = await updateProfile({ home, ...base });
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p2.planHash, assertStoppedFn: async () => ({ ok: false }) }), { code: 'APP_RUNNING' });
  await mkdir(join(home, '.dsh-setup.lock'));
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p2.planHash, ...base }), { code: 'LOCKED' });
  await assert.rejects(updateProfile({ home, dryRun: false, ...base }), { code: 'PLAN_REQUIRED' });
});

test('injected failure rolls back transaction paths and keeps backup', async t => {
  const home = await fixture(t);
  const before = await readFile(join(home, '.dsh/profiles/desktop/package.json'), 'utf8');
  const p = await updateProfile({ home, ...base });
  let n = 0;
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, ...base, afterWrite: async () => { if (++n === 2) throw new Error('boom'); } }), e => e.code === 'UPDATE_FAILED' && !!e.backupPath);
  assert.equal(await readFile(join(home, '.dsh/profiles/desktop/package.json'), 'utf8'), before);
  assert.equal((await readdir(join(home, '.dsh/backups'))).length, 1);
  await assert.rejects(lstat(join(home, '.dsh/plugins/oh-my-dsh-slim/lib/index.js')));
});

test('modified relay workaround is preserved; modified managed files need acknowledgement; extras kept', async t => {
  const home = await fixture(t);
  await mkdir(join(home, '.dsh/plugins/zstd-render'), { recursive: true });
  await writeFile(join(home, '.dsh/plugins/zstd-render/index.js'), 'const ALIASES = {};\n');
  await mkdir(join(home, '.dsh/plugins/oh-my-dsh-slim/lib'), { recursive: true });
  await writeFile(join(home, '.dsh/plugins/oh-my-dsh-slim/package.json'), JSON.stringify({ name: 'oh-my-dsh-slim', version: '0.8.7-native.1' }));
  await writeFile(join(home, '.dsh/plugins/oh-my-dsh-slim/lib/index.js'), 'custom\n');
  await writeFile(join(home, '.dsh/plugins/oh-my-dsh-slim/mine.txt'), 'mine');
  const p = await updateProfile({ home, ...base });
  assert.ok(p.actions.some(a => a.reason === 'RELAY_WORKAROUND_PRESERVED'));
  assert.ok(p.actions.some(a => a.reason === 'EXTRA_FILE_PRESERVED'));
  assert.equal(p.requiresAck, true);
  const noAck = await updateProfile({ home, dryRun: false, planHash: p.planHash, ...base });
  assert.equal(noAck.ok, false); assert.deepEqual(noAck.conflicts, ['ACK_REQUIRED']);
  assert.equal(await readFile(join(home, '.dsh/plugins/oh-my-dsh-slim/lib/index.js'), 'utf8'), 'custom\n');
  const done = await updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(done.ok, true);
  assert.equal(await readFile(join(home, '.dsh/plugins/zstd-render/index.js'), 'utf8'), 'const ALIASES = {};\n');
  assert.equal(await readFile(join(home, '.dsh/plugins/oh-my-dsh-slim/mine.txt'), 'utf8'), 'mine');
  assert.notEqual(await readFile(join(home, '.dsh/plugins/oh-my-dsh-slim/lib/index.js'), 'utf8'), 'custom\n');
});

test('HTTP /api/update previews and applies with token and sanitized errors', async t => {
  const home = await fixture(t);
  const instance = createServer({ home, assertStoppedFn: ok, inspectEnvironmentFn: async () => ({ ok: true, blockers: [], checks: [], runtimePaths: {} }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.server.close(resolve)));
  const post = (body, token = instance.token) => fetch(instance.origin + '/api/update', { method: 'POST', headers: { 'X-DSH-Setup-Token': token, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await post({ dryRun: true }, 'bad')).status, 403);
  assert.equal((await post('x'.repeat(262145))).status, 413);
  assert.equal((await post({})).status, 400);
  const preview = await (await post({ dryRun: true })).json();
  assert.equal(preview.ok, true); assert.equal(preview.dryRun, true);
  const stale = await post({ dryRun: false, planHash: 'a'.repeat(64), acknowledgeManagedFiles: true });
  assert.equal(stale.status, 409);
  const text = await stale.text();
  assert.equal(JSON.parse(text).code, 'STALE_PLAN'); assert.ok(!text.includes(home));
  const applied = await (await post({ dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true })).json();
  assert.equal(applied.ok, true); assert.ok(applied.backupPath);
});

const slimPkg = v => JSON.stringify({ name: 'oh-my-dsh-slim', version: v });
async function withSlim(home, v) {
  await mkdir(join(home, '.dsh/plugins/oh-my-dsh-slim'), { recursive: true });
  await writeFile(join(home, '.dsh/plugins/oh-my-dsh-slim/package.json'), slimPkg(v));
}

test('unknown installed tree version blocks even with acknowledgement; known 0.8.7 predecessor upgrades', async t => {
  const home = await fixture(t);
  await withSlim(home, '0.9.0');
  const before = await snapshot(home);
  const p = await updateProfile({ home, ...base });
  assert.ok(p.conflicts.includes('TREE_VERSION_MISMATCH')); assert.equal(p.canApply, false);
  const r = await updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(r.ok, false);
  assert.deepEqual(await snapshot(home), before);
  const ok087 = await fixture(t);
  await withSlim(ok087, '0.8.7');
  await writeFile(join(ok087, '.dsh/plugins/oh-my-dsh-slim/extra.txt'), 'mine');
  const q = await updateProfile({ home: ok087, ...base });
  assert.ok(!q.conflicts.includes('TREE_VERSION_MISMATCH'));
  const pkgAction = q.actions.find(a => a.path === '.dsh/plugins/oh-my-dsh-slim/package.json');
  assert.equal(pkgAction.needsAck, true);
  const done = await updateProfile({ home: ok087, dryRun: false, planHash: q.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(done.ok, true);
  assert.equal(JSON.parse(await readFile(join(ok087, '.dsh/plugins/oh-my-dsh-slim/package.json'), 'utf8')).version, '0.8.7-native.1');
  assert.equal(await readFile(join(ok087, '.dsh/plugins/oh-my-dsh-slim/extra.txt'), 'utf8'), 'mine');
});

test('symlinked profile package/patch files are refused and targets untouched', async t => {
  const home = await fixture(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'p.json'), JSON.stringify(oldPkg));
  await rm(join(home, '.dsh/profiles/desktop/package.json'));
  await symlink(join(outside, 'p.json'), join(home, '.dsh/profiles/desktop/package.json'));
  const r = await updateProfile({ home, ...base });
  assert.ok(r.conflicts.includes('UNSAFE_PATH'));
  const done = await updateProfile({ home, dryRun: false, planHash: r.planHash, acknowledgeManagedFiles: true, ...base });
  assert.equal(done.ok, false);
  assert.equal(await readFile(join(outside, 'p.json'), 'utf8'), JSON.stringify(oldPkg));
});

test('payload change after preview is stale; incompatible app cannot apply; user-removed registry/models semantics', async t => {
  const home = await fixture(t);
  const payloadRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-payload-')));
  t.after(() => rm(payloadRoot, { recursive: true, force: true }));
  await mkdir(join(payloadRoot, 'plugins/foo'), { recursive: true });
  await writeFile(join(payloadRoot, 'plugins/foo/a.txt'), 'one');
  const p = await updateProfile({ home, payloadRoot, ...base });
  await writeFile(join(payloadRoot, 'plugins/foo/a.txt'), 'two');
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p.planHash, payloadRoot, acknowledgeManagedFiles: true, ...base }), { code: 'STALE_PLAN' });
  const env = await updateProfile({ home, payloadRoot, ...base, checkEnvironment: async () => ({ ok: false, checks: [{ id: 'app', ok: false }] }) });
  assert.ok(env.conflicts.includes('APP_INCOMPATIBLE')); assert.equal(env.canApply, false);
  // Missing registry row is a visible, separate action detail.
  const detail = p.actions.find(a => a.reason === 'PROFILE_PATCH_MERGE');
  assert.deepEqual(detail.details, ['PRESET_REGISTRY_ADDED']);
  // Empty model list is seeded; the seed is visible as a detail.
  const empty = await fixture(t, { patch: [oldPatch[0], { id: 'llm-pi-ai', config: { providers: { cliproxy: { models: [] } } } }, oldPatch[2]] });
  const e = await updateProfile({ home: empty, payloadRoot, ...base });
  assert.ok(e.actions.find(a => a.reason === 'PROFILE_PATCH_MERGE').details.includes('CATALOG_SEEDED'));
});

test('mid-transaction user edit gives STALE_PLAN, keeps the edit and restores earlier writes; backup bytes verified', async t => {
  const home = await fixture(t);
  const pkgPath = join(home, '.dsh/profiles/desktop/package.json');
  const patchPath = join(home, '.dsh/profiles/desktop/cordis.patch.yml');
  const origPkg = await readFile(pkgPath);
  await chmod(pkgPath, 0o640);
  const p = await updateProfile({ home, ...base });
  let backupPath;
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, ...base, afterWrite: async rel => { if (rel.endsWith('package.json')) await writeFile(patchPath, '[{"id":"user-edit"}]'); } }), e => { backupPath = e.backupPath; return e.code === 'STALE_PLAN'; });
  assert.equal(await readFile(patchPath, 'utf8'), '[{"id":"user-edit"}]');
  assert.deepEqual(await readFile(pkgPath), origPkg);
  assert.equal((await stat(pkgPath)).mode & 0o777, 0o640);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o700);
  const manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8'));
  assert.equal((await stat(join(backupPath, 'manifest.json'))).mode & 0o777, 0o600);
  const entry = manifest.files.find(f => f.path.endsWith('package.json'));
  assert.equal(entry.mode, 0o640); assert.equal(entry.size, origPkg.length);
  assert.equal(entry.sha256, createHash('sha256').update(origPkg).digest('hex'));
  const saved = join(backupPath, entry.backup);
  assert.deepEqual(await readFile(saved), origPkg);
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
});

test('failed rollback is surfaced as ROLLBACK_FAILED with backupPath', async t => {
  const home = await fixture(t);
  const pkgPath = join(home, '.dsh/profiles/desktop/package.json');
  const p = await updateProfile({ home, ...base });
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, ...base, afterWrite: async rel => { if (rel.endsWith('package.json')) { await rm(pkgPath); await mkdir(pkgPath); throw new Error('boom'); } } }), e => e.code === 'ROLLBACK_FAILED' && !!e.backupPath);
});

test('HTTP /api/update rejects bad origin, cross-site fetch metadata and non-JSON content type', async t => {
  const home = await fixture(t);
  const instance = createServer({ home, assertStoppedFn: ok, inspectEnvironmentFn: async () => ({ ok: true, blockers: [], checks: [], runtimePaths: {} }) });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.server.close(resolve)));
  const call = headers => fetch(instance.origin + '/api/update', { method: 'POST', headers: { 'X-DSH-Setup-Token': instance.token, 'Content-Type': 'application/json', ...headers }, body: '{"dryRun":true}' });
  assert.equal((await call({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call({})).status, 200);
  const hostStatus = await new Promise((resolve, reject) => http.request(instance.origin + '/api/update', { method: 'POST', headers: { 'X-DSH-Setup-Token': instance.token, Host: 'evil.example', 'Content-Type': 'application/json' } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject).end('{"dryRun":true}'));
  assert.equal(hostStatus, 403);
});
