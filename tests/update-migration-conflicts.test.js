import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProfile } from '../lib/update.js';
import { models as catalog } from '../lib/profile.js';

const options = { migrateNativeFallbacks: true, assertStoppedFn: async () => ({ ok: true }) };
const alias = { provider: 'cliproxy', model: 'fallback-oracle', effort: 'high' };
const custom = { provider: 'cliproxy', model: 'custom-model', sharedMcpTools: ['mcp__example__tool'] };

async function fixture(t, baseRole, advancedRole) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-cross-scope-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, '.dsh/profiles/desktop');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true }));
  const rows = [
    { id: 'agent-default-model', name: 'm', config: { provider: 'cliproxy', model: 'fallback-main' } },
    { id: 'llm-pi-ai', name: 'p', config: { providers: { cliproxy: { models: [...catalog, { id: 'fallback-oracle' }, { id: 'fallback-main' }, { id: 'custom-model' }] } } } },
    { id: 'agent-preset-registry', name: 'r', config: { default: 'oh-my-dsh-slim' } },
    { id: 'oh-my-dsh-slim', name: 's', config: { roles: { oracle: baseRole }, advanced: { roles: { oracle: advancedRole } } } },
  ];
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(rows));
  await mkdir(join(home, '.dsh/plugins/oh-my-dsh-slim'), { recursive: true });
  await writeFile(join(home, '.dsh/plugins/oh-my-dsh-slim/package.json'), JSON.stringify({ name: 'oh-my-dsh-slim', version: '0.8.7' }));
  return home;
}

// Capture all existing files, links and directories (including modes), not just the profile patch.
async function snapshot(root) {
  const result = {};
  async function walk(rel) {
    for (const name of (await readdir(join(root, rel))).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const full = join(root, child);
      const st = await lstat(full);
      if (st.isDirectory()) { result[`${child}/`] = st.mode & 0o777; await walk(child); }
      else if (st.isSymbolicLink()) result[child] = { link: await readlink(full) };
      else result[child] = { mode: st.mode & 0o777, bytes: (await readFile(full)).toString('base64') };
    }
  }
  await walk('');
  return result;
}

for (const [description, baseRole, advancedRole] of [
  ['base alias with advanced custom route', alias, custom],
  ['base alias with explicit empty advanced fallbacks', alias, { fallbacks: [] }],
  ['base custom route with advanced alias', custom, alias],
]) {
  test(`${description}: preview conflicts and apply leaves no writes`, async t => {
    const home = await fixture(t, baseRole, advancedRole);
    const before = await snapshot(home);
    const preview = await updateProfile({ home, ...options });
    assert.ok(preview.conflicts.includes('MIGRATION_CONFIG_CONFLICT'), JSON.stringify(preview.conflicts));
    assert.equal(preview.canApply, false);
    assert.deepEqual(await snapshot(home), before, 'preview must not write');
    const applied = await updateProfile({ home, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true, ...options });
    assert.equal(applied.ok, false);
    assert.ok(applied.conflicts.includes('MIGRATION_CONFIG_CONFLICT'));
    assert.deepEqual(await snapshot(home), before, 'apply must leave no backup, lock, stage, or other mutation');
  });
}
