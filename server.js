import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mcps, roles, validateConfig } from './lib/config.js';
import { inspectEnvironment as defaultInspect } from './lib/environment.js';
import { buildInstallPlan } from './lib/plan.js';
import { installPlan } from './lib/install.js';
import { probeRelayPort } from './lib/relay-port.js';

const root = dirname(fileURLToPath(import.meta.url));
const maxBody = 256 * 1024;
export function createServer({ token = randomBytes(32).toString('hex'), uiRoot = resolve(root, 'ui'), home = homedir(), environment, inspectEnvironmentFn = defaultInspect, afterWrite } = {}) {
  let origin;
  let relayPortPromise;
  const relayPort = () => relayPortPromise ??= probeRelayPort();
  const inspect = () => inspectEnvironmentFn({ home });
  const publicEnvironment = env => ({ ...env, checks: (env.checks || []).filter(c => !['uvx', 'npx', 'pnpm', 'cli'].includes(c.id)), runtimePaths: undefined });
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host;
    if (!origin || host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return send(res, 403, { ok: false, error: 'Forbidden' });
    if (req.method === 'OPTIONS') return send(res, 403, { ok: false, error: 'Forbidden' });
    const pathname = new URL(req.url, origin).pathname;
    if (pathname.startsWith('/api/')) {
      const given = req.headers['x-dsh-setup-token'];
      const a = Buffer.from(typeof given === 'string' ? given : ''); const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return send(res, 403, { ok: false, error: 'Forbidden' });
      if (req.method === 'GET' && pathname === '/api/bootstrap') {
        try { return send(res, 200, { ok: true, defaults: { apiUrl: '', roles, mcps }, environment: publicEnvironment(environment ?? await inspect()) }); }
        catch { return send(res, 500, { ok: false, error: 'Environment inspection failed.', code: 'PREFLIGHT_FAILED' }); }
      }
      if (req.method !== 'POST' || !['/api/validate', '/api/install'].includes(pathname)) return send(res, 404, { ok: false, error: 'Not found' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { ok: false, error: 'JSON required' });
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > maxBody) return send(res, 413, { ok: false, error: 'Request too large' }); chunks.push(chunk); }
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const config = input.config ?? input;
        validateConfig(config);
        const checks = await inspect();
        let port = await relayPort();
        let plan = await buildInstallPlan(config, { targetHome: home, runtimePaths: checks.runtimePaths, relayPort: port });
        const blockers = [...(checks.blockers || []), ...plan.requirements.filter(r => typeof r === 'string' && r.startsWith('BLOCKER:'))];
        const warnings = [...(checks.warnings || []), ...plan.requirements.filter(r => typeof r === 'string' && !r.startsWith('BLOCKER:'))];
        if (pathname === '/api/validate') return send(res, 200, { ok: true, apiUrl: plan.apiUrl, environment: publicEnvironment(checks), blockers, warnings, preview: { fileCount: plan.files.length, relayPort: port }, message: 'Configuration is structurally valid. No network request was made.' });
        if (blockers.length || checks.ok === false) return send(res, 409, { ok: false, code: 'PREFLIGHT_FAILED', error: 'Installation prerequisites are not satisfied.', blockers });
        // Retry only a port collision, after installPlan has cleaned up its stage and lock.
        for (let attempt = 0; ; attempt++) {
          try {
            await installPlan(plan, { checkEnvironment: async () => {
              const current = await inspect();
              const currentPlan = await buildInstallPlan(config, { targetHome: home, runtimePaths: current.runtimePaths, relayPort: port });
              const currentBlockers = [...(current.blockers || []), ...currentPlan.requirements.filter(r => typeof r === 'string' && r.startsWith('BLOCKER:'))];
              if (current.ok === false || currentBlockers.length) return { ok: false, blockers: currentBlockers };
              if (JSON.stringify(current.runtimePaths || {}) !== JSON.stringify(checks.runtimePaths || {})) return { ok: false, blockers: ['Runtime environment changed during installation. Please retry.'] };
              try { await probeRelayPort(port); } catch (error) {
                return { ok: false, blockers: [`Relay port ${port} is unavailable.`], relayPortOccupied: error?.code === 'EADDRINUSE' };
              }
              return { ok: true };
            }, afterWrite });
            break;
          } catch (error) {
            if (!error.relayPortOccupied || attempt >= 4) throw error;
            port = await probeRelayPort();
            relayPortPromise = Promise.resolve(port);
            plan = await buildInstallPlan(config, { targetHome: home, runtimePaths: checks.runtimePaths, relayPort: port });
          }
        }
        return send(res, 200, { ok: true, profilePath: resolve(home, '.dsh/profiles/desktop'), relayPort: port, backupPath: null, rollback: { instructions: 'Remove the installed profile and installer files only after confirming they are no longer needed.' }, warnings });
      } catch (error) {
        const codes = new Set(['INVALID_PLAN', 'UNSAFE_PATH', 'EXISTING_PROFILE', 'EXISTING_FILE', 'LOCKED', 'PREFLIGHT_FAILED', 'ROLLBACK_FAILED', 'INSTALL_FAILED']);
        if (codes.has(error?.code)) return send(res, 409, { ok: false, code: error.code, error: 'Installation could not be completed.', ...(error.code === 'PREFLIGHT_FAILED' ? { blockers: error.blockers || [] } : {}) });
        return send(res, 400, { ok: false, error: error instanceof SyntaxError ? 'Invalid JSON' : 'Invalid configuration or installation plan.' });
      }
    }
    if (req.method !== 'GET' || pathname.includes('\0')) return send(res, 404, { ok: false, error: 'Not found' });
    try {
      const base = await realpath(uiRoot); const file = await realpath(resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname)));
      if (!file.startsWith(base + sep)) throw new Error('outside UI');
      const data = await readFile(file);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' }); res.end(data);
    } catch { send(res, 404, { ok: false, error: 'UI not found' }); }
  });
  server.on('listening', () => { origin = `http://127.0.0.1:${server.address().port}`; });
  return { server, token, get origin() { return origin; } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = createServer();
  instance.server.listen(0, '127.0.0.1', () => {
    const url = `${instance.origin}/#${instance.token}`;
    console.log(`Open this local setup URL in your browser:\n${url}`);
    if (process.platform === 'darwin') import('node:child_process').then(({ spawn }) => { const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' }); child.on('error', () => {}); });
  });
}
