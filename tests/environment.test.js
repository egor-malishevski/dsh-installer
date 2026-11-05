import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEnvironment, assertStopped } from '../lib/environment.js';
import { fileURLToPath } from 'node:url';

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

test('classifies desktop and host commands conservatively without leaking arguments', async () => {
  const app = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
  const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/dsh-desktop-host/lib/cli.js';
  const server = fileURLToPath(new URL('../server.js', import.meta.url));
  const installer = `${app} --expose-internals ${server}`;
  const check = rows => assertStopped('/home/me/custom profile', { ownPid: 123, listProcesses: async () => rows });
  for (const command of [`bash -c DSH_DESKTOP_NODE_EXECUTABLE=${app}`, `node script.js DSH_DESKTOP_NODE_EXECUTABLE=${app}`, installer, 'node script.js main_host=x', 'node /tmp/main-host.js.backup', 'node -e "console.log(\"/tmp/main-host.js\")"', 'node --eval=/tmp/main-host.js', 'node SECRET=/tmp/main-host.js', 'node script.js /tmp/main-host.js', 'node /tmp/other.js /tmp/main-host.js', 'node --require /tmp/x.js /tmp/other.js /tmp/main-host.js']) {
    assert.equal((await check([`124 ${command}`])).ok, true, command);
  }
  for (const command of [app, `"${app}"`, `${app} --expose-internals /other/server.js`, `${installer} extra`, `${app} --unknown`, 'node main-host.js', 'node /tmp/main_host.js', 'node --expose-internals /tmp/main-host.js', 'node -- /tmp/main-host.js', 'node "/tmp/main-host.js"', 'node /tmp/a spaced directory/main-host.js', 'node /tmp/main-host.js --profile desktop', 'node --require /tmp/x.js /tmp/main-host.js', 'node --require "/tmp/a spaced/x.js" /tmp/main-host.js', 'node --require /tmp/a spaced/x.js /tmp/main-host.js', 'node -rfoo /tmp/main-host.js', 'node --import /tmp/x.js /tmp/main-host.js', 'node --require /tmp/x.js -- /tmp/main-host.js', `node --require /tmp/x.js ${cli} web`, `node ${cli} web`, `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node --expose-internals ${cli} web`, `${app} DSH_HOME=/other profile SECRET=do-not-leak`]) {
    const result = await check([`123 ${app}`, `124 ${installer}`, `125 ${command}`]);
    assert.equal(result.ok, false, command);
    assert.ok(!JSON.stringify(result).includes('do-not-leak'));
  }
  assert.equal((await check([`123 ${app}`, `124 ${installer}`])).ok, true);
  for (const rows of [[], ['broken SECRET=do-not-leak'], [null], ['0 node'], [`123 ${installer}`, 'invalid']]) {
    const result = await check(rows);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
  assert.equal((await assertStopped('/home/me/.dsh', { listProcesses: async () => { throw new Error('secret'); } })).ok, false);
});

test('production collector requests arguments without environments and fails closed', async () => {
  const calls = [];
  const execFileFn = async (...args) => { calls.push(args); return { stdout: ' 123 node script.js\n' }; };
  assert.equal((await assertStopped('/home/me/.dsh', { ownPid: 999, execFileFn })).ok, true);
  assert.equal(calls[0][0], '/bin/ps');
  assert.deepEqual(calls[0][1], ['-ww', '-axo', 'pid=,args=']);
  assert.ok(calls[0][2].timeout > 0 && calls[0][2].maxBuffer > 0);
  const failed = await assertStopped('/home/me/.dsh', { execFileFn: async () => { throw new Error('secret'); } });
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes('secret'));
});
