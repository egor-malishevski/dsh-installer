import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const sources = {}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]
  if (!['--integrations', '--slim', '--relay'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || sources[key]) {
    throw new Error('Usage: prepare-payload.js --integrations PATH --slim PATH --relay PATH')
  }
  sources[key] = resolve(args[i + 1])
}
if (Object.keys(sources).length !== 3) throw new Error('All three source paths are required')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'payload')
const staging = mkdtempSync(join(root, '.payload-stage-'))
const excluded = /^(?:\.git|node_modules|tests?|__tests__|profiles?|secrets?|data|sessions?|backups?|logs?|\.env(?:\..*)?|package-lock\.json|npm-shrinkwrap\.json|.*\.bak(?:-.*)?|\.DS_Store)$/i

function copy(source, target, required = true) {
  if (!existsSync(source)) {
    if (required) throw new Error(`Missing required source: ${source}`)
    return
  }
  cpSync(source, target, {
    recursive: true,
    filter: (entry) => !excluded.test(entry.split(/[\\/]/).pop()) && !lstatSync(entry).isSymbolicLink(),
    dereference: false,
  })
}

try {
  const integrations = join(staging, 'bundles/dsh-integrations')
  const slim = join(staging, 'plugins/oh-my-dsh-slim')
  const relay = join(staging, 'plugins/zstd-render')
  for (const dir of [integrations, slim, relay]) mkdirSync(dir, { recursive: true })
  for (const item of ['package.json', 'lib', 'client']) copy(join(sources['--integrations'], item), join(integrations, item))
  // Keep the pinned search bundle across payload refreshes and retire the legacy adapter.
  copy(join(destination, 'plugins/dsh-web-search-multi'), join(staging, 'plugins/dsh-web-search-multi'))
  const integrationManifestPath = join(integrations, 'package.json')
  const integrationManifest = JSON.parse(readFileSync(integrationManifestPath, 'utf8'))
  if (integrationManifest.exports) delete integrationManifest.exports['./web-search-account']
  writeFileSync(integrationManifestPath, JSON.stringify(integrationManifest, null, 2) + '\n')
  rmSync(join(integrations, 'lib/web-search-account.js'), { force: true })
  const editorPath = join(integrations, 'lib/editor.js')
  const editor = readFileSync(editorPath, 'utf8')
  const sourceServers = "const SERVERS = new Set(['mcp-obscura', 'mcp-bitbucket', 'mcp-kibana', 'mcp-jira', 'mcp-confluence', 'mcp-sequential-thinking', 'mcp-memory', 'mcp-google-sheets', 'mcp-figma']);"
  const installerServers = sourceServers.replace("'mcp-bitbucket',", "'mcp-bitbucket', 'mcp-gitlab',").replace("'mcp-figma']", "'mcp-figma', 'mcp-context7']")
  const declarations = editor.match(/^const SERVERS\s*=.*$/gm) || []
  if (declarations.length !== 1 || ![sourceServers, installerServers].includes(declarations[0])) throw new Error('Unexpected integrations editor server allowlist')
  if (declarations[0] === sourceServers) writeFileSync(editorPath, editor.replace(sourceServers, installerServers))
  for (const item of ['LICENSE', 'README.md', 'NOTICE', 'NOTICE.md']) copy(join(sources['--integrations'], item), join(integrations, item), false)
  for (const item of ['package.json', 'lib', 'preset', 'client', 'cordis.patch.yml', 'LICENSE']) copy(join(sources['--slim'], item), join(slim, item))
  for (const item of ['README.md', 'NOTICE', 'NOTICE.md']) copy(join(sources['--slim'], item), join(slim, item), false)

  const relaySource = readFileSync(sources['--relay'], 'utf8')
  const defaultPattern = /(^\s*upstream:\s*)'https:\/\/[^'\s]+'(,\s*)$/m
  if ((relaySource.match(new RegExp(defaultPattern.source, 'gm')) || []).length !== 1) throw new Error('Expected exactly one relay upstream default')
  const oldLifecycle = "  ctx.effect(() => {\n    let server\n    let timer\n    let stopped = false\n\n    const tryBind = () => {\n      if (stopped) return\n      const candidate = http.createServer(handler)\n      candidate.requestTimeout = 0 // long SSE streams\n      candidate.headersTimeout = 60_000\n      candidate.keepAliveTimeout = 5_000\n      candidate.on('clientError', (_error, socket) => {\n        try { socket.destroy() } catch {}\n      })\n      candidate.once('error', (error) => {\n        // Port owned by another relay (opencode or a second DSH) — take over when it goes away.\n        if (error?.code !== 'EADDRINUSE') note(`BIND ERROR ${error?.message ?? error}`)\n        try { candidate.close() } catch {}\n        if (!stopped) timer = setTimeout(tryBind, config.retryBindMs)\n      })\n      candidate.listen(config.port, config.host, () => {\n        if (stopped) {\n          candidate.close()\n          return\n        }\n        server = candidate\n        candidate.on('error', (error) => note(`SERVER ERROR ${error?.message ?? error}`))\n        note(`bound ${config.host}:${config.port} pid=${process.pid}`)\n      })\n    }\n    tryBind()\n\n    return () => {\n      stopped = true\n      if (timer) clearTimeout(timer)\n      if (server) {\n        server.close()\n        server.closeAllConnections?.()\n      }\n    }\n  })"
  const newLifecycle = "  return new Promise((resolve, reject) => {\n    ctx.effect(() => {\n      let settled = false\n      const server = http.createServer(handler)\n      server.requestTimeout = 0 // long SSE streams\n      server.headersTimeout = 60_000\n      server.keepAliveTimeout = 5_000\n      server.on('clientError', (_error, socket) => {\n        try { socket.destroy() } catch {}\n      })\n      server.once('error', (error) => {\n        if (settled) return\n        settled = true\n        reject(Object.assign(new Error(error?.code === 'EADDRINUSE' ? '[zstd-render] relay port occupied' : '[zstd-render] relay bind failed'), { code: error?.code }))\n      })\n      server.listen(config.port, config.host, () => {\n        if (settled) return\n        settled = true\n        server.on('error', (error) => note(`SERVER ERROR ${error?.message ?? error}`))\n        note(`bound ${config.host}:${config.port} pid=${process.pid}`)\n        resolve()\n      })\n      return () => {\n        if (!settled) {\n          settled = true\n          reject(new Error('[zstd-render] relay stopped before binding'))\n        }\n        server.close()\n        server.closeAllConnections?.()\n      }\n    })\n  })"
  const oldComment = "// opencode runs the same relay on the same port: whichever process binds first serves,\n// the other retries so the relay survives when its owner exits."
  if (relaySource.split(oldLifecycle).length !== 2 || relaySource.split(oldComment).length !== 2 || relaySource.split('  retryBindMs: 10_000,\n').length !== 2) throw new Error('Unexpected relay lifecycle source')
  const preparedRelay = relaySource.replace(defaultPattern, "$1''$2")
    .replace(oldLifecycle, newLifecycle)
    .replace(oldComment, "// A dedicated port must be available; an existing listener is not trusted.")
    .replace('  retryBindMs: 10_000,\n', '')
  writeFileSync(join(relay, 'index.js'), preparedRelay)

  // Verify exported package entrypoints before replacing the existing payload.
  for (const dir of [integrations, slim]) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const entry of [pkg.main, ...Object.values(pkg.exports)]) {
      if (typeof entry !== 'string' || !existsSync(resolve(dir, entry))) throw new Error(`Missing package entrypoint in ${pkg.name}: ${entry}`)
    }
  }
  rmSync(destination, { recursive: true, force: true })
  renameSync(staging, destination)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
