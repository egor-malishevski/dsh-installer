import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject, mergeModels } from '../payload/plugins/cliproxy-models/index.js'

const seed = [{ id: 'a', name: 'Seed A', input: ['text'], reasoningEfforts: { low: 'low' } }]
// rc.5 resolves model rows with extra defaulted fields; these must not cause write churn.
const resolved = (row) => ({ ...row, compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} } })

function harness({ route, listing, config = {}, extra = {}, schema, loader, current } = {}) {
  const state = {
    revision: 1,
    value: { providers: { cliproxy: { baseURL: 'http://x/v1', api: 'openai-completions', headers: { Authorization: 'Bearer SECRET' }, models: current ?? [{ id: 'old', name: 'Old', input: ['text'], contextWindow: 9 }], ...route } } },
  }
  const calls = { discover: [], mutate: [], warn: [], describeArgs: [] }
  // describe() is SYNC and takes an options object, returning an array of rows.
  const rows = () => [
    { ns: 'llm-pi-ai', value: state.value, revision: state.revision, schema },
    ...Object.entries(extra).map(([ns, value]) => ({ ns, value, revision: 1 })),
  ]
  let dispose
  const h = {
    listing,
    mutateImpl: async (ns, ops) => {
      state.value = structuredClone(state.value)
      state.value.providers.cliproxy.models = ops[0].value.map(resolved)
      state.revision += 1
    },
    state, calls,
    ctx: {
      logger: { warn: m => calls.warn.push(m), info() {} },
      effect(fn) { dispose = fn() },
      get: (key) => (key === 'loader' ? loader : undefined),
      settings: {
        describe: (...args) => { calls.describeArgs.push(args); return rows() },
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
const ids = (h) => h.calls.mutate.at(-1).ops[0].value.map(m => m.id)

test('exports', () => { assert.equal(name, 'cliproxy-models'); assert.deepEqual(inject, ['llm', 'settings']) })

test('sorted merge, seed wins, unknown default, user extras kept', async () => {
  const h = harness({ listing: [{ id: 'b', name: 'B' }, { id: 'a', name: 'Listed A' }, { id: 'old' }, { id: 'bad id' }] })
  await start(h)
  h.dispose()
  assert.equal(h.calls.mutate.length, 1)
  const next = h.calls.mutate[0].ops[0].value
  assert.deepEqual(next.map(m => m.id), ['a', 'b', 'old'])
  assert.equal(next[0].name, 'Seed A')
  assert.deepEqual(next[0].input, ['text'])
  assert.deepEqual(next[1], { id: 'b', name: 'B', input: ['text', 'image'] })
  assert.equal(next[2].contextWindow, 9)
  assert.equal(next[2].name, 'Old')
})

test('describe() is called without a namespace; discover args; one mutate with numeric revision; no secret logs', async () => {
  const h = harness({ listing: [{ id: 'a' }] })
  await start(h)
  h.dispose()
  assert.ok(h.calls.describeArgs.every(args => args.length === 0 || typeof args[0] !== 'string'))
  const { ns, r, signal } = h.calls.discover[0]
  assert.equal(ns, 'llm-pi-ai')
  assert.deepEqual(r, { provider: 'cliproxy', baseURL: 'http://x/v1', api: 'openai-completions' })
  assert.ok(signal instanceof AbortSignal)
  assert.equal(h.calls.mutate.length, 1)
  assert.deepEqual(h.calls.mutate[0].ops[0].path, ['providers', 'cliproxy', 'models'])
  assert.equal(h.calls.mutate[0].rev, 1)
  assert.ok(!h.calls.warn.join().includes('SECRET'))
})

test('shuffled listing and resolved rows cause no second mutate', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const h = harness({ current: [], listing: [{ id: 'c' }, { id: 'a' }, { id: 'b' }], config: { intervalMs: 5000 } })
    await start(h)
    assert.equal(h.calls.mutate.length, 1)
    assert.deepEqual(ids(h), ['a', 'b', 'c'])
    h.listing = [{ id: 'b' }, { id: 'c' }, { id: 'a' }]
    mock.timers.tick(5000); await flush()
    h.listing = [{ id: 'a' }, { id: 'c' }, { id: 'b' }]
    mock.timers.tick(5000); await flush()
    assert.equal(h.calls.discover.length, 3)
    assert.equal(h.calls.mutate.length, 1)
    h.dispose()
  } finally { mock.timers.reset() }
})

test('pinned ids from config, default model and roles are kept (sorted after listing)', async () => {
  const h = harness({
    current: [],
    listing: [{ id: 'a' }],
    config: { pinned: ['cfg-pin'] },
    extra: {
      'agent-default-model': { provider: 'cliproxy', model: 'def-model' },
      'oh-my-dsh-slim': { roles: { fixer: { provider: 'cliproxy', model: 'role-m' }, oracle: { provider: 'other', model: 'nope' } }, orchestrator: {} },
    },
  })
  await start(h)
  h.dispose()
  assert.deepEqual(ids(h), ['a', 'cfg-pin', 'def-model', 'role-m'])
  assert.deepEqual(h.calls.mutate[0].ops[0].value[1], { id: 'cfg-pin', name: 'cfg-pin', input: ['text', 'image'] })
})

test('removal grace: kept until dropAfter misses, reappearance resets, permanent pins stay', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const current = ['a', 'gone', 'back', 'pin'].map(id => ({ id, name: id, input: ['text'] }))
    const h = harness({ current, listing: [{ id: 'a' }, { id: 'new' }], config: { intervalMs: 5000, dropAfter: 3, pinned: ['pin'], seed: [] } })
    const tick = async () => { mock.timers.tick(5000); await flush() }
    await start(h) // miss 1 for gone/back
    assert.deepEqual(ids(h), ['a', 'new', 'back', 'gone', 'pin'])
    h.listing = [{ id: 'a' }, { id: 'back' }, { id: 'new' }]
    await tick() // gone miss 2, back reset
    assert.deepEqual(ids(h), ['a', 'back', 'new', 'gone', 'pin'])
    h.listing = [{ id: 'a' }, { id: 'new' }]
    await tick() // gone miss 3 -> dropped; back miss 1
    assert.deepEqual(ids(h), ['a', 'new', 'back', 'pin'])
    await tick() // back miss 2
    await tick() // back miss 3 -> dropped
    assert.deepEqual(ids(h), ['a', 'new', 'pin'])
    h.dispose()
  } finally { mock.timers.reset() }
})

