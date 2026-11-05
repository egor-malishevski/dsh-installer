import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateConfigDocument, FALLBACK_ROLE_IDS, MAX_FALLBACKS } from '../payload/plugins/oh-my-dsh-slim/preset/config.js';
import { apply, createCooldowns, COOLDOWN_MS, FAILOVER_CODES } from '../payload/plugins/oh-my-dsh-slim/preset/subagent-roles.js';
import { buildConfigSchema } from '../payload/plugins/oh-my-dsh-slim/lib/config-settings.js';

const dir = mkdtempSync(join(tmpdir(), 'native-fallback-'));
let seq = 0;
function useConfig(doc) {
  const path = join(dir, `cfg-${seq += 1}.json`);
  writeFileSync(path, JSON.stringify(doc));
  process.env.OH_MY_DSH_SLIM_CONFIG = path;
}
test.after(() => { delete process.env.OH_MY_DSH_SLIM_CONFIG; });

const PRIMARY = { provider: 'p0', model: 'm0' };
const FB1 = { provider: 'p1', model: 'm1', effort: 'high' };
const FB2 = { provider: 'p2', model: 'm2' };
const INFO = {
  p0: { reasoning: { efforts: [{ id: 'max' }, { id: 'high' }] } },
  p1: { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } },
  p2: {},
};

function roleDoc(extra = {}, role = 'fixer') {
  return { roles: { [role]: { ...PRIMARY, effort: 'max', fallbacks: [FB1, FB2], ...extra } } };
}

/** Fake ctx collecting listeners with their options. */
function makeHarness({ missing = [], now = () => 0, role = 'fixer', subagent = true } = {}) {
  const listeners = {};
  const options = {};
  const logs = [];
  const missingSet = new Set(missing);
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    effect: (fn) => fn(),
    on: (name, fn, opts) => { listeners[name] = fn; options[name] = opts; return () => {}; },
    get: (name) => {
      if (name === 'llm') {
        return { resolveModelInfo: async (provider, model) => {
          if (missingSet.has(provider + '/' + model)) throw new Error('unknown');
          return INFO[provider] ?? {};
        } };
      }
      throw new Error('no ' + name);
    },
  };
  apply(ctx, { now: () => now() });
  const agent = {
    options: subagent ? { dshRoleId: role } : {},
    session: { header: subagent ? { origin: 'subagent' } : {} },
  };
  const request = (turn, step, seed = { ...PRIMARY, reasoningEffort: 'max' }) =>
    listeners['agent/request']({ agent, turn, step, signal: new AbortController().signal }, async () => seed);
  const fail = (turn, step, failure, { signal = new AbortController().signal, hostNext } = {}) => {
    let nextCalls = 0;
    const out = listeners['agent/request-error']({ agent, turn, step, provider: 'x', failure, signal },
      async () => { nextCalls += 1; return hostNext; });
    return out.then((action) => ({ action, nextCalls }));
  };
  return { ctx, listeners, options, logs, agent, request, fail };
}

test('error listener is global, prepended, request listener global', () => {
  useConfig(roleDoc());
  const h = makeHarness();
  assert.deepEqual(h.options['agent/request-error'], { global: true, prepend: true });
  assert.equal(h.options['agent/request'].global, true);
});

test('quota error retries same step on fallback; next() not called; effort set from fallback', async () => {
  useConfig(roleDoc());
  const h = makeHarness();
  const first = await h.request(1, 1);
  assert.equal(first.model, 'm0');
  assert.equal(first.reasoningEffort, 'max');
  const { action, nextCalls } = await h.fail(1, 1, { code: 'QUOTA', message: 'q' });
  assert.deepEqual(action, { kind: 'retry' });
  assert.equal(nextCalls, 0);
  const second = await h.request(1, 1);
  assert.deepEqual([second.provider, second.model, second.reasoningEffort], ['p1', 'm1', 'high']);
  assert.ok(h.logs.some((l) => l.includes('model role switch role=fixer from=p0/m0 to=p1/m1 reason=QUOTA')));
  assert.ok(!h.logs.join('\n').includes('"message"'));
});

