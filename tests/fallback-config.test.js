import test from 'node:test';
import assert from 'node:assert/strict';
import { roles, validateConfig, normalizeFallbacks } from '../lib/config.js';
import { generateProfile, models } from '../lib/profile.js';
import { recommendRoles, invalidRoles, profileModels } from '../lib/discovery.js';

const config = () => ({ apiUrl: 'https://api.example.com', apiKey: 'secret', mcps: [], roles: structuredClone(roles) });
const discovered = ids => models.filter(m => ids.includes(m.id)).map(m => ({ ...m, ...(m.reasoningEfforts ? { reasoningEfforts: Object.keys(m.reasoningEfforts) } : {}) }));
const slimOf = (c, availableModels) => JSON.parse(generateProfile(c, { targetHome: '/home/a', availableModels })[1].content).find(r => r.id === 'oh-my-dsh-slim').config;
const all = discovered(models.map(m => m.id));

test('old role configs without fallbacks validate and generate no fallbacks key', () => {
  validateConfig(config());
  const slim = slimOf(config());
  for (const name of ['oracle', 'designer', 'fixer', 'explorer', 'librarian']) assert.equal('fallbacks' in slim.roles[name], false);
  assert.equal(slim.orchestrator.fallbacks, undefined);
});

test('accepts native and route-form fallbacks, generates explicit provider+model, effort only if given', () => {
  const c = config();
  c.roles.oracle.fallbacks = [{ provider: 'cliproxy', model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-sonnet-5-5' }, { model: 'cliproxy/grok-4.7', effort: '' }];
  validateConfig(c);
  assert.deepEqual(slimOf(c).roles.oracle.fallbacks, [
    { provider: 'cliproxy', model: 'claude-opus-5-5', effort: 'high' },
    { provider: 'cliproxy', model: 'claude-sonnet-5-5' },
    { provider: 'cliproxy', model: 'grok-4.7' },
  ]);
  c.roles.fixer.fallbacks = [];
  validateConfig(c);
  assert.equal('fallbacks' in slimOf(c).roles.fixer, false);
});

test('rejects invalid fallbacks', () => {
  const dup = { model: 'claude-opus-5-5' };
  for (const [name, value] of [
    ['oracle', 'x'], ['oracle', {}], ['oracle', [null]], ['oracle', [dup, dup]],
    ['oracle', [{ model: 'gpt-6.1-sol' }]], // equals primary
    ['oracle', [{ model: 'a' }, { model: 'b' }, { model: 'c' }, { model: 'd' }]],
    ['oracle', [{ provider: 'other', model: 'x' }]],
    ['oracle', [{ model: 'x;bad' }]], ['oracle', [{ model: '' }]], ['oracle', [{ provider: 'cliproxy' }]],
    ['oracle', [{ model: 'x', effort: 'xhigh' }]], ['oracle', [{ model: 'x', extra: 1 }]],
    ['main', [{ model: 'x' }]], ['orchestrator', []],
  ]) {
    const c = config(); c.roles[name].fallbacks = value; assert.throws(() => validateConfig(c), undefined, `${name} ${JSON.stringify(value)}`);
  }
  assert.throws(() => normalizeFallbacks('oracle', { model: 'cliproxy/a', fallbacks: [{ model: 'a' }] }));
});

test('defaults: reserves are cross-family, ranked, deduped, available-only, max 2', () => {
  const r = recommendRoles(roles, all);
  assert.deepEqual(r.oracle.model, 'cliproxy/gpt-6.1-sol');
  assert.deepEqual(r.oracle.fallbacks.map(f => f.model), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(r.designer.fallbacks.map(f => f.model), ['gpt-6.1-terra', 'claude-opus-5-5']);
  assert.deepEqual(r.fixer.fallbacks.map(f => f.model), ['gpt-6.1-terra', 'claude-opus-5-5']);
  assert.deepEqual(r.explorer.fallbacks.map(f => f.model), ['grok-4.7-build-fast', 'grok-4.7']);
  assert.deepEqual(r.librarian.fallbacks.map(f => f.model), ['claude-sonnet-5-5', 'gpt-6.1-terra']);
  assert.equal(r.main.fallbacks, undefined);
  assert.equal(r.orchestrator.fallbacks, undefined);
  for (const [name, role] of Object.entries(r)) for (const f of role.fallbacks ?? []) {
    assert.equal(f.provider, 'cliproxy'); assert.notEqual(`cliproxy/${f.model}`, role.model, name);
  }
  // explicit high/medium effort carried only when the reserve supports it; never required on grok
  assert.deepEqual(r.oracle.fallbacks[0], { provider: 'cliproxy', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(r.librarian.fallbacks[0].effort, undefined);
  assert.equal(r.explorer.fallbacks[0].effort, undefined);
  assert.deepEqual(invalidRoles(r, all), []);
});

test('user chains with user-selected primaries are kept and reserves follow conditional ranking', () => {
  const c = structuredClone(roles);
  c.oracle = { model: 'cliproxy/claude-opus-5-5', effort: 'high' };
  c.explorer = { model: 'cliproxy/grok-4.7-build-fast', effort: '' };
  const r = recommendRoles(c, all);
  assert.equal(r.oracle.model, 'cliproxy/claude-opus-5-5');
  assert.deepEqual(r.oracle.fallbacks.map(f => f.model), ['gpt-6.1-sol', 'claude-sonnet-5-5']);
  assert.equal(r.explorer.model, 'cliproxy/grok-4.7-build-fast');
  assert.deepEqual(r.explorer.fallbacks.map(f => f.model), ['claude-haiku-5-5', 'grok-4.7']);
  assert.equal(r.main.model, 'cliproxy/claude-opus-5-5');
});

test('unavailable models are never invented; missing inventory yields no/fewer reserves', () => {
  const only = discovered(['claude-sonnet-5-5']);
  const r = recommendRoles(roles, only);
  for (const name of ['oracle', 'designer', 'fixer', 'explorer', 'librarian']) {
    assert.equal(r[name].model, 'cliproxy/claude-sonnet-5-5');
    assert.equal(r[name].fallbacks, undefined, name);
  }
  const some = recommendRoles(roles, discovered(['claude-sonnet-5-5', 'grok-4.7']));
  assert.deepEqual(some.librarian.fallbacks, [{ provider: 'cliproxy', model: 'claude-sonnet-5-5', effort: undefined }].map(({ effort, ...f }) => f));
  assert.deepEqual(recommendRoles(roles, [{ id: 'custom', name: 'custom', input: ['text', 'image'] }]).oracle.fallbacks, undefined);
});

test('explicit fallbacks preserved by recommend, invalid when unavailable or unsupported effort', () => {
  const c = structuredClone(roles);
  c.fixer.fallbacks = [{ model: 'claude-opus-5-5', effort: 'low' }];
  c.oracle.fallbacks = [];
  const r = recommendRoles(c, all);
  assert.deepEqual(r.fixer.fallbacks, [{ provider: 'cliproxy', model: 'claude-opus-5-5', effort: 'low' }]);
  assert.deepEqual(r.oracle.fallbacks, []);
  assert.deepEqual(invalidRoles(r, all), []);
  assert.deepEqual(invalidRoles({ ...r, fixer: { ...r.fixer, fallbacks: [{ provider: 'cliproxy', model: 'nope' }] } }, all), ['fixer']);
  assert.deepEqual(invalidRoles({ ...r, fixer: { ...r.fixer, fallbacks: [{ provider: 'cliproxy', model: 'grok-4.7', effort: 'high' }] } }, all), ['fixer']);
  assert.deepEqual(invalidRoles({ ...r, fixer: { ...r.fixer, fallbacks: [{ provider: 'deepseek-account', model: 'x' }] } }, all), ['fixer']);
});

test('generated profile from recommended roles keeps main real model and metadata seed intact', () => {
  const r = recommendRoles(roles, all);
  const c = { ...config(), roles: r };
  validateConfig(c);
  const rows = JSON.parse(generateProfile(c, { targetHome: '/home/a', availableModels: profileModels(all) })[1].content);
  assert.deepEqual(rows.find(x => x.id === 'agent-default-model').config, { provider: 'cliproxy', model: 'claude-opus-5-5' });
  assert.equal(rows.find(x => x.id === 'oh-my-dsh-slim').config.roles.oracle.fallbacks.length, 2);
  assert.equal(rows.find(x => x.id === 'oh-my-dsh-slim').config.orchestrator.fallbacks, undefined);
});
