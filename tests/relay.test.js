import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { apply } from '../payload/plugins/zstd-render/index.js'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
async function close(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
function context() {
  let dispose
  return { ctx: { effect(fn) { dispose = fn() } }, cleanup() { dispose?.() } }
}

test('occupied relay port rejects activation and never takes over', { timeout: 5000 }, async () => {
  let requests = 0
  const occupied = http.createServer((_req, res) => { requests++; res.end() })
  const port = await listen(occupied)
  const scope = context()
  try {
    await assert.rejects(apply(scope.ctx, { host: '127.0.0.1', port, upstream: 'http://127.0.0.1:1', retryBindMs: 5 }), { code: 'EADDRINUSE', message: '[zstd-render] relay port occupied' })
    assert.equal(requests, 0)
    assert.equal(occupied.listening, true)
  } finally {
    scope.cleanup()
    await close(occupied)
  }
  const probe = http.createServer()
  try {
    probe.listen(port, '127.0.0.1')
    await once(probe, 'listening')
  } finally { await close(probe) }
})

test('dedicated relay forwards upstream path and authorization', { timeout: 5000 }, async () => {
  let observed
  const upstream = http.createServer((req, res) => {
    observed = { path: req.url, authorization: req.headers.authorization }
    res.end('ok')
  })
  const upstreamPort = await listen(upstream)
  const reservation = http.createServer()
  const port = await listen(reservation)
  await close(reservation)
  const scope = context()
  try {
    await apply(scope.ctx, { host: '127.0.0.1', port, upstream: `http://127.0.0.1:${upstreamPort}/custom`, logPath: '/dev/null' })
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer fixture-key' } })
    assert.equal(await response.text(), 'ok')
    assert.deepEqual(observed, { path: '/custom/v1/models', authorization: 'Bearer fixture-key' })
  } finally {
    scope.cleanup()
    await close(upstream)
  }
})
