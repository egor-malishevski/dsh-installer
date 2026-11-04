// Runtime model sync for the CLIProxyAPI route of llm-pi-ai — DeepSeek Harness 0.2.1-rc.5 has no
// route-level `discoverModels`, so this plugin periodically asks ctx.llm.discoverModels() for the
// live listing and keeps `providers.<provider>.models` of the llm-pi-ai settings in sync, live.
//
// Ordering: the listing is sorted by id (CLIProxyAPI's map iteration order is not stable), so an
// unchanged catalog never causes a write.
//
// Pins (never dropped): config.pinned, the agent default model and oh-my-dsh-slim role models whose
// provider is this route. Removal grace: a current model absent from a successful NON-EMPTY listing
// is retained until it has been absent `dropAfter` times in a row. This only covers temporary
// disappearance; it is NOT a guarantee that every model selected in an open session stays supported.
// Failed or empty fetches never count.
//
// Every callback is guarded: in DSH an unhandled rejection in detached work is fatal for the app.
// Secrets: descriptor values/headers contain the evaluated Authorization; they and raw host error
// messages (which may echo credentials) are never logged — only error names/codes.

import { isDeepStrictEqual } from 'node:util'

export const name = 'cliproxy-models'
export const inject = ['llm', 'settings']

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DEFAULT_INPUT = ['text', 'image']
const DEFAULTS = { provider: 'cliproxy', settingsNs: 'llm-pi-ai', intervalMs: 300000, timeoutMs: 5000, dropAfter: 3, seed: [], pinned: [] }

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (id) => typeof id === 'string' && id.length <= 191 && ID_RE.test(id)
const posInt = (value, fallback) => (Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback)
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeConfig(raw) {
  const input = isObject(raw) ? raw : {}
  const str = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  return {
    provider: str(input.provider, DEFAULTS.provider),
    settingsNs: str(input.settingsNs, DEFAULTS.settingsNs),
    intervalMs: Math.max(1000, posInt(input.intervalMs, DEFAULTS.intervalMs)),
    timeoutMs: posInt(input.timeoutMs, DEFAULTS.timeoutMs),
    dropAfter: posInt(input.dropAfter, DEFAULTS.dropAfter),
    seed: Array.isArray(input.seed) ? input.seed.filter((row) => isObject(row) && validId(row.id)) : [],
    pinned: Array.isArray(input.pinned) ? input.pinned.filter(validId) : [],
  }
}

/** settings.describe(options?) is synchronous and returns an array of rows; find ours by ns.
 * Tolerates a promise or a single-row result. */
async function describeNs(settings, ns) {
  let result = await settings.describe()
  if (Array.isArray(result)) result = result.find((row) => row?.ns === ns)
  else if (isObject(result) && result.ns !== ns) result = undefined
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

const errorCode = (error) => String(error?.code ?? error?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'Error'

/** Merge a listing into the current rows. `pinned` ids missing from the listing are appended
 * (sorted). Listing ids are sorted so the result does not depend on upstream order. */
export function mergeModels({ listing, current, seed, pinned }) {
  const currentById = new Map((Array.isArray(current) ? current : []).filter((r) => isObject(r) && typeof r.id === 'string').map((r) => [r.id, r]))
  const seedById = new Map(seed.map((r) => [r.id, r]))
  const listed = new Map()
  for (const item of Array.isArray(listing) ? listing : []) {
    if (validId(item?.id) && !listed.has(item.id)) listed.set(item.id, item)
  }
  const out = []
  const seen = new Set()
  for (const id of [...listed.keys()].sort(byId)) {
    seen.add(id)
    const item = listed.get(id)
    const label = typeof item.name === 'string' && item.name ? item.name : id
    out.push({ id, name: label, input: [...DEFAULT_INPUT], ...currentById.get(id), ...seedById.get(id) })
  }
  for (const id of [...new Set(pinned)].filter(validId).sort(byId)) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ ...(currentById.get(id) ?? seedById.get(id) ?? { id, name: id, input: [...DEFAULT_INPUT] }) })
  }
  return out
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const warned = new Set()
  const log = (level, message) => { try { ctx.logger?.[level]?.(`cliproxy-models: ${message}`) } catch {} }
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    log('warn', message)
  }
  const recover = (prefix) => { for (const key of [...warned]) if (key.startsWith(prefix)) warned.delete(key) }

  try {
    ctx.effect(() => {
      let disposed = false
      let inFlight = false
      let timer
      let run
      const misses = new Map() // current valid model id -> consecutive absences from non-empty listings

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
            if (!disposed) warnOnce('fail:listing', `model listing failed (${errorCode(error)}); keeping current models`)
            return
          }
          if (disposed) return
          const listedIds = new Set((Array.isArray(listing) ? listing : []).map((m) => m?.id).filter(validId))
          if (listedIds.size === 0) {
            warnOnce('fail:empty', 'model listing is empty; keeping current models')
            return
          }
          recover('fail:listing'); recover('fail:empty')

          // Removal grace: only successful non-empty listings count.
          const currentIds = (Array.isArray(route.models) ? route.models : []).map((m) => m?.id).filter(validId)
          const retained = []
          for (const id of currentIds) {
            if (listedIds.has(id)) { misses.delete(id); continue }
            const count = (misses.get(id) ?? 0) + 1
            misses.set(id, count)
            if (count < config.dropAfter) retained.push(id)
          }
          for (const id of [...misses.keys()]) if (!currentIds.includes(id)) misses.delete(id)

          const pins = [...await pinnedIds(), ...retained]
          const next = mergeModels({ listing, current: route.models, seed: config.seed, pinned: pins })
          if (next.length === 0) return
          if (isDeepStrictEqual(next, route.models)) { recover('fail:mutate'); recover('fail:tick'); return }
          if (disposed) return
          try {
            await ctx.settings.mutate(config.settingsNs, [{ op: 'set', path: ['providers', config.provider, 'models'], value: next }], d.revision)
          } catch (error) {
            if (!disposed) warnOnce(`fail:mutate:${errorCode(error)}`, `settings update failed (${errorCode(error)}); retrying next tick`)
            return
          }
          recover('fail:mutate'); recover('fail:tick')
          log('info', `synced ${next.length} models`)
        } catch (error) {
          if (!disposed) warnOnce(`fail:tick:${errorCode(error)}`, `sync failed (${errorCode(error)}); retrying next tick`)
        } finally {
          inFlight = false
          if (run === controller) run = undefined
        }
      }

      const safeTick = () => { try { tick().catch(() => {}) } catch {} }

      try {
        timer = setInterval(safeTick, config.intervalMs)
        timer.unref?.()
      } catch (error) {
        log('warn', `failed to start timer (${errorCode(error)})`)
      }

      // Detached startup: wait for the loader if one is available, but run the first tick regardless.
      Promise.resolve()
        .then(() => {
          let loader
          try { loader = ctx.get?.('loader') } catch {}
          return loader?.await?.()
        })
        .catch(() => {})
        .then(() => { if (!disposed) safeTick() })
        .catch(() => {})

      return () => {
        disposed = true
        if (timer) clearInterval(timer)
        try { run?.abort() } catch {}
      }
    })
  } catch (error) {
    log('warn', `failed to start (${errorCode(error)})`)
  }
}
