import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, link, open, mkdir, mkdtemp, readdir, readlink, rename, rm, rmdir, symlink, unlink, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { models as catalog } from './profile.js';
import { assertStopped } from './environment.js';
import { planFallbackMigration } from './fallback-migration.js';
import { planLegacyFallbackCleanup } from './fallback-cleanup.js';
import { planFallbackSeeding } from './fallback-seeding.js';
import { parsePatch } from './yaml-patch.js';

// Safe updater for an EXISTING profile. Errors/conflicts are bounded codes only: never paths, contents or secrets.
// Reads only: profile package.json / cordis.patch.yml, a pnpm lock importer when a local link must be added,
// managed payload destinations. It never reads .credentials.yaml, data/, sessions or logs, never touches the
// !!js integrations patch, never deletes user files.

const defaultPayload = fileURLToPath(new URL('../payload/', import.meta.url));
const SUPPORTED = '0.2.1-rc.5';
const MAX_FILE = 1024 * 1024;
const MAX_ENTRIES = 2000;
const PROFILE = '.dsh/profiles/desktop';
const PKG = `${PROFILE}/package.json`;
const PATCH = `${PROFILE}/cordis.patch.yml`;
const INTEGRATIONS_PATCH = 'bundles/dsh-integrations/cordis.patch.yml';
const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock'];
const desiredDeps = { '@deepseek-ai/dsh-base': SUPPORTED, '@deepseek-ai/dsh-web-app': SUPPORTED, 'dsh-integrations': 'link:../../bundles/dsh-integrations', 'dsh-web-search-exa-parallel': 'link:../../plugins/dsh-web-search-exa-parallel', 'oh-my-dsh-slim': 'link:../../plugins/oh-my-dsh-slim' };
const desiredBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-search-exa-parallel', 'dsh-integrations', 'oh-my-dsh-slim'];
const linkTargets = { 'dsh-integrations': '.dsh/bundles/dsh-integrations', 'dsh-web-search-exa-parallel': '.dsh/plugins/dsh-web-search-exa-parallel', 'oh-my-dsh-slim': '.dsh/plugins/oh-my-dsh-slim' };

// Explicit predecessor versions that may be upgraded in place: package -> { installedVersion: payloadVersion }.
const NATIVE_VERSION = '0.8.7-native.1';
const PREDECESSORS = { 'oh-my-dsh-slim': { '0.8.7': '0.8.7-native.1' } };

const fail = (code, extra) => Object.assign(new Error(code), { code }, extra);
const sha = buf => createHash('sha256').update(buf).digest('hex');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validLocalLink = (value, home, target) => typeof value === 'string' && value.startsWith('link:') && value.length > 5 && !value.includes('\0') && path.resolve(home, PROFILE, value.slice(5)) === path.resolve(home, target);

// Pure policy, separate from file hashing: callers cannot override the installed bytes.
export const ORIGINAL_RELAY_HASH = '77058099982aa362047ff7e565dbc7641783ad507c62bbfbc2fa719479c4cccd';
export function relayCleanupConflict(hash, rows, opaqueRelayFields, home) {
  if (hash === 'e3ba9001109984f51a5b2b428f31b0a03ca655c9fe41f56729a241c34b05bfbe') return null;
  if (hash !== ORIGINAL_RELAY_HASH) return 'RELAY_HASH_MISMATCH';
  const matches = rows.filter(row => row.id === 'zstd-render');
  const relay = matches[0];
  const relayPath = path.join(home, '.dsh/plugins/zstd-render/index.js');
  const consumers = rows.filter(row => typeof row.name === 'string' && path.isAbsolute(row.name) && path.resolve(row.name) === relayPath);
  if (opaqueRelayFields || matches.length !== 1 || consumers.length !== 1 || relay.name !== relayPath || !isObj(relay.config) || typeof relay.config.upstream !== 'string' || !relay.config.upstream || relay.config.upstream.trim() !== relay.config.upstream) return 'RELAY_UPSTREAM_REQUIRED';
  try {
    const url = new URL(relay.config.upstream);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return 'RELAY_UPSTREAM_REQUIRED';
  } catch { return 'RELAY_UPSTREAM_REQUIRED'; }
  return null;
}

// A pnpm link importer records only the link path. Append that one missing entry; never rewrite the rest.
export function pnpmLinkLockAddition(text, name, specifier) {
  if (typeof text !== 'string' || text.includes('\0') || !text.startsWith("lockfileVersion: '9.0'\n") || !/^[-A-Za-z0-9_.]+$/.test(name)) return null;
  if (!/^link:\.\.\/(?:\.\.\/)?(?:bundles|plugins)\/[A-Za-z0-9_.-]+$/.test(specifier)) return null;
  const lines = text.split('\n');
  const start = lines.indexOf('importers:');
  const end = lines.findIndex((line, index) => index > start && line && !/^\s/.test(line));
  const limit = end < 0 ? lines.length : end;
  if (start < 0 || lines[start + 1] !== '' || lines[start + 2] !== '  .:' || !['    dependencies:', '    devDependencies:'].includes(lines[start + 3])) return null;
  const section = lines.slice(start, limit);
  if (section.some(line => line.includes(`\n`)) || section.filter(line => line === `      ${name}:`).length) return null;
  const entry = ['      ' + name + ':', '        specifier: ' + specifier, '        version: ' + specifier];
  const depsAt = start + 3;
  let insert = depsAt + 1;
  if (lines[depsAt] !== '    dependencies:') {
    entry.unshift('    dependencies:');
    insert = depsAt;
  }
  lines.splice(insert, 0, ...entry);
  return lines.join('\n');
}

