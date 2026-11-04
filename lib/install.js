import { lstat, readdir, mkdir, mkdtemp, writeFile, link, symlink, unlink, rmdir, rm } from 'node:fs/promises';
import path from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
const missing = async p => { try { return await lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

async function inspectParents(p) {
  const parsed = path.parse(p);
  let current = parsed.root;
  for (const part of p.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await missing(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('UNSAFE_PATH');
  }
}

async function checkClean(home, files) {
  await inspectParents(home);
  const dsh = path.join(home, '.dsh');
  await inspectParents(dsh);
  const profiles = path.join(dsh, 'profiles');
  const profileStat = await missing(profiles);
  if (profileStat && (profileStat.isSymbolicLink() || !profileStat.isDirectory() || (await readdir(profiles)).length)) throw fail('EXISTING_PROFILE');
  if (await missing(path.join(dsh, 'desktop'))) throw fail('EXISTING_PROFILE');
  for (const file of files) {
    const dest = path.join(home, file.path);
    await inspectParents(path.dirname(dest));
    if (await missing(dest)) throw fail('EXISTING_FILE');
  }
}

async function checks(checkEnvironment) {
    const result = await checkEnvironment();
    if (result === false || result?.ok === false || result?.blockers?.length) {
      const error = fail('PREFLIGHT_FAILED');
      error.blockers = Array.isArray(result?.blockers) ? result.blockers.filter(b => typeof b === 'string').slice(0, 20) : [];
      if (!error.blockers.length && typeof result?.message === 'string') error.blockers = [result.message];
      if (result?.relayPortOccupied === true) error.relayPortOccupied = true;
      throw error;
    }
}

// Errors deliberately contain only bounded codes, never paths or file contents.
export async function installPlan(plan, { checkEnvironment, afterWrite } = {}) {
  let lock, stage;
  const createdFiles = [], createdDirs = [];
  try {
    if (!plan || typeof plan.targetHome !== 'string' || !path.isAbsolute(plan.targetHome) || plan.targetHome.includes('\0') || !Array.isArray(plan.files) || !plan.files.length || plan.files.length > 256 || typeof checkEnvironment !== 'function' || (afterWrite !== undefined && typeof afterWrite !== 'function')) throw fail('INVALID_PLAN');
    const home = path.resolve(plan.targetHome);
    const seen = new Set();
    let total = 0;
    const files = plan.files.map(file => {
      if (!file || typeof file.path !== 'string' || !file.path || file.path.includes('\0') || file.path.includes('\\') || path.isAbsolute(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..')) throw fail('INVALID_PLAN');
      if (file.path === '.dsh-setup.lock' || file.path.startsWith('.dsh-setup.lock/') || file.path.split('/').some(p => p.startsWith('.dsh-setup-stage-'))) throw fail('INVALID_PLAN');
      if (seen.has(file.path)) throw fail('INVALID_PLAN');
      seen.add(file.path);
      if (file.type === 'symlink') {
        const targets = { '.dsh/profiles/desktop/node_modules/dsh-integrations': '.dsh/bundles/dsh-integrations', '.dsh/profiles/desktop/node_modules/oh-my-dsh-slim': '.dsh/plugins/oh-my-dsh-slim', '.dsh/profiles/desktop/node_modules/dsh-web-search-multi': '.dsh/plugins/dsh-web-search-multi' };
        const expected = targets[file.path];
        if (!expected || typeof file.target !== 'string' || path.isAbsolute(file.target) || file.target.includes('\0') || path.resolve(home, path.dirname(file.path), file.target) !== path.resolve(home, expected)) throw fail('INVALID_PLAN');
        return { path: file.path, target: file.target, targetPath: expected, type: 'symlink' };
      }
      if (file.type !== undefined || (!Buffer.isBuffer(file.content) && typeof file.content !== 'string') || typeof file.secret !== 'boolean') throw fail('INVALID_PLAN');
      const content = Buffer.from(file.content);
      total += content.length;
      if (content.length > 1024 * 1024 || total > 10 * 1024 * 1024) throw fail('INVALID_PLAN');
      return { path: file.path, content };
    });
    for (const file of files) for (const other of files) if (other.path.startsWith(file.path + '/')) throw fail('INVALID_PLAN');
    for (const file of files) if (file.type === 'symlink' && !files.some(other => other.path.startsWith(file.targetPath + '/'))) throw fail('INVALID_PLAN');
    await inspectParents(home);
    if (!(await missing(home))) throw fail('INVALID_PLAN');
    lock = path.join(home, '.dsh-setup.lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch (e) { lock = undefined; if (e.code === 'EEXIST') throw fail('LOCKED'); throw e; }
    await checks(checkEnvironment);
    await checkClean(home, files);
    stage = await mkdtemp(path.join(home, '.dsh-setup-stage-'));
    for (let i = 0; i < files.length; i++) if (files[i].type !== 'symlink') await writeFile(path.join(stage, String(i)), files[i].content, { mode: 0o600, flag: 'wx' });
    await checks(checkEnvironment);
    await checkClean(home, files);
    for (let i = 0; i < files.length; i++) {
      const dest = path.join(home, files[i].path);
      let current = home;
      for (const part of files[i].path.split('/').slice(0, -1)) {
        current = path.join(current, part);
        try { await mkdir(current, { mode: 0o700 }); createdDirs.push(current); }
        catch (e) { if (e.code !== 'EEXIST') throw e; const stat = await lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('UNSAFE_PATH'); }
      }
      // link is an atomic no-replace commit; rename() would overwrite a raced-in file.
      try { if (files[i].type === 'symlink') { await inspectParents(path.join(home, files[i].targetPath)); await symlink(files[i].target, dest); } else await link(path.join(stage, String(i)), dest); } catch (e) { if (e.code === 'EEXIST') throw fail('EXISTING_FILE'); throw e; }
      createdFiles.push(dest);
      if (afterWrite) await afterWrite(files[i].path);
    }
    return { ok: true, installedPaths: files.map(file => file.path), rollbackSupported: true };
  } catch (error) {
    let cleanupFailed = false;
    for (const file of createdFiles.reverse()) try { await unlink(file); } catch { cleanupFailed = true; }
    for (const dir of createdDirs.reverse()) try { await rmdir(dir); } catch { cleanupFailed = true; }
    const allowed = new Set(['INVALID_PLAN', 'UNSAFE_PATH', 'EXISTING_PROFILE', 'EXISTING_FILE', 'LOCKED', 'PREFLIGHT_FAILED']);
    if (!cleanupFailed && error?.code === 'PREFLIGHT_FAILED') throw error;
    throw fail(cleanupFailed ? 'ROLLBACK_FAILED' : allowed.has(error?.code) ? error.code : 'INSTALL_FAILED');
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (lock) await rmdir(lock).catch(() => {});
  }
}
