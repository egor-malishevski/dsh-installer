// Native compatibility restoration: continuable roles alone own MCP clients.
// The host owns connections and registrations; the first assembly waits at
// most 20 seconds and remains failure-open, as in the 0.1.x preset.
import { hostImport } from './bridge.js';
import { readFile } from 'node:fs/promises';
import { loadConfig, bindProfileContext, isMcpToolName } from './config.js';
import { ROLE_TABLE, effectiveRoleFilter, roleIdForAgent } from './roles.js';

export const name = 'omds-role-mcp';
export const inject = ['loader', 'agents', 'tools'];
export const MCP_WAIT_TIMEOUT_MS = 20000;

/**
 * Whether a role may mount MCP tools. Council seats are read-only and the
 * synthesizer is tool-less. Config validation also rejects their MCP lists.
 * @param roleId - a role id from the session descriptor.
 */
export function roleSupportsMcp(roleId) {
  const row = ROLE_TABLE[roleId];
  return row !== undefined && row.synthesisOnly !== true && !Array.isArray(row.fixedAllow);
}

export async function serverConfig(serverName, server) {
  const { envFiles, ...config } = server;
  if (envFiles !== undefined) {
    const env = { ...config.env };
    for (const [key, path] of Object.entries(envFiles)) {
      try { env[key] = (await readFile(path, 'utf8')).trim(); }
      catch { throw new Error('oh-my-dsh-slim: unable to read MCP envFiles'); }
    }
    config.env = env;
  }
  return { ...config, serverName };
}

export function mcpPolicy(roleId, role, sharedAllowed = () => false) {
  const names = roleSupportsMcp(roleId) && role.enabled !== false ? (role.mcps ?? []) : [];
  const filter = effectiveRoleFilter(roleId, role);
  return name => {
    if (!isMcpToolName(name)) return false;
    // A double underscore inside either component makes the server boundary
    // ambiguous, including for inherited servers unknown to this preset.
    const parts = name.slice(5).split('__');
    if (parts.length !== 2 || (!names.includes(parts[0]) && !sharedAllowed(name))) return false;
    return (filter?.allow === undefined || filter.allow.includes(name)) && !filter?.deny?.includes(name);
  };
}

export function installMcpPolicy(agent, roleId, role, parentScope) {
  const tools = agent.ctx.tools;
  if (typeof tools?.guard !== 'function') throw new Error('oh-my-dsh-slim: scoped tools.guard is required for role MCP security');
  const grants = roleSupportsMcp(roleId) && role.enabled !== false ? role.sharedMcpTools ?? [] : [];
  const inherited = new Map();
  if (grants.length && (typeof tools.get !== 'function' || parentScope === undefined)) throw new Error('oh-my-dsh-slim: inherited tool scope is required for shared MCP security');
  for (const name of grants) {
    const definition = tools.get(name, parentScope);
    if (definition !== undefined && tools.get(name, agent) === definition) inherited.set(name, definition);
  }
  // Definition identity establishes provenance, not an atomic dispatch lock or
  // integrity against trusted plugins replacing their own registrations.
  const sharedAllowed = name => inherited.has(name) && tools.get(name, parentScope) === inherited.get(name) && tools.get(name, agent) === inherited.get(name);
  const policy = mcpPolicy(roleId, role, sharedAllowed);
  const allowed = name => grants.includes(name) ? sharedAllowed(name) && policy(name) : policy(name);
  const dispose = tools.guard(exec => typeof exec.name === 'string' && exec.name.startsWith('mcp__') && !allowed(exec.name) ? 'MCP tool denied by role policy' : undefined);
  if (typeof dispose !== 'function') throw new Error('oh-my-dsh-slim: scoped tools.guard did not return a disposer');
  return { allowed, dispose };
}

export function filterMcpSchemas(assembly, allowed) {
  assembly.tools = assembly.tools.filter(tool => typeof tool.name !== 'string' || !tool.name.startsWith('mcp__') || allowed(tool.name));
}

/** Persisted descriptors restore eligibility after a cold resume. */
export function isContinuableAgent(agent) {
  if (agent?.options?.dshRunMode !== undefined) return agent.options.dshRunMode === 'continuable';
  const session = agent?.session;
  const events = typeof session?.ownEvents === 'function' ? session.ownEvents()
    : typeof session?.snapshotEvents === 'function' ? session.snapshotEvents(session.inheritedEventCount ?? 0)
    : (session?.events ?? []).slice(session?.inheritedEventCount ?? 0);
  return events.some((event) => event?.type === 'subagent/descriptor' && event.data?.mode === 'continuable');
}

async function quiesce(fiber) {
  await fiber.dispose();
  try { await fiber.await(); } catch { /* startup diagnostics belong to the client */ }
}

