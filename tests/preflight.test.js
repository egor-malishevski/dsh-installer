import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflight } from '../lib/preflight.js';
import { assertStopped } from '../lib/environment.js';
import { installPlan } from '../lib/install.js';

test('preflight reports unsupported system without modifying native data', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preflight-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.dsh'));
  await writeFile(join(home, '.dsh', 'keep'), 'untouched');
  const result = await preflight({ home, platform: 'linux', filesystem: { access: async () => { throw new Error(); } } });
  assert.ok(result.blockers.some(b => b.includes('macOS')));
  assert.ok(result.blockers.some(b => b.includes('0.2.1-rc.5')));
  assert.equal(await readFile(join(home, '.dsh', 'keep'), 'utf8'), 'untouched');
  assert.equal((await assertStopped(join(home, '.dsh'), { home, ownPid: 123, listProcesses: async () => ['124 node dsh-desktop-host/lib/cli.js web'] })).ok, false);
  await mkdir(join(home, '.dsh/profiles/desktop'), { recursive: true });
  await assert.rejects(installPlan({ targetHome: home, files: [{ path: '.dsh/profiles/desktop/test', content: '', secret: false }] }, { checkEnvironment: async () => true, checkStopped: async () => true }), { code: 'EXISTING_PROFILE' });
});

test('valid environment has no unconditional installation blocker', async () => {
  const execFileFn = async (file, args) => ({ stdout: file.endsWith('PlistBuddy') ? (args[1].includes('Identifier') ? 'com.deepseek.dsh' : '0.2.1-rc.5') : file.endsWith('/node') ? 'v22.0.0' : '/missing/tool' });
  const result = await preflight({ home: '/home/test', platform: 'darwin', execFileFn, filesystem: { access: async () => {} } });
  assert.deepEqual(result.blockers, []);
});
