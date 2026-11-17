// sandbox-role-grants.js — role-scoped Seatbelt write grants for workspace-write.
//
// Host Seatbelt profiles under workspace-write only allow the workspace root and
// a temp area. Maestro/applesimutils also need to write simulator device data
// under ~/Library/Developer/CoreSimulator/Devices/<UDID>/data. This plugin wraps
// ctx.sandbox.confine (host scope) and, for named roles only, appends fixed SBPL
// allow forms after the existing profile string (last matching rule wins).
//
// Least privilege / fail closed:
// - darwin + workspace-write + sandbox-exec -p <string> only
// - role resolved from policy.sessionId via agents.get + roleIdForAgent
// - only named grants from KNOWN_GRANTS (never free-form paths from config)
// - unknown session/role/shape/error → return confine result unchanged

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { roleIdForAgent } from './roles.js';

export const name = 'sandbox-role-grants';
/** Host-scope: needs the shared sandbox provider and agent registry. */
export const inject = ['sandbox', 'agents', 'loader'];

/**
 * Fixed grant table. Values are SBPL form builders; never accept raw paths from
 * role config. Keep this list short and review any addition carefully.
 */
export const KNOWN_GRANTS = Object.freeze({
  'coresim-device-data': (home) =>
    `(allow file-write* (regex #"^${escapeSbplRegex(home)}/Library/Developer/CoreSimulator/Devices/[0-9A-F-]{36}/data(/|$)"))`,
});

export const KNOWN_GRANT_NAMES = Object.freeze(Object.keys(KNOWN_GRANTS));

/** Escape a literal path fragment for inclusion inside an SBPL `#""` regex. */
export function escapeSbplRegex(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Resolve the real home directory used in grant regexes.
 * @returns absolute home path, or undefined when unusable.
 */
export function resolveHomeDir(realpathSync = fs.realpathSync, homedir = os.homedir) {
  try {
    const home = realpathSync(homedir());
    return typeof home === 'string' && home.length > 0 ? home : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build SBPL allow forms for the named grants. Unknown names are skipped
 * (fail closed — never invent paths).
 * @param {string[]} grantNames
 * @param {string} [home]
 */
export function buildGrantForms(grantNames, home = resolveHomeDir()) {
  if (typeof home !== 'string' || home.length === 0 || !Array.isArray(grantNames) || grantNames.length === 0) {
    return [];
  }
  const forms = [];
  for (const grantName of grantNames) {
    const builder = KNOWN_GRANTS[grantName];
    if (typeof builder !== 'function') continue;
    forms.push(builder(home));
  }
  return forms;
}

/** Whether a confine() result looks like a Seatbelt sandbox-exec -p profile wrap. */
export function isSeatbeltConfineResult(out) {
  if (out === undefined || out === null || typeof out !== 'object') return false;
  const argv = out.argv;
  if (!Array.isArray(argv) || argv.length < 3) return false;
  const prog = path.basename(String(argv[0] ?? ''));
  return prog === 'sandbox-exec' && argv[1] === '-p' && typeof argv[2] === 'string';
}

/**
 * Append known grant forms to a confine result when all gates pass.
 * Never mutates `out`; returns a shallow copy with a new argv array, or `out`.
 *
 * @param {object} out - confine() result
 * @param {{ mode?: string, sessionId?: string }} policy
 * @param {string|undefined} roleId
 * @param {string[]|undefined} grantNames
 * @param {string} [home]
 * @param {string} [platform]
 */
export function applyGrantsToConfineResult(
  out,
  policy,
  roleId,
  grantNames,
  home = resolveHomeDir(),
  platform = process.platform,
) {
  try {
    if (platform !== 'darwin') return out;
    if (policy?.mode !== 'workspace-write') return out;
    if (!isSeatbeltConfineResult(out)) return out;
    if (typeof roleId !== 'string' || roleId.length === 0) return out;
    if (!Array.isArray(grantNames) || grantNames.length === 0) return out;
    const forms = buildGrantForms(grantNames, home);
    if (forms.length === 0) return out;
    const profile = `${out.argv[2]} ${forms.join(' ')}`;
    return {
      ...out,
      argv: [out.argv[0], out.argv[1], profile, ...out.argv.slice(3)],
    };
  } catch {
    return out;
  }
}

function roleIdForSession(ctx, sessionId) {
  if (sessionId === undefined || sessionId === null) return undefined;
  const agent = ctx.agents?.get?.(sessionId);
  if (agent === undefined || agent === null) return undefined;
  return roleIdForAgent(agent);
}

function grantNamesForRole(ctx, roleId) {
  if (typeof roleId !== 'string' || roleId.length === 0) return undefined;
  try {
    const config = loadConfig(ctx);
    const grants = config?.roles?.[roleId]?.sandboxGrants;
    return Array.isArray(grants) ? grants : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wrap ctx.sandbox.confine so role-scoped Seatbelt grants can be appended.
 * Restores the original method on dispose via ctx.effect.
 */
export function apply(ctx) {
  const sandbox = ctx.sandbox;
  if (sandbox === undefined || sandbox === null || typeof sandbox.confine !== 'function') {
    ctx.logger?.warn?.('sandbox-role-grants: ctx.sandbox.confine unavailable; skipping');
    return;
  }

  const origConfine = sandbox.confine.bind(sandbox);

  sandbox.confine = async (argv, policy, signal) => {
    const out = await origConfine(argv, policy, signal);
    try {
      const roleId = roleIdForSession(ctx, policy?.sessionId);
      const grantNames = grantNamesForRole(ctx, roleId);
      return applyGrantsToConfineResult(out, policy, roleId, grantNames);
    } catch (error) {
      ctx.logger?.warn?.(
        'sandbox-role-grants: grant path failed closed: %s',
        String(error?.message ?? error),
      );
      return out;
    }
  };

  ctx.effect(
    () => () => {
      sandbox.confine = origConfine;
    },
    'oh-my-dsh-slim: sandbox-role-grants',
  );
}
