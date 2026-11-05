// preset/subagent-roles.js — per-role model parameters for delegated children.
//
// DSH 0.2.0 dropped the 0.1.x mechanism this preset used to steer a role's
// request (an agent option field carried through the delegation request). What
// survives is the persona the child session persists in its
// `subagent/descriptor` event, which is written BEFORE the first
// `agent/request` of that child — so the waterfall can still tell which role
// is asking and rewrite the resolved route.
//
// This row is the 0.2.0 successor of the 0.1.x `effort-by-role.js`: one
// standing listener for all six roles, reading the same configuration file, so
// role temperature and reasoning effort keep working without a per-role tool
// fork. Invalid configuration fails visibly, matching the upstream loader;
// an unidentified child receives the upstream high/0.1 fallback.
//
// An effort the mounted model does not offer is the one exception: it degrades
// (dropped, model default used) with a warning instead of failing the request.
// The settings card blocks such a value on save, so this path only serves
// configuration written outside the card — an older profile, a hand-edited
// document, or a model whose declaration changed. Failing there would turn an
// upgrade into "the subagent stopped working" with no way to run it.
//
// The route is also resolved per request: when the saved role model differs
// from the one the child inherited at mount, this listener reroutes the
// child's next request. That is what makes a card edit apply to an existing
// conversation instead of only to sessions created afterwards.

import { loadConfig, bindProfileContext, ROLE_IDS, FALLBACK_ROLE_IDS } from './config.js';
import { isSubagent, roleIdForAgent } from './roles.js';
import { hostImport } from './bridge.js';

/** Cordis plugin name. */
export const name = 'omds-subagent-roles';
/** `llm` is optional on purpose: without it the row still applies temperature
 * and keeps each role's configured effort, it just cannot verify the effort
 * against the model's declared list before the host does. */
export const inject = ['llm', 'loader'];

/** The orchestrator's own temperature, applied when the host resolved none. */
const ORCHESTRATOR_TEMPERATURE = 0.1;


/** Effort fallbacks already reported, so a live model switch warns once per
 * (role, route, effort) instead of on every child request. */
const effortWarnings = new Set();

/** Unavailable-route warnings already reported, one per (role, route). */
const routeWarnings = new Set();