const lstatOrNull = async p => { try { return await lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// Every existing component must be a real directory (no symlinks).
async function checkChain(base, parts) {
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('UNSAFE_PATH');
  }
}
async function checkHome(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0') || path.resolve(home) !== home) throw fail('UNSAFE_PATH');
  const root = path.parse(home).root;
  await checkChain(root, home.slice(root.length).split(path.sep).filter(Boolean));
  if (!(await lstatOrNull(home))) throw fail('UNSAFE_PATH');
}
const validRel = rel => typeof rel === 'string' && rel.startsWith('.dsh/') && !rel.includes('\0') && !rel.includes('\\') && rel.split('/').every(p => p && p !== '.' && p !== '..') && !rel.split('/').some(p => p.startsWith('.dsh-setup'));
async function checkRel(home, rel) {
  if (!validRel(rel)) throw fail('UNSAFE_PATH');
  await checkChain(home, rel.split('/').slice(0, -1));
}
async function readDest(home, rel) {
  await checkRel(home, rel);
  const full = path.join(home, rel);
  const stat = await lstatOrNull(full);
  if (!stat) return { exists: false, hash: null };
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE) throw fail('UNSAFE_PATH');
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = await handle.readFile();
    return { exists: true, buf, hash: sha(buf), mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}

async function payloadFiles(root) {
  const files = [];
  const walk = async rel => {
    for (const name of (await readdir(path.join(root, rel))).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const full = path.join(root, r);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw fail('UNSAFE_PAYLOAD');
      if (stat.isDirectory()) await walk(r);
      else if (stat.isFile() && stat.size <= MAX_FILE) { if (r !== INTEGRATIONS_PATCH) files.push({ rel: r, full }); }
      else throw fail('UNSAFE_PAYLOAD');
      if (files.length > 512) throw fail('UNSAFE_PAYLOAD');
    }
  };
  for (const top of ['plugins', 'bundles']) if (await lstatOrNull(path.join(root, top))) await walk(top);
  return files;
}

async function readPayload(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function buildPlan(home, { payloadRoot, checkEnvironment, migrateNativeFallbacks = false, cleanupLegacyFallbacks = false, mainModel, scope = 'all', seedNativeFallbacks = false }) {
  if (scope === 'slim') return buildSlimPlan(home, { payloadRoot, checkEnvironment, migrateNativeFallbacks, seedNativeFallbacks });
  await checkHome(home);
  const conflicts = new Set();
  const ops = [];
  const skips = [];
  const op = (rel, kind, reason, extra) => ops.push({ path: rel, op: kind, reason, ...extra });
  const guarded = async (fn) => { try { return await fn(); } catch (e) { conflicts.add(['UNSAFE_PATH', 'UNSAFE_PAYLOAD'].includes(e?.code) ? e.code : 'READ_FAILED'); return undefined; } };

  if (checkEnvironment) {
    try {
      const env = await checkEnvironment();
      const app = (env?.checks || []).find(c => c.id === 'app');
      if (app ? !app.ok : env?.ok === false) conflicts.add('APP_INCOMPATIBLE');
    } catch { conflicts.add('ENV_CHECK_FAILED'); }
  }
  const dsh = await lstatOrNull(path.join(home, '.dsh'));
  if (!dsh || dsh.isSymbolicLink() || !dsh.isDirectory()) { conflicts.add(dsh ? 'UNSAFE_PATH' : 'PROFILE_MISSING'); return { ops, skips, conflicts, migrate: migrateNativeFallbacks, cleanup: cleanupLegacyFallbacks, mainModel }; }

  // Profile manifest: add missing deps/pins/bundle names, keep everything else.
  await guarded(async () => {
    const file = await readDest(home, PKG);
    if (!file.exists) { conflicts.add('PROFILE_MISSING'); return; }
    let pkg;
    try { pkg = JSON.parse(file.buf.toString('utf8')); } catch { conflicts.add('PACKAGE_UNPARSEABLE'); return; }
    if (!isObj(pkg) || (pkg.dependencies !== undefined && !isObj(pkg.dependencies)) || (pkg.dsh !== undefined && !isObj(pkg.dsh)) || (pkg.dsh?.profile !== undefined && !isObj(pkg.dsh.profile)) || (pkg.dsh?.profile?.bundles !== undefined && !Array.isArray(pkg.dsh.profile.bundles))) { conflicts.add('PACKAGE_SHAPE'); return; }
    const next = structuredClone(pkg);
    let bad = false;
    const details = [];
    next.dependencies ??= {};
    for (const [name, wanted] of Object.entries(desiredDeps)) {
      if (!Object.hasOwn(next.dependencies, name)) { next.dependencies[name] = wanted; details.push('DEPENDENCY_ADDED'); }
      else if (name.startsWith('@') ? next.dependencies[name] !== wanted : !validLocalLink(next.dependencies[name], home, linkTargets[name])) { conflicts.add(name.startsWith('@') ? 'PIN_CONFLICT' : 'LINK_CONFLICT'); bad = true; }
    }
    next.dsh ??= {}; next.dsh.profile ??= {}; next.dsh.profile.bundles ??= [];
    for (const name of desiredBundles) if (!next.dsh.profile.bundles.includes(name)) { next.dsh.profile.bundles.push(name); details.push('BUNDLE_ADDED'); }
    if (bad || same(pkg, next)) return;
    const present = [];
    for (const lock of LOCKS) if (await lstatOrNull(path.join(home, PROFILE, lock))) present.push(lock);
    const addedLinks = Object.entries(desiredDeps).filter(([name, wanted]) => !Object.hasOwn(pkg.dependencies ?? {}, name) && !name.startsWith('@') && wanted.startsWith('link:'));
    if (!(present.length === 1 && present[0] === 'pnpm-lock.yaml' && addedLinks.length === 1 && details.every(item => item === 'DEPENDENCY_ADDED' || item === 'BUNDLE_ADDED'))) {
      if (present.length) { conflicts.add('UNEXPECTED_LOCK'); return; }
    } else {
      const [name, specifier] = addedLinks[0];
      const rel = `${PROFILE}/pnpm-lock.yaml`;
      const lockFile = await readDest(home, rel);
      const updated = lockFile.exists ? pnpmLinkLockAddition(lockFile.buf.toString('utf8'), name, specifier) : null;
      if (!updated || !Buffer.from(updated).equals(Buffer.from(updated, 'utf8'))) { conflicts.add('UNEXPECTED_LOCK'); return; }
      op(rel, 'replace', 'PNPM_LINK_LOCK_UPDATED', { content: Buffer.from(updated), expected: lockFile.hash, current: lockFile.buf, mode: lockFile.mode });
    }
    op(PKG, 'replace', 'PROFILE_MANIFEST_REPAIR', { details: [...new Set(details)], content: Buffer.from(JSON.stringify(next, null, 2) + '\n'), expected: file.hash, current: file.buf, mode: file.mode });
  });

  // Profile patch: add only missing known managed entries/models; never regenerate or overwrite.
  // The op is emitted after the payload checks so the optional native-fallback migration can depend on them.
  let patchState;
  await guarded(async () => {
    const file = await readDest(home, PATCH);
    if (!file.exists) { conflicts.add('PROFILE_MISSING'); return; }
    const text = file.buf.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(file.buf)) { conflicts.add('PATCH_UNPARSEABLE'); return; }
    let adapter, rows;
    try { adapter = parsePatch(text); rows = adapter.rows; } catch (e) { conflicts.add(e?.code === 'PATCH_YAML_UNSUPPORTED' ? e.code : 'PATCH_UNPARSEABLE'); return; }
    if (!Array.isArray(rows) || rows.some(r => !isObj(r))) { conflicts.add('PATCH_SHAPE'); return; }
    const next = structuredClone(rows);
    const details = [];
    const find = id => { const hits = next.filter(r => r.id === id); if (hits.length > 1) { conflicts.add('DUPLICATE_ENTRY'); return null; } return hits[0]; };
    for (const id of ['agent-default-model', 'llm-pi-ai', 'oh-my-dsh-slim']) if (!find(id) && !conflicts.has('DUPLICATE_ENTRY')) conflicts.add('PATCH_ENTRY_MISSING');
    const provider = find('llm-pi-ai')?.config?.providers?.cliproxy;
    if (find('llm-pi-ai') && !isObj(provider)) conflicts.add('PATCH_SHAPE');
    else if (provider) {
      if (provider.models !== undefined && !Array.isArray(provider.models)) conflicts.add('PATCH_SHAPE');
      else if (!provider.models?.length) {
        // Seed only a missing/empty list: models a user removed from a populated list stay removed.
        provider.models = catalog.map(m => structuredClone(m));
        details.push('CATALOG_SEEDED');
      }
    }
    if (!find('agent-preset-registry') && !conflicts.has('DUPLICATE_ENTRY')) {
      details.push('PRESET_REGISTRY_ADDED');
      const index = next.findIndex(r => r.id === 'oh-my-dsh-slim');
      next.splice(index < 0 ? next.length : index, 0, { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'oh-my-dsh-slim' } });
    }
    if ([...conflicts].some(c => ['PATCH_SHAPE', 'DUPLICATE_ENTRY', 'PATCH_ENTRY_MISSING'].includes(c))) return;
    patchState = { rows, next, details, file, adapter };
  });

  // Link dependencies in node_modules (created only when absent).
  for (const [name, target] of Object.entries(linkTargets)) await guarded(async () => {
    const rel = `${PROFILE}/node_modules/${name}`;
    await checkRel(home, rel);
    const stat = await lstatOrNull(path.join(home, rel));
    const relTarget = path.relative(path.dirname(rel), target);
    if (!stat) op(rel, 'symlink', 'LINK_MISSING', { type: 'symlink', target: relTarget, expected: null });
    else if (!stat.isSymbolicLink() || path.resolve(home, path.dirname(rel), await readlink(path.join(home, rel))) !== path.resolve(home, target)) conflicts.add('LINK_CONFLICT');
  });

  // Payload trees (plugins/bundles). Integrations patch is excluded (may contain !!js secrets).
  const files = await guarded(() => payloadFiles(payloadRoot)) || [];
  const known = new Set(files.map(f => `.dsh/${f.rel}`));
  // Tree identity: an existing managed tree may only be updated from the same package name+version, or an explicitly
  // known predecessor. Anything else (unknown/newer/unnamed) blocks the whole update, even with acknowledgement.
  const roots = [...new Set(files.map(f => f.rel.split('/').slice(0, 2).join('/')))];
  for (const root of roots) await guarded(async () => {
    const wantedBuf = files.some(f => f.rel === `${root}/package.json`) ? await readPayload(path.join(payloadRoot, root, 'package.json')) : null;
    if (!wantedBuf) return;
    const stat = await lstatOrNull(path.join(home, '.dsh', root));
    if (!stat) return;
    const wanted = JSON.parse(wantedBuf.toString('utf8'));
    const installed = await readDest(home, `.dsh/${root}/package.json`);
    let current;
    try { current = installed.exists ? JSON.parse(installed.buf.toString('utf8')) : null; } catch { current = null; }
    const ok = current && current.name === wanted.name && (current.version === wanted.version || PREDECESSORS[wanted.name]?.[current.version] === wanted.version);
    if (!ok) conflicts.add('TREE_VERSION_MISMATCH');
  });
  let relayCandidate;
  for (const file of files) await guarded(async () => {
    const rel = `.dsh/${file.rel}`;
    const wanted = await readPayload(file.full);
    const current = await readDest(home, rel);
    if (!current.exists) return op(rel, 'create', 'PAYLOAD_MISSING', { content: wanted, expected: null, mode: 0o644 });
    if (current.hash === sha(wanted)) return;
    if (file.rel === 'plugins/zstd-render/index.js') {
      if (cleanupLegacyFallbacks) { relayCandidate = { rel, wanted, current }; return; }
      if (current.hash === ORIGINAL_RELAY_HASH || /ALIASES|fallback-main/.test(current.buf.toString('utf8'))) {
        skips.push({ path: rel, op: 'skip', reason: current.hash === ORIGINAL_RELAY_HASH ? 'ORIGINAL_RELAY_PRESERVED' : 'RELAY_WORKAROUND_PRESERVED' });
        return;
      }
    }
    op(rel, 'replace', 'PAYLOAD_MODIFIED_MANAGED_FILE', { content: wanted, expected: current.hash, current: current.buf, mode: current.mode, needsAck: true });
  });
  // Extra files inside managed trees are preserved, never deleted. Symlinks are refused.
  let seen = 0;
  const walk = async rel => {
    await checkRel(home, `${rel}/x`);
    const full = path.join(home, rel);
    const stat = await lstatOrNull(full);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('UNSAFE_PATH');
    for (const name of (await readdir(full)).sort()) {
      if (name === 'node_modules') continue; // package-manager territory: never inspected
      if (++seen > MAX_ENTRIES) throw fail('READ_FAILED');
      const r = `${rel}/${name}`;
      const s = await lstat(path.join(home, r));
      if (s.isSymbolicLink()) throw fail('UNSAFE_PATH');
      if (s.isDirectory()) await walk(r);
      else if (s.isFile() && !known.has(r)) skips.push({ path: r, op: 'skip', reason: 'EXTRA_FILE_PRESERVED' });
    }
  };
  for (const root of roots) await guarded(() => walk(`.dsh/${root}`));

  if (patchState) await guarded(async () => {
    const { rows, next, details, file, adapter } = patchState;
    let entries = next;
    if (migrateNativeFallbacks || cleanupLegacyFallbacks) {
      // Capability comes from the payload actually being installed, never from the caller's boolean alone.
      const treeOk = !conflicts.has('TREE_VERSION_MISMATCH') && !conflicts.has('UNSAFE_PATH') && !conflicts.has('UNSAFE_PAYLOAD') && !conflicts.has('READ_FAILED');
      const supported = treeOk && await nativeCapable(payloadRoot);
      const plan = planFallbackMigration(next, { migrateNativeFallbacks: true, nativeFallbacksSupported: supported, preserveCatalogAliases: adapter.preserveCatalogAliases });
      if (!plan.ok) for (const c of plan.conflicts) conflicts.add(String(c.code).replace(/[^A-Z_]/g, '').slice(0, 64) || 'MIGRATION_CONFLICT');
      else if (plan.status === 'capability-required') conflicts.add('NATIVE_CAPABILITY_UNSUPPORTED');
      else if (plan.applied) {
        entries = plan.entries;
        details.push('NATIVE_FALLBACK_MIGRATION');
        for (const k of plan.keeps) skips.push({ path: PATCH, op: 'skip', reason: adapter.opaque ? 'ALIAS_STILL_REFERENCED' : k.code, details: [String(k.id)] });
      }
    }
    if (cleanupLegacyFallbacks) {
      const plan = planLegacyFallbackCleanup(entries, { cleanupLegacyFallbacks: true, mainModel });
      if (!plan.ok) {
        for (const c of plan.conflicts) conflicts.add(String(c.code).replace(/[^A-Z_]/g, '').slice(0, 64) || 'CLEANUP_CONFLICT');
        return;
      }
      entries = plan.entries;
      if (plan.applied) details.push('LEGACY_FALLBACK_CLEANUP');
      if (plan.actions.some(a => a.code === 'CLEANUP_MAIN_REWRITTEN')) details.push('MAIN_MODEL_SELECTED');
      if (relayCandidate) {
        const { rel, wanted, current } = relayCandidate;
        const relayIndex = rows.findIndex(row => row.id === 'zstd-render');
        const opaqueRelayFields = relayIndex >= 0 && [['id'], ['name'], ['config', 'upstream']].some(parts => adapter.isOpaqueAt([relayIndex, ...parts]));
        const conflict = relayCleanupConflict(current.hash, rows, opaqueRelayFields, home);
        if (conflict) conflicts.add(conflict);
        else op(rel, 'replace', 'RELAY_FALLBACK_REMOVED', { content: wanted, expected: current.hash, current: current.buf, mode: current.mode, needsAck: true });
      }
    }
    if (seedNativeFallbacks) {
      if (!await nativeCapable(payloadRoot) || conflicts.has('TREE_VERSION_MISMATCH')) conflicts.add('NATIVE_CAPABILITY_UNSUPPORTED');
      else {
        const plan = planFallbackSeeding(entries);
        if (!plan.ok) for (const c of plan.conflicts) conflicts.add(String(c.code).replace(/[^A-Z_]/g, '').slice(0, 64) || 'SEED_CONFIG_CONFLICT');
        else if (plan.applied) { entries = plan.entries; details.push('NATIVE_FALLBACK_SEEDING'); }
      }
    }
    if (same(rows, entries)) return;
    let content;
    try { content = Buffer.from(adapter.render(entries)); } catch { conflicts.add('PATCH_YAML_UNSUPPORTED'); return; }
    op(PATCH, 'replace', 'PROFILE_PATCH_MERGE', { details: [...new Set(details)], content, expected: file.hash, current: file.buf, mode: file.mode });
  });
  return { ops, skips, conflicts, migrate: migrateNativeFallbacks, cleanup: cleanupLegacyFallbacks, mainModel, scope, seed: seedNativeFallbacks };
}