test('error and empty listings do not count toward expiry', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const current = ['a', 'gone'].map(id => ({ id, name: id, input: ['text'] }))
    const h = harness({ current, listing: [{ id: 'a' }, { id: 'z' }], config: { intervalMs: 5000, dropAfter: 2, seed: [] } })
    const tick = async () => { mock.timers.tick(5000); await flush() }
    await start(h) // miss 1
    h.listing = []; await tick(); await tick()
    h.listing = async () => { throw new Error('boom') }; await tick(); await tick()
    assert.equal(h.calls.mutate.length, 1)
    assert.ok(ids(h).includes('gone'))
    h.listing = [{ id: 'a' }, { id: 'z' }]
    await tick() // miss 2 -> dropped
    assert.deepEqual(ids(h), ['a', 'z'])
    h.dispose()
  } finally { mock.timers.reset() }
})

for (const [label, listing] of [['reject', async () => { throw new Error('boom Bearer SECRET') }], ['empty', []], ['timeout', (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)))]]) {
  test(`listing ${label} → no mutate, warns once, no raw message`, async () => {
    const h = harness({ listing, config: { timeoutMs: 20 } })
    await start(h)
    if (label === 'timeout') await new Promise(r => setTimeout(r, 60))
    await flush()
    h.dispose()
    assert.equal(h.calls.mutate.length, 0)
    assert.equal(h.calls.warn.length, 1)
    assert.ok(!h.calls.warn.join().includes('SECRET'))
  })
}

test('warnings dedupe per streak and recover clears the streak', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const h = harness({ listing: [], config: { intervalMs: 5000 } })
    const tick = async () => { mock.timers.tick(5000); await flush() }
    await start(h); await tick(); await tick()
    assert.equal(h.calls.warn.length, 1)
    h.listing = [{ id: 'a' }]; await tick()
    h.listing = []; await tick()
    assert.equal(h.calls.warn.length, 2)
    h.dispose()
  } finally { mock.timers.reset() }
})

test('conflict does not throw, is retried next tick, warns once', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const h = harness({ listing: [{ id: 'a' }], config: { intervalMs: 5000 } })
    const real = h.mutateImpl
    h.mutateImpl = async () => { throw Object.assign(new Error('conflict token=SECRET'), { code: 'CONFLICT' }) }
    await start(h)
    mock.timers.tick(5000); await flush()
    assert.equal(h.calls.mutate.length, 2)
    assert.equal(h.calls.warn.length, 1)
    assert.ok(!h.calls.warn[0].includes('SECRET'))
    h.mutateImpl = real
    mock.timers.tick(5000); await flush()
    assert.equal(h.calls.mutate.length, 3)
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

test('interval starts before loader; loader failure still runs initial tick', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const h = harness({ listing: [{ id: 'a' }], loader: { await: () => Promise.reject(new Error('loader down')) }, config: { intervalMs: 5000 } })
    apply(h.ctx, h.config)
    mock.timers.tick(5000) // interval already armed synchronously
    await flush()
    assert.ok(h.calls.discover.length >= 1)
    h.dispose()
  } finally { mock.timers.reset() }
  const h2 = harness({ listing: [{ id: 'a' }], loader: { await: async () => {} } })
  h2.ctx.get = () => { throw new Error('no loader') }
  await start(h2)
  h2.dispose()
  assert.equal(h2.calls.mutate.length, 1)
})

test('dispose before loader resolves prevents any write', async () => {
  let release
  const h = harness({ listing: [{ id: 'a' }], loader: { await: () => new Promise(r => { release = r }) } })
  apply(h.ctx, h.config)
  await flush()
  h.dispose()
  release()
  await flush()
  assert.equal(h.calls.discover.length, 0)
  assert.equal(h.calls.mutate.length, 0)
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
