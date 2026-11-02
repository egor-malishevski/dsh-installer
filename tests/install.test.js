import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installPlan } from '../lib/install.js';

const callbacks = () => ({ checkEnvironment: async () => true, checkStopped: async () => true });
const files = () => [{ path: '.dsh/profiles/desktop/config.json', content: 'secret-value', secret: true }, { path: '.dsh/profiles/desktop/other', content: Buffer.from('data'), secret: false }];
async function fixture(t) {
  const home = await mkdtemp(path.join(await realpath(os.tmpdir()), 'install-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
const code = expected => error => error.code === expected && error.message === expected;

test('installs privately, checks twice, preserves unrelated native data, and refuses retry', async t => {
  const home = await fixture(t);
  await mkdir(path.join(home, '.dsh'));
  await writeFile(path.join(home, '.dsh', 'native'), 'untouched');
  let env = 0, stopped = 0;
  const result = await installPlan({ targetHome: home, files: files() }, { checkEnvironment: async () => { env++; return true; }, checkStopped: async () => { stopped++; return true; } });
  assert.deepEqual(result, { ok: true, installedPaths: files().map(f => f.path), rollbackSupported: true });
  assert.equal(env, 2); assert.equal(stopped, 2);
  assert.equal(await readFile(path.join(home, '.dsh/native'), 'utf8'), 'untouched');
  for (const dir of ['.dsh/profiles', '.dsh/profiles/desktop']) assert.equal((await stat(path.join(home, dir))).mode & 0o777, 0o700);
  for (const file of files()) assert.equal((await stat(path.join(home, file.path))).mode & 0o777, 0o600);
  await assert.rejects(installPlan({ targetHome: home, files: files() }, callbacks()), code('EXISTING_PROFILE'));
  assert.equal(await readFile(path.join(home, files()[0].path), 'utf8'), 'secret-value');
  assert.deepEqual((await readdir(home)).sort(), ['.dsh']);
});

test('refuses existing desktop profile without changing bytes', async t => {
  const home = await fixture(t);
  await mkdir(path.join(home, '.dsh/profiles/desktop'), { recursive: true });
  await writeFile(path.join(home, '.dsh/profiles/desktop/config.json'), 'existing');
  await assert.rejects(installPlan({ targetHome: home, files: files() }, callbacks()), code('EXISTING_PROFILE'));
  assert.equal(await readFile(path.join(home, '.dsh/profiles/desktop/config.json'), 'utf8'), 'existing');
});

test('rejects traversal, duplicate paths, and symlink parents', async t => {
  const home = await fixture(t);
  for (const invalid of ['../outside', '/absolute', 'a/../b']) await assert.rejects(installPlan({ targetHome: home, files: [{ path: invalid, content: 'secret', secret: true }] }, callbacks()), code('INVALID_PLAN'));
  await assert.rejects(installPlan({ targetHome: home, files: [files()[0], files()[0]] }, callbacks()), code('INVALID_PLAN'));
  await mkdir(path.join(home, 'outside'));
  await symlink(path.join(home, 'outside'), path.join(home, '.dsh'));
  await assert.rejects(installPlan({ targetHome: home, files: files() }, callbacks()), code('UNSAFE_PATH'));
  assert.deepEqual(await readdir(path.join(home, 'outside')), []);
});

test('rolls back only created files and directories on failure', async t => {
  const home = await fixture(t);
  await mkdir(path.join(home, '.dsh'));
  await writeFile(path.join(home, '.dsh/native'), 'keep');
  await assert.rejects(installPlan({ targetHome: home, files: files() }, { ...callbacks(), afterWrite: async () => { throw new Error('secret-value'); } }), code('INSTALL_FAILED'));
  assert.deepEqual(await readdir(path.join(home, '.dsh')), ['native']);
  assert.equal(await readFile(path.join(home, '.dsh/native'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(home), ['.dsh']);
});

test('exclusive lock rejects concurrent installation', async t => {
  const home = await fixture(t);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const first = installPlan({ targetHome: home, files: files() }, { ...callbacks(), checkEnvironment: async () => { if (++calls === 1) { entered(); await blocked; } return true; } });
  await ready;
  assert.equal((await stat(path.join(home, '.dsh-setup.lock'))).mode & 0o777, 0o700);
  await assert.rejects(installPlan({ targetHome: home, files: files() }, callbacks()), code('LOCKED'));
  release();
  assert.equal((await first).ok, true);
});

test('allowlisted links roll back and arbitrary links are rejected', async t => {
  const home = await fixture(t);
  const payload = { path: '.dsh/bundles/dsh-integrations/package.json', content: '{}', secret: false };
  const link = { type: 'symlink', path: '.dsh/profiles/desktop/node_modules/dsh-integrations', target: '../../../bundles/dsh-integrations' };
  await assert.rejects(installPlan({ targetHome: home, files: [payload, { ...link, target: '../../../../../../etc' }] }, callbacks()), code('INVALID_PLAN'));
  await assert.rejects(installPlan({ targetHome: home, files: [payload, link] }, { ...callbacks(), afterWrite: async p => { if (p === link.path) throw new Error('fail'); } }), code('INSTALL_FAILED'));
  assert.deepEqual(await readdir(home), []);
});
