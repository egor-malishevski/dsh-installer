import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallPlan } from '../lib/plan.js';
import { roles } from '../lib/config.js';

test('plan includes curated files and protects credentials', async () => {
  const config = { apiUrl: 'https://example.org/v1', apiKey: 'key-secret', mcps: [{ id: 'gitlab', values: { url: 'https://git.example', token: 'token-secret' } }], roles };
  const plan = await buildInstallPlan(config, { targetHome: '/test', relayPort: 19123, runtimePaths: { npx: process.execPath } });
  assert.ok(plan.files.length > 34);
  assert.ok(!plan.requirements.some(r => r.startsWith('BLOCKER:')));
  const publicFiles = plan.files.filter(file => !file.secret).map(file => String(file.content || '')).join('\n');
  assert.doesNotMatch(publicFiles, /key-secret|token-secret/);
  const patch = plan.files.find(file => file.path === '.dsh/bundles/dsh-integrations/cordis.patch.yml').content;
  assert.match(patch, /!!js/);
  assert.match(patch, /https:\/\/example.org/);
  assert.doesNotMatch(patch, /https:\/\/example.org\/v1/);
  assert.equal(JSON.parse(patch.replace(/!!js ("(?:\\.|[^"\\])*")/g, '$1'))[0].insert[0].config.port, 19123);
  assert.match(plan.files.find(file => file.path === '.dsh/profiles/desktop/cordis.patch.yml').content, /127\.0\.0\.1:19123\/v1/);
  assert.equal(plan.files.filter(file => file.type === 'symlink').length, 3);
  const ops = JSON.parse(patch.replace(/!!js ("(?:\\.|[^"\\])*")/g, '$1'));
  assert.ok(!ops[0].insert.some(row => row.id === 'cliproxy-models'));
  assert.ok(!plan.files.some(file => file.path.includes('cliproxy-models')));
  assert.deepEqual(ops[1], { id: 'web-search-exa-parallel', name: 'dsh-web-search-exa-parallel' });
  assert.deepEqual(ops[2], { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'exa-parallel', fetchProvider: 'http' } });
  assert.ok(!ops[0].insert.some(row => row.id === 'web-search-exa-parallel'));
  assert.ok(!plan.files.some(file => file.path.endsWith('/web-search-account.js')));
  const manifest = JSON.parse(plan.files.find(file => file.path === '.dsh/bundles/dsh-integrations/package.json').content);
  assert.equal(manifest.exports['./web-search-account'], undefined);
});

test('fresh home plans an owner-only credential store; existing store is skipped with a visible requirement', async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'dsh-plan-'));
  try {
    const config = { apiUrl: 'https://example.org/v1', apiKey: ' synthetic-plan-key ', mcps: [], roles };
    const options = { targetHome: home, relayPort: 19123, runtimePaths: {} };
    const fresh = await buildInstallPlan(config, options);
    const store = fresh.files.filter(file => file.path === '.dsh/.credentials.yaml');
    assert.equal(store.length, 1);
    assert.equal(store[0].secret, true);
    assert.equal(store[0].content, 'version: 1\nrefs:\n  CLIPROXY_API_KEY: "synthetic-plan-key"\n');
    assert.ok(!fresh.requirements.some(r => /credentials\.yaml/.test(r)));
    assert.ok(!JSON.stringify(fresh.requirements).includes('synthetic-plan-key'));
    assert.ok(!fresh.files.some(file => file.path.includes('cliproxy-key')));

    await mkdir(join(home, '.dsh'));
    await writeFile(join(home, '.dsh/.credentials.yaml'), 'version: 1\nrefs: {}\n');
    const existing = await buildInstallPlan(config, options);
    assert.ok(!existing.files.some(file => file.path === '.dsh/.credentials.yaml'));
    assert.ok(existing.requirements.some(r => /credentials\.yaml/.test(r) && /Settings → Models → CLIProxyAPI.*Save/.test(r) && !r.startsWith('BLOCKER:')));
    assert.ok(!JSON.stringify(existing.requirements).includes('synthetic-plan-key'));
    assert.ok(!existing.files.some(file => String(file.content || '').includes('synthetic-plan-key') && !file.secret));

    // A dangling symlink still counts as present: never write through it.
    await rm(join(home, '.dsh/.credentials.yaml'));
    await symlink(join(home, 'nowhere'), join(home, '.dsh/.credentials.yaml'));
    const dangling = await buildInstallPlan(config, options);
    assert.ok(!dangling.files.some(file => file.path === '.dsh/.credentials.yaml'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('rejects relative home and blocks missing selected executable', async () => {
  const config = { apiUrl: 'https://example.org', apiKey: 'key', mcps: [], roles };
  await assert.rejects(buildInstallPlan(config, { targetHome: 'relative' }));
  await assert.rejects(buildInstallPlan(config, { targetHome: '/test' }));
  const plan = await buildInstallPlan({ ...config, mcps: [{ id: 'memory', values: {} }] }, { targetHome: '/test', relayPort: 19123 });
  assert.ok(plan.requirements.some(r => r.startsWith('BLOCKER:')));
});
