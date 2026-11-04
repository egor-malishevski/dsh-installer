import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig, TOOL_NAMES } from '../payload/plugins/oh-my-dsh-slim/preset/config.js';
import { ROLE_TABLE, effectiveRoleFilter, fitFilterToKnown } from '../payload/plugins/oh-my-dsh-slim/preset/roles.js';

const root = new URL('../payload/plugins/oh-my-dsh-slim/', import.meta.url);
const defaults = JSON.parse(readFileSync(new URL('preset/defaults.json', root), 'utf8'));
const controls = ['create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'list_agents', 'interrupt_agent', 'subagent_result', ...Object.values(ROLE_TABLE).map(row => row.toolName)];

test('all ordinary roles deny orchestration tools, but retain parent communication and execution', () => {
  const config = loadConfig();
  for (const role of ['oracle', 'designer', 'fixer', 'explorer', 'librarian', 'observer']) {
    const policy = config.roles[role];
    const filter = effectiveRoleFilter(role, policy);
    for (const name of controls) {
      assert.ok(TOOL_NAMES.has(name), `${name} must validate`);
      assert.ok(filter.deny.includes(name), `${role} must deny ${name}`);
    }
    assert.ok(!filter.deny.includes('send_message'), `${role} needs parent reporting`);
    assert.ok(!filter.deny.includes('bash'), `${role} retains diagnostics`);
    if (['oracle', 'explorer', 'librarian', 'observer'].includes(role)) {
      assert.ok(filter.deny.includes('edit'));
      assert.ok(filter.deny.includes('write'));
    }
    const narrowed = effectiveRoleFilter(role, { ...policy, tools: [...controls, 'read', 'send_message'], deny: [...policy.deny, 'read'] });
    assert.ok(narrowed.deny.includes('read'));
    const known = ['read', 'send_message', 'create_goal', 'subagent_fixer'];
    const fitted = fitFilterToKnown(narrowed, known);
    assert.deepEqual(fitted.deny.sort(), ['create_goal', 'read', 'subagent_fixer']);
    assert.ok(fitted.allow.includes('send_message'));
  }
});

test('council seats remain read-only and synthesizer remains tool-less', () => {
  for (const role of ['councillor-alpha', 'councillor-beta', 'councillor-gamma']) {
    assert.deepEqual(effectiveRoleFilter(role, { tools: ['read', 'bash', 'subagent_fixer'] }).allow, ['read']);
  }
  assert.deepEqual(effectiveRoleFilter('council', { tools: ['bash'] }), { allow: [] });
});

test('settings UI and backend recognize identical global tool names', () => {
  const client = readFileSync(new URL('client/client.js', root), 'utf8');
  const list = client.match(/const TOOL_NAMES = \[([\s\S]*?)\];/)[1];
  const names = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...TOOL_NAMES].sort(), names.sort());
  for (const roles of Object.values(defaults.presets)) {
    for (const role of Object.values(roles)) {
      for (const name of [...(role.deny ?? []), ...(role.tools ?? [])]) assert.ok(TOOL_NAMES.has(name));
    }
  }
});

test('file policy, bounded QA and targeted research guidance ship in preset', () => {
  const source = readFileSync(new URL('preset/preset.js', root), 'utf8');
  assert.match(source, /SLIM_FILE_POLICY_V1/);
  assert.doesNotMatch(source, /Shell is acceptable for bulk or mechanical/);
  assert.doesNotMatch(source, /Prefer dedicated file tools/);
  assert.match(source, /validation-only/i);
  assert.match(source, /Context7/);
});
