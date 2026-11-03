import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEnvironment, assertStopped } from '../lib/environment.js';

test('verifies app identity, runtime execution and tool discovery without shell', async () => {
  const calls = [];
  const execFileFn = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file.endsWith('PlistBuddy')) return { stdout: args[1].includes('Identifier') ? 'com.deepseek.dsh' : '0.2.1-rc.5' };
    if (file.endsWith('/runtime/bin/node')) return { stdout: 'v22.3.0' };
    if (file === '/usr/bin/which') return { stdout: `/usr/local/bin/${args[0]}` };
    throw new Error('unexpected');
  };
  const result = await inspectEnvironment({ home: '/home/test', platform: 'darwin', appPath: '/App.app', execFileFn, filesystem: { access: async () => {} } });
  assert.equal(result.ok, true);
  assert.equal(result.targetHome, '/home/test/.dsh');
  assert.equal(result.runtimePaths.npx, '/usr/local/bin/npx');
  assert.equal(calls.find(call => call.file.endsWith('/runtime/bin/node')).options.env.DSH_DESKTOP_NODE_EXECUTABLE, '/App.app/Contents/MacOS/DeepSeek Harness');
  assert.ok(calls.every(call => Array.isArray(call.args)));
});

test('rejects wrong app identity and old bundled node', async () => {
  const execFileFn = async (file, args) => ({ stdout: file.endsWith('PlistBuddy') ? (args[1].includes('Identifier') ? 'other' : '0.2.1-rc.5') : file.endsWith('/node') ? 'v18.0.0' : '/bin/tool' });
  const result = await inspectEnvironment({ platform: 'darwin', execFileFn, filesystem: { access: async () => {} } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.id), ['app', 'node']);
});

test('checks target processes without exposing process environments', async () => {
  const app = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
  const rows = [`101 node main-host.js DSH_HOME=/other SECRET=do-not-leak`, `102 ${app} DSH_HOME=/other`];
  assert.equal((await assertStopped('/home/me/.dsh', { home: '/home/me', listProcesses: async () => rows })).ok, true);
  const result = await assertStopped('/home/me/.dsh', { home: '/home/me', listProcesses: async () => [`101 ${app} SECRET=do-not-leak`, '102 node main-host.js'] });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('do-not-leak'));
  assert.equal((await assertStopped('/home/me/.dsh', { listProcesses: async () => { throw new Error('secret'); } })).ok, false);
});

test('ignores only installer PID and fails closed on malformed process rows', async () => {
  const command = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals server.js';
  const options = { home: '/home/me', ownPid: 123 };
  const check = rows => assertStopped('/home/me/.dsh', { ...options, listProcesses: async () => rows });
  assert.equal((await check([`123 ${command}`])).ok, true);
  assert.equal((await check([`123 ${command}`, `124 ${command}`])).ok, false);
  assert.equal((await check([`123 ${command}`, '124 node main-host.js'])).ok, false);
  assert.equal((await check([`123 ${command}`, `124 ${command} DSH_HOME=/other`])).ok, true);
  for (const rows of [[], ['broken SECRET=do-not-leak'], [null], ['0 node'], [`123 ${command}`, 'invalid']]) {
    const result = await check(rows);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});
