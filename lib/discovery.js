import { normalizeApiUrl, roles as defaults } from './config.js';
import { models as knownModels } from './profile.js';

const MAX_BODY = 1024 * 1024;
const MAX_MODELS = 1000;
const validId = id => typeof id === 'string' && id.length <= 191 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const failure = code => Object.assign(new Error(code), { code });

export async function discoverModels(apiUrl, apiKey, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeApiUrl(apiUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey.trim()}` }, redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw failure('MODEL_DISCOVERY_FAILED');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BODY) { controller.abort(); throw failure('MODEL_DISCOVERY_FAILED'); }
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data?.data) || data.data.length > MAX_MODELS) throw failure('MODEL_DISCOVERY_FAILED');
    const ids = [...new Set(data.data.map(item => item?.id).filter(id => validId(id) && !(apiKey.trim().length >= 8 && id.includes(apiKey.trim()))))].sort();
    if (!ids.length) throw failure('NO_MODELS');
    return ids.map(id => {
      const known = knownModels.find(model => model.id === id);
      return known ? { ...known, input: [...known.input], ...(known.reasoningEfforts ? { reasoningEfforts: Object.keys(known.reasoningEfforts) } : {}) } : { id, name: id, input: ['text', 'image'] };
    });
  } catch (error) {
    throw failure(error?.code === 'NO_MODELS' ? 'NO_MODELS' : 'MODEL_DISCOVERY_FAILED');
  } finally { clearTimeout(timer); controller.abort(); }
}

const rankings = {
  main: ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5'],
  oracle: ['gpt-6.1-sol', 'gpt-6.1-terra', 'claude-opus-5-5'],
  designer: ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol'],
  fixer: ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-opus-5-5'],
  explorer: ['claude-haiku-5-5', 'grok-4.7-build-fast', 'grok-4.7', 'claude-sonnet-5-5'],
  librarian: ['grok-4.7', 'grok-4.7-build-fast', 'claude-haiku-5-5'],
};
export function recommendRoles(roles, models) {
  const byId = new Map(models.map(m => [m.id, m]));
  const result = { orchestrator: { model: '', effort: roles.orchestrator.effort } };
  for (const name of Object.keys(rankings)) {
    const incoming = roles[name];
    const selected = incoming.model.startsWith('cliproxy/') && byId.get(incoming.model.slice(9));
    const model = selected || rankings[name].map(id => byId.get(id)).find(Boolean) || [...models].sort((a, b) => a.id.localeCompare(b.id))[0];
    const preferred = selected ? incoming.effort : defaults[name].effort;
    result[name] = { model: `cliproxy/${model.id}`, effort: name === 'main' ? '' : (model.reasoningEfforts?.includes(preferred) ? preferred : '') };
  }
  const mainModel = byId.get(result.main.model.slice(9));
  if (!mainModel.reasoningEfforts?.includes(result.orchestrator.effort)) result.orchestrator.effort = '';
  return result;
}
export function invalidRoles(roles, models) {
  const byId = new Map(models.map(m => [m.id, m]));
  return Object.entries(roles).filter(([name, role]) => {
    if (name === 'orchestrator') {
      const main = roles.main.model.startsWith('cliproxy/') && byId.get(roles.main.model.slice(9));
      return !!role.effort && !main?.reasoningEfforts?.includes(role.effort);
    }
    const model = role.model.startsWith('cliproxy/') && byId.get(role.model.slice(9));
    return !model || (role.effort && !model.reasoningEfforts?.includes(role.effort));
  }).map(([name]) => name);
}
export function profileModels(models) {
  return models.map(model => {
    const known = knownModels.find(item => item.id === model.id);
    return known || { id: model.id, name: model.id, input: ['text', 'image'] };
  });
}
