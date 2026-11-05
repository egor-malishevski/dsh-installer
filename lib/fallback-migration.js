// Pure, deterministic migration of relay "fallback-<role>" aliases to native role fallbacks.
// No IO, no mutation of input, no secrets or values in diagnostics (code-only conflicts/actions).
//
// planFallbackMigration(entries, { migrateNativeFallbacks, nativeFallbacksSupported })
//   -> { ok, status, applied, requiresCapability, entries, actions, keeps, conflicts }
// The caller applies `entries` only when `applied === true`. Gate: opts.migrateNativeFallbacks === true AND
// opts.nativeFallbacksSupported === true (caller sets it when installing the native-slim tree 0.8.7-native.1).
// Otherwise entries are an unchanged clone and actions are returned as a preview (applied:false).

export const NATIVE_FALLBACKS_CAPABILITY = 'native-role-fallbacks@0.8.7-native.1';
export const SLIM_ROW_ID = 'oh-my-dsh-slim';
export const CATALOG_ROW_ID = 'llm-pi-ai';
export const MAIN_ALIAS = 'fallback-main';
export const MAX_DEPTH = 32;
export const MAX_NODES = 50000;
export const MAX_ENTRIES = 1000;

// primary + reserves (<=3 total fallbacks allowed natively); effort = reserve effort when metadata supports it.
export const NATIVE_CHAINS = Object.freeze({
  oracle: { primary: 'claude-opus-5-5', reserves: ['gpt-6.1-sol', 'claude-sonnet-5-5'], effort: 'high' },
  designer: { primary: 'claude-sonnet-5-5', reserves: ['gpt-6.1-terra', 'claude-opus-5-5'], effort: 'medium' },
  fixer: { primary: 'claude-sonnet-5-5', reserves: ['gpt-6.1-terra', 'claude-opus-5-5'], effort: 'medium' },
  explorer: { primary: 'grok-4.7-build-fast', reserves: ['claude-haiku-5-5', 'grok-4.7'], effort: null },
  librarian: { primary: 'grok-4.7', reserves: ['claude-sonnet-5-5', 'gpt-6.1-terra'], effort: null },
});
const ROLES = Object.keys(NATIVE_CHAINS);
const SCOPES = [['config.roles', c => c.roles], ['advanced.roles', c => c.advanced?.roles]];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const aliasOf = role => `fallback-${role}`;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

// Bounded structural validation + count; returns false when too deep/large/cyclic/non-JSON.
function boundedOk(root) {
  let nodes = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (++nodes > MAX_NODES || d > MAX_DEPTH) return false;
    if (Array.isArray(v) || isObj(v)) {
      // shared refs are fine; cycles are caught by the depth/node bounds
      for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, d + 1]);
    } else if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return false;
  }
  return true;
}

const clone = v => structuredClone(v);

function supportsEffort(meta, effort) {
  const r = meta?.reasoningEfforts;
  if (Array.isArray(r)) return r.includes(effort);
  return isObj(r) && own(r, effort) && r[effort] != null;
}

// Does any string in `value` reference the alias (bare or cliproxy/<alias>)? Skips the catalogue models array.
function referencesAlias(value, aliases, skip) {
  const stack = [value];
  const found = new Set();
  while (stack.length) {
    const v = stack.pop();
    if (v === skip) continue;
    if (typeof v === 'string') {
      for (const a of aliases) if (v === a || v === `cliproxy/${a}`) found.add(a);
    } else if (Array.isArray(v)) stack.push(...v);
    else if (isObj(v)) { for (const [k, c] of Object.entries(v)) { stack.push(k); stack.push(c); } }
  }
  return found;
}

function result(entries, extra) {
  return { ok: true, status: 'noop', applied: false, requiresCapability: NATIVE_FALLBACKS_CAPABILITY, entries: clone(entries), actions: [], keeps: [], conflicts: [], ...extra };
}

