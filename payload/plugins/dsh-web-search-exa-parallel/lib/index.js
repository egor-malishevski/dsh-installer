export const name = 'dsh-web-search-exa-parallel'
export const inject = ['web']

const LIMIT = 256 * 1024
const endpoints = {
  exa: 'https://mcp.exa.ai/mcp',
  parallel: 'https://mcp.parallel.ai/mcp',
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

function abortError() {
  const error = new Error('Web search aborted by caller')
  error.name = 'AbortError'
  return error
}

function normalize(items, maxResults) {
  const sources = []
  const seen = new Set()
  let truncated = false
  for (const item of items) {
    if (!object(item) || typeof item.url !== 'string') continue
    let url
    try {
      const parsed = new URL(item.url.trim())
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue
      url = parsed.href
    } catch { continue }
    if (seen.has(url)) continue
    seen.add(url)
    if (sources.length >= maxResults) { truncated = true; continue }
    const title = text(item.title, 300)
    const excerpt = text(item.excerpt, 2000)
    const published = typeof item.published === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(item.published) && Number.isFinite(Date.parse(item.published))
      ? new Date(item.published).toISOString() : undefined
    sources.push({ url, ...(title && { title }), ...(excerpt && { snippet: excerpt.slice(0, 300), summary: excerpt }), ...(published && { publishedAt: published }) })
  }
  return { sources, truncated }
}

export function parseExa(result, maxResults = 8) {
  if (!object(result) || !Array.isArray(result.content)) throw new Error('invalid Exa response')
  const items = []
  for (const part of result.content) {
    if (!object(part) || part.type !== 'text' || typeof part.text !== 'string') continue
    for (const block of part.text.split(/\r?\n\s*---\s*\r?\n/)) {
      const fields = {}
      let key
      for (const line of block.split(/\r?\n/)) {
        const match = /^(Title|URL|Published|Author|Highlights|Text):\s*(.*)$/i.exec(line)
        const field = match?.[1].toLowerCase()
        if (match && key !== 'highlights' && key !== 'text' && !(field in fields)) {
          key = field
          fields[key] = match[2]
        } else if (key === 'highlights' || key === 'text') {
          fields[key] += `\n${line}`
        }
      }
      items.push({ url: fields.url, title: fields.title, published: fields.published, excerpt: fields.highlights || fields.text })
    }
  }
  return normalize(items, maxResults)
}

export function parseParallel(result, maxResults = 8) {
  if (!object(result)) throw new Error('invalid Parallel response')
  let data = result.structuredContent
  if (data === undefined && Array.isArray(result.content)) {
    const part = result.content.find(part => object(part) && part.type === 'text' && typeof part.text === 'string')
    try { data = JSON.parse(part?.text) } catch { throw new Error('invalid Parallel response') }
  }
  if (!object(data) || !Array.isArray(data.results)) throw new Error('invalid Parallel response')
  return normalize(data.results.map(item => object(item) ? {
    url: item.url, title: item.title, published: item.publish_date,
    excerpt: Array.isArray(item.excerpts) ? item.excerpts.filter(x => typeof x === 'string').join('\n') : '',
  } : null), maxResults)
}

function envelope(value, provider) {
  if (!object(value) || value.jsonrpc !== '2.0' || value.id !== 1) throw new Error('invalid JSON-RPC envelope')
  if ('error' in value) {
    const code = value.error?.code
    throw new Error(Number.isSafeInteger(code) ? `JSON-RPC error ${code}` : 'JSON-RPC error')
  }
  if (!object(value.result)) throw new Error('invalid JSON-RPC result')
  if (value.result.isError === true) {
    if (provider === 'exa' && value.result._meta?.['ai.exa/rateLimited'] === true) {
      const error = new Error('rate limited'); error.code = 'RATE_LIMITED'; throw error
    }
    throw new Error('tool error')
  }
  return value.result
}

// Read only a bounded response. SSE connections can remain open after their result frame.
async function readResponse(response, provider) {
  const length = response.headers.get('content-length')
  if (length && Number(length) > LIMIT) {
    response.body?.cancel().catch(() => {})
    throw new Error('response too large')
  }
  if (!response.body) throw new Error('empty response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const sse = /text\/event-stream/i.test(response.headers.get('content-type') || '')
  let buffer = '', size = 0, completed = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) { completed = true; buffer += decoder.decode(); break }
      size += value.byteLength
      if (size > LIMIT) throw new Error('response too large')
      buffer += decoder.decode(value, { stream: true })
      if (sse) {
        let boundary
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
          if (!data) continue
          let parsed
          try { parsed = JSON.parse(data) } catch { throw new Error('invalid SSE JSON') }
          // Ignore notifications and server requests, even if their ID matches.
          if (object(parsed) && parsed.id === 1 && !('method' in parsed)) return envelope(parsed, provider)
        }
      }
    }
    if (sse) throw new Error('missing SSE result')
    let parsed
    try { parsed = JSON.parse(buffer) } catch { throw new Error('invalid JSON-RPC response') }
    return envelope(parsed, provider)
  } finally {
    if (!completed) reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function cooldownMs(header, now) {
  if (!header) return 60000
  const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
  return Number.isFinite(ms) ? Math.max(0, Math.min(300000, ms)) : 60000
}

// FIFO gate limiting logical in-flight requests. A fetch that ignores abort cannot be
// cancelled by JS; its slot is released at the call deadline to avoid deadlock.
class Gate {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = [] }
  take() { this.active++; return this.releaser() }
  releaser() {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = this.waiters.shift()
      if (next) next.grant(); else this.active--
    }
  }
  acquire(signal, waitMs) {
    if (signal?.aborted) return Promise.reject(abortError())
    const release = () => this.releaser()
    if (this.active < this.limit) return Promise.resolve(this.take())
    return new Promise((resolve, reject) => {
      const waiter = {}
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      const drop = error => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        cleanup(); reject(error)
      }
      const onAbort = () => drop(abortError())
      const timer = setTimeout(() => drop(new Error('timeout')), Math.max(0, waitMs))
      waiter.grant = () => { cleanup(); resolve(release()) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }
}

export class ExaParallelSearchProvider {
  id = 'exa-parallel'
  constructor({ fetch: fetchImpl = globalThis.fetch, now = Date.now, exaTimeout = 12000, totalTimeout = 25000, concurrency = 1 } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.exaTimeout = exaTimeout
    this.totalTimeout = totalTimeout
    this.cooldowns = { exa: 0, parallel: 0 }
    const limit = Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1
    this.gates = { exa: new Gate(limit), parallel: new Gate(limit) }
  }
  available() { return true }

  async call(provider, query, maxResults, signal, timeout) {
    const controller = new AbortController()
    let timer, onAbort
    const stop = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); reject(abortError()) }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeout)
    })
    const work = (async () => {
      const args = provider === 'exa' ? { query, numResults: maxResults } : { objective: query, search_queries: [query] }
      const response = await this.fetch(endpoints[provider], {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: provider === 'exa' ? 'web_search_exa' : 'web_search', arguments: args } }),
      })
      if (!response.ok) {
        response.body?.cancel().catch(() => {})
        const error = new Error(`HTTP ${response.status}`)
        if (response.status === 429) { error.code = 'RATE_LIMITED'; error.retryMs = cooldownMs(response.headers.get('retry-after'), this.now()) }
        throw error
      }
      let result
      try { result = await readResponse(response, provider) }
      catch (error) {
        if (error.code === 'RATE_LIMITED') error.retryMs = cooldownMs(response.headers.get('retry-after'), this.now())
        throw error
      }
      const parsed = provider === 'exa' ? parseExa(result, maxResults) : parseParallel(result, maxResults)
      if (!parsed.sources.length) throw new Error('no usable sources')
      return parsed
    })()
    try { return await Promise.race([work, stop]) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  }

  async search(request, signal) {
    if (signal?.aborted) throw abortError()
    if (typeof request?.query !== 'string' || !request.query.trim()) throw new Error('Web search query is required')
    const value = request.maxResults
    const maxResults = typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : 8
    const started = performance.now()
    const errors = [], rateRetries = []
    for (const provider of ['exa', 'parallel']) {
      if (signal?.aborted) throw abortError()
      if (this.cooldowns[provider] > this.now()) {
        const retry = Math.ceil((this.cooldowns[provider] - this.now()) / 1000)
        rateRetries.push(provider); errors.push(`${provider}: rate limit cooldown, retry after ${retry}s`); continue
      }
      const remaining = this.totalTimeout - (performance.now() - started)
      if (remaining <= 0) { errors.push(`${provider}: overall timeout`); break }
      const phase = provider === 'exa' ? Math.min(this.exaTimeout, remaining) : remaining
      const phaseStart = performance.now()
      let release
      try {
        const gate = this.gates[provider]
        // Free slot: take it synchronously so an immediate abort still reaches fetch's signal.
        release = gate.active < gate.limit ? gate.take() : await gate.acquire(signal, phase)
        if (signal?.aborted) throw abortError()
        if (this.cooldowns[provider] > this.now()) {
          const retry = Math.ceil((this.cooldowns[provider] - this.now()) / 1000)
          rateRetries.push(provider); errors.push(`${provider}: rate limit cooldown, retry after ${retry}s`); continue
        }
        const left = phase - (performance.now() - phaseStart)
        if (left <= 0) throw new Error('timeout')
        return await this.call(provider, request.query, maxResults, signal, left)
      } catch (error) {
        if (signal?.aborted) throw abortError()
        if (error?.code === 'RATE_LIMITED') {
          this.cooldowns[provider] = Math.max(this.cooldowns[provider], this.now() + error.retryMs)
          rateRetries.push(provider)
          errors.push(`${provider}: ${error.message === 'HTTP 429' ? 'HTTP 429' : 'rate limited'}, retry after ${Math.ceil(Math.max(0, this.cooldowns[provider] - this.now()) / 1000)}s`)
          continue
        }
        // Never expose upstream error text, URLs, request data, or response bodies.
        const message = error instanceof Error && /^(timeout|HTTP \d{3}|response too large|empty response|invalid (?:Exa response|Parallel response|SSE JSON|JSON-RPC (?:response|envelope|result))|JSON-RPC error(?: -?\d+)?|tool error|missing SSE result|no usable sources)$/.test(error.message) ? error.message : 'network or protocol failure'
        errors.push(`${provider}: ${message}`)
      } finally { release?.() }
    }
    const error = new Error(`Web search failed (${errors.join('; ')})`)
    error.code = 'WEB_SEARCH_FAILED'
    if (rateRetries.length === errors.length && rateRetries.length === 2) error.retryAfterSeconds = Math.ceil(Math.max(0, Math.min(...rateRetries.map(provider => this.cooldowns[provider] - this.now()))) / 1000)
    throw error
  }
}

export function apply(ctx) {
  ctx.web.registerSearchProvider(new ExaParallelSearchProvider())
}
