// Runtime model sync for the CLIProxyAPI route of llm-pi-ai — DeepSeek Harness 0.2.1-rc.5 has no
// route-level `discoverModels`, so this plugin periodically asks ctx.llm.discoverModels() for the
// live listing and keeps `providers.<provider>.models` of the llm-pi-ai settings in sync, live.
//
// Models in use (config.pinned, the agent default model, oh-my-dsh-slim role models) are never
// dropped even if the listing omits them. An empty/failed listing never changes anything.
//
// Every callback is guarded: in DSH an unhandled rejection in detached work is fatal for the app.
// Secrets: descriptor values/headers contain the evaluated Authorization and are never logged.

import { isDeepStrictEqual } from 'node:util'

export const name = 'cliproxy-models'
export const inject = ['llm', 'settings']

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DEFAULT_INPUT = ['text', 'image']
const DEFAULTS = { provider: 'cliproxy', settingsNs: 'llm-pi-ai', intervalMs: 300000, timeoutMs: 5000, seed: [], pinned: [] }

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (id) => typeof id === 'string' && id.length <= 191 && ID_RE.test(id)
const posInt = (value, fallback) => (Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback)

export function normalizeConfig(raw) {
  const input = isObject(raw) ? raw : {}
  const str = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  return {
    provider: str(input.provider, DEFAULTS.provider),
    settingsNs: str(input.settingsNs, DEFAULTS.settingsNs),
    intervalMs: Math.max(1000, posInt(input.intervalMs, DEFAULTS.intervalMs)),
    timeoutMs: posInt(input.timeoutMs, DEFAULTS.timeoutMs),
    seed: Array.isArray(input.seed) ? input.seed.filter((row) => isObject(row) && validId(row.id)) : [],
    pinned: Array.isArray(input.pinned) ? input.pinned.filter(validId) : [],
  }
}

/** Find a namespace row. rc.5 describe() returns an array of rows; tolerate describe(ns) too. */
async function describeNs(settings, ns) {
  let result = await settings.describe(ns)
  if (Array.isArray(result)) result = result.find((row) => row?.ns === ns)
  else if (isObject(result) && result.ns !== undefined && result.ns !== ns) result = undefined
  return isObject(result) ? result : undefined
}

function declaresDiscoverModels(row) {
  try {
    const text = JSON.stringify(row?.schema)
    return typeof text === 'string' && text.includes('"discoverModels"')
  } catch {
    return false // schema not inspectable: gate on nothing
  }
}

export function mergeModels({ listing, current, seed, pinned }) {
  const currentById = new Map((Array.isArray(current) ? current : []).filter((r) => isObject(r) && typeof r.id === 'string').map((r) => [r.id, r]))
  const seedById = new Map(seed.map((r) => [r.id, r]))
  const out = []
  const seen = new Set()
  for (const listed of listing) {
    const id = listed?.id
    if (!validId(id) || seen.has(id)) continue
    seen.add(id)
    const name = typeof listed.name === 'string' && listed.name ? listed.name : id
    out.push({ id, name, input: [...DEFAULT_INPUT], ...currentById.get(id), ...seedById.get(id) })
  }
  for (const id of pinned) {
    if (!validId(id) || seen.has(id)) continue
    seen.add(id)
    const base = currentById.get(id) ?? seedById.get(id) ?? { id, name: id, input: [...DEFAULT_INPUT] }
    out.push({ ...base })
  }
  return out
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    try { ctx.logger?.warn?.(`cliproxy-models: ${message}`) } catch {}
  }
  const info = (message) => { try { ctx.logger?.info?.(`cliproxy-models: ${message}`) } catch {} }

  ctx.effect(() => {
    let disposed = false
    let inFlight = false
    let failing = false
    let timer
    let run // current AbortController

    const fail = (message) => {
      if (!failing) warnOnce(`fail:${message}`, message)
      failing = true
    }

    const pinnedIds = async () => {
      const ids = [...config.pinned]
      try {
        const def = (await describeNs(ctx.settings, 'agent-default-model'))?.value
        if (isObject(def) && def.provider === config.provider && typeof def.model === 'string') ids.push(def.model)
      } catch {}
      try {
        const slim = (await describeNs(ctx.settings, 'oh-my-dsh-slim'))?.value
        const roles = isObject(slim?.roles) ? Object.values(slim.roles) : []
        const orch = isObject(slim?.orchestrator) ? [slim.orchestrator] : []
        for (const role of [...roles, ...orch]) {
          if (isObject(role) && role.provider === config.provider && typeof role.model === 'string') ids.push(role.model)
        }
      } catch {}
      return ids.filter(validId)
    }

    const tick = async () => {
      if (disposed || inFlight) return
      inFlight = true
      const controller = new AbortController()
      run = controller
      try {
        const d = await describeNs(ctx.settings, config.settingsNs)
        if (disposed || !d) return
        const route = d.value?.providers?.[config.provider]
        if (!isObject(route) || typeof route.baseURL !== 'string' || typeof route.api !== 'string') {
          warnOnce('route', `provider "${config.provider}" has no baseURL/api in ${config.settingsNs}; skipping`)
          return
        }
        if (route.discoverModels === true && declaresDiscoverModels(d)) {
          warnOnce('dormant', 'host supports native discoverModels; plugin is dormant')
          return
        }
        let listing
        try {
          listing = await ctx.llm.discoverModels(
            config.settingsNs,
            { provider: config.provider, baseURL: route.baseURL, api: route.api },
            AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)]),
          )
        } catch (error) {
          if (!disposed) fail(`model listing failed (${error?.name ?? 'Error'}: ${error?.message ?? error})`)
          return
        }
        if (disposed) return
        if (!Array.isArray(listing) || listing.filter((m) => validId(m?.id)).length === 0) {
          fail('model listing is empty; keeping current models')
          return
        }
        failing = false
        const next = mergeModels({ listing, current: route.models, seed: config.seed, pinned: await pinnedIds() })
        if (next.length === 0 || isDeepStrictEqual(next, route.models)) return
        if (disposed) return
        await ctx.settings.mutate(config.settingsNs, [{ op: 'set', path: ['providers', config.provider, 'models'], value: next }], d.revision)
        info(`synced ${next.length} models`)
      } catch (error) {
        if (!disposed) try { ctx.logger?.warn?.(`cliproxy-models: sync failed, retrying next tick (${error?.message ?? error})`) } catch {}
      } finally {
        inFlight = false
        if (run === controller) run = undefined
      }
    }

    const safeTick = () => { tick().catch(() => {}) }

    try {
      Promise.resolve(ctx.loader?.await?.()).catch(() => {}).then(() => { if (!disposed) safeTick() }).catch(() => {})
      timer = setInterval(safeTick, config.intervalMs)
      timer.unref?.()
    } catch (error) {
      try { ctx.logger?.warn?.(`cliproxy-models: failed to start (${error?.message ?? error})`) } catch {}
    }

    return () => {
      disposed = true
      if (timer) clearInterval(timer)
      try { run?.abort() } catch {}
    }
  })
}
