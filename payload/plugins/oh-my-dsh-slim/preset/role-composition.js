// role-composition.js — apply a role's persona and tool surface to its child.
//
// DSH 0.2.1 removed `persona`/`toolFilter` from the subagent tool config and
// rejected both outright: a child's composition is a preset now, and the tool
// may only name one. On the child's own scope at `agent/created`, this module
// replaces the preset's manager persona during system-prompt/assemble and
// applies tools.restrict(filter). The named persona is already registered by
// the child preset; registering it again in that scope is not an override.
//
// Identity comes from `subagent/descriptor.label` (written inside the host's
// setup(), before `agent/created`). The role tool wrapper prefixes the label
// with "<roleId> · ", so the same read works for a live child and for a cold
// resume after a restart. A 0.6.3-created child carries the persona marker
// instead; roleIdFromEvents() keeps that as a fallback.
//
// Failure policy: persona assembly and tool restriction fail closed. A child
// must not run with manager instructions or an unconstrained tool surface.

import { hostImport } from './bridge.js';
import { loadConfig, bindProfileContext } from './config.js';
import { ROLE_PERSONAS } from './preset.js';
import {
  ROLE_TABLE, composeRolePersona, effectiveRoleFilter, fitFilterToKnown, isSubagent, roleIdForAgent,
} from './roles.js';

export const name = 'omds-role-composition';
export const inject = ['loader'];

/** Replace only deployment identity, never tool grants or required safety context. */
export function replaceRolePersona(assembly, text) {
  const persona = assembly.sections.find(section => section.name === 'deployment:persona-prefix');
  if (!persona) throw new Error('oh-my-dsh-slim: child persona section is missing');
  assembly.sections = assembly.sections.map(section => section === persona
    ? { ...section, text, interpolate: false }
    : section);
  return assembly;
}

/** Roles whose composition has already been installed on this exact agent. */
const applied = new WeakSet();

/**
 * The section/tool-filter a role's child should receive, derived from the same
 * user configuration `resolveRole()` uses. Kept as a thin wrapper around
 * `effectiveRoleFilter` so both paths can never disagree on the boundary.
 * @param roleId - the role id whose child is being composed.
 * @param roleConfig - one role entry from the merged configuration.
 * @param definition - the row's `definition` block, when available.
 * @returns a tool filter, or undefined when the role is unrestricted.
 */
export function roleFilter(roleId, roleConfig = {}, definition = {}) {
  return effectiveRoleFilter(roleId, roleConfig, definition);
}

/**
 * Install a role composition on one child. Exported for the smoke harness.
 * @param agent - the child agent (a non-subagent is ignored).
 * @param ctx - a context in the preset composition (for configuration/logging).
 * @param scopeOf - the host's scope helper.
 * @returns 'ok', 'skipped', or throws when `restrict` is unavailable/fails.
 */
export async function composeChild(agent, ctx, scopeOf) {
  if (!isSubagent(agent) || applied.has(agent)) return 'skipped';
  const roleId = roleIdForAgent(agent);
  if (roleId === undefined || ROLE_TABLE[roleId] === undefined) return 'skipped';
  const preset = loadConfig(ctx);
  const roleConfig = preset.roles[roleId] ?? {};
  // `enabled` gates whether the delegation TOOL is mounted, not what an
  // already-mounted tool may create. A session that still holds a tool from an
  // older generation (the user disabled the role mid-session) must not produce
  // an unconstrained child: skipping here was a fail-open permission hole.
  applied.add(agent);

  const section = composeRolePersona(roleId, ROLE_PERSONAS[roleId], roleConfig.personaAppend, undefined);
  // The child's preset already owns this named section in the same scope.
  // A second section() registration throws rather than replacing it. Replace
  // only the persona at assembly time; keep safety sections and runtime facts.
  agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const result = await next();
    return replaceRolePersona(result ?? assembly, section);
  }, { prepend: true });

  const filter = roleFilter(roleId, roleConfig);
  if (filter === undefined) return 'ok';
  const tools = agent.ctx.get?.('tools') ?? agent.ctx.tools;
  const known = tools?.view?.(scopeOf(agent.ctx))?.restrictableNames;
  // No catch: this is the role's permission boundary. A host that cannot
  // enforce it must fail the delegation, not run the child unconstrained.
  const shared = roleConfig.enabled !== false && !ROLE_TABLE[roleId].fixedAllow && !ROLE_TABLE[roleId].synthesisOnly ? (roleConfig.sharedMcpTools ?? []) : [];
  const globalFilter = fitFilterToKnown(filter, known, shared);
  if (globalFilter !== undefined) tools.restrict(globalFilter);
  return 'ok';
}

/** Cordis entry point: one listener per preset composition. */
export async function apply(ctx, config = {}) {
  bindProfileContext(ctx, config.profileId);
  const scope = await hostImport(ctx, '@deepseek-ai/dsh-scope');
  // Return the promise: the host announces `agent/created` through a serial
  // dispatch, and a rejected restrict must reject that announcement so the
  // delegation fails (fail closed).
  // Do not return the private composition status: serial dispatch treats it as a bail.
  ctx.effect(() => ctx.on('agent/created', async ({ agent }) => {
    await composeChild(agent, ctx, scope.scopeOf);
  }), 'oh-my-dsh-slim: role composition');
}
