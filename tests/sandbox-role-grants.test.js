import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KNOWN_GRANT_NAMES,
  KNOWN_GRANTS,
  applyGrantsToConfineResult,
  buildGrantForms,
  escapeSbplRegex,
  isSeatbeltConfineResult,
} from '../payload/plugins/oh-my-dsh-slim/preset/sandbox-role-grants.js';
import { loadConfig, resetConfigForTests, validateConfigDocument } from '../payload/plugins/oh-my-dsh-slim/preset/config.js';

const home = '/Users/tester';
const grantForm = KNOWN_GRANTS['coresim-device-data'](home);

function seatbeltOut(profile = '(version 1) (allow default) (deny file-write*)') {
  return {
    argv: ['sandbox-exec', '-p', profile, '--', 'true'],
    enforcement: 'full',
  };
}

test('KNOWN_GRANTS exposes coresim-device-data only', () => {
  assert.deepEqual([...KNOWN_GRANT_NAMES], ['coresim-device-data']);
  assert.match(grantForm, /CoreSimulator\/Devices\/\[0-9A-F-\]\{36\}\/data/);
  assert.match(grantForm, new RegExp(escapeSbplRegex(home)));
});

test('buildGrantForms appends only known names', () => {
  assert.deepEqual(buildGrantForms(['coresim-device-data'], home), [grantForm]);
  assert.deepEqual(buildGrantForms(['coresim-device-data', 'unknown-grant'], home), [grantForm]);
  assert.deepEqual(buildGrantForms([], home), []);
  // Empty home fails closed (explicit empty string, not omitted — omitted uses realpath home).
  assert.deepEqual(buildGrantForms(['coresim-device-data'], ''), []);
});

test('isSeatbeltConfineResult detects sandbox-exec -p shape', () => {
  assert.equal(isSeatbeltConfineResult(seatbeltOut()), true);
  assert.equal(isSeatbeltConfineResult({ argv: ['/usr/bin/sandbox-exec', '-p', 'x', '--', 'ls'] }), true);
  assert.equal(isSeatbeltConfineResult({ argv: ['bwrap', '--', 'ls'] }), false);
  assert.equal(isSeatbeltConfineResult({ argv: ['sandbox-exec', '-f', 'profile.sb', '--', 'ls'] }), false);
  assert.equal(isSeatbeltConfineResult({ argv: ['sandbox-exec', '-p'] }), false);
  assert.equal(isSeatbeltConfineResult(null), false);
});

test('applyGrantsToConfineResult appends grant for tester workspace-write seatbelt', () => {
  const out = seatbeltOut('(version 1) (deny file-write*)');
  const next = applyGrantsToConfineResult(
    out,
    { mode: 'workspace-write', sessionId: 'sess-1' },
    'tester',
    ['coresim-device-data'],
    home,
    'darwin',
  );
  assert.notEqual(next, out);
  assert.equal(next.argv[0], out.argv[0]);
  assert.equal(next.argv[1], '-p');
  assert.equal(next.argv[2], `${out.argv[2]} ${grantForm}`);
  assert.deepEqual(next.argv.slice(3), out.argv.slice(3));
  assert.equal(out.argv[2].includes('CoreSimulator'), false);
});

test('applyGrantsToConfineResult fails closed for other roles / modes / shapes', () => {
  const out = seatbeltOut();
  // Other roles reach this helper with empty/undefined grants (config has no sandboxGrants).
  const cases = [
    ['fixer', 'workspace-write', 'darwin', undefined],
    ['fixer', 'workspace-write', 'darwin', []],
    ['tester', 'read-only', 'darwin', ['coresim-device-data']],
    ['tester', 'workspace-write', 'linux', ['coresim-device-data']],
    [undefined, 'workspace-write', 'darwin', ['coresim-device-data']],
    ['tester', 'workspace-write', 'darwin', undefined],
    ['tester', 'workspace-write', 'darwin', []],
  ];
  for (const [roleId, mode, platform, grants] of cases) {
    const next = applyGrantsToConfineResult(out, { mode, sessionId: 's' }, roleId, grants, home, platform);
    assert.equal(next, out, `expected passthrough for ${roleId}/${mode}/${platform}/${JSON.stringify(grants)}`);
  }

  const nonSeatbelt = { argv: ['bwrap', '--ro-bind', '/', '/', '--', 'true'], enforcement: 'full' };
  assert.equal(
    applyGrantsToConfineResult(
      nonSeatbelt,
      { mode: 'workspace-write' },
      'tester',
      ['coresim-device-data'],
      home,
      'darwin',
    ),
    nonSeatbelt,
  );
});

test('defaults tester includes coresim-device-data sandboxGrant', () => {
  resetConfigForTests();
  const defaults = JSON.parse(readFileSync(new URL('../payload/plugins/oh-my-dsh-slim/preset/defaults.json', import.meta.url), 'utf8'));
  assert.deepEqual(defaults.presets['my-dsh-normal'].tester.sandboxGrants, ['coresim-device-data']);
  const config = loadConfig();
  assert.deepEqual(config.roles.tester.sandboxGrants, ['coresim-device-data']);
});

test('validateRole rejects unknown sandbox grant names', () => {
  assert.throws(
    () => validateConfigDocument({
      roles: { tester: { sandboxGrants: ['not-a-real-grant'] } },
    }),
    /unknown grant/,
  );
});

test('validateRole rejects sandboxGrants on council roles', () => {
  assert.throws(
    () => validateConfigDocument({
      roles: { 'councillor-alpha': { sandboxGrants: ['coresim-device-data'] } },
    }),
    /not supported for council roles/,
  );
});

test('validateOrchestrator rejects sandboxGrants', () => {
  assert.throws(
    () => validateConfigDocument({
      orchestrator: { sandboxGrants: ['coresim-device-data'] },
    }),
    /orchestrator\.sandboxGrants is unsupported/,
  );
});

test('preset registers sandbox-role-grants and orchestrator-tools at host scope', () => {
  const source = readFileSync(new URL('../payload/plugins/oh-my-dsh-slim/preset/preset.js', import.meta.url), 'utf8');
  assert.match(source, /\{ id: 'sandbox-role-grants', name: here\('sandbox-role-grants\.js'\) \}/);
  assert.match(source, /\{ id: 'orchestrator-tools', name: here\('orchestrator-tools\.js'\) \}/);
  assert.match(source, /Simulator device-data writes under CoreSimulator/);
  // Host-scope: after the delegation isolate group closes (role-mcp sibling).
  const delegationClose = source.indexOf("isolate: { workflowEngine: true }");
  const grantsIdx = source.indexOf("id: 'sandbox-role-grants'");
  const orchIdx = source.indexOf("id: 'orchestrator-tools'");
  assert.ok(delegationClose > 0 && grantsIdx > delegationClose);
  assert.ok(orchIdx > delegationClose && orchIdx < grantsIdx);
});
