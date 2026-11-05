import test from 'node:test';
import assert from 'node:assert/strict';
import { planFallbackMigration, NATIVE_CHAINS } from '../lib/fallback-migration.js';

const eff = { low: 'low', medium: 'medium', high: 'high' };
const ids = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra', 'grok-4.7', 'grok-4.7-build-fast'];
const aliasIds = ['fallback-main', 'fallback-oracle', 'fallback-designer', 'fallback-fixer', 'fallback-explorer', 'fallback-librarian'];
const meta = id => ({ id, input: ['text', 'image'], ...(/^(claude|gpt)/.test(id) ? { reasoningEfforts: eff } : {}), custom: 1 });
const roleNames = Object.keys(NATIVE_CHAINS);
const GO = { migrateNativeFallbacks: true, nativeFallbacksSupported: true };

function fixture(over = {}) {
  const roles = {};
  for (const r of roleNames) roles[r] = { provider: 'cliproxy', model: `fallback-${r}`, ...(r === 'oracle' ? { effort: 'high' } : {}), sharedMcpTools: ['mcp__a__b'], temperature: 0.3, persona: 'p', futureField: { x: 1 } };
  return [
    { id: 'agent-default-model', config: { provider: 'cliproxy', model: 'fallback-main' } },
    { id: 'llm-pi-ai', config: { providers: { cliproxy: { baseURL: 'x', models: [...ids, ...aliasIds].map(meta), ...over.prov }, other: { a: 1 } } } },
    { id: 'oh-my-dsh-slim', unknown: 1, config: { orchestrator: { effort: 'high' }, roles, ...over.slim } },
  ];
}
const slimOf = e => e.find(r => r.id === 'oh-my-dsh-slim').config;
const modelsOf = e => e.find(r => r.id === 'llm-pi-ai').config.providers.cliproxy.models.map(m => m.id);

test('all five aliased roles migrate, fields preserved, no mutation', () => {
  const e = fixture(); const snap = JSON.stringify(e);
  const p = planFallbackMigration(e, GO);
  assert.equal(JSON.stringify(e), snap);
  assert.equal(p.ok, true); assert.equal(p.applied, true);
  const roles = slimOf(p.entries).roles;
  for (const r of roleNames) {
    const c = NATIVE_CHAINS[r], o = slimOf(e).roles[r];
    assert.equal(roles[r].provider, 'cliproxy'); assert.equal(roles[r].model, c.primary);
    assert.equal(roles[r].effort, o.effort);
    assert.deepEqual(roles[r].sharedMcpTools, o.sharedMcpTools); assert.equal(roles[r].temperature, 0.3);
    assert.equal(roles[r].persona, 'p'); assert.deepEqual(roles[r].futureField, { x: 1 });
    assert.deepEqual(roles[r].fallbacks.map(f => f.model), c.reserves);
    assert.ok(roles[r].fallbacks.length <= 3);
  }
  assert.equal(p.entries[2].unknown, 1);
  assert.deepEqual(slimOf(p.entries).orchestrator, { effort: 'high' });
  assert.notEqual(p.entries[2], e[2]);
});

test('fallback efforts by role and metadata', () => {
  const roles = slimOf(planFallbackMigration(fixture(), GO).entries).roles;
  assert.deepEqual(roles.oracle.fallbacks, [{ provider: 'cliproxy', model: 'gpt-6.1-sol', effort: 'high' }, { provider: 'cliproxy', model: 'claude-sonnet-5-5', effort: 'high' }]);
  assert.ok(roles.designer.fallbacks.every(f => f.effort === 'medium'));
  assert.ok(roles.fixer.fallbacks.every(f => f.effort === 'medium'));
  for (const r of ['explorer', 'librarian']) assert.ok(roles[r].fallbacks.every(f => !('effort' in f)));
  // metadata without effort support -> omitted
  const e = fixture(); e[1].config.providers.cliproxy.models = e[1].config.providers.cliproxy.models.map(m => ({ id: m.id }));
  const r2 = slimOf(planFallbackMigration(e, GO).entries).roles;
  assert.ok(r2.oracle.fallbacks.every(f => !('effort' in f)));
});