function text(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The configured facts for one role, or undefined for the orchestrator or an
 * unknown role.
 * @param agent - a live agent from the agent/request payload.
 */
function roleFacts(ctx, agent) {
  const roleId = roleIdForAgent(agent);
  if (!ROLE_IDS.includes(roleId)) return undefined;
  const config = loadConfig(ctx);
  return { roleId, configured: config.roles[roleId], source: config.source };
}

/**
 * Report a configured effort the target model does not offer, once per
 * (role, route, effort, fallback).
 *
 * This is a degradation, not a failure: the request runs on the session's own
 * effort when that model declares it, and on the model default otherwise,
 * instead of being rejected at dispatch. It fires for configuration the card
 * could not gate — an inherited route whose session model changed, an old
 * profile saved before the model-scoped dropdown existed, a hand-edited
 * document, or a model whose declaration changed — so the warning is the only
 * trace outside the settings card.
 */
function warnEffortFallback(ctx, facts, target, effort, declared, fallback) {
  const key = facts.roleId + '|' + target.provider + '|' + target.model + '|' + effort + '|' + (fallback ?? '');
  if (effortWarnings.has(key)) return;
  effortWarnings.add(key);
  ctx.logger?.warn?.(
    'oh-my-dsh-slim: role "' + facts.roleId + '" effort "' + effort + '" is not offered by "' +
    target.provider + '/' + target.model + '"; ' +
    (fallback === undefined
      ? 'using the model default.'
      : 'using the session effort "' + fallback + '".') +
    (declared.length > 0 ? ' Declared: ' + declared.join(', ') + '.' : ' The model declares no reasoning efforts.'),
  );
}

/**
 * The route the delegating session is running right now, or undefined.
 *
 * A child session persists its `parentSession` in the header, and the parent
 * agent keeps its latest request header — the same source the host reads when
 * it resolves a child at spawn (`parentAgentOptionsForDelegation`). Re-reading
 * it per request is what makes "follow the session model" survive a main-model
 * switch inside a running conversation: the child's spawn options keep the
 * route that was current when the role tool was mounted, which is exactly the
 * value this function replaces.
 */
function parentRoute(ctx, agent) {
  const parentId = agent?.session?.header?.parentSession;
  if (!text(parentId)) return undefined;
  let agents;
  try { agents = ctx.get('agents'); } catch { return undefined; }
  try {
    const parent = typeof agents?.get === 'function' ? agents.get(parentId) : undefined;
    const config = parent?.session?.requestHeader?.()?.config;
    if (!text(config?.provider) || !text(config?.model)) return undefined;
    return config;
  } catch {
    // A disposed or half-torn-down parent must not break the child's request:
    // falling back to the resolved route is the pre-existing behaviour.
    return undefined;
  }
}

/** Resolve the route this request should use: the role's configured provider
 * AND model when both are present, otherwise the delegating session's current
 * route, otherwise whatever the host already resolved.
 * Half a route (only one of the two) is treated as "no route" for the same
 * reason roles.js omits it: pairing one provider id with another provider's
 * model id would produce a target nobody asked for. Roles ship without a route
 * (issue #11), so following the session is the default path: the parent's live
 * header is what the child would have inherited had it been created now. */
function targetRoute(configured, resolved, parent) {
  if (text(configured?.provider) && text(configured?.model)) {
    return { provider: configured.provider, model: configured.model };
  }
  if (text(parent?.provider) && text(parent?.model)) {
    return { provider: parent.provider, model: parent.model };
  }
  return { provider: resolved?.provider, model: resolved?.model };
}

/** A route change is only meaningful when the host resolved both halves; a
 * fixture without them keeps the historical behaviour. */
function routeChanged(target, resolved) {
  if (!text(resolved?.provider) || !text(resolved?.model)) return false;
  return target.provider !== resolved.provider || target.model !== resolved.model;
}

/** Model metadata for the route a role is configured to use. Metadata lookup is
 * advisory (as upstream): a transient or unknown failure must not break a
 * request that could still run on the route the host already resolved, so the
 * failure is reported and the caller keeps the current route. */
async function resolveRoute(ctx, target, facts, silent = false) {
  // A fixture without a resolved provider/model has nothing to look up; the
  // caller keeps the route it already has instead of issuing a dead request.
  if (!text(target?.provider) || !text(target?.model)) return undefined;
  let llm;
  try { llm = ctx.get('llm'); } catch { return undefined; }
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return undefined;
  try {
    return await llm.resolveModelInfo(target.provider, target.model, undefined);
  } catch (error) {
    const key = facts.roleId + '|' + target.provider + '|' + target.model;
    if (!silent && !routeWarnings.has(key)) {
      routeWarnings.add(key);
      ctx.logger?.warn?.(
        'oh-my-dsh-slim: role "' + facts.roleId + '": metadata is unavailable; keeping the current route (' +
        target.provider + '/' + target.model + ').' +
        (text(error?.message) ? ' (' + error.message + ')' : ''),
      );
    }
    return undefined;
  }
}

/** The effort ids a model declares, or undefined when it declares none. */
function declaredEfforts(info) {
  const efforts = info?.reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  return efforts.map((entry) => String(entry?.id));
}

/**
 * The config this role's request needs. Role temperature overrides inherited
 * temperature, configured effort overrides inherited effort, and `none` leaves
 * the resolved effort untouched on an unchanged route (it is dropped when the
 * model is rerouted, because the effort belonged to the old model).
 *
 * The model is read from the live configuration on every request. A role whose
 * configured route differs from the one resolved at mount (because the user
 * changed the card after the session started) is rerouted here, so saving the
 * card takes effect on the current conversation instead of only the next one.
 *
 * A role WITHOUT a route follows the delegating session, and that route is
 * re-read from the parent's live request header on every request as well. The
 * spawn options alone cannot express "follow": they carry the route that was
 * current when this role tool mounted, so a main-model switch inside a running
 * conversation would silently leave the child on the old model — the same
 * class of staleness the pinned-route reroute above already fixes.
 * @returns the next config, or undefined when the request needs no change.
 */
async function requestConfig(ctx, payload, resolved) {
  const child = isSubagent(payload?.agent);
  if (!child) {
    const patch = {};
    if (resolved?.temperature === undefined) patch.temperature = ORCHESTRATOR_TEMPERATURE;
    const effort = loadConfig(ctx).orchestrator?.effort;
    if (text(effort) && effort !== 'none' && effort !== resolved?.reasoningEffort) {
      const target = { provider: resolved?.provider, model: resolved?.model };
      const facts = { roleId: 'orchestrator' };
      const info = await resolveRoute(ctx, target, facts);
      const declared = declaredEfforts(info);
      if (info !== undefined && !(declared ?? []).includes(effort)) {
        warnEffortFallback(ctx, facts, target, effort, declared ?? [], resolved?.reasoningEffort);
      } else {
        patch.reasoningEffort = effort;
      }
    }
    return Object.keys(patch).length === 0 ? undefined : { ...resolved, ...patch };
  }
  const facts = roleFacts(ctx, payload.agent);
  const configured = facts?.configured;
  if (configured === undefined) {
    const patch = {};
    if (resolved?.reasoningEffort === undefined) patch.reasoningEffort = 'high';
    if (resolved?.temperature === undefined) patch.temperature = 0.1;
    return Object.keys(patch).length === 0 ? undefined : { ...resolved, ...patch };
  }

  // A role without its own route follows the delegating session. The parent's
  // header is the route this child would inherit if it were created now; the
  // spawn options are only the mount-time snapshot of the same source.
  const following = !(text(configured.provider) && text(configured.model));
  // Read the session route for BOTH cases: a pinned role still needs it to
  // tell the session's output cap apart from a cap that belongs to this model.
  const parent = parentRoute(ctx, payload.agent);
  const target = targetRoute(configured, resolved, parent);
  const changed = routeChanged(target, resolved);
  // A pinned route that names a different model than the session must not
  // inherit the session's output cap: the host copies it unconditionally, and
  // the target model may have a smaller limit. A cap the role names explicitly
  // still wins; without one the target model's own default applies.
  const foreignCap = !following && parent !== undefined
    && (parent.provider !== target.provider || parent.model !== target.model)
    && typeof configured.maxTokens !== 'number';
  const effort = configured.effort;
  const effortRequested = text(effort) && effort !== 'none';
  // Metadata answers two questions: whether the saved route differs from the
  // one the host resolved (reroute), and whether the saved effort is one that
  // route offers. A failed lookup is advisory for both — it must not break a
  // request that can still run.
  const info = changed || effortRequested ? await resolveRoute(ctx, target, facts) : undefined;
  // A route whose metadata cannot be read is not rerouted: breaking a request
  // that still has a working route is worse than leaving the live
  // configuration unapplied for this request.
  const reroute = changed && info !== undefined;
  // The session values may only travel with the session route. When the target
  // lookup fails, the request stays on the route the host resolved, and copying
  // the parent's level or cap onto another model is exactly the kind of
  // mismatch this row exists to prevent.
  const onSessionRoute = parent !== undefined && (!changed || reroute);
  // An explicit cap on an already-mounted pinned route still has to respect the
  // model's declared default; the first request of a session never takes the
  // reroute branch, so it needs its own (silent, fail-open) lookup.
  const capInfo = !following && !changed && typeof configured.maxTokens === 'number' && info === undefined
    ? await resolveRoute(ctx, target, facts, true)
    : info;
  const patch = {};
  let dropEffort = false;
  let dropMaxTokens = foreignCap && resolved?.maxTokens !== undefined;

  if (reroute) {
    patch.provider = target.provider;
    patch.model = target.model;
    if (!foreignCap) {
      // A pinned role's own cap is authoritative; anything larger than the
      // target model's declared default is clamped.
      const modelCap = typeof capInfo?.defaultMaxTokens === 'number' ? capInfo.defaultMaxTokens : undefined;
      const roleCap = typeof configured.maxTokens === 'number' ? configured.maxTokens : undefined;
      const cap = roleCap === undefined
        ? (typeof resolved?.maxTokens === 'number' && modelCap !== undefined ? Math.min(resolved.maxTokens, modelCap) : undefined)
        : (modelCap === undefined ? roleCap : Math.min(roleCap, modelCap));
      if (cap !== undefined && cap !== resolved?.maxTokens) patch.maxTokens = cap;
    }
  } else if (!following && typeof configured.maxTokens === 'number') {
    // First request of a pinned role: the cap came from the role itself at
    // mount, so nothing would ever clamp it. Honour the model's declared
    // default here too (fail-open when the lookup is unavailable).
    const modelCap = typeof capInfo?.defaultMaxTokens === 'number' ? capInfo.defaultMaxTokens : undefined;
    if (modelCap !== undefined && configured.maxTokens > modelCap) patch.maxTokens = modelCap;
  }

  // The effort lands on the route the request will actually run on: the
  // rerouted target when the reroute is possible, otherwise the route the host
  // already resolved (a failed target lookup leaves the request where it was).
  // The second lookup is silent — the first one already reported the outage.
  const effortRoute = !effortRequested
    ? undefined
    : reroute || !changed
      ? target
      : { provider: resolved?.provider, model: resolved?.model };
  const effortInfo = effortRoute === undefined || effortRoute === target
    ? info
    : await resolveRoute(ctx, effortRoute, facts, true);

  if (effortRequested) {
    // `effortInfo === undefined` means the lookup failed: keep the saved level
    // and let the host judge it (fail-open, matching the reroute decision
    // above). Metadata without declared efforts means the model has no effort
    // control, so no explicit level is supported.
    const declared = declaredEfforts(effortInfo);
    const supported = effortInfo === undefined ? undefined : (declared ?? []).includes(effort);
    if (supported === false) {
      // The saved level belongs to a model this route replaced, or it was
      // written outside the card (an old profile, a hand-edited document, a
      // model whose declaration changed). Prefer the level the child inherited
      // from the session: on an inherited route that is the main model's own
      // effort, so "follow the model" lands on what the session actually runs
      // with instead of an arbitrary model default. A pinned route (where the
      // inherited value IS the unsupported saved level) or a level the session
      // model also cannot use falls back to the model default. Either way the
      // request stays runnable; the card remains the visible fix point.
      const inherited = resolved?.reasoningEffort;
      const fallback = text(inherited) && inherited !== effort && (declared ?? []).includes(inherited)
        ? inherited
        : undefined;
      if (fallback === undefined) dropEffort = true;
      warnEffortFallback(ctx, facts, effortRoute, effort, declared ?? [], fallback);
    } else if (effort !== resolved?.reasoningEffort) {
      patch.reasoningEffort = effort;
    }
  } else if (following && onSessionRoute) {
    // No role level: inherit the session's level verbatim. The parent header
    // is what the main model actually sends, so the value is supported by
    // construction — unlike the spawn snapshot, which can belong to a model
    // the session has since replaced.
    if (text(parent.reasoningEffort)) {
      if (parent.reasoningEffort !== resolved?.reasoningEffort) patch.reasoningEffort = parent.reasoningEffort;
    } else if (resolved?.reasoningEffort !== undefined) {
      dropEffort = true;
    }
  } else if (reroute) {
    // The inherited effort belonged to the old route; keeping it is what
    // breaks a switch to a model with a different effort vocabulary.
    dropEffort = true;
  }

  // The output cap follows the same rule: a followed session carries the
  // session's own cap (valid for the model that owns it), while a pinned route
  // keeps the role budget clamped to the target model above.
  if (following && onSessionRoute) {
    if (typeof parent.maxTokens === 'number') {
      if (parent.maxTokens !== resolved?.maxTokens) patch.maxTokens = parent.maxTokens;
    } else if (resolved?.maxTokens !== undefined) {
      dropMaxTokens = true;
    }
  }

  if (configured.temperature !== undefined && configured.temperature !== resolved?.temperature) {
    patch.temperature = configured.temperature;
  }

  if (Object.keys(patch).length === 0 && !dropEffort && !dropMaxTokens) return undefined;
  const next = { ...resolved, ...patch };
  if (dropEffort) delete next.reasoningEffort;
  if (dropMaxTokens) delete next.maxTokens;
  return next;
}

// ---------------------------------------------------------------------------
// Native model failover (roles.<specialist>.fallbacks)
//
// DSH 0.2.1 dispatches `agent/request-error` when a model request fails and a
// listener returning { kind: 'retry' } makes the loop run prepareRequest and
// agent/request AGAIN for the SAME turn/step — no pre-step, no tool rerun (tools
// execute only after a successful assistant message; failed attempts never
// reach model history). So failover is: remember which candidate the step runs
// on, advance it in the error listener, and let the request listener above
// apply it. The host agent object is the same in both waterfalls
// (agentEvents(loopCtx, this) fuses the agent), so a WeakMap keyed by it is a
// stable identity; entries carry {turn, step, index}.
// ---------------------------------------------------------------------------

/** Failure codes that justify moving to the next candidate. Everything else
 * (AUTH, context, invalid request, unsupported, aborted ...) passes through. */
export const FAILOVER_CODES = Object.freeze([
  'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  'EMPTY_RESPONSE', 'UNKNOWN_MODEL', 'PI_AI_ERROR',
]);
const LONG_COOLDOWN_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'UNKNOWN_MODEL']);
const TRANSIENT_CODES = new Set(['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'PI_AI_ERROR']);
export const COOLDOWN_MS = Object.freeze({
  long: 10 * 60_000,
  rateMin: 30_000,
  rateMax: 600_000,
  transient: 60_000,
  transientWindow: 60_000,
  transientCount: 2,
});

const modelKey = (route) => route.provider + '\u0000' + route.model;

/**
 * Per provider/model cooldowns. Success does not reset counters (no safe hook);
 * transient failures simply expire from a 60 s window.
 * @param now - injectable clock returning epoch milliseconds.
 */
export function createCooldowns(now = Date.now) {
  const until = new Map();
  const transient = new Map();
  return {
    isCooling(route) {
      const end = until.get(modelKey(route));
      if (end === undefined) return false;
      if (end <= now()) { until.delete(modelKey(route)); return false; }
      return true;
    },
    /** Record a failure; returns the cooldown duration applied (0 = none). */
    record(route, failure) {
      const key = modelKey(route);
      const code = failure?.code;
      const at = now();
      let duration = 0;
      if (LONG_COOLDOWN_CODES.has(code)) duration = COOLDOWN_MS.long;
      else if (code === 'RATE_LIMIT') {
        const hint = Number.isFinite(failure?.providerRetryAfterMs) ? failure.providerRetryAfterMs : 0;
        duration = Math.min(COOLDOWN_MS.rateMax, Math.max(COOLDOWN_MS.rateMin, hint));
      } else if (TRANSIENT_CODES.has(code)) {
        const recent = (transient.get(key) ?? []).filter((time) => at - time < COOLDOWN_MS.transientWindow);
        recent.push(at);
        transient.set(key, recent);
        if (recent.length >= COOLDOWN_MS.transientCount) duration = COOLDOWN_MS.transient;
      }
      if (duration > 0) until.set(key, Math.max(until.get(key) ?? 0, at + duration));
      return duration;
    },
  };
}

/** The chain's candidate list: the effective primary route, then each fallback
 * that does not repeat an earlier pair (a following role's primary is dynamic,
 * so equality with it can only be checked here). */
function buildChain(primary, fallbacks) {
  const chain = [{ provider: primary.provider, model: primary.model, primary: true }];
  const seen = new Set([modelKey(primary)]);
  for (const entry of fallbacks) {
    const key = modelKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ provider: entry.provider, model: entry.model, ...(entry.effort === undefined ? {} : { effort: entry.effort }) });
  }
  return chain;
}

