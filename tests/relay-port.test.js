import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { probeRelayPort } from '../lib/relay-port.js';

test('selects a free loopback port and detects an occupied port', async t => {
  const occupied = createServer();
  await new Promise((resolve, reject) => occupied.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  assert.notEqual(await probeRelayPort(), port);
  await assert.rejects(probeRelayPort(port), { code: 'EADDRINUSE' });
});
