// orchestrator-tools.js — keep the main agent orchestration-only.
//
// Specialist children already get tools.restrict via role-composition. The
// orchestrator is the preset composition root: host tools are registered on
// its own agent layer, and tools.restrict only masks INHERITED names. An
// early agent/created restrict against an empty restrictableNames set also
// collapses deny to [] via fitFilterToKnown. So the durable boundary here is:
//   1) system-prompt/assemble filter (schemas the model sees)
//   2) tools.guard (execution denial)
// plus a best-effort tools.restrict for any inherited names that are already known.
//
// Host MCP servers stay registered so role sharedMcpTools can inherit them,
// but their schemas are stripped from the orchestrator prompt and direct MCP
// execution by the orchestrator is denied.
//
// IMPORTANT: this plugin must NOT live inside an isolate:{workflowEngine:true}
// group — the host agent is created outside that scope, so agent/created and
// assemble listeners would never attach to the orchestrator.
import { hostImport } from './bridge.js';
import { loadConfig, bindProfileContext } from './config.js';
import { isSubagent, fitFilterToKnown } from './roles.js';

export const name = 'omds-orchestrator-tools';
export const inject = ['loader', 'agents'];

const applied = new WeakSet();

/** Escape hatches not always present in TOOL_NAMES / config deny validation. */
const HARD_DENY_PREFIXES = ['mcp__', 'terminal_'];
const HARD_DENY_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

function orchestratorFilter(orch = {}) {
  const allow = Array.isArray(orch.tools) && orch.tools.length > 0 ? [...orch.tools] : undefined;
  const deny = Array.isArray(orch.deny) ? [...new Set(orch.deny)] : [];
  if (allow === undefined && deny.length === 0) return undefined;
  return {
    ...(allow === undefined ? {} : { allow }),
    ...(deny.length === 0 ? {} : { deny }),
  };
}

function isHardDenied(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (HARD_DENY_NAMES.has(name)) return true;
  return HARD_DENY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isDeniedTool(name, filter) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (isHardDenied(name)) return true;
  if (filter === undefined) return false;
  if (Array.isArray(filter.allow)) return !filter.allow.includes(name);
  if (Array.isArray(filter.deny) && filter.deny.includes(name)) return true;
  return false;
}

function denialReason(name, filter) {
  if (typeof name !== 'string') return undefined;
  if (name.startsWith('mcp__') || HARD_DENY_NAMES.has(name)) {
    return 'MCP tools/resources are reserved for specialist roles; delegate with subagent_* instead';
  }
  if (name.startsWith('terminal_')) {
    return 'Persistent terminals are denied for the orchestrator; delegate shell work to a specialist';
  }
  if (filter === undefined) return undefined;
  if (Array.isArray(filter.allow) && !filter.allow.includes(name)) {
    return `Orchestrator allow-list excludes "${name}"; delegate to a specialist`;
  }
  if (Array.isArray(filter.deny) && filter.deny.includes(name)) {
    return `Orchestrator is denied tool "${name}"; delegate to a specialist`;
  }
  return undefined;
}

function stripDeniedTools(tools, filter) {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((tool) => !isDeniedTool(tool?.name, filter));
}

/** Mutate assembly.tools in place and return the same object (listeners that
 * ignore next()'s return still see the stripped catalog). */
function filterAssemblyToolsInPlace(assembly, filter) {
  if (!assembly || !Array.isArray(assembly.tools)) return assembly;
  assembly.tools = stripDeniedTools(assembly.tools, filter);
  return assembly;
}

function tryRestrict(agent, ctx, scopeOf, filter) {
  if (filter === undefined) return 'skipped';
  const tools = agent.ctx.get?.('tools') ?? agent.ctx.tools;
  if (typeof tools?.restrict !== 'function') return 'unavailable';
  try {
    const known = tools?.view?.(scopeOf(agent.ctx))?.restrictableNames;
    const knownList = known === undefined ? undefined : [...known];
    if (knownList === undefined || knownList.length === 0) return 'deferred';
    const globalFilter = fitFilterToKnown(filter, knownList, []);
    if (globalFilter === undefined) return 'empty';
    tools.restrict(globalFilter);
    return 'applied:' + (globalFilter.deny?.join(',') ?? '');
  } catch (error) {
    ctx.logger?.warn?.(
      'oh-my-dsh-slim: orchestrator tools.restrict failed: %s',
      String(error?.message ?? error),
    );
    return 'failed';
  }
}

function installOrchestratorFence(agent, ctx, scopeOf, filter) {
  const tools = agent.ctx.get?.('tools') ?? agent.ctx.tools;

  if (typeof tools?.guard === 'function') {
    // Scoped guard: only this agent. Cannot override another denial.
    tools.guard((exec) => denialReason(exec?.name, filter));
  }

  // Best-effort restrict for inherited names (own-layer tools stay visible to
  // restrict but are still stripped by assemble + blocked by guard).
  const restrictStatus = tryRestrict(agent, ctx, scopeOf, filter);

  // Authoritative schema fence. prepend:true so we wrap later listeners and can
  // strip after they run. Also mutate the input assembly in place: some host
  // listeners return next()'s result while others keep mutating the original.
  agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    tryRestrict(agent, ctx, scopeOf, filter);
    filterAssemblyToolsInPlace(assembly, filter);
    const result = await next();
    const finalAssembly = result ?? assembly;
    filterAssemblyToolsInPlace(finalAssembly, filter);
    return finalAssembly;
  }, { prepend: true });

  // Belt-and-suspenders: if anything reintroduces schemas after assemble,
  // scrub decision.assembly before the loop builds request/header.
  agent.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision?.assembly) filterAssemblyToolsInPlace(decision.assembly, filter);
    return decision;
  }, { prepend: true });

  ctx.logger?.info?.(
    'oh-my-dsh-slim: orchestrator fence installed deny=%s hard=mcp+/terminal+ restrict=%s agent=%s',
    filter?.deny?.join(',') ?? '(none)',
    restrictStatus,
    agent?.id ?? agent?.session?.id ?? '(unknown)',
  );
}

export async function composeOrchestrator(agent, ctx, scopeOf) {
  if (isSubagent(agent) || applied.has(agent)) return 'skipped';
  const preset = loadConfig(ctx);
  applied.add(agent);
  const filter = orchestratorFilter(preset.orchestrator ?? {});
  // Even with an empty config deny, hard-deny still fences mcp__/terminal_.
  installOrchestratorFence(agent, ctx, scopeOf, filter);
  return 'ok';
}

export async function apply(ctx, config = {}) {
  bindProfileContext(ctx, config.profileId);
  const scope = await hostImport(ctx, '@deepseek-ai/dsh-scope');
  ctx.effect(
    () => ctx.on('agent/created', ({ agent }) => composeOrchestrator(agent, ctx, scope.scopeOf)),
    'oh-my-dsh-slim: orchestrator tools',
  );
  for (const agent of ctx.agents?.list?.() ?? []) {
    try { await composeOrchestrator(agent, ctx, scope.scopeOf); }
    catch (error) { ctx.logger?.warn?.('oh-my-dsh-slim: orchestrator tools: %s', String(error?.message ?? error)); }
  }
}
