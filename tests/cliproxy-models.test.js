import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject, mergeModels } from '../payload/plugins/cliproxy-models/index.js'

const seed = [{ id: 'a', name: 'Seed A', input: ['text'], reasoningEfforts: { low: 'low' } }]

function harness({ route, listing, config = {}, extra = {}, schema } = {}) {
  const state = {
    revision: 'r1',
    value: { providers: { cliproxy: { baseURL: 'http://x/v1', api: 'openai-completions', headers: { Authorization: 'Bearer SECRET' }, models: [{ id: 'old', name: 'Old', input: ['text'], contextWindow: 9 }], ...route } } },
  }
  const calls = { discover: [], mutate: [], warn: [] }
  const rows = () => [
    { ns: 'llm-pi-ai', value: state.value, revision: state.revision, schema },
    ...Object.entries(extra).map(([ns, value]) => ({ ns, value, revision: 'x' })),
  ]
  let dispose
  const h = {
    listing,
    mutateImpl: async (ns, ops, rev) => {
      state.value = structuredClone(state.value)
      state.value.providers.cliproxy.models = ops[0].value
      state.revision = 'r' + (Number(state.revision.slice(1)) + 1)
    },
    state, calls,
    ctx: {
      logger: { warn: m => calls.warn.push(m), info() {} },
      effect(fn) { dispose = fn() },
      loader: { await: async () => {} },
      settings: {
        describe: async () => rows(),
        mutate: async (ns, ops, rev) => { calls.mutate.push({ ns, ops, rev }); return h.mutateImpl(ns, ops, rev) },
      },
      llm: {
        discoverModels: async (ns, r, signal) => {
          calls.discover.push({ ns, r, signal })
          if (typeof h.listing === 'function') return h.listing(signal)
          return h.listing
        },
      },
    },
    dispose: () => dispose?.(),
    config: { seed, ...config },
  }
  return h
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }
const start = async (h) => { apply(h.ctx, h.config); await flush() }

test('exports', () => { assert.equal(name, 'cliproxy-models'); assert.deepEqual(inject, ['llm', 'settings']) })

test('merge order, seed wins, unknown default, user extras kept', async () => {
  const h = harness({ listing: [{ id: 'b', name: 'B' }, { id: 'a', name: 'Listed A' }, { id: 'old' }, { id: 'bad id' }] })
  await start(h)
  h.dispose()
  assert.equal(h.calls.mutate.length, 1)
  const next = h.calls.mutate[0].ops[0].value
  assert.deepEqual(next.map(m => m.id), ['b', 'a', 'old'])
  assert.deepEqual(next[0], { id: 'b', name: 'B', input: ['text', 'image'] })
  assert.equal(next[1].name, 'Seed A')
  assert.deepEqual(next[1].input, ['text'])
  assert.equal(next[2].contextWindow, 9)
  assert.equal(next[2].name, 'Old')
})

test('discoverModels args, one mutate with path and revision, secrets not logged', async () => {
  const h = harness({ listing: [{ id: 'a' }] })
  await start(h)
  h.dispose()
  assert.equal(h.calls.discover.length, 1)
  const { ns, r, signal } = h.calls.discover[0]
  assert.equal(ns, 'llm-pi-ai')
  assert.deepEqual(r, { provider: 'cliproxy', baseURL: 'http://x/v1', api: 'openai-completions' })
  assert.ok(signal instanceof AbortSignal)
  assert.equal(h.calls.mutate.length, 1)
  assert.deepEqual(h.calls.mutate[0].ops[0].path, ['providers', 'cliproxy', 'models'])
  assert.equal(h.calls.mutate[0].rev, 'r1')
  assert.ok(!h.calls.warn.join().includes('SECRET'))
})