test('custom / non-alias / wrong provider unchanged, noop', () => {
  const e = fixture();
  const roles = slimOf(e).roles;
  roles.oracle = { provider: 'cliproxy', model: 'custom-x' };
  roles.designer = { provider: 'other', model: 'fallback-designer' };
  roles.fixer = { provider: 'cliproxy', model: 'fallback-oracle' };
  roles.explorer = { model: 'fallback-explorer' };
  roles.librarian = { provider: 'cliproxy', model: 'grok-4.7' };
  const p = planFallbackMigration(e, GO);
  assert.equal(p.status, 'noop'); assert.deepEqual(p.entries, e); assert.deepEqual(p.actions, []);
});

test('missing target model -> conflict, no mutation', () => {
  const e = fixture(); const p0 = e[1].config.providers.cliproxy;
  p0.models = p0.models.filter(m => m.id !== 'gpt-6.1-terra');
  const p = planFallbackMigration(e, GO);
  assert.equal(p.ok, false); assert.equal(p.applied, false);
  assert.ok(p.conflicts.some(c => c.code === 'MIGRATION_TARGET_MODEL_MISSING'));
  assert.deepEqual(p.entries, e);
});

test('missing catalogue refused safely', () => {
  const e = fixture().filter(r => r.id !== 'llm-pi-ai');
  const p = planFallbackMigration(e, GO);
  assert.equal(p.ok, false); assert.equal(p.conflicts[0].code, 'MIGRATION_CATALOG_MISSING'); assert.deepEqual(p.entries, e);
});

test('existing differing fallbacks -> MIGRATION_CONFIG_CONFLICT; identical idempotent', () => {
  const e = fixture(); slimOf(e).roles.fixer.fallbacks = [{ provider: 'cliproxy', model: 'grok-4.7' }];
  const p = planFallbackMigration(e, GO);
  assert.equal(p.ok, false); assert.deepEqual(p.conflicts, [{ code: 'MIGRATION_CONFIG_CONFLICT', role: 'fixer', scope: 'config.roles' }]);
  assert.deepEqual(p.entries, e);
  const e2 = fixture(); const first = planFallbackMigration(e2, GO);
  slimOf(e2).roles.oracle.fallbacks = first.entries[2].config.roles.oracle.fallbacks;
  assert.equal(planFallbackMigration(e2, GO).ok, true);
});

test('main alias preserved in default model and catalogue', () => {
  const p = planFallbackMigration(fixture(), GO);
  assert.deepEqual(p.entries[0].config, { provider: 'cliproxy', model: 'fallback-main' });
  assert.ok(modelsOf(p.entries).includes('fallback-main'));
  assert.deepEqual(modelsOf(p.entries).filter(i => i.startsWith('fallback-')), ['fallback-main']);
  assert.equal(p.actions.filter(a => a.code === 'ALIAS_REMOVED').length, 5);
  assert.deepEqual(p.entries[1].config.providers.other, { a: 1 });
  assert.deepEqual(p.entries[1].config.providers.cliproxy.baseURL, 'x');
});

test('referenced alias retained, unreferenced removed', () => {
  const e = fixture(); e.push({ id: 'custom-row', config: { model: 'cliproxy/fallback-oracle' } }, { id: 'c2', config: { list: [{ model: 'fallback-fixer' }] } });
  const p = planFallbackMigration(e, GO);
  assert.equal(p.ok, true);
  const m = modelsOf(p.entries);
  assert.ok(m.includes('fallback-oracle') && m.includes('fallback-fixer'));
  for (const a of ['designer', 'explorer', 'librarian']) assert.ok(!m.includes(`fallback-${a}`));
  assert.deepEqual(p.keeps.map(k => k.id).sort(), ['fallback-fixer', 'fallback-oracle']);
});

test('advanced.roles override migrates only matching; other scope conflicts not guessed', () => {
  const e = fixture(); const s = slimOf(e);
  s.roles = { oracle: { sharedMcpTools: ['tool'] } };
  s.advanced = { roles: { oracle: { provider: 'cliproxy', model: 'fallback-oracle', keep: 1 }, fixer: { provider: 'x', model: 'fallback-fixer' } }, unknownAdv: { a: 1 } };
  const p = planFallbackMigration(e, GO);
  const ns = slimOf(p.entries);
  assert.deepEqual(ns.roles.oracle, { sharedMcpTools: ['tool'] });
  assert.equal(ns.advanced.roles.oracle.model, 'claude-opus-5-5'); assert.equal(ns.advanced.roles.oracle.keep, 1);
  assert.deepEqual(ns.advanced.roles.fixer, { provider: 'x', model: 'fallback-fixer' });
  assert.deepEqual(ns.advanced.unknownAdv, { a: 1 });
  // fixer alias still referenced by advanced override -> kept
  assert.ok(modelsOf(p.entries).includes('fallback-fixer'));
  // conflict across scopes
  const e2 = fixture(); slimOf(e2).advanced = { roles: { oracle: { fallbacks: [{ provider: 'cliproxy', model: 'grok-4.7' }] } } };
  assert.equal(planFallbackMigration(e2, GO).conflicts[0].code, 'MIGRATION_CONFIG_CONFLICT');
});