async function buildSlimPlan(home, { payloadRoot, checkEnvironment, migrateNativeFallbacks, seedNativeFallbacks }) {
  await checkHome(home);
  const ops = [], skips = [], conflicts = new Set(), inputs = [];
  const result = { ops, skips, conflicts, inputs, scope: 'slim', seed: seedNativeFallbacks, migrate: migrateNativeFallbacks };
  const capture = async rel => {
    const file = await readDest(home, rel);
    inputs.push({ path: rel, kind: file.exists ? 'file' : 'missing', hash: file.hash });
    return file;
  };
  try {
    if (checkEnvironment) {
      try { const env = await checkEnvironment(); const app = (env?.checks || []).find(c => c.id === 'app'); if (app ? !app.ok : env?.ok === false) conflicts.add('APP_INCOMPATIBLE'); }
      catch { conflicts.add('ENV_CHECK_FAILED'); }
    }
    const manifest = await capture(PKG);
    if (!manifest.exists) { conflicts.add('SLIM_NOT_INSTALLED'); return result; }
    let pkg;
    try { pkg = JSON.parse(manifest.buf.toString('utf8')); } catch { conflicts.add('PACKAGE_UNPARSEABLE'); return result; }
    if (!isObj(pkg) || !isObj(pkg.dependencies) || !Array.isArray(pkg.dsh?.profile?.bundles)) { conflicts.add('SLIM_NOT_INSTALLED'); return result; }
    if (!Object.hasOwn(pkg.dependencies, 'oh-my-dsh-slim') || !pkg.dsh.profile.bundles.includes('oh-my-dsh-slim')) conflicts.add('SLIM_NOT_INSTALLED');
    else if (!validLocalLink(pkg.dependencies['oh-my-dsh-slim'], home, linkTargets['oh-my-dsh-slim'])) conflicts.add('LINK_CONFLICT');
    const linkRel = `${PROFILE}/node_modules/oh-my-dsh-slim`;
    await checkRel(home, linkRel);
    const linkPath = path.join(home, linkRel), stat = await lstatOrNull(linkPath);
    if (!stat) { inputs.push({ path: linkRel, kind: 'missing' }); conflicts.add('SLIM_NOT_INSTALLED'); }
    else if (!stat.isSymbolicLink()) { inputs.push({ path: linkRel, kind: 'other' }); conflicts.add('LINK_CONFLICT'); }
    else {
      const target = await readlink(linkPath);
      inputs.push({ path: linkRel, kind: 'symlink', target });
      if (path.resolve(path.dirname(linkPath), target) !== path.resolve(home, linkTargets['oh-my-dsh-slim'])) conflicts.add('LINK_CONFLICT');
    }
    const patch = await capture(PATCH);
    if (!patch.exists) { conflicts.add('PROFILE_MISSING'); return result; }
    let adapter;
    try { const text = patch.buf.toString('utf8'); if (!Buffer.from(text).equals(patch.buf)) throw Error(); adapter = parsePatch(text); if (!Array.isArray(adapter.rows) || adapter.rows.some(r => !isObj(r))) throw Error(); }
    catch (e) { conflicts.add(e?.code === 'PATCH_YAML_UNSUPPORTED' ? e.code : 'PATCH_UNPARSEABLE'); return result; }
    const root = 'plugins/oh-my-dsh-slim';
    const files = [];
    const walk = async rel => {
      const dir = path.join(payloadRoot, rel);
      const s = await lstat(dir); if (s.isSymbolicLink() || !s.isDirectory()) throw fail('UNSAFE_PAYLOAD');
      for (const name of (await readdir(dir)).sort()) {
        const r = `${rel}/${name}`, full = path.join(payloadRoot, r), st = await lstat(full);
        if (st.isSymbolicLink()) throw fail('UNSAFE_PAYLOAD');
        if (st.isDirectory()) await walk(r);
        else if (st.isFile() && st.size <= MAX_FILE) files.push({ rel: r, full });
        else throw fail('UNSAFE_PAYLOAD');
        if (files.length > 512) throw fail('UNSAFE_PAYLOAD');
      }
    };
    await walk(root);
    const installed = await capture(`.dsh/${root}/package.json`);
    if (!installed.exists) { conflicts.add('SLIM_NOT_INSTALLED'); return result; }
    let current, wanted;
    try { current = JSON.parse(installed.buf.toString('utf8')); wanted = JSON.parse((await readPayload(path.join(payloadRoot, root, 'package.json'))).toString('utf8')); }
    catch { conflicts.add('VERSION_CONFLICT'); return result; }
    if (wanted.name !== 'oh-my-dsh-slim' || wanted.version !== NATIVE_VERSION || current.name !== wanted.name || ![NATIVE_VERSION, '0.8.7'].includes(current.version)) conflicts.add('VERSION_CONFLICT');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'devDependencies', 'bundledDependencies', 'bundleDependencies']) if (!same(current[field] ?? null, wanted[field] ?? null)) conflicts.add('VERSION_CONFLICT');
    for (const file of files) {
      const rel = `.dsh/${file.rel}`, desired = await readPayload(file.full);
      const existing = rel === `.dsh/${root}/package.json` ? installed : await readDest(home, rel);
      if (!existing.exists) ops.push({ path: rel, op: 'create', reason: 'PAYLOAD_MISSING', content: desired, expected: null, mode: 0o644 });
      else if (existing.hash !== sha(desired)) ops.push({ path: rel, op: 'replace', reason: 'PAYLOAD_MODIFIED_MANAGED_FILE', content: desired, expected: existing.hash, current: existing.buf, mode: existing.mode, needsAck: true });
    }
    if (migrateNativeFallbacks || seedNativeFallbacks) {
      const capable = !conflicts.size && await nativeCapable(payloadRoot);
      let entries = adapter.rows;
      const details = [];
      if (!capable) conflicts.add('NATIVE_CAPABILITY_UNSUPPORTED');
      else {
        if (migrateNativeFallbacks) {
          const plan = planFallbackMigration(entries, { migrateNativeFallbacks: true, nativeFallbacksSupported: true, preserveCatalogAliases: adapter.preserveCatalogAliases });
          if (!plan.ok) for (const c of plan.conflicts) conflicts.add(String(c.code).replace(/[^A-Z_]/g, '').slice(0, 64) || 'MIGRATION_CONFLICT');
          else if (plan.status === 'capability-required') conflicts.add('NATIVE_CAPABILITY_UNSUPPORTED');
          else if (plan.applied) { entries = plan.entries; details.push('NATIVE_FALLBACK_MIGRATION'); }
        }
        if (seedNativeFallbacks && !conflicts.size) {
          const plan = planFallbackSeeding(entries);
          if (!plan.ok) for (const c of plan.conflicts) conflicts.add(String(c.code).replace(/[^A-Z_]/g, '').slice(0, 64) || 'SEED_CONFIG_CONFLICT');
          else if (plan.applied) { entries = plan.entries; details.push('NATIVE_FALLBACK_SEEDING'); }
        }
        if (!same(adapter.rows, entries)) {
          try { ops.push({ path: PATCH, op: 'replace', reason: 'PROFILE_PATCH_MERGE', details, content: Buffer.from(adapter.render(entries)), expected: patch.hash, current: patch.buf, mode: patch.mode }); }
          catch { conflicts.add('PATCH_YAML_UNSUPPORTED'); }
        }
      }
    }
  } catch (e) { conflicts.add(['UNSAFE_PATH', 'UNSAFE_PAYLOAD'].includes(e?.code) ? e.code : 'READ_FAILED'); }
  return result;
}