/** The specialist's declared fallbacks, or [] when it has none. */
function fallbackFacts(ctx, agent) {
  if (!isSubagent(agent)) return undefined;
  const facts = roleFacts(ctx, agent);
  const list = facts?.configured?.fallbacks;
  if (!FALLBACK_ROLE_IDS.includes(facts?.roleId) || !Array.isArray(list) || list.length === 0) return undefined;
  return { ...facts, fallbacks: list };
}

/** Config for a fallback candidate, or undefined when its metadata cannot be
 * resolved (the candidate is then skipped, never silently replaced by the old
 * route). The role's own effort belongs to the primary model and is dropped;
 * the candidate's effort applies only when that model declares it. */
async function fallbackConfig(ctx, facts, base, candidate) {
  const info = await resolveRoute(ctx, candidate, facts, true);
  if (info === undefined) return undefined;
  const next = { ...base, provider: candidate.provider, model: candidate.model };
  delete next.reasoningEffort;
  if (text(candidate.effort)) {
    const declared = declaredEfforts(info);
    if ((declared ?? []).includes(candidate.effort)) next.reasoningEffort = candidate.effort;
    else warnEffortFallback(ctx, facts, candidate, candidate.effort, declared ?? [], undefined);
  }
  const modelCap = typeof info.defaultMaxTokens === 'number' ? info.defaultMaxTokens : undefined;
  const roleCap = typeof facts.configured.maxTokens === 'number' ? facts.configured.maxTokens : undefined;
  if (roleCap !== undefined) next.maxTokens = modelCap === undefined ? roleCap : Math.min(roleCap, modelCap);
  else delete next.maxTokens;
  return next;
}

