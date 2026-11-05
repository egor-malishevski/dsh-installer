import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProfile } from '../lib/update.js';

const stopped = async () => ({ ok: true });
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'slim-update-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, '.dsh/profiles/desktop');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await mkdir(join(home, '.dsh/plugins'), { recursive: true });
  await cp(new URL('../payload/plugins/oh-my-dsh-slim', import.meta.url), join(home, '.dsh/plugins/oh-my-dsh-slim'), { recursive: true });
  await symlink('../../../plugins/oh-my-dsh-slim', join(profile, 'node_modules/oh-my-dsh-slim'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'oh-my-dsh-slim': 'link:../../plugins/oh-my-dsh-slim' }, dsh: { profile: { bundles: ['oh-my-dsh-slim'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'oh-my-dsh-slim', config: {} }, { id: 'custom', name: 'keep' }]));
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'locked');
  return { home, profile };
}
const preview = home => updateProfile({ home, scope: 'slim' });
test('slim no-op preserves patch and lock and ignores unrelated unsafe tree', async t => {
  const { home, profile } = await fixture(t);
  await symlink('/outside', join(home, '.dsh/plugins/unrelated'));
  const patch = await readFile(join(profile, 'cordis.patch.yml'));
  const p = await preview(home);
  assert.deepEqual(p.conflicts, []); assert.equal(p.actions.length, 0);
  const applied = await updateProfile({ home, scope: 'slim', dryRun: false, planHash: p.planHash, assertStoppedFn: stopped });
  assert.equal(applied.ok, true); assert.deepEqual(await readFile(join(profile, 'cordis.patch.yml')), patch);
  assert.equal(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8'), 'locked');
});
test('slim detects missing link and stale read-only manifest', async t => {
  const { home, profile } = await fixture(t);
  const p = await preview(home);
  await writeFile(join(profile, 'package.json'), (await readFile(join(profile, 'package.json'), 'utf8')) + ' ');
  await assert.rejects(updateProfile({ home, scope: 'slim', dryRun: false, planHash: p.planHash, assertStoppedFn: stopped }), { code: 'STALE_PLAN' });
  await unlink(join(profile, 'node_modules/oh-my-dsh-slim'));
  assert.ok((await preview(home)).conflicts.includes('SLIM_NOT_INSTALLED'));
});
test('slim validates options and hashes seed choice', async t => {
  const { home } = await fixture(t);
  const p = await preview(home);
  assert.notEqual(p.planHash, (await updateProfile({ home, scope: 'slim', seedNativeFallbacks: true })).planHash);
  for (const opts of [{ scope: 'other' }, { seedNativeFallbacks: 'true' }, { scope: 'slim', mainModel: undefined }, { scope: 'slim', cleanupLegacyFallbacks: true }]) await assert.rejects(updateProfile({ home, ...opts }), { code: 'BAD_UPDATE_OPTIONS' });
});
test('slim rolls back writes while preserving concurrent manifest edit', async t => {
  const { home, profile } = await fixture(t);
  const file = join(home, '.dsh/plugins/oh-my-dsh-slim/lib/index.js');
  await writeFile(file, 'modified');
  const p = await preview(home);
  assert.ok(p.requiresAck);
  await assert.rejects(updateProfile({ home, scope: 'slim', dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true, assertStoppedFn: stopped, afterWrite: async () => { await writeFile(join(profile, 'package.json'), 'user edit'); } }), { code: 'STALE_PLAN' });
  assert.equal(await readFile(file, 'utf8'), 'modified');
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), 'user edit');
});
