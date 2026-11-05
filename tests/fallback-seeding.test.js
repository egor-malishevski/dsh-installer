import test from 'node:test';
import assert from 'node:assert/strict';
import { planFallbackSeeding } from '../lib/fallback-seeding.js';

const ids = ['gpt-6.1-sol', 'gpt-6.1-terra', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'grok-4.7-build-fast', 'grok-4.7', 'fallback-main'];
const roles = ['oracle', 'designer', 'fixer', 'explorer', 'librarian'];
function fixture() {
  const primary = ['gpt-6.1-sol', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'grok-4.7-build-fast', 'grok-4.7'];
  return [
    { id: 'alfagen-main', config: { text: '!!js projection unrelated string' } },
    { id: 'llm-pi-ai', config: { providers: { cliproxy: { models: ids.map(id => ({ id, reasoningEfforts: { medium: {}, high: {} }, unknown: 1 })) } } } },
    { id: 'oh-my-dsh-slim', unknown: { x: 1 }, config: { roles: Object.fromEntries(roles.map((role, i) => [role, { provider: 'cliproxy', model: primary[i], ...(i < 3 ? { effort: i ? 'medium' : 'high' } : {}), sharedMcpTools: ['tool'], unknown: { value: 3 } }])) } },
  ];
}
const getRoles = e => e[2].config.roles;
const models = e => e[1].config.providers.cliproxy.models;

test('seeds all five explicit real primaries without changing anything else', () => {
  const input = fixture(), before = structuredClone(input);
  const result = planFallbackSeeding(input);
  assert.equal(result.ok, true); assert.equal(result.applied, true); assert.deepEqual(input, before);
  const expected = [['claude-opus-5-5', 'claude-sonnet-5-5'], ['gpt-6.1-terra', 'claude-opus-5-5'], ['gpt-6.1-terra', 'claude-opus-5-5'], ['claude-haiku-5-5', 'grok-4.7'], ['claude-sonnet-5-5', 'gpt-6.1-terra']];
  for (const [i, role] of roles.entries()) {
    const { fallbacks, ...rest } = getRoles(result.entries)[role];
    assert.deepEqual(rest, getRoles(before)[role]);
    assert.deepEqual(fallbacks.map(f => f.model), expected[i]);
    assert.ok(fallbacks.length <= 2);
    assert.ok(fallbacks.every(f => i < 3 ? f.effort === (i ? 'medium' : 'high') : !('effort' in f)));
  }
  assert.deepEqual(result.entries.slice(0, 2), before.slice(0, 2));
  const again = planFallbackSeeding(result.entries);
  assert.equal(again.applied, false); assert.deepEqual(again.entries, result.entries);
});

test('own fallbacks including null and empty are preserved', () => {
  const e = fixture(); getRoles(e).oracle.fallbacks = []; getRoles(e).designer.fallbacks = null;
  getRoles(e).fixer.fallbacks = [{ provider: 'custom', model: 'x' }];
  const p = planFallbackSeeding(e);
  for (const r of roles.slice(0, 3)) assert.deepEqual(getRoles(p.entries)[r], getRoles(e)[r]);
});

test('conflicting layers and selected preset refuse atomically', () => {
  for (const override of [{ advanced: { roles: { oracle: { model: 'other' } } } }, { preset: 'x', presets: { x: { oracle: { provider: 'cliproxy', model: 'grok-4.7' } } } }]) {
    const e = fixture(); Object.assign(e[2].config, override); const before = structuredClone(e);
    const p = planFallbackSeeding(e); assert.equal(p.ok, false); assert.equal(p.conflicts[0].code, 'SEED_CONFIG_CONFLICT');
    assert.deepEqual(p.entries, before); assert.deepEqual(e, before); assert.deepEqual(p.actions, []);
  }
});

test('missing primary and duplicate catalogue ids fail closed', () => {
  const e = fixture(); models(e).splice(0, 1);
  assert.equal(planFallbackSeeding(e).conflicts[0].code, 'SEED_TARGET_MODEL_MISSING');
  const d = fixture(); models(d).push({ id: ids[0] });
  assert.equal(planFallbackSeeding(d).conflicts[0].code, 'SEED_CATALOG_INVALID');
  const c = fixture(); c.push(structuredClone(c[1]));
  assert.equal(planFallbackSeeding(c).conflicts[0].code, 'SEED_CATALOG_AMBIGUOUS');
  const s = fixture(); s.push(structuredClone(s[2]));
  assert.equal(planFallbackSeeding(s).conflicts[0].code, 'SEED_SLIM_AMBIGUOUS');
});

test('missing reserves skip, unsupported routes skip and effort requires metadata', () => {
  const e = fixture(); e[2].config.roles = { oracle: getRoles(e).oracle, fixer: { provider: 'other', model: 'x' } };
  e[1].config.providers.cliproxy.models = [{ id: 'gpt-6.1-sol' }];
  const p = planFallbackSeeding(e); assert.equal(p.ok, true); assert.equal(p.applied, false);
  assert.ok(p.actions.some(a => a.code === 'SEED_NO_RESERVES')); assert.ok(p.actions.some(a => a.code === 'SEED_ROLE_SKIPPED'));
  models(e).push({ id: 'claude-opus-5-5', reasoningEfforts: { medium: {} } });
  assert.deepEqual(getRoles(planFallbackSeeding(e).entries).oracle.fallbacks, [{ provider: 'cliproxy', model: 'claude-opus-5-5' }]);
});