test('fallback without effort drops role effort', async () => {
  useConfig(roleDoc({ fallbacks: [FB2] }));
  const h = makeHarness();
  await h.request(1, 1);
  await h.fail(1, 1, { code: 'SERVER', message: 's' });
  const second = await h.request(1, 1);
  assert.equal(second.model, 'm2');
  assert.ok(!('reasoningEffort' in second));
});

test('fallback effort the model does not declare is dropped', async () => {
  useConfig(roleDoc({ fallbacks: [{ provider: 'p2', model: 'm2', effort: 'high' }] }));
  const h = makeHarness();
  await h.request(1, 1);
  await h.fail(1, 1, { code: 'SERVER', message: 's' });
  const second = await h.request(1, 1);
  assert.ok(!('reasoningEffort' in second));
});

test('new step returns to primary; cooling candidates are skipped on new step', async () => {
  useConfig(roleDoc());
  const h = makeHarness();
  await h.request(1, 1);
  await h.fail(1, 1, { code: 'ACCOUNT_QUOTA', message: 'q' }); // primary cooled 10 min
  await h.request(1, 1);
  const next = await h.request(1, 2); // new step: primary cooling -> first non-cooling fallback
  assert.equal(next.model, 'm1');
  // cool fb1 too, step 3 lands on fb2
  await h.fail(1, 2, { code: 'UNKNOWN_MODEL', message: 'u' });
  assert.equal((await h.request(1, 2)).model, 'm2');
  assert.equal((await h.request(1, 3)).model, 'm2');
});

test('primary is used again once cooldown expires (injectable clock)', async () => {
  useConfig(roleDoc());
  let t = 1000;
  const h = makeHarness({ now: () => t });
  await h.request(1, 1);
  await h.fail(1, 1, { code: 'QUOTA', message: 'q' });
  assert.equal((await h.request(1, 2)).model, 'm1');
  t += COOLDOWN_MS.long + 1;
  assert.equal((await h.request(1, 3)).model, 'm0');
});

test('all candidates cooling: new step probes primary', async () => {
  useConfig(roleDoc({ fallbacks: [FB2] }));
  const h = makeHarness();
  await h.request(1, 1);
  await h.fail(1, 1, { code: 'QUOTA', message: 'q' });
  await h.request(1, 1);
  await h.fail(1, 1, { code: 'QUOTA', message: 'q' }); // exhausted -> next
  const probe = await h.request(1, 2);
  assert.equal(probe.model, 'm0');
  assert.equal(probe.reasoningEffort, 'max');
});

test('exhausted chain passes to next(); each candidate at most once per step', async () => {
  useConfig(roleDoc());
  const h = makeHarness();
  await h.request(1, 1);
  const calls = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await h.fail(1, 1, { code: 'RATE_LIMIT', message: 'r' }, { hostNext: { kind: 'retry' } });
    calls.push(r);
    if (r.nextCalls > 0) break;
    await h.request(1, 1);
  }
  assert.equal(calls.length, 3); // primary->fb1, fb1->fb2, fb2->host
  assert.deepEqual(calls[2].action, { kind: 'retry' });
  assert.equal(calls[2].nextCalls, 1);
  assert.equal(calls[0].nextCalls + calls[1].nextCalls, 0);
});