// The payload must be the native-fallback slim tree: exact package identity plus runtime files that carry the schema.
async function nativeCapable(payloadRoot) {
  try {
    const dir = path.join(payloadRoot, 'plugins/oh-my-dsh-slim');
    const pkg = JSON.parse((await readPayload(path.join(dir, 'package.json'))).toString('utf8'));
    if (pkg.name !== 'oh-my-dsh-slim' || pkg.version !== NATIVE_VERSION) return false;
    const has = async (rel, re) => re.test((await readPayload(path.join(dir, rel))).toString('utf8'));
    return await has('lib/config-settings.js', /fallbacks:\s*z\.array/) && await has('preset/config.js', /orchestrator\.fallbacks is unsupported/) && await has('preset/subagent-roles.js', /function buildChain\(/);
  } catch { return false; }
}

function summarize(plan, extra) {
  const conflicts = [...plan.conflicts].sort();
  const actions = [...plan.ops.map(({ path: p, op: o, reason, needsAck, details }) => ({ path: p, op: o, reason, needsAck: !!needsAck, ...(details?.length ? { details } : {}) })), ...plan.skips.map(s => ({ ...s, needsAck: false }))];
  const planHash = sha(JSON.stringify({ ops: plan.ops.map(o => [o.path, o.op, o.expected, o.content ? sha(o.content) : o.target]), skips: plan.skips, conflicts, migrate: !!plan.migrate, cleanup: !!plan.cleanup, mainModel: plan.mainModel ?? null, scope: plan.scope ?? 'all', seed: !!plan.seed, ...(plan.scope === 'slim' ? { inputs: plan.inputs } : {}) }));
  const needsAck = plan.ops.some(o => o.needsAck);
  return { dryRun: extra.dryRun, actions, conflicts, backupPath: extra.backupPath ?? null, requiresRestart: plan.ops.length > 0 && !conflicts.length, requiresAck: needsAck, canApply: !conflicts.length && plan.ops.length > 0, planHash, policy: 'existing-profile-merge; managed payload files replaced only with acknowledgement; extra files, relay workarounds and secrets preserved' };
}

async function ensureDir(home, rel, created) {
  let current = home;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); created.push(current); }
    catch (e) { if (e.code !== 'EEXIST') throw e; const s = await lstat(current); if (s.isSymbolicLink() || !s.isDirectory()) throw fail('UNSAFE_PATH'); }
  }
}

