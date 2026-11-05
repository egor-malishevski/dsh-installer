// Pure, bounded cleanup of legacy relay aliases. Diagnostics never contain input values.
const ALIASES = new Set(['fallback-main', 'fallback-oracle', 'fallback-designer', 'fallback-fixer', 'fallback-explorer', 'fallback-librarian']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Accept only plain JSON data, without accessors, special keys, cycles or exotic prototypes.
function valid(root) {
  const stack = [[root, 0]];
  let count = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++count > 50000 || depth > 32) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') { if (!Number.isFinite(value)) return false; continue; }
    if (typeof value !== 'object') return false;
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(k => typeof k !== 'string')) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !descriptor.enumerable || !own(descriptor, 'value')) return false;
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false;
      stack.push([descriptor.value, depth + 1]);
    }
    if (array && Object.keys(descriptors).length !== value.length + 1) return false;
  }
  return true;
}

const copy = value => JSON.parse(JSON.stringify(value));
const result = (entries, ok, applied, actions = [], conflicts = []) => ({ ok, applied, entries, actions, conflicts });
const conflict = (entries, code) => result(copy(entries), false, false, [], [{ code }]);

export function planLegacyFallbackCleanup(entries, options = {}) {
  const { cleanupLegacyFallbacks = false, mainModel } = object(options) ? options : {};
  if (!Array.isArray(entries) || entries.length > 1000 || !valid(entries)) {
    return result([], false, false, [], [{ code: 'CLEANUP_INPUT_INVALID' }]);
  }
  if (cleanupLegacyFallbacks !== true) return result(copy(entries), true, false);
  const work = copy(entries);
  const catalogs = work.filter(row => object(row) && row.id === 'llm-pi-ai');
  const defaults = work.filter(row => object(row) && row.id === 'agent-default-model');
  if (catalogs.length !== 1 || defaults.length > 1) return conflict(entries, 'CLEANUP_CATALOG_INVALID');
  const models = catalogs[0]?.config?.providers?.cliproxy?.models;
  if (!Array.isArray(models)) return conflict(entries, 'CLEANUP_CATALOG_INVALID');
  const ids = new Set();
  for (const model of models) {
    if (object(model) && typeof model.id === 'string') {
      if (ids.has(model.id)) return conflict(entries, 'CLEANUP_CATALOG_INVALID');
      ids.add(model.id);
    }
  }
  const config = defaults[0]?.config;
  const rewrite = object(config) && config.provider === 'cliproxy' && config.model === 'fallback-main';
  if (rewrite) {
    if (typeof mainModel !== 'string' || !mainModel.trim() || mainModel !== mainModel.trim() || mainModel.includes('fallback-') || !ids.has(mainModel)) {
      return conflict(entries, 'CLEANUP_MAIN_MODEL_INVALID');
    }
    config.model = mainModel;
  }
  // Scan all other JSON strings, including keys and opaque expressions.
  const stack = [work];
  while (stack.length) {
    const value = stack.pop();
    if (value === models) {
      for (const model of models) if (!(object(model) && ALIASES.has(model.id))) stack.push(model);
      continue;
    }
    if (typeof value === 'string') {
      if (value.includes('fallback-')) return conflict(entries, 'CLEANUP_ALIAS_REFERENCED');
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (object(value)) {
      for (const [key, item] of Object.entries(value)) stack.push(key, item);
    }
  }
  const kept = models.filter(model => !(object(model) && ALIASES.has(model.id)));
  const actions = [];
  if (rewrite) actions.push({ code: 'CLEANUP_MAIN_REWRITTEN' });
  if (kept.length !== models.length) {
    catalogs[0].config.providers.cliproxy.models = kept;
    actions.push({ code: 'CLEANUP_ALIASES_REMOVED' });
  }
  return result(work, true, actions.length > 0, actions);
}
