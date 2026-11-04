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

function envelope(value) {
  if (!object(value) || value.jsonrpc !== '2.0' || value.id !== 1 || value.error || !object(value.result) || value.result.isError) {
    throw new Error('invalid or error JSON-RPC response')
  }
  return value.result
}

// Read only a bounded response. SSE connections can remain open after their result frame.
async function readResponse(response) {
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
          if (object(parsed) && parsed.id === 1 && !('method' in parsed)) return envelope(parsed)
        }
      }
    }
    if (sse) throw new Error('missing SSE result')
    try { return envelope(JSON.parse(buffer)) } catch { throw new Error('invalid JSON-RPC response') }
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

export class ExaParallelSearchProvider {
  id = 'exa-parallel'
  constructor({ fetch: fetchImpl = globalThis.fetch, now = Date.now, exaTimeout = 12000, totalTimeout = 25000 } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.exaTimeout = exaTimeout
    this.totalTimeout = totalTimeout
    this.cooldowns = { exa: 0, parallel: 0 }
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
        if (response.status === 429) this.cooldowns[provider] = this.now() + cooldownMs(response.headers.get('retry-after'), this.now())
        response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await readResponse(response)
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
    const errors = []
    for (const provider of ['exa', 'parallel']) {
      if (signal?.aborted) throw abortError()
      if (this.cooldowns[provider] > this.now()) { errors.push(`${provider}: rate limit cooldown`); continue }
      const remaining = this.totalTimeout - (performance.now() - started)
      if (remaining <= 0) { errors.push(`${provider}: overall timeout`); break }
      try {
        return await this.call(provider, request.query, maxResults, signal, provider === 'exa' ? Math.min(this.exaTimeout, remaining) : remaining)
      } catch (error) {
        if (signal?.aborted) throw abortError()
        // Never expose upstream error text, URLs, request data, or response bodies.
        const message = error instanceof Error && /^(timeout|HTTP \d{3}|response too large|empty response|invalid .*|missing SSE result|no usable sources)$/.test(error.message) ? error.message : 'network or protocol failure'
        errors.push(`${provider}: ${message}`)
      }
    }
    const error = new Error(`Web search failed (${errors.join('; ')})`)
    error.code = 'WEB_SEARCH_FAILED'
    throw error
  }
}

export function apply(ctx) {
  ctx.web.registerSearchProvider(new ExaParallelSearchProvider())
}