export function planFallbackMigration(entries, opts = {}) {
  const o = isObj(opts) ? opts : {};
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES || !boundedOk(entries)) {
    return { ok: false, status: 'refused', applied: false, requiresCapability: NATIVE_FALLBACKS_CAPABILITY, entries: Array.isArray(entries) ? entries : [], actions: [], keeps: [], conflicts: [{ code: 'MIGRATION_INPUT_INVALID' }] };
  }
  const requested = o.migrateNativeFallbacks === true;
  const capable = o.nativeFallbacksSupported === true;
  const work = clone(entries);
  const conflicts = [];
  const actions = [];
  const keeps = [];
  const conflict = (code, extra = {}) => conflicts.push({ code, ...extra });

  const slim = work.find(r => isObj(r) && r.id === SLIM_ROW_ID);
  const slimCfg = isObj(slim?.config) ? slim.config : null;
  const migrated = []; // {role, scope}

  // Discover aliased roles (exact provider+model match only).
  const found = [];
  if (slimCfg) {
    for (const [scope, get] of SCOPES) {
      const roles = get(slimCfg);
      if (!isObj(roles)) continue;
      for (const role of ROLES) {
        const r = roles[role];
        if (isObj(r) && r.provider === 'cliproxy' && r.model === aliasOf(role)) found.push({ role, scope, roles });
      }
    }
  }
  if (!found.length) return result(entries, { status: requested ? 'noop' : 'disabled' });

  // Catalogue must exist and be well-formed.
  const catRow = work.find(r => isObj(r) && r.id === CATALOG_ROW_ID);
  const catModels = catRow?.config?.providers?.cliproxy?.models;
  if (!Array.isArray(catModels)) {
    conflict('MIGRATION_CATALOG_MISSING');
  } else {
    const ids = new Map();
    for (const m of catModels) if (isObj(m) && typeof m.id === 'string') ids.set(m.id, m);
    for (const { role, scope, roles } of found) {
      const chain = NATIVE_CHAINS[role];
      for (const id of [chain.primary, ...chain.reserves]) {
        if (!ids.has(id)) { conflict('MIGRATION_TARGET_MODEL_MISSING', { role, scope, model: id }); }
      }
      const existing = roles[role].fallbacks;
      if (existing !== undefined && !(Array.isArray(existing) && existing.length === 0)) {
        const planned = buildReserves(role, ids);
        if (!Array.isArray(existing) || canonical(existing) !== canonical(planned)) conflict('MIGRATION_CONFIG_CONFLICT', { role, scope });
      }
      // Override in the other scope also defines fallbacks for this role: do not guess the effective chain.
      for (const [otherScope, get] of SCOPES) {
        if (otherScope === scope) continue;
        const other = get(slimCfg)?.[role];
        // A partial or different explicit route may change the effective primary.
        // Refuse rather than attach these reserves to an unknown/custom route.
        if (isObj(other) && (own(other, 'provider') || own(other, 'model'))
          && !(other.provider === 'cliproxy' && other.model === aliasOf(role))) {
          conflict('MIGRATION_CONFIG_CONFLICT', { role, scope: otherScope });
        }
        if (isObj(other) && other.fallbacks !== undefined
          && ((scope === 'config.roles' && otherScope === 'advanced.roles' && Array.isArray(other.fallbacks) && other.fallbacks.length === 0)
            || (!(Array.isArray(other.fallbacks) && other.fallbacks.length === 0)
              && canonical(other.fallbacks) !== canonical(buildReserves(role, ids))))) conflict('MIGRATION_CONFIG_CONFLICT', { role, scope: otherScope });
      }
    }
  }
  if (conflicts.length) {
    return result(entries, { ok: false, status: 'conflict', conflicts: dedupe(conflicts) });
  }

  const ids = new Map(catModels.filter(m => isObj(m) && typeof m.id === 'string').map(m => [m.id, m]));
  for (const { role, scope, roles } of found) {
    const chain = NATIVE_CHAINS[role];
    const cur = roles[role];
    const next = {};
    for (const [k, v] of Object.entries(cur)) next[k] = k === 'model' ? chain.primary : v;
    next.fallbacks = buildReserves(role, ids);
    roles[role] = next;
    migrated.push({ role, scope });
    actions.push({ type: 'role-native', code: 'ROLE_MIGRATED', role, scope, primary: chain.primary, fallbacks: next.fallbacks.map(f => ({ ...f })) });
  }

  // Catalogue: remove alias entries only when nothing else references them (post-migration view).
  const aliases = ROLES.map(aliasOf);
  const refs = new Set();
  for (const row of work) for (const a of referencesAlias(row, aliases, catModels)) refs.add(a);
  const kept = [];
  const nextModels = catModels.filter(m => {
    const id = isObj(m) ? m.id : undefined;
    if (aliases.includes(id)) {
      if (refs.has(id) || o.preserveCatalogAliases === true) { kept.push({ id, code: refs.has(id) ? 'ALIAS_STILL_REFERENCED' : 'YAML_ALIAS_PRESERVED' }); return true; }
      actions.push({ type: 'catalog-remove', code: 'ALIAS_REMOVED', id });
      return false;
    }
    return true; // includes fallback-main and unknown entries
  });
  for (const item of kept) if (!keeps.some(k => k.id === item.id)) keeps.push(item);
  catRow.config.providers.cliproxy.models = nextModels;

  const applied = requested && capable;
  const status = applied ? 'applied' : !requested ? 'disabled' : 'capability-required';
  return {
    ok: true, status, applied, requiresCapability: NATIVE_FALLBACKS_CAPABILITY,
    entries: applied ? work : clone(entries), actions, keeps, conflicts: [],
  };
}

function buildReserves(role, ids) {
  const chain = NATIVE_CHAINS[role];
  return chain.reserves.map(model => {
    const f = { provider: 'cliproxy', model };
    if (chain.effort && supportsEffort(ids.get(model), chain.effort)) f.effort = chain.effort;
    return f;
  });
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(c => { const k = canonical(c); if (seen.has(k)) return false; seen.add(k); return true; });
}
