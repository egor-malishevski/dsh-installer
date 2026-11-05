import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLegacyFallbackCleanup as plan } from '../lib/fallback-cleanup.js';

const aliases = ['main', 'oracle', 'designer', 'fixer', 'explorer', 'librarian'].map(x => ({ id: `fallback-${x}` }));
const fixture = () => [
  { id: 'agent-default-model', config: { provider: 'cliproxy', model: 'fallback-main', effort: 'high' } },
  { id: 'llm-pi-ai', config: { providers: { cliproxy: { models: [{ id: 'custom', extra: 1 }, ...aliases, { id: 'gpt-6.1-sol' }] } } } },
  { id: 'oh-my-dsh-slim', config: { roles: { oracle: { provider: 'cliproxy', model: 'real' } } } },
];
const opts = { cleanupLegacyFallbacks: true, mainModel: 'gpt-6.1-sol' };

test('rewrites main and removes aliases without mutating input, then is idempotent', () => {
  const input = fixture(), original = structuredClone(input);
  const r = plan(input, opts);
  assert.equal(r.ok, true); assert.equal(r.applied, true);
  assert.deepEqual(input, original);
  assert.deepEqual(r.entries[0].config, { provider: 'cliproxy', model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(r.entries[1].config.providers.cliproxy.models, [{ id: 'custom', extra: 1 }, { id: 'gpt-6.1-sol' }]);
  const again = plan(r.entries, { cleanupLegacyFallbacks: true });
  assert.equal(again.ok, true); assert.equal(again.applied, false); assert.deepEqual(again.entries, r.entries);
});

test('reference conflicts are atomic including unknown and opaque references', () => {
  for (const ref of ['fallback-oracle', 'cliproxy/fallback-designer', 'tag:${fallback-unknown}', 'fallback-main']) {
    const input = fixture(); input[2].config.reference = ref;
    const r = plan(input, opts);
    assert.equal(r.ok, false); assert.deepEqual(r.entries, input); assert.deepEqual(r.actions, []);
    assert.deepEqual(r.conflicts, [{ code: 'CLEANUP_ALIAS_REFERENCED' }]);
  }
});

test('other provider bare alias also blocks cleanup', () => {
  const input = fixture(); input.push({ config: { provider: 'other', model: 'fallback-fixer' } });
  assert.equal(plan(input, opts).conflicts[0].code, 'CLEANUP_ALIAS_REFERENCED');
});

test('requires real catalog target only when rewriting main', () => {
  for (const mainModel of [undefined, '', 'fallback-oracle', 'absent', 3]) {
    const input = fixture(), r = plan(input, { cleanupLegacyFallbacks: true, mainModel });
    assert.equal(r.ok, false); assert.deepEqual(r.entries, input);
  }
  const input = fixture(); input[0].config.model = 'custom';
  const r = plan(input, { ...opts, mainModel: 'gpt-6.1-sol' });
  assert.equal(r.ok, true); assert.equal(r.entries[0].config.model, 'custom');
});

test('disabled, missing catalog, duplicate ids and invalid JSON are safe', () => {
  const input = fixture(); assert.deepEqual(plan(input).entries, input); assert.equal(plan(input).applied, false);
  assert.equal(plan([], opts).ok, false);
  input[1].config.providers.cliproxy.models.push({ id: 'custom' });
  assert.equal(plan(input, opts).ok, false);
  assert.equal(plan(Array(1001).fill(null), opts).ok, false);
  let deep = {}; for (let i = 0; i < 34; i++) deep = { deep };
  assert.equal(plan([deep], opts).ok, false);
  assert.equal(plan([JSON.parse('{"__proto__":{}}')], opts).ok, false);
  assert.equal(plan([{ value: NaN }], opts).ok, false);
});