/**
 * Request side: pick the candidate for this step and return its config.
 * @returns the config to use, or undefined to keep `base`.
 */
async function failoverRequest(ctx, fo, payload, base) {
  const agent = payload?.agent;
  const turn = payload.turn;
  const step = payload.step;
  let state = fo.steps.get(agent);
  if (state !== undefined && state.turn === turn && state.step === step) {
    // The same step again. The snapshot taken at the step's first request is
    // authoritative: configuration edits or metadata loss mid-step never swap
    // the chain, and never reset to the primary (that would repeat it).
    // `exhausted` only stops further switching: a host retry of the chain's
    // last candidate keeps running on that candidate.
    if (state.lost || state.index === 0) return undefined;
    const candidate = state.chain[state.index];
    const config = candidate === undefined ? undefined : await fallbackConfig(ctx, state.facts, base, candidate);
    if (config !== undefined) return config;
    state.exhausted = true;
    state.lost = true;
    ctx.logger?.warn?.('oh-my-dsh-slim: role "' + state.roleId + '" fallback metadata unavailable; no further failover this step.');
    return undefined;
  }
  const facts = fallbackFacts(ctx, agent);
  if (facts === undefined) return undefined;
  const primary = { provider: base?.provider, model: base?.model };
  if (!text(primary.provider) || !text(primary.model)) return undefined;
  const chain = buildChain(primary, facts.fallbacks);
  {
    // A new step: first candidate that is not cooling and can be built; every
    // candidate cooling means one bounded probe of the primary.
    let chosen = 0;
    let config;
    for (let i = 0; i < chain.length; i += 1) {
      if (fo.cooldowns.isCooling(chain[i])) continue;
      if (i === 0) { chosen = 0; break; }
      config = await fallbackConfig(ctx, facts, base, chain[i]);
      if (config !== undefined) { chosen = i; break; }
    }
    state = {
      turn, step, index: chosen, chain, roleId: facts.roleId, exhausted: false,
      facts: { roleId: facts.roleId, configured: facts.configured },
    };
    fo.steps.set(agent, state);
    if (chosen > 0) {
      logSwitch(ctx, facts.roleId, chain[0], chain[chosen], 'cooldown');
      return config;
    }
    return undefined;
  }
}

