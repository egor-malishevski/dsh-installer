import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverModels, recommendRoles } from '../lib/discovery.js';
import { roles } from '../lib/config.js';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('discovers normalized models with bearer authentication and safe deduplication', async t => {
  const url = await fixture(t, (req, res) => {
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer secret');
    res.end(JSON.stringify({ data: [{ id: 'custom' }, { id: 'custom' }, { id: 'gpt-6.1-sol' }, { id: '../bad' }, { id: 'a'.repeat(192) }] }));
  });
  const models = await discoverModels(url, 'secret');
  assert.deepEqual(models.map(m => m.id), ['custom', 'gpt-6.1-sol']);
  assert.equal(models[0].reasoningEfforts, undefined);
  assert.deepEqual(recommendRoles(roles, [models[0]]).explorer, { model: 'cliproxy/custom', effort: '' });
});
test('short API keys do not filter valid model IDs', async t => {
  const url = await fixture(t, (req, res) => res.end(JSON.stringify({ data: [{ id: 'claude-haiku-5-5' }] })));
  assert.equal((await discoverModels(url, 'a'))[0].id, 'claude-haiku-5-5');
});
test('streaming error responses are canceled promptly without leaking secrets', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const url = await fixture(t, (req, res) => {
    res.on('close', closed);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.write('private-upstream-body');
  });
  await assert.rejects(discoverModels(url, 'private-api-key', { timeoutMs: 5000 }), error =>
    error.code === 'MODEL_DISCOVERY_FAILED' && !error.message.includes('private'));
  let timer;
  try {
    await Promise.race([disconnected, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream connection was not canceled')), 1000); })]);
  } finally { clearTimeout(timer); }
});
test('discovery rejects empty, malformed, error, redirect and timeout without leaking secrets', async t => {
  const url = await fixture(t, (req, res) => {
    if (req.headers.authorization === 'Bearer empty') return res.end('{"data":[]}');
    if (req.headers.authorization === 'Bearer invalid') return res.end('not json private');
    if (req.headers.authorization === 'Bearer error') { res.writeHead(500); return res.end('private'); }
    if (req.headers.authorization === 'Bearer redirect') { res.writeHead(302, { Location: '/leaked' }); return res.end(); }
  });
  for (const key of ['empty', 'invalid', 'error', 'redirect', 'timeout']) {
    await assert.rejects(discoverModels(url, key, { timeoutMs: 50 }), error => error.code === (key === 'empty' ? 'NO_MODELS' : 'MODEL_DISCOVERY_FAILED') && !error.message.includes(key));
  }
});
