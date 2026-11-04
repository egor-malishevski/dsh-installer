import { test } from 'node:test'
import assert from 'node:assert/strict'
const plugin = import('../payload/plugins/dsh-web-search-exa-parallel/lib/index.js')
const rpc = result => ({ jsonrpc: '2.0', id: 1, result })
const exa = rpc({ content: [{ type: 'text', text: 'Title: One\nURL: https://one.example\nPublished: 2025-01-01\nHighlights: first\nmore\n\n---\n\nTitle: Two\nURL: https://two.example/\nText: second\n\n---\n\nTitle: Three\nURL: https://three.example\nHighlights: third\n\n---\n\nTitle: None\nURL: N/A' }] })
const parallel = rpc({ structuredContent: { session_id: 'private', results: [ { url: 'https://parallel.example', title: 'Parallel', publish_date: '2025-01-02', excerpts: ['first', 'second'] } ] } })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const sse = value => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const provider = async (fetch, extra = {}) => new (await plugin).ExaParallelSearchProvider({ fetch, ...extra })

test('registration and available lifecycle', async () => {
  const m = await plugin, providers = []
  assert.equal(m.name, 'dsh-web-search-exa-parallel')
  assert.deepEqual(m.inject, ['web'])
  assert.equal(m.apply({ web: { registerSearchProvider(p) { providers.push(p) } } }), undefined)
  assert.equal(providers.length, 1); assert.equal(providers[0].id, 'exa-parallel'); assert.equal(providers[0].available(), true)
})

test('Exa real SSE blocks, request shape, canonical URLs', async () => {
  const calls = []
  const p = await provider(async (url, opts) => { calls.push([url, opts]); return sse(exa) })
  const result = await p.search({ query: 'hello' })
  assert.equal(result.sources.length, 3); assert.equal(result.sources[0].url, 'https://one.example/')
  assert.equal(result.sources[0].snippet, 'first\nmore'); assert.equal(result.sources[0].publishedAt, '2025-01-01T00:00:00.000Z')
  assert.equal(result.truncated, false); assert.equal(calls.length, 1)
  assert.equal(calls[0][1].redirect, 'error')
  assert.deepEqual(Object.keys(calls[0][1].headers).sort(), ['Accept', 'Content-Type'])
  assert.deepEqual(JSON.parse(calls[0][1].body).params, { name: 'web_search_exa', arguments: { query: 'hello', numResults: 8 } })
})

test('Exa body cannot replace its source URL', async () => {
  const { parseExa } = await plugin
  const result = parseExa({ content: [{ type: 'text', text: 'URL: https://good.example\nHighlights:\nfoo\nURL: https://evil.com\nbar' }] })
  assert.equal(result.sources[0].url, 'https://good.example/')
  assert.equal(result.sources[0].snippet, 'foo\nURL: https://evil.com\nbar')
})

test('Exa unknown metadata does not corrupt URL', async () => {
  const { parseExa } = await plugin
  const result = parseExa({ content: [{ type: 'text', text: 'URL: https://ex.com/path\nPublished Date: 2025-01-01' }] })
  assert.equal(result.sources[0].url, 'https://ex.com/path')
})