/** Metadata-free record of a switch: roles and models only, never prompts or keys. */
function logSwitch(ctx, roleId, from, to, reason) {
  ctx.logger?.info?.(
    'oh-my-dsh-slim: model role switch role=' + roleId + ' from=' + from.provider + '/' + from.model +
    ' to=' + to.provider + '/' + to.model + ' reason=' + reason,
  );
}

/**
 * Error side: record the cooldown and, for an eligible failure, advance to the
 * next not-cooling candidate whose metadata resolves. Returns the retry action,
 * or undefined to let the next listener (the host's own retry) decide.
 */
async function failoverError(ctx, fo, payload) {
  const agent = payload?.agent;
  const state = agent === undefined ? undefined : fo.steps.get(agent);
  if (state === undefined || state.turn !== payload.turn || state.step !== payload.step) return undefined;
  if (payload.signal?.aborted) return undefined;
  const code = payload.failure?.code;
  if (!FAILOVER_CODES.includes(code)) return undefined;
  if (state.exhausted) return undefined;
  const facts = state.facts;
  const current = state.chain[state.index];
  if (current === undefined) { state.exhausted = true; return undefined; }
  fo.cooldowns.record(current, payload.failure);
  for (let j = state.index + 1; j < state.chain.length; j += 1) {
    const candidate = state.chain[j];
    if (fo.cooldowns.isCooling(candidate)) continue;
    if (await resolveRoute(ctx, candidate, facts, true) === undefined) continue;
    if (payload.signal?.aborted) return undefined;
    state.index = j;
    logSwitch(ctx, state.roleId, current, candidate, code);
    return { kind: 'retry' };
  }
  state.exhausted = true;
  return undefined;
}

