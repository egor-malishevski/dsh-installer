// zstd relay for the Render-hosted CLIProxyAPI — DeepSeek Harness (Cordis) port of
// ~/.config/opencode/plugins/zstd-render.
//
// Render's edge WAF (Cloudflare) blocks requests whose conversation history contains
// shell snippets such as "`curl -sS ", "../../../../etc/..." or "${jndi:...}", which
// kills the whole session with 403. CLIProxyAPI accepts `Content-Encoding: zstd`
// bodies, which the WAF does not inspect, so this plugin runs a local relay that
// compresses every request body and forwards it to Render; responses (including SSE
// streams) pass through unchanged. The `cliproxy` llm-pi-ai route points at the relay.
//
// A dedicated port must be available; an existing listener is not trusted.
//
// Every callback is guarded: in DSH an uncaught exception or unhandled rejection in
// detached work is fatal for the whole app.

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'

export const name = 'zstd-render'

const DEFAULTS = {
  host: '127.0.0.1',
  port: 18317,
  upstream: '',
  upstreamRetries: 2, // transient network errors only; never on an HTTP status
  logPath: path.join(os.homedir(), '.dsh/logs/zstd-render-access.log'),
  logMaxBytes: 2_000_000,
}

// Hop-by-hop and encoding headers must not cross between the two connections:
// fetch() has already decoded the upstream body.
const DROP_REQUEST = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding', 'keep-alive'])
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const logging = process.env.DSH_ZSTD_RELAY_LOG !== '0'

  const note = (line) => {
    if (!logging) return
    try {
      fs.mkdirSync(path.dirname(config.logPath), { recursive: true })
      try {
        if (fs.statSync(config.logPath).size > config.logMaxBytes) fs.rmSync(config.logPath)
      } catch {}
      fs.appendFileSync(config.logPath, `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  const forward = async (target, init, signal) => {
    let lastError
    for (let attempt = 0; attempt <= config.upstreamRetries; attempt++) {
      try {
        return await fetch(target, { ...init, signal })
      } catch (error) {
        if (signal.aborted) throw error // client went away — do not retry
        lastError = error
      }
    }
    throw lastError
  }

  const relay = async (req, res) => {
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(key)) continue
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }

    let body
    let rawLen = 0
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const raw = await readBody(req)
      rawLen = raw.byteLength
      if (rawLen > 0) {
        body = zlib.zstdCompressSync(raw)
        headers.set('content-encoding', 'zstd')
      }
    }

    const upstream = await forward(
      config.upstream + req.url,
      { method: req.method, headers, body },
      abort.signal,
    )
    note(`${req.method} ${req.url} ${rawLen}->${body ? body.byteLength : 0} ${upstream.status}`)

    const outHeaders = {}
    upstream.headers.forEach((value, key) => {
      if (!DROP_RESPONSE.has(key)) outHeaders[key] = value
    })
    res.writeHead(upstream.status, outHeaders)
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    if (!upstream.body) {
      res.end()
      return
    }
    await new Promise((resolve) => {
      const stream = Readable.fromWeb(upstream.body)
      stream.on('error', (error) => {
        if (!abort.signal.aborted) note(`STREAM ERROR ${error?.message ?? error}`)
        res.destroy()
        resolve()
      })
      res.on('close', () => {
        stream.destroy()
        resolve()
      })
      stream.pipe(res)
    })
  }

  const handler = (req, res) => {
    relay(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (error?.name !== 'AbortError') note(`ERROR ${message}`)
      try {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `[zstd-render] ${message}` } }))
        } else {
          res.destroy()
        }
      } catch {}
    })
  }

  return new Promise((resolve, reject) => {
    ctx.effect(() => {
      let settled = false
      const server = http.createServer(handler)
      server.requestTimeout = 0 // long SSE streams
      server.headersTimeout = 60_000
      server.keepAliveTimeout = 5_000
      server.on('clientError', (_error, socket) => {
        try { socket.destroy() } catch {}
      })
      server.once('error', (error) => {
        if (settled) return
        settled = true
        reject(Object.assign(new Error(error?.code === 'EADDRINUSE' ? '[zstd-render] relay port occupied' : '[zstd-render] relay bind failed'), { code: error?.code }))
      })
      server.listen(config.port, config.host, () => {
        if (settled) return
        settled = true
        server.on('error', (error) => note(`SERVER ERROR ${error?.message ?? error}`))
        note(`bound ${config.host}:${config.port} pid=${process.pid}`)
        resolve()
      })
      return () => {
        if (!settled) {
          settled = true
          reject(new Error('[zstd-render] relay stopped before binding'))
        }
        server.close()
        server.closeAllConnections?.()
      }
    })
  })
}
