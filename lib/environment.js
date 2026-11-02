import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const defaultApp = '/Applications/DeepSeek Harness.app';

// Process output contains environment variables. Keep it in memory only, and
// never include raw rows or errors in the returned message.
export async function assertStopped(targetHome, { listProcesses, appPath = defaultApp, home = homedir() } = {}) {
  try {
    const rows = listProcesses ? await listProcesses() : (await exec('/bin/ps', ['eww', '-axo', 'command='], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n');
    if (!Array.isArray(rows)) throw new Error('invalid process list');
    const desktop = join(appPath, 'Contents/MacOS/DeepSeek Harness');
    const defaultTarget = resolve(targetHome) === resolve(home, '.dsh');
    const relevant = rows.filter(row => typeof row === 'string' && (row.includes(desktop) || /(?:^|[\s/])(?:main[-_]host|mainHost)(?:[.\s/=-]|$)/i.test(row) || /dsh-desktop-host\/lib\/cli\.js\s+web(?:\s|$)/.test(row)));
    const envHome = row => /(?:^|\s)DSH_HOME=([^\s]*)/.exec(row)?.[1];
    const targetDesktop = relevant.some(row => row.includes(desktop) && (envHome(row) ? resolve(envHome(row)) === resolve(targetHome) : defaultTarget));
    const targetHost = relevant.some(row => !row.includes(desktop) && (envHome(row) ? resolve(envHome(row)) === resolve(targetHome) : defaultTarget));
    if (targetDesktop || targetHost) return { ok: false, message: 'Quit the target DeepSeek Harness application and its main host before installation.' };
    return { ok: true, message: 'Target DeepSeek Harness processes are stopped.' };
  } catch {
    return { ok: false, message: 'Could not safely inspect DeepSeek Harness processes.' };
  }
}

export async function inspectEnvironment({ home = homedir(), platform = process.platform, appPath = defaultApp, execFileFn = exec, filesystem = { access } } = {}) {
  const targetHome = join(home, '.dsh');
  const resources = join(appPath, 'Contents/Resources');
  const desktopNode = join(appPath, 'Contents/MacOS/DeepSeek Harness');
  const runtimePaths = {
    appPath, node: join(resources, 'runtime/bin/node'), desktopNode,
    pnpm: join(resources, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs'),
    cli: join(resources, 'runtime/cli/bin/dsh'),
    officialBundles: join(targetHome, 'bundles/dsh-integrations'), uvx: null, npx: null,
  };
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok: !!ok, message });
  const exists = async (path, mode = constants.F_OK) => { try { await filesystem.access(path, mode); return true; } catch { return false; } };
  const run = async (file, args, options = {}) => {
    const result = await execFileFn(file, args, { timeout: 10000, maxBuffer: 1024 * 1024, ...options });
    return typeof result === 'string' ? result.trim() : String(result.stdout ?? '').trim();
  };
  add('platform', platform === 'darwin', platform === 'darwin' ? 'macOS detected.' : 'macOS is required.');
  let version = '', identifier = '';
  if (platform === 'darwin') {
    try {
      const plist = join(appPath, 'Contents/Info.plist');
      version = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
      identifier = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
    } catch { /* Report a safe fixed message below. */ }
  }
  add('app', version === '0.2.1-rc.5' && identifier === 'com.deepseek.dsh', version === '0.2.1-rc.5' && identifier === 'com.deepseek.dsh' ? 'Supported DeepSeek Harness app verified.' : 'DeepSeek Harness 0.2.1-rc.5 with bundle ID com.deepseek.dsh is required.');
  let nodeOk = false;
  if (await exists(runtimePaths.node, constants.X_OK) && await exists(desktopNode, constants.X_OK)) {
    try {
      const output = await run(runtimePaths.node, ['--version'], { env: { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: desktopNode } });
      nodeOk = /^v?(\d+)\./.test(output) && Number(output.match(/^v?(\d+)\./)[1]) >= 20;
    } catch { /* Unusable runtime. */ }
  }
  add('node', nodeOk, nodeOk ? 'Bundled Node.js 20 or newer verified.' : 'The Harness bundled Node.js 20 or newer could not be executed.');
  for (const name of ['pnpm', 'cli']) {
    const ok = await exists(runtimePaths[name]);
    add(name, ok, ok ? `Bundled ${name} found.` : `Bundled ${name} not found.`);
  }
  const searchPath = [process.env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin')].join(':');
  for (const name of ['uvx', 'npx']) {
    try {
      const found = await run('/usr/bin/which', [name], { env: { ...process.env, PATH: searchPath } });
      if (found && await exists(found, constants.X_OK)) runtimePaths[name] = found;
    } catch { /* Missing tools are reported as blockers. */ }
    add(name, !!runtimePaths[name], runtimePaths[name] ? `${name} found.` : `${name} is required and was not found on the target PATH.`);
  }
  if (runtimePaths.npx) {
    try {
      const handle = await open(runtimePaths.npx, 'r');
      let prefix;
      try { const buffer = Buffer.alloc(128); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); prefix = buffer.subarray(0, bytesRead).toString(); }
      finally { await handle.close(); }
      if (/^#!\s*\/usr\/bin\/env\s+node(?:\s|$)/.test(prefix)) {
        const nodeVersion = await run('/usr/bin/env', ['node', '--version'], { env: { ...process.env, PATH: searchPath } });
        if (/^v?\d+\.\d+\.\d+/.test(nodeVersion)) { runtimePaths.nodeVersion = nodeVersion; runtimePaths.npxPath = searchPath; }
      }
    } catch { /* Unverified npx Node cannot satisfy version-gated servers. */ }
  }
  // An existing bundle is informational; a clean target may not have one yet.
  runtimePaths.officialBundles = await exists(runtimePaths.officialBundles) ? runtimePaths.officialBundles : null;
  const optional = new Set(['uvx', 'npx', 'pnpm', 'cli']);
  const blockers = checks.filter(check => !check.ok && !optional.has(check.id)).map(check => check.message);
  const warnings = checks.filter(check => !check.ok && optional.has(check.id)).map(check => check.message);
  return { ok: blockers.length === 0, checks, blockers, warnings, runtimePaths, targetHome };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inspectEnvironment();
  for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'BLOCKED'}: ${check.message}`);
  process.exitCode = result.ok ? 0 : 1;
}