test('opposite custom and partial routes conflict atomically in either scope', () => {
  for (const [scope, other] of [
    ['advanced', { provider: 'other', model: 'custom' }],
    ['base', { provider: 'other', model: 'custom', fallbacks: [{ provider: 'other', model: 'reserve' }] }],
    ['advanced', { provider: 'cliproxy' }],
    ['advanced', { model: 'fallback-oracle' }],
    ['base', { model: 'custom' }],
  ]) {
    const e = fixture();
    const s = slimOf(e);
    if (scope === 'advanced') s.advanced = { roles: { oracle: other } };
    else { s.roles.oracle = other; s.advanced = { roles: { oracle: { provider: 'cliproxy', model: 'fallback-oracle' } } }; }
    const before = structuredClone(e);
    const p = planFallbackMigration(e, GO);
    assert.equal(p.status, 'conflict');
    assert.ok(p.conflicts.some(c => c.code === 'MIGRATION_CONFIG_CONFLICT' && c.role === 'oracle'));
    assert.equal(p.applied, false); assert.deepEqual(p.entries, before); assert.deepEqual(e, before);
    assert.deepEqual(p.actions, []);
  }
});

test('advanced empty fallbacks override conflicts with base alias atomically', () => {
  const e = fixture();
  slimOf(e).advanced = { roles: { oracle: { fallbacks: [] } } };
  const before = structuredClone(e);
  const p = planFallbackMigration(e, GO);
  assert.equal(p.status, 'conflict');
  assert.ok(p.conflicts.some(c => c.code === 'MIGRATION_CONFIG_CONFLICT' && c.role === 'oracle' && c.scope === 'advanced.roles'));
  assert.equal(p.applied, false); assert.deepEqual(p.entries, before); assert.deepEqual(e, before);
  assert.deepEqual(p.actions, []);
});

test('identical opposite alias and tools-only override are safe', () => {
  const e = fixture();
  slimOf(e).advanced = { roles: { oracle: { provider: 'cliproxy', model: 'fallback-oracle', custom: 1 }, fixer: { sharedMcpTools: ['tool'] } } };
  const p = planFallbackMigration(e, GO);
  assert.equal(p.applied, true);
  assert.equal(slimOf(p.entries).roles.oracle.model, 'claude-opus-5-5');
  assert.equal(slimOf(p.entries).advanced.roles.oracle.model, 'claude-opus-5-5');
  assert.deepEqual(slimOf(p.entries).advanced.roles.fixer, { sharedMcpTools: ['tool'] });
});

test('second pass is noop', () => {
  const first = planFallbackMigration(fixture(), GO);
  const second = planFallbackMigration(first.entries, GO);
  assert.equal(second.status, 'noop'); assert.deepEqual(second.entries, first.entries); assert.deepEqual(second.actions, []);
});

test('gating: preview without opt-in or capability does not apply', () => {
  const e = fixture();
  const a = planFallbackMigration(e, {});
  assert.equal(a.applied, false); assert.equal(a.status, 'disabled'); assert.deepEqual(a.entries, e); assert.ok(a.actions.length > 0);
  const b = planFallbackMigration(e, { migrateNativeFallbacks: true });
  assert.equal(b.status, 'capability-required'); assert.deepEqual(b.entries, e); assert.equal(typeof b.requiresCapability, 'string');
});

test('invalid / oversized input refused with code only', () => {
  assert.equal(planFallbackMigration(null, GO).conflicts[0].code, 'MIGRATION_INPUT_INVALID');
  const cyc = fixture(); cyc[0].self = cyc;
  assert.equal(planFallbackMigration(cyc, GO).conflicts[0].code, 'MIGRATION_INPUT_INVALID');
  let deep = {}; const d = deep; for (let i = 0; i < 100; i++) deep = deep.n = {};
  assert.equal(planFallbackMigration([d], GO).ok, false);
});