test('non-trigger codes, abort, unknown role, main and no chain pass through unchanged', async () => {
  useConfig(roleDoc());
  const h = makeHarness();
  await h.request(1, 1);
  for (const code of ['AUTH', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST', 'UNSUPPORTED', 'ABORTED', 'MISSING_CREDENTIAL']) {
    assert.ok(!FAILOVER_CODES.includes(code));
    const r = await h.fail(1, 1, { code, message: 'x' });
    assert.equal(r.action, undefined);
    assert.equal(r.nextCalls, 1);
  }
  const ac = new AbortController();
  ac.abort();
  const aborted = await h.fail(1, 1, { code: 'QUOTA', message: 'q' }, { signal: ac.signal });
  assert.equal(aborted.action, undefined);
  assert.equal(aborted.nextCalls, 1);
  assert.equal((await h.request(1, 1)).model, 'm0');

  // main/orchestrator
  const main = makeHarness({ subagent: false });
  await main.request(1, 1);
  assert.equal((await main.fail(1, 1, { code: 'QUOTA', message: 'q' })).nextCalls, 1);
  // no chain
  useConfig({ roles: { fixer: { ...PRIMARY } } });
  const bare = makeHarness();
  await bare.request(1, 1);
  assert.equal((await bare.fail(1, 1, { code: 'QUOTA', message: 'q' })).nextCalls, 1);
  assert.equal((await bare.request(1, 1)).model, 'm0');
  // error for a step the request listener never saw
  useConfig(roleDoc());
  const fresh = makeHarness();
  assert.equal((await fresh.fail(9, 9, { code: 'QUOTA', message: 'q' })).nextCalls, 1);
});

test('fallback with unresolvable metadata is skipped, never silently keeps old route', async () => {
  useConfig(roleDoc());
  const h = makeHarness({ missing: ['p1/m1'] });
  await h.request(1, 1);
  const r = await h.fail(1, 1, { code: 'SERVER', message: 's' });
  assert.deepEqual(r.action, { kind: 'retry' });
  assert.equal((await h.request(1, 1)).model, 'm2'); // skipped m1
  const none = makeHarness({ missing: ['p1/m1', 'p2/m2'] });
  await none.request(1, 1);
  const r2 = await none.fail(1, 1, { code: 'SERVER', message: 's' });
  assert.equal(r2.action, undefined);
  assert.equal(r2.nextCalls, 1);
});

test('cooldown rules: quota 10min, rate-limit clamp, two transient in 60s', () => {
  let t = 0;
  const cd = createCooldowns(() => t);
  const m = { provider: 'a', model: 'b' };
  cd.record(m, { code: 'RATE_LIMIT', providerRetryAfterMs: 1000 });
  t = 29_000; assert.ok(cd.isCooling(m));
  t = 30_001; assert.ok(!cd.isCooling(m));
  t = 0;
  const m2 = { provider: 'a', model: 'c' };
  cd.record(m2, { code: 'RATE_LIMIT', providerRetryAfterMs: 99_999_999 });
  t = 599_000; assert.ok(cd.isCooling(m2));
  t = 600_001; assert.ok(!cd.isCooling(m2));
  t = 0;
  const m3 = { provider: 'a', model: 'd' };
  cd.record(m3, { code: 'QUOTA' });
  t = 599_999; assert.ok(cd.isCooling(m3));
  t = 600_001; assert.ok(!cd.isCooling(m3));
  // transient
  t = 0;
  const m4 = { provider: 'a', model: 'e' };
  assert.equal(cd.record(m4, { code: 'SERVER' }), 0);
  assert.ok(!cd.isCooling(m4));
  t = 30_000;
  assert.equal(cd.record(m4, { code: 'TRANSPORT' }), COOLDOWN_MS.transient);
  assert.ok(cd.isCooling(m4));
  // two transients more than 60s apart do not cool
  t = 1_000_000;
  const m5 = { provider: 'a', model: 'f' };
  cd.record(m5, { code: 'TIMEOUT' });
  t += 61_000;
  assert.equal(cd.record(m5, { code: 'TIMEOUT' }), 0);
});

test('config validation: bad pairs, max 3, duplicates, effort, roles', () => {
  const bad = (doc, re) => assert.throws(() => validateConfigDocument(doc), re);
  validateConfigDocument(roleDoc());
  bad(roleDoc({ fallbacks: 'x' }), /must be an array/);
  bad(roleDoc({ fallbacks: [{ provider: 'p', model: '' }] }), /model must be a non-empty string/);
  bad(roleDoc({ fallbacks: [{ provider: 5, model: 'm' }] }), /provider must be a non-empty string/);
  bad(roleDoc({ fallbacks: [{ provider: 'a', model: 'b', extra: 1 }] }), /unknown field/);
  bad(roleDoc({ fallbacks: ['a/b'] }), /must be an object/);
  assert.equal(MAX_FALLBACKS, 3);
  const four = [1, 2, 3, 4].map((n) => ({ provider: 'p' + n, model: 'm' + n }));
  bad(roleDoc({ fallbacks: four }), /at most 3/);
  validateConfigDocument(roleDoc({ fallbacks: four.slice(0, 3) }));
  bad(roleDoc({ fallbacks: [{ ...PRIMARY }] }), /duplicates/);
  bad(roleDoc({ fallbacks: [FB2, { ...FB2, effort: 'low' }] }), /duplicates/);
  bad(roleDoc({ fallbacks: [{ ...FB2, effort: 'bad effort' }] }), /effort must be a short token/);
  for (const id of ['councillor-alpha', 'councillor-beta', 'councillor-gamma', 'council', 'observer']) {
    bad({ roles: { [id]: { fallbacks: [FB2] } } }, /not supported for this role/);
  }
  bad({ orchestrator: { fallbacks: [FB2] } }, /orchestrator\.fallbacks/);
  for (const id of FALLBACK_ROLE_IDS) validateConfigDocument(roleDoc({}, id));
});

test('loadConfig replaces fallbacks arrays whole, including advanced.roles', () => {
  useConfig({ roles: { fixer: { ...PRIMARY, fallbacks: [FB1, FB2] } }, advanced: { roles: { fixer: { fallbacks: [FB2] } } } });
  assert.deepEqual(loadConfig().roles.fixer.fallbacks, [FB2]);
  useConfig({ roles: { fixer: { ...PRIMARY, fallbacks: [FB1, FB2] } } });
  assert.deepEqual(loadConfig().roles.fixer.fallbacks, [FB1, FB2]);
  useConfig({ roles: { oracle: { ...PRIMARY } } });
  assert.equal(loadConfig().roles.oracle.fallbacks, undefined);
});

test('settings schema carries fallbacks field (real schemastery when a host copy is extracted)', async (t) => {
  const { existsSync } = await import('node:fs');
  const path = process.env.DSH_SCHEMASTERY_PATH || '/tmp/dshx/ex/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
  if (!existsSync(path)) { t.skip('host schemastery not available; set DSH_SCHEMASTERY_PATH'); return; }
  const z = (await import(path)).default;
  const schema = buildConfigSchema(z);
  // Volatile fields parse to {} in the host (existing behaviour), so assert accept/reject.
  const ok = { provider: 'a', model: 'b', effort: 'high' };
  schema.dict.roles({ fixer: { fallbacks: [ok] } });
  schema.dict.roles({ fixer: { model: 'x' } });
  schema.dict.presets({ 'my-dsh-normal': { oracle: { fallbacks: [ok] } } });
  assert.throws(() => schema.dict.roles({ fixer: { fallbacks: [{ provider: 'a', effort: 'high' }] } }), /fallbacks\[0\]\.model/);
  assert.throws(() => schema.dict.roles({ fixer: { fallbacks: [{ provider: 'a', model: 'b', effort: 'no good' }] } }));
  assert.throws(() => schema.dict.roles({ fixer: { fallbacks: 'x' } }));
  assert.throws(() => schema.dict.advanced({ roles: { oracle: { fallbacks: [{ provider: 'a' }] } } }), /fallbacks\[0\]\.model/);
});

test('mid-step config shrink/removal: no throw, snapshot kept, reaches next()', async () => {
  useConfig(roleDoc());
  const h = makeHarness();
  await h.request(1, 1);
  assert.deepEqual(await h.fail(1, 1, { code: 'SERVER', message: 's' }).then((r) => r.action), { kind: 'retry' });
  assert.equal((await h.request(1, 1)).model, 'm1');
  useConfig(roleDoc({ fallbacks: undefined })); // fallbacks removed mid-step
  const r = await h.fail(1, 1, { code: 'SERVER', message: 's' });
  assert.deepEqual(r.action, { kind: 'retry' }); // snapshot chain still advances to m2
  assert.equal((await h.request(1, 1)).model, 'm2');
  useConfig({ roles: { fixer: { ...PRIMARY } } });
  const last = await h.fail(1, 1, { code: 'SERVER', message: 's' });
  assert.equal(last.action, undefined);
  assert.equal(last.nextCalls, 1);
  assert.equal((await h.request(1, 1)).model, 'm2'); // host retry stays on last candidate, no primary repeat
  const again = await h.fail(1, 1, { code: 'SERVER', message: 's' });
  assert.equal(again.nextCalls, 1);
  assert.equal(again.action, undefined);
  await h.request(1, 2); // a new step resets normally
});

test('mid-step shrink/primary change does not throw or loop', async () => {
  useConfig(roleDoc());
  const h = makeHarness();
  await h.request(1, 1);
  await h.fail(1, 1, { code: 'SERVER', message: 's' });
  await h.request(1, 1);
  useConfig({ roles: { fixer: { provider: 'z', model: 'z' } } });
  const r = await h.fail(1, 1, { code: 'RATE_LIMIT', message: 'r' });
  assert.equal(r.action.kind, 'retry'); // snapshot chain: m1 -> m2
  assert.equal((await h.request(1, 1)).model, 'm2');
  assert.equal((await h.fail(1, 1, { code: 'RATE_LIMIT', message: 'r' })).nextCalls, 1);
});

test('request-side metadata loss mid-step: no further switch, no primary reset', async () => {
  useConfig(roleDoc());
  const miss = new Set();
  const h = makeHarness();
  h.ctx.get = (n) => {
    if (n !== 'llm') throw new Error('no ' + n);
    return { resolveModelInfo: async (p, m) => { if (miss.has(p + '/' + m)) throw new Error('gone'); return INFO[p] ?? {}; } };
  };
  await h.request(1, 1);
  assert.deepEqual((await h.fail(1, 1, { code: 'SERVER', message: 's' })).action, { kind: 'retry' });
  miss.add('p1/m1'); // candidate metadata disappears before the request side
  assert.equal((await h.request(1, 1)).model, 'm0'); // base, no swap
  miss.clear();
  const r = await h.fail(1, 1, { code: 'SERVER', message: 's' });
  assert.equal(r.action, undefined); // exhausted: no additional switch this step
  assert.equal(r.nextCalls, 1);
  assert.equal((await h.request(1, 1)).model, 'm0');
  assert.ok(await h.request(1, 2)); // a new step may reset normally
});

test('fake host loop: failed attempt reruns only the request; tools execute once after success', async () => {
  useConfig(roleDoc());
  const h = makeHarness();
  const seen = [];
  let toolRuns = 0;
  let prestep = 0;
  const outcomes = { 'p0/m0': { code: 'RATE_LIMIT', message: 'r' }, 'p1/m1': { code: 'TIMEOUT', message: 't' }, 'p2/m2': 'ok' };
  // Mirrors dsh-agent-loop step(): prepareRequest -> stream -> on failure waterfall
  // agent/request-error and `continue` on retry; tools run only after success.
  async function step(turn, stepNo) {
    prestep += 1;
    const signal = new AbortController().signal;
    while (true) {
      const cfg = await h.listeners['agent/request']({ agent: h.agent, turn, step: stepNo, signal }, async () => ({ ...PRIMARY, reasoningEffort: 'max' }));
      seen.push(cfg.provider + '/' + cfg.model);
      const outcome = outcomes[cfg.provider + '/' + cfg.model];
      if (outcome === 'ok') { toolRuns += 1; return 'completed'; }
      const action = await h.listeners['agent/request-error']({ agent: h.agent, turn, step: stepNo, provider: cfg.provider, failure: outcome, signal }, async () => undefined);
      if (action?.kind !== 'retry') throw new Error('request failed: ' + outcome.code);
    }
  }
  assert.equal(await step(1, 1), 'completed');
  assert.deepEqual(seen, ['p0/m0', 'p1/m1', 'p2/m2']);
  assert.equal(toolRuns, 1);
  assert.equal(prestep, 1);
  // Limitation: this is a contract-level mirror of dsh-agent-loop 0.2.1-rc.5
  // (step() lines ~1051-1146), not the real loop, which needs a full host.
});