export async function apply(ctx, config = {}) {
  bindProfileContext(ctx, config.profileId);
  loadConfig(ctx);
  const scope = await hostImport(ctx, '@deepseek-ai/dsh-scope');
  const mcp = await hostImport(ctx, '@deepseek-ai/dsh-mcp-client');
  if (typeof scope.scopeOf !== 'function' || typeof scope.scopeChainOf !== 'function' || typeof mcp.apply !== 'function') {
    throw new Error('oh-my-dsh-slim: role MCP requires native dsh-scope and dsh-mcp-client APIs');
  }
  const composition = scope.scopeOf(ctx);
  if (composition === undefined) throw new Error('oh-my-dsh-slim: role MCP must mount in the scoped agent preset composition');
  const entries = new Map();
  const departed = new WeakSet();
  let disposed = false;
  const belongs = (agent) => scope.scopeChainOf(scope.scopeOf(agent.ctx)).includes(composition);
  const report = () => ctx.logger.warn('role-subagent: MCP setup failed (details withheld)');

  function stop(entry, agent) {
    if (entry.stopping) return entry.stopping;
    entry.stopped = true;
    entry.unlisten?.();
    entry.cancelWait?.();
    entry.stopping = (async () => {
      // Claim pending native connects immediately, before draining setup.
      const closing = entry.fibers.map(quiesce);
      await entry.ready.catch(() => {});
      const results = await Promise.allSettled(closing);
      for (const result of results) if (result.status === 'rejected') report(result.reason);
      // Keep the agent-owned guard until its scope retires, even if this preset
      // unloads first: inherited MCP tools must not become callable in the gap.
      if (departed.has(agent)) entry.guard.dispose();
    })();
    return entry.stopping;
  }

  function ensure(agent) {
    if (disposed || departed.has(agent)) return;
    const existing = entries.get(agent);
    if (existing) {
      if (!belongs(agent)) {
        stop(existing, agent).finally(() => {
          if (entries.get(agent) === existing) entries.delete(agent);
        }).catch(report);
      }
      return;
    }
    if (!belongs(agent)) return;
    const loaded = loadConfig(ctx);
    const roleId = roleIdForAgent(agent);
    const role = loaded.roles[roleId];
    if (!role) return;
    if (scope.scopeOf(agent.ctx) === undefined || scope.scopeOf(agent.ctx) === composition) {
      throw new Error('oh-my-dsh-slim: role MCP requires a distinct agent scope');
    }
    const continuable = isContinuableAgent(agent);
    const parentScope = scope.scopeChainOf(scope.scopeOf(agent.ctx))[1];
    const guard = installMcpPolicy(agent, roleId, continuable ? role : { ...role, mcps: [] }, parentScope);
    const names = continuable && roleSupportsMcp(roleId) && role.enabled !== false ? [...new Set(role.mcps ?? [])].filter((id) => loaded.servers[id] !== undefined) : [];
    const entry = { fibers: [], stopped: false, waited: false, ready: undefined, guard };
    entries.set(agent, entry);
    entry.unlisten = agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      if (!entry.waited && !entry.stopped) {
        entry.waited = true;
        let timer;
        const timeout = new Promise((resolve) => {
          entry.cancelWait = resolve;
          timer = setTimeout(resolve, MCP_WAIT_TIMEOUT_MS);
        });
        try {
          await Promise.allSettled([Promise.race([entry.ready, timeout])]);
        } finally {
          clearTimeout(timer);
          entry.cancelWait = undefined;
        }
        if (!entry.stopped) {
          // assemble has already captured its tool snapshot. Refresh only the
          // exact Agent's native MCP schemas, preserving all existing entries.
          for (const tool of agent.ctx.tools.schemas(context.agent ?? agent)) {
            if (typeof tool.name === 'string' && tool.name.startsWith('mcp__') && guard.allowed(tool.name) && !assembly.tools.some((item) => item.name === tool.name)) assembly.tools.push(tool);
          }
        }
      }
      filterMcpSchemas(assembly, guard.allowed);
      const result = await next();
      filterMcpSchemas(assembly, guard.allowed);
      return result;
    });
    // Serialize clients, matching the legacy install order. Created observers
    // do not return this readiness promise: only the first assembly waits.
    entry.ready = Promise.resolve().then(async () => {
      for (const serverName of names) {
        if (disposed || entry.stopped) return;
        const resolved = await serverConfig(serverName, loaded.servers[serverName]);
        if (disposed || entry.stopped) return;
        const fiber = agent.ctx.plugin(mcp, resolved);
        entry.fibers.push(fiber);
        await fiber.await();
      }
    });
    entry.ready.catch(report); // retain successful earlier clients on failure
  }

  function reconcile() {
    if (disposed) return;
    for (const agent of ctx.agents.list()) {
      ensure(agent);
    }
  }
  ctx.effect(() => async () => {
    disposed = true;
    await Promise.allSettled([...entries].map(([agent, entry]) => stop(entry, agent)));
    entries.clear();
  });
  ctx.on('agent/created', ({ agent }) => { ensure(agent); });
  ctx.on('agent/disposed', ({ agent }) => {
    departed.add(agent);
    const entry = entries.get(agent);
    if (!entry) return;
    return stop(entry, agent).finally(() => entries.delete(agent));
  });
  ctx.on('tools/change', reconcile);
  reconcile(); // attach already-live role children after preset reload
}
