// Pure planning for native fallbacks on existing, explicit specialist routes.
import { defaultFallbacks } from './discovery.js';

const ROLES = ['oracle', 'designer', 'fixer', 'explorer', 'librarian'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = id => typeof id === 'string' && id.length <= 191 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);

function bounded(root) {
  let count = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (++count > 50000 || depth > 32) return false;
    if (Array.isArray(v) || object(v)) {
      for (const child of Object.values(v)) stack.push([child, depth + 1]);
    } else if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return false;
  }
  return true;
}

export function planFallbackSeeding(entries) {
  if (!Array.isArray(entries) || entries.length > 1000 || !bounded(entries)) {
    return { ok: false, applied: false, entries: [], actions: [], conflicts: [{ code: 'SEED_INPUT_INVALID' }] };
  }
  const work = structuredClone(entries);
  const fail = conflicts => ({ ok: false, applied: false, entries: structuredClone(entries), actions: [], conflicts });
  const slimRows = work.filter(row => object(row) && row.id === 'oh-my-dsh-slim');
  if (slimRows.length > 1) return fail([{ code: 'SEED_SLIM_AMBIGUOUS' }]);
  if (!slimRows.length) return { ok: true, applied: false, entries: work, actions: [], conflicts: [] };
  const cfg = slimRows[0].config;
  if (!object(cfg)) return fail([{ code: 'SEED_CONFIG_CONFLICT' }]);
  if ((own(cfg, 'roles') && !object(cfg.roles)) || (own(cfg, 'advanced') && !object(cfg.advanced)) ||
      (object(cfg.advanced) && own(cfg.advanced, 'roles') && !object(cfg.advanced.roles)) ||
      (own(cfg, 'presets') && !object(cfg.presets)) || (own(cfg, 'preset') && typeof cfg.preset !== 'string')) {
    return fail([{ code: 'SEED_CONFIG_CONFLICT' }]);
  }
  const preset = typeof cfg.preset === 'string' ? cfg.presets?.[cfg.preset] : undefined;
  if (preset !== undefined && !object(preset)) return fail([{ code: 'SEED_CONFIG_CONFLICT' }]);
  const scopes = [['config.roles', cfg.roles], ['advanced.roles', cfg.advanced?.roles], ['presets', preset]];
  const candidates = [];
  const actions = [];
  const conflicts = [];
  for (const role of ROLES) {
    const rows = scopes.filter(([, roles]) => object(roles) && own(roles, role)).map(([scope, roles]) => ({ scope, value: roles[role] }));
    for (const row of rows) {
      if (!object(row.value)) { conflicts.push({ code: 'SEED_CONFIG_CONFLICT', role, scope: row.scope }); continue; }
      if (own(row.value, 'fallbacks')) continue;
      if (row.value.provider !== 'cliproxy' || !validId(row.value.model) || row.value.model.startsWith('fallback-')) {
        actions.push({ code: 'SEED_ROLE_SKIPPED', role, scope: row.scope });
        continue;
      }
      // Another layer's route or fallbacks can change the effective chain.
      if (rows.some(other => other !== row && object(other.value) && ['provider', 'model', 'fallbacks', 'effort'].some(k => own(other.value, k)))) {
        conflicts.push({ code: 'SEED_CONFIG_CONFLICT', role, scope: row.scope });
        continue;
      }
      candidates.push({ role, ...row });
    }
  }
  if (conflicts.length) return fail(conflicts);
  if (!candidates.length) return { ok: true, applied: false, entries: work, actions, conflicts: [] };
  const catalogs = work.filter(row => object(row) && row.id === 'llm-pi-ai');
  if (!catalogs.length) return fail([{ code: 'SEED_CATALOG_MISSING' }]);
  if (catalogs.length > 1) return fail([{ code: 'SEED_CATALOG_AMBIGUOUS' }]);
  const models = catalogs[0].config?.providers?.cliproxy?.models;
  if (!Array.isArray(models) || models.length > 1000) return fail([{ code: 'SEED_CATALOG_INVALID' }]);
  const byId = new Map();
  for (const model of models) {
    if (!object(model) || !validId(model.id) || byId.has(model.id)) return fail([{ code: 'SEED_CATALOG_INVALID' }]);
    const efforts = model.reasoningEfforts;
    byId.set(model.id, { reasoningEfforts: Array.isArray(efforts) ? efforts : object(efforts) ? Object.keys(efforts).filter(k => efforts[k] != null) : [] });
  }
  for (const { role, scope, value } of candidates) {
    if (!byId.has(value.model)) conflicts.push({ code: 'SEED_TARGET_MODEL_MISSING', role, scope });
  }
  if (conflicts.length) return fail(conflicts);
  let applied = false;
  for (const { role, scope, value } of candidates) {
    const fallbacks = defaultFallbacks(role, value.model, value.effort, byId);
    if (!fallbacks.length) { actions.push({ code: 'SEED_NO_RESERVES', role, scope }); continue; }
    value.fallbacks = fallbacks;
    applied = true;
    actions.push({ code: 'SEED_ROLE_APPLIED', role, scope });
  }
  return { ok: true, applied, entries: work, actions, conflicts: [] };
}
