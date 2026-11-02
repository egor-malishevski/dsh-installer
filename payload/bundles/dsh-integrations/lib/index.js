import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEditor } from './editor.js';
import { snapshot } from './mcp-status.js';

export const name = 'dsh-integrations';

function hostBase(ctx) {
  const entry = (process.argv[1] ?? '').replaceAll('\\', '/');
  const marker = '/resources/app.asar/';
  const at = entry.toLowerCase().indexOf(marker);
  const packaged = at < 0 ? undefined : pathToFileURL(entry.slice(0, at + marker.length - 1) + '/dsh/node_modules/x/y.js').href;
  return ctx.loader?.config?.bareModuleBaseUrl ?? packaged ?? ctx.loader?.ctx?.baseUrl ?? ctx.loader?.config?.baseUrl;
}

// Loader entries are nested under the root include; `options.id` is the local
// patch id while `entry.id` is its fully qualified runtime id.
export function activeRow(loader, id, fields) {
  try {
    const matches = [...loader.entries()].filter(row => row.options?.id === id);
    if (matches.length !== 1) return false;
    const row = matches[0];
    // dsh-app-boot's FIBER_ACTIVE is 2; inactiveEntries uses this same check.
    return row.fiber?.state === 2 && ['@deepseek-ai/dsh-mcp-client', 'dsh-integrations/mcp-client'].includes(row.options?.name) && (!fields || Object.entries(fields).every(([key, value]) => JSON.stringify(row.options.config?.[key]) === JSON.stringify(value)));
  } catch { return false; }
}

export async function editorRequest(editor, endpoint, payload, signal, peer) {
  if (peer?.principal?.kind !== 'owner') return { ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden', details: {} } };
  let value;
  if (endpoint === 'status') {
    try { value = snapshot(await editor.statusRows()); } catch { value = { ok: false, code: 'UNAVAILABLE' }; }
  } else value = endpoint === 'describe' ? await editor.describe() : endpoint === 'mutate' ? await editor.mutate(payload, signal) : { ok: false, code: 'UNKNOWN_ENDPOINT' };
  return { ok: true, value };
}

export function apply(ctx) {
  // Missing optional services or host imports must not block the panel.
  ctx.inject(['loader', 'connection', 'webServer'], async child => {
    let active = true;
    child.effect(() => () => { active = false; }, 'integration editor transport lifetime');
    try {
      const base = hostBase(child);
      if (!base || !child.loader.internal?.import) return;
      const load = specifier => child.loader.internal.import(specifier, base, {});
      const [yaml, atomic, connection] = await Promise.all([load('yaml'), load('@deepseek-ai/dsh-atomic-write'), load('@deepseek-ai/dsh-client-connection')]);
      if (!active || typeof connection.HostConnectionService?.prototype?.register !== 'function') return;
      const path = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cordis.patch.yml');
      const recoveryDir = join(homedir(), '.dsh', 'migration-backups', 'mcp-editor-backend-20261101', 'recovery');
      const isActive = (id, fields) => activeRow(child.loader, id, fields);
      const editor = createEditor({ path, recoveryDir, yaml, atomic, getHmr: () => child.get('hmr'), isActive });
      connection.HostConnectionService.prototype.register.call(child.connection, child, '/integrations-editor', async (endpoint, payload, signal, peer) => {
        return editorRequest(editor, endpoint, payload, signal, peer);
      });
    } catch {
      // The editor is optional; never expose host import or configuration errors.
    }
  });
}