test('SSE ignores server requests with matching id', async () => {
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  const body = `data: ${ping}\n\ndata: ${JSON.stringify(exa)}\n\n`
  const p = await provider(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal((await p.search({ query: 'q' })).sources[0].url, 'https://one.example/')
})

test('fallback to Parallel structured response, no session sharing', async () => {
  const calls = []
  const p = await provider(async (url, opts) => { calls.push([url, opts]); return url.includes('exa.ai') ? new Response('', { status: 503 }) : json(parallel) })
  for (let i = 0; i < 2; i++) {
    const result = await p.search({ query: 'q' })
    assert.equal(result.sources[0].summary, 'first\nsecond')
  }
  assert.equal(calls.length, 4)
  for (const [url, opts] of calls.filter(([u]) => u.includes('parallel.ai'))) {
    assert.equal(url, 'https://mcp.parallel.ai/mcp')
    assert.deepEqual(JSON.parse(opts.body).params, { name: 'web_search', arguments: { objective: 'q', search_queries: ['q'] } })
    assert.equal(opts.redirect, 'error'); assert.equal(opts.headers.Authorization, undefined)
  }
})

test('JSON text fallback, deduplication, invalid URLs, limit and truncation', async () => {
  const { parseParallel } = await plugin
  const data = { results: [{ url: 42 }, { url: {} }, { url: 'https://u:p@example.com' }, { url: 'javascript:alert(1)' }, { url: 'https://example.com', excerpts: ['x'.repeat(3000)] }, { url: 'https://example.com/' }, { url: 'https://second.example' }] }
  const result = parseParallel({ content: [{ type: 'text', text: JSON.stringify(data) }] }, 1)
  assert.equal(result.sources.length, 1); assert.equal(result.truncated, true)
  assert.equal(result.sources[0].snippet.length, 300); assert.equal(result.sources[0].summary.length, 2000)
})

test('malformed and empty upstream responses fall back and errors are sanitized', async () => {
  let calls = 0
  const p = await provider(async () => ++calls === 1 ? json(rpc({ content: [] })) : json(rpc({ structuredContent: { results: [{ url: 5 }] } })))
  await assert.rejects(p.search({ query: 'secret query' }), e => e.code === 'WEB_SEARCH_FAILED' && !e.message.includes('secret query'))
  assert.equal(calls, 2)
  const p2 = await provider(async () => json({ jsonrpc: '2.0', id: 1, error: { message: 'secret' } }))
  await assert.rejects(p2.search({ query: 'q' }), e => !e.message.includes('secret'))
})

test('caller abort rejects promptly without fallback', async () => {
  let calls = 0
  const p = await provider(() => { calls++; return new Promise(() => {}) })
  const controller = new AbortController()
  const promise = p.search({ query: 'q' }, controller.signal)
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' }); assert.equal(calls, 1)
})

test('timeout falls back even when fetch ignores abort', async () => {
  let calls = 0
  const p = await provider(() => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(json(parallel)), { exaTimeout: 10, totalTimeout: 1000 })
  assert.equal((await p.search({ query: 'q' })).sources.length, 1); assert.equal(calls, 2)
})

test('size limits for content length and stream', async () => {
  let calls = 0
  const oversized = () => new Response(new Uint8Array(256 * 1024 + 1))
  const p = await provider(async () => ++calls === 1 ? new Response('x', { headers: { 'content-length': String(256 * 1024 + 1) } }) : oversized())
  await assert.rejects(p.search({ query: 'q' }), /response too large/); assert.equal(calls, 2)
})

test('429 cooldown honors seconds, dates, bounds and avoids retries', async () => {
  let now = Date.parse('2025-01-01T00:00:00Z'), calls = []
  const p = await provider(async url => { calls.push(url); return new Response('', { status: 429, headers: { 'retry-after': url.includes('exa.ai') ? '10' : 'Wed, 01 Jan 2025 00:00:20 GMT' } }) }, { now: () => now })
  await assert.rejects(p.search({ query: 'q' }), /HTTP 429/)
  await assert.rejects(p.search({ query: 'q' }), /cooldown/); assert.equal(calls.length, 2)
  now += 11000; await assert.rejects(p.search({ query: 'q' })); assert.equal(calls.length, 3)
})

test('SSE multiline JSON and open stream completion', async () => {
  let cancelled = false
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"content":[{"type":"text","text":"URL: https://example.org"}]}}\n\n')) }, cancel() { cancelled = true } })
  const p = await provider(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal((await p.search({ query: 'q' })).sources.length, 1); assert.equal(cancelled, true)
})

test('clamps maxResults and detects RPC tool error', async () => {
  let calls = 0
  const p = await provider(async (_url, opts) => { calls++; if (calls === 1) { assert.equal(JSON.parse(opts.body).params.arguments.numResults, 10); return json(rpc({ isError: true })) } return json(parallel) })
  assert.equal((await p.search({ query: 'q', maxResults: 99 })).sources.length, 1); assert.equal(calls, 2)
})