test('pinned ids from config, default model and roles are kept', async () => {
  const h = harness({
    listing: [{ id: 'a' }],
    config: { pinned: ['cfg-pin'] },
    extra: {
      'agent-default-model': { provider: 'cliproxy', model: 'def-model' },
      'oh-my-dsh-slim': { roles: { fixer: { provider: 'cliproxy', model: 'role-m' }, oracle: { provider: 'other', model: 'nope' } }, orchestrator: {} },
    },
  })
  await start(h)
  h.dispose()
  const ids = h.calls.mutate[0].ops[0].value.map(m => m.id)
  assert.deepEqual(ids, ['a', 'cfg-pin', 'def-model', 'role-m'])
  assert.deepEqual(h.calls.mutate[0].ops[0].value[1], { id: 'cfg-pin', name: 'cfg-pin', input: ['text', 'image'] })
})

test('identical second tick performs no write', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const h = harness({ listing: [{ id: 'a' }], config: { intervalMs: 5000 } })
    await start(h)
    assert.equal(h.calls.mutate.length, 1)
    mock.timers.tick(5000)
    await flush()
    assert.equal(h.calls.discover.length, 2)
    assert.equal(h.calls.mutate.length, 1)
    h.dispose()
  } finally { mock.timers.reset() }
})

for (const [label, listing] of [['reject', async () => { throw new Error('boom') }], ['empty', []], ['timeout', (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)))]]) {
  test(`listing ${label} → no mutate, warns once`, async () => {
    const h = harness({ listing, config: { timeoutMs: 20 } })
    await start(h)
    if (label === 'timeout') await new Promise(r => setTimeout(r, 60))
    await flush()
    h.dispose()
    assert.equal(h.calls.mutate.length, 0)
    assert.equal(h.calls.warn.length, 1)
  })
}

test('conflict does not throw and is retried next tick', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const h = harness({ listing: [{ id: 'a' }], config: { intervalMs: 5000 } })
    const real = h.mutateImpl
    h.mutateImpl = async () => { throw new Error('conflict') }
    await start(h)
    assert.equal(h.calls.mutate.length, 1)
    h.mutateImpl = real
    mock.timers.tick(5000)
    await flush()
    assert.equal(h.calls.mutate.length, 2)
    assert.deepEqual(h.state.value.providers.cliproxy.models.map(m => m.id), ['a'])
    h.dispose()
    await flush()
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', onUnhandled); mock.timers.reset() }
})

test('dormant gate: native discoverModels in schema and route', async () => {
  const schema = { dict: { providers: { discoverModels: {} } } }
  const h = harness({ listing: [{ id: 'a' }], route: { discoverModels: true }, schema })
  await start(h)
  h.dispose()
  assert.equal(h.calls.discover.length, 0)
  assert.equal(h.calls.mutate.length, 0)
  // route flag alone (schema not inspectable) still runs
  const h2 = harness({ listing: [{ id: 'a' }], route: { discoverModels: true } })
  await start(h2)
  h2.dispose()
  assert.equal(h2.calls.mutate.length, 1)
})

test('missing baseURL → skip', async () => {
  const h = harness({ listing: [{ id: 'a' }], route: { baseURL: undefined } })
  await start(h)
  h.dispose()
  assert.equal(h.calls.discover.length, 0)
})

test('dispose stops interval and aborts in-flight run', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let seen
    const h = harness({ listing: (signal) => { seen = signal; return new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))) }, config: { intervalMs: 5000 } })
    await start(h)
    assert.ok(seen && !seen.aborted)
    h.dispose()
    await flush()
    assert.ok(seen.aborted)
    mock.timers.tick(20000)
    await flush()
    assert.equal(h.calls.discover.length, 1)
    assert.equal(h.calls.mutate.length, 0)
  } finally { mock.timers.reset() }
})

test('mergeModels never yields invalid ids', () => {
  assert.deepEqual(mergeModels({ listing: [{ id: '-x' }, { id: 'ok' }], current: [], seed: [], pinned: ['bad/id'] }).map(m => m.id), ['ok'])
})
