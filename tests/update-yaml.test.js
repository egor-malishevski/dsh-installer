import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProfile } from '../lib/update.js';
import { parsePatch } from '../lib/yaml-patch.js';
import { models } from '../lib/profile.js';
import { NATIVE_CHAINS } from '../lib/fallback-migration.js';

const source = '# retained\n- id: agent-default-model\n  config: {model: fallback-main}\n- id: llm-pi-ai\n  config:\n    providers:\n      cliproxy:\n        models: []\n- id: oh-my-dsh-slim\n  note: !!js/function "throw new Error(\'never execute\')"\n  config: {}\n';
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-yaml-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.dsh/profiles/desktop');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), '{}');
  await writeFile(join(dir, 'cordis.patch.yml'), source);
  return { home, patch: join(dir, 'cordis.patch.yml') };
}
const stopped = async () => ({ ok: true });
test('YAML preview, apply and repeat preserve untouched source', async t => {
  const { home, patch } = await fixture(t);
  const preview = await updateProfile({ home });
  assert.deepEqual(preview.conflicts, []);
  assert.equal(await readFile(patch, 'utf8'), source);
  const applied = await updateProfile({ home, dryRun: false, planHash: preview.planHash, assertStoppedFn: stopped, acknowledgeManagedFiles: true });
  assert.equal(applied.ok, true);
  const out = await readFile(patch, 'utf8');
  assert.ok(out.startsWith('# retained\n'));
  assert.ok(out.includes('note: !!js/function "throw new Error(\'never execute\')"'));
  const rows = parsePatch(out).rows;
  assert.ok(rows.some(r => r.id === 'agent-preset-registry'));
  assert.ok(rows.find(r => r.id === 'llm-pi-ai').config.providers.cliproxy.models.length);
  const next = await updateProfile({ home });
  assert.deepEqual(next.conflicts, []);
  assert.equal(next.actions.filter(a => a.op !== 'skip').length, 0);
});
test('native migration preserves YAML catalogue aliases and opaque references', async t => {
  const { home, patch } = await fixture(t);
  const aliases = Object.keys(NATIVE_CHAINS).map(role => ({ id: `fallback-${role}` }));
  const roleLines = Object.keys(NATIVE_CHAINS).map(role => `      ${role}: {provider: cliproxy, model: fallback-${role}}`).join('\n');
  const input = `- id: agent-default-model\n  config: {model: fallback-main}\n- id: llm-pi-ai\n  config:\n    providers:\n      cliproxy:\n        models: ${JSON.stringify([...models, ...aliases, { id: 'fallback-main' }])}\n- id: oh-my-dsh-slim\n  note: !!js/function "fallback-fixer embedded"\n  config:\n    roles:\n${roleLines}\n`;
  await writeFile(patch, input);
  const preview = await updateProfile({ home, migrateNativeFallbacks: true });
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.actions.some(a => a.reason === 'ALIAS_STILL_REFERENCED'));
  const result = await updateProfile({ home, dryRun: false, planHash: preview.planHash, migrateNativeFallbacks: true, assertStoppedFn: stopped, acknowledgeManagedFiles: true });
  assert.equal(result.ok, true);
  const out = await readFile(patch, 'utf8'), rows = parsePatch(out).rows;
  assert.ok(out.includes('note: !!js/function "fallback-fixer embedded"'));
  const cat = rows.find(r => r.id === 'llm-pi-ai').config.providers.cliproxy.models;
  for (const item of aliases) assert.ok(cat.some(m => m.id === item.id));
  assert.ok(cat.some(m => m.id === 'fallback-main'));
  const roles = rows.find(r => r.id === 'oh-my-dsh-slim').config.roles;
  for (const role of Object.keys(NATIVE_CHAINS)) assert.equal(roles[role].model, NATIVE_CHAINS[role].primary);
});
test('invalid UTF-8 conflicts without profile writes or backups', async t => {
  const { home, patch } = await fixture(t);
  const bytes = Buffer.concat([Buffer.from(source), Buffer.from([0xff])]);
  await writeFile(patch, bytes);
  const preview = await updateProfile({ home });
  assert.ok(preview.conflicts.includes('PATCH_UNPARSEABLE'));
  assert.ok(!preview.actions.some(a => a.path === '.dsh/profiles/desktop/cordis.patch.yml'));
  const result = await updateProfile({ home, dryRun: false, planHash: preview.planHash, assertStoppedFn: stopped, acknowledgeManagedFiles: true });
  assert.equal(result.ok, false);
  assert.ok(result.conflicts.includes('PATCH_UNPARSEABLE'));
  assert.deepEqual(await readFile(patch), bytes);
  await assert.rejects(lstat(join(home, '.dsh/backups')), { code: 'ENOENT' });
});
test('valid UTF-8 BOM and CRLF survive profile changes', async t => {
  const { home, patch } = await fixture(t);
  const input = '\ufeff' + source.replaceAll('\n', '\r\n');
  await writeFile(patch, input);
  const preview = await updateProfile({ home });
  assert.deepEqual(preview.conflicts, []);
  const result = await updateProfile({ home, dryRun: false, planHash: preview.planHash, assertStoppedFn: stopped, acknowledgeManagedFiles: true });
  assert.equal(result.ok, true);
  const out = await readFile(patch, 'utf8');
  assert.ok(out.startsWith('\ufeff# retained\r\n'));
  assert.equal(out.replaceAll('\r\n', '').includes('\n'), false);
});
test('YAML transaction failure restores original bytes', async t => {
  const { home, patch } = await fixture(t);
  const preview = await updateProfile({ home });
  await assert.rejects(updateProfile({ home, dryRun: false, planHash: preview.planHash, assertStoppedFn: stopped, acknowledgeManagedFiles: true, afterWrite: async p => { if (p.endsWith('cordis.patch.yml')) throw Error('injected'); } }), { code: 'UPDATE_FAILED' });
  assert.equal(await readFile(patch, 'utf8'), source);
});
