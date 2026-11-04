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
  assert.deepEqual(ops[1], { id: 'web-search-multi', name: 'dsh-web-search-multi', config: { provider: 'bing', enableFallback: false } });
  assert.deepEqual(ops[2], { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'multi-search', fetchProvider: 'http' } });
  assert.ok(!plan.files.some(file => file.path.endsWith('/web-search-account.js')));
  const manifest = JSON.parse(plan.files.find(file => file.path === '.dsh/bundles/dsh-integrations/package.json').content);
  assert.equal(manifest.exports['./web-search-account'], undefined);
});

test('rejects relative home and blocks missing selected executable', async () => {
  const config = { apiUrl: 'https://example.org', apiKey: 'key', mcps: [], roles };
  await assert.rejects(buildInstallPlan(config, { targetHome: 'relative' }));
  await assert.rejects(buildInstallPlan(config, { targetHome: '/test' }));
  const plan = await buildInstallPlan({ ...config, mcps: [{ id: 'memory', values: {} }] }, { targetHome: '/test', relayPort: 19123 });
  assert.ok(plan.requirements.some(r => r.startsWith('BLOCKER:')));
});