/** Apply the row: one standing listener for every role in this preset. */
export function apply(ctx, config = {}) {
  bindProfileContext(ctx, config.profileId);
  const scopeModule = ctx.loader !== undefined ? hostImport(ctx, '@deepseek-ai/dsh-scope') : undefined;
  const fo = { steps: new WeakMap(), cooldowns: createCooldowns(config.now ?? Date.now) };
  const inScope = async (payload) => {
    if (!scopeModule) return true;
    const scope = await scopeModule;
    const owner = scope.scopeOf(ctx);
    return !(owner === undefined || !payload?.agent?.ctx || !scope.scopeChainOf(scope.scopeOf(payload.agent.ctx)).includes(owner));
  };
  ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
    if (!await inScope(payload)) return next();
    const resolved = await next();
    const nextConfig = await requestConfig(ctx, payload, resolved);
    const base = nextConfig === undefined ? resolved : nextConfig;
    const failover = await failoverRequest(ctx, fo, payload, base);
    return failover === undefined ? base : failover;
  }, { global: true }), 'omds-subagent-roles: agent/request');
  // Prepended so it runs before the host llm-retry listener, with the same
  // scope filter as the request listener.
  ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
    if (!await inScope(payload)) return next();
    const action = await failoverError(ctx, fo, payload);
    return action === undefined ? next() : action;
  }, { global: true, prepend: true }), 'omds-subagent-roles: agent/request-error');
}
