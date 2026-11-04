import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const payload = resolve(dirname(fileURLToPath(import.meta.url)), '../payload')
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/prepare-payload.js')
const servers = "const SERVERS = new Set(['mcp-obscura', 'mcp-bitbucket', 'mcp-gitlab', 'mcp-kibana', 'mcp-jira', 'mcp-confluence', 'mcp-sequential-thinking', 'mcp-memory', 'mcp-google-sheets', 'mcp-figma', 'mcp-context7']);"
const clients = "const MODULES = new Set(['@deepseek-ai/dsh-mcp-client', 'dsh-integrations/mcp-client']);"
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    assert.ok(!entry.isSymbolicLink(), `symlink: ${path}`)
    return entry.isDirectory() ? files(path) : [path]
  })
}

test('payload contains curated code, package entrypoints and licenses', () => {
  const integrations = join(payload, 'bundles/dsh-integrations')
  const slim = join(payload, 'plugins/oh-my-dsh-slim')
  for (const dir of [integrations, slim]) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const entry of [pkg.main, ...Object.values(pkg.exports)]) assert.ok(existsSync(resolve(dir, entry)), `${pkg.name}: ${entry}`)
  }
  for (const file of ['bundles/dsh-integrations/lib/mcp-client.LICENSE', 'plugins/oh-my-dsh-slim/LICENSE', 'plugins/oh-my-dsh-slim/preset/LICENSE', 'plugins/oh-my-dsh-slim/cordis.patch.yml', 'plugins/zstd-render/index.js']) {
    assert.ok(existsSync(join(payload, file)), file)
  }
  assert.match(readFileSync(join(slim, 'LICENSE'), 'utf8'), /MIT License/i)
  assert.ok(!existsSync(join(integrations, 'cordis.patch.yml')))
  assert.match(readFileSync(join(payload, 'plugins/zstd-render/index.js'), 'utf8'), /upstream:\s*''/)
  const editor = readFileSync(join(integrations, 'lib/editor.js'), 'utf8')
  assert.deepEqual(editor.match(/^const SERVERS\s*=.*$/gm), [servers])
  assert.deepEqual(editor.match(/^const MODULES\s*=.*$/gm), [clients])
})

test('preparation adds GitLab and Context7 only to the expected editor allowlist', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-payload-test-'))
  try {
    mkdirSync(join(temp, 'scripts'))
    writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
    cpSync(script, join(temp, 'scripts/prepare-payload.js'))
    const integrations = join(temp, 'integrations')
    const slim = join(temp, 'slim')
    cpSync(join(payload, 'bundles/dsh-integrations'), integrations, { recursive: true })
    cpSync(join(payload, 'plugins/oh-my-dsh-slim'), slim, { recursive: true })
    cpSync(join(payload, 'plugins/dsh-web-search-multi'), join(temp, 'payload/plugins/dsh-web-search-multi'), { recursive: true })
    const relay = join(temp, 'relay.js')
    const scriptText = readFileSync(script, 'utf8')
    const oldLifecycle = JSON.parse(scriptText.match(/^  const oldLifecycle = (.+)$/m)[1])
    const oldComment = JSON.parse(scriptText.match(/^  const oldComment = (.+)$/m)[1])
    const relaySource = `${oldComment}\nconst defaults = {\n  upstream: 'https://example.invalid',\n  retryBindMs: 10_000,\n}\n${oldLifecycle}\n`
    writeFileSync(relay, relaySource)
    const editorPath = join(integrations, 'lib/editor.js')
    const original = readFileSync(editorPath, 'utf8')
    const run = () => spawnSync(process.execPath, [join(temp, 'scripts/prepare-payload.js'), '--integrations', integrations, '--slim', slim, '--relay', relay], { encoding: 'utf8' })
    writeFileSync(editorPath, original.replace(servers, servers.replace("'mcp-bitbucket', 'mcp-gitlab',", "'mcp-bitbucket',").replace(", 'mcp-context7']", "]")))
    let result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(temp, 'payload/bundles/dsh-integrations/lib/editor.js'), 'utf8'), original)
    assert.equal(readFileSync(join(temp, 'payload/plugins/dsh-web-search-multi/lib/index.js'), 'utf8'), readFileSync(join(payload, 'plugins/dsh-web-search-multi/lib/index.js'), 'utf8'))
    assert.equal(JSON.parse(readFileSync(join(temp, 'payload/bundles/dsh-integrations/package.json'), 'utf8')).exports['./web-search-account'], undefined)
    const preparedRelay = readFileSync(join(temp, 'payload/plugins/zstd-render/index.js'), 'utf8')
    assert.match(preparedRelay, /relay port occupied/)
    assert.doesNotMatch(preparedRelay, /setTimeout\(tryBind/)
    writeFileSync(editorPath, original)
    result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(temp, 'payload/bundles/dsh-integrations/lib/editor.js'), 'utf8'), original)
    writeFileSync(editorPath, original.replace(servers, servers.replace("'mcp-gitlab',", "'mcp-gitlab', 'mcp-arbitrary',")))
    result = run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Unexpected integrations editor server allowlist/)
    writeFileSync(editorPath, original)
    writeFileSync(relay, relaySource.replace('setTimeout(tryBind', 'setTimeout(other'))
    result = run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Unexpected relay lifecycle source/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('payload has no private machine configuration or excluded content', () => {
  const all = files(payload)
  let size = 0
  for (const file of all) {
    const relative = file.slice(payload.length + 1)
    assert.doesNotMatch(relative, /(?:^|\/)(?:\.git|node_modules|tests?|__tests__|profiles?|secrets?|data|sessions?|backups?|logs?|\.env(?:\..*)?|package-lock\.json)(?:\/|$)/i)
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /\/Users\/egor|alfagen|alfabank|[\w-]+\.onrender\.com/i, relative)
    assert.doesNotMatch(text, /(?:api[_-]?key|token|secret)\s*[:=]\s*['"][^'"]{12,}['"]/i, relative)
    size += statSync(file).size
  }
  assert.ok(all.length <= 256, `${all.length} files exceeds transaction limit`)
  assert.ok(size <= 10 * 1024 * 1024, `${size} bytes exceeds transaction limit`)
  console.log(`payload inventory: ${all.length} files, ${size} bytes`)
})