async function transact(home, plan, { afterWrite, now }) {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backups = path.join(home, '.dsh/backups');
  await checkRel(home, '.dsh/backups/x');
  try { await mkdir(backups, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const dir = await mkdtemp(path.join(backups, `installer-update-${stamp}-`));
  await chmod(dir, 0o700);
  await mkdir(path.join(dir, 'files'), { mode: 0o700 });
  const manifest = { version: 1, created: now().toISOString(), files: [] };
  plan.ops.forEach((o, i) => manifest.files.push(o.current ? { path: o.path, mode: o.mode, size: o.current.length, sha256: o.expected, backup: `files/${i}` } : { path: o.path, created: true }));
  for (const [i, o] of plan.ops.entries()) if (o.current) await writeFile(path.join(dir, 'files', String(i)), o.current, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  let stage;
  const done = [], createdDirs = [];
  try {
    stage = await mkdtemp(path.join(home, '.dsh-setup-stage-'));
    for (const [i, o] of plan.ops.entries()) if (o.content) { await writeFile(path.join(stage, String(i)), o.content, { mode: 0o600, flag: 'wx' }); await chmod(path.join(stage, String(i)), o.mode); }
    const written = new Set();
    const checkInputs = async () => {
      for (const input of plan.inputs || []) {
        if (written.has(input.path)) continue;
        try {
          await checkRel(home, input.path);
          if (input.kind === 'symlink') {
            const p = path.join(home, input.path), s = await lstatOrNull(p);
            if (!s?.isSymbolicLink() || await readlink(p) !== input.target) throw fail('STALE_PLAN');
          } else if (input.kind === 'file') {
            if ((await readDest(home, input.path)).hash !== input.hash) throw fail('STALE_PLAN');
          } else if (await lstatOrNull(path.join(home, input.path))) throw fail('STALE_PLAN');
        } catch { throw fail('STALE_PLAN'); }
      }
    };
    for (const [i, o] of plan.ops.entries()) {
      await checkInputs();
      const dest = path.join(home, o.path);
      await checkRel(home, o.path);
      // TOCTOU recheck of the exact precondition just before replacing.
      const stat = await lstatOrNull(dest);
      if (o.op === 'symlink' || o.op === 'create') { if (stat) throw fail('STALE_PLAN'); }
      else if (!stat || (await readDest(home, o.path)).hash !== o.expected) throw fail('STALE_PLAN');
      await ensureDir(home, o.path.split('/').slice(0, -1).join('/'), createdDirs);
      // Creates commit with no-replace link()/symlink() so a raced-in file is never overwritten; only replaces use rename.
      try {
        if (o.op === 'symlink') await symlink(o.target, dest);
        else if (o.op === 'create') await link(path.join(stage, String(i)), dest);
        else await rename(path.join(stage, String(i)), dest);
      } catch (e) { throw e.code === 'EEXIST' ? fail('STALE_PLAN') : e; }
      done.push({ dest, prior: o.current, mode: o.mode });
      written.add(o.path);
      if (afterWrite) await afterWrite(o.path);
    }
    await checkInputs();
  } catch (error) {
    let failed = false;
    for (const item of done.reverse()) {
      try {
        if (!item.prior) await unlink(item.dest);
        else { const tmp = `${item.dest}.dsh-restore-${randomBytes(4).toString('hex')}`; await writeFile(tmp, item.prior, { mode: item.mode, flag: 'wx' }); await rename(tmp, item.dest); }
      } catch { failed = true; }
    }
    for (const d of createdDirs.reverse()) try { await rmdir(d); } catch { failed = true; }
    const code = failed ? 'ROLLBACK_FAILED' : ['UNSAFE_PATH', 'STALE_PLAN'].includes(error?.code) ? error.code : 'UPDATE_FAILED';
    throw fail(code, { backupPath: dir });
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  return dir;
}

// Returns {ok,dryRun,actions:[{path,op,reason}],conflicts:[codes],backupPath,requiresRestart,requiresAck,canApply,planHash,policy}.
// Preview (dryRun) writes nothing, takes no lock and works while the app is running. Apply needs planHash from a preview
// and acknowledgeManagedFiles:true when managed payload files would be replaced.
export async function updateProfile({ home, dryRun = true, planHash, acknowledgeManagedFiles = false, assertStoppedFn = assertStopped, checkEnvironment, payloadRoot = defaultPayload, afterWrite, now = () => new Date(), migrateNativeFallbacks = false, cleanupLegacyFallbacks = false, mainModel, scope = 'all', seedNativeFallbacks = false } = {}) {
  if (!['all', 'slim'].includes(scope) || typeof seedNativeFallbacks !== 'boolean' || (scope === 'slim' && (cleanupLegacyFallbacks === true || Object.hasOwn(arguments[0] ?? {}, 'mainModel')))) throw fail('BAD_UPDATE_OPTIONS');
  if (typeof dryRun !== 'boolean' || typeof migrateNativeFallbacks !== 'boolean' || typeof cleanupLegacyFallbacks !== 'boolean' || (mainModel !== undefined && typeof mainModel !== 'string')) throw fail('INVALID_REQUEST');
  // Opt-in only; the UI must re-send the same choice for preview and apply (it is part of planHash).
  const options = { payloadRoot, checkEnvironment, migrateNativeFallbacks, cleanupLegacyFallbacks, mainModel, scope, seedNativeFallbacks };
  if (dryRun) {
    const plan = await buildPlan(home, options);
    return { ok: true, ...summarize(plan, { dryRun: true }) };
  }
  if (typeof planHash !== 'string' || !/^[0-9a-f]{64}$/.test(planHash)) throw fail('PLAN_REQUIRED');
  await checkHome(home);
  const stopped = await assertStoppedFn(path.join(home, '.dsh'), { home });
  if (!stopped?.ok) throw fail('APP_RUNNING');
  const lock = path.join(home, '.dsh-setup.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (e) { throw fail(e.code === 'EEXIST' ? 'LOCKED' : 'UPDATE_FAILED'); }
  try {
    const plan = await buildPlan(home, options);
    const summary = summarize(plan, { dryRun: false });
    if (summary.planHash !== planHash) throw fail('STALE_PLAN');
    if (summary.conflicts.length) return { ok: false, ...summary };
    if (!plan.ops.length) return { ok: true, ...summary };
    if (summary.requiresAck && acknowledgeManagedFiles !== true) return { ok: false, ...summary, conflicts: ['ACK_REQUIRED'] };
    const backupPath = await transact(home, plan, { afterWrite, now });
    return { ok: true, ...summarize(plan, { dryRun: false, backupPath }) };
  } finally { await rmdir(lock).catch(() => {}); }
}
