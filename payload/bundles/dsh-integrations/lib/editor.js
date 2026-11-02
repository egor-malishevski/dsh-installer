import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const FIELDS = ['command', 'args', 'cwd', 'toolCallTimeoutMs'];
const MODULES = new Set(['@deepseek-ai/dsh-mcp-client', 'dsh-integrations/mcp-client']);
const SERVERS = new Set(['mcp-obscura', 'mcp-bitbucket', 'mcp-gitlab', 'mcp-kibana', 'mcp-jira', 'mcp-confluence', 'mcp-sequential-thinking', 'mcp-memory', 'mcp-google-sheets', 'mcp-figma', 'mcp-context7']);
const secret = /(?:token|secret|password|passwd|api[_-]?key|authorization|bearer|credential|private[_-]?key|:\/\/[^\s/]*@|[?&](?:key|auth|signature)=|\$\{|\b[A-Za-z0-9_-]{40,}\b)/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

// The parser never converts tagged values to JavaScript objects or evaluates them.
function parse(yaml, bytes) {
  const doc = yaml.parseDocument(bytes.toString('utf8'), { uniqueKeys: true, merge: false, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: text => text }] });
  if (doc.errors.length || !yaml.isSeq(doc.contents)) fail('INVALID_DOCUMENT');
  function check(node) {
    if (!node) return;
    if (yaml.isAlias(node) || node.anchor) fail('UNSUPPORTED_DOCUMENT');
    if (yaml.isMap(node)) for (const pair of node.items) {
      if (!yaml.isScalar(pair.key) || pair.key.value === '<<') fail('UNSUPPORTED_DOCUMENT');
      check(pair.key); check(pair.value);
    }
    else if (yaml.isSeq(node)) for (const item of node.items) check(item);
  }
  check(doc.contents);
  return doc;
}

function rows(yaml, doc) {
  const result = new Map();
  const ids = new Set();
  for (const operation of doc.contents.items) {
    if (!yaml.isMap(operation)) fail('INVALID_DOCUMENT');
    const insert = operation.get('insert', true);
    if (insert === undefined) continue;
    if (!yaml.isSeq(insert)) fail('INVALID_DOCUMENT');
    for (const row of insert.items) {
      if (!yaml.isMap(row)) fail('INVALID_DOCUMENT');
      const id = row.get('id');
      if (typeof id !== 'string' || ids.has(id)) fail('AMBIGUOUS_ID');
      ids.add(id);
      if (!SERVERS.has(id)) continue;
      if (!MODULES.has(row.get('name'))) fail('INVALID_DOCUMENT');
      const config = row.get('config', true);
      if (!yaml.isMap(config) || config.tag) continue;
      if (config.get('transport') !== 'stdio') continue;
      result.set(id, config);
    }
  }
  return result;
}

function field(yaml, config, name) {
  const node = config.get(name, true);
  if (!node || node.tag || !node.range) return undefined;
  if (name === 'args') {
    if (!yaml.isSeq(node) || node.items.some(n => !yaml.isScalar(n) || n.tag || typeof n.value !== 'string' || secret.test(n.value))) return undefined;
    return node.items.map(n => n.value);
  }
  if (!yaml.isScalar(node)) return undefined;
  if (name === 'toolCallTimeoutMs') return typeof node.value === 'number' && Number.isFinite(node.value) ? node.value : undefined;
  return typeof node.value === 'string' && !secret.test(node.value) ? node.value : undefined;
}

function valid(name, value) {
  if (name === 'toolCallTimeoutMs') return typeof value === 'number' && Number.isFinite(value);
  if (name === 'args') return Array.isArray(value) && value.length <= 128 && value.every(s => typeof s === 'string' && s.length <= 4096 && !secret.test(s));
  return typeof value === 'string' && value.length <= 4096 && !secret.test(value) && (name !== 'command' || value.length > 0);
}

export function createEditor({ path, recoveryDir, yaml, atomic, getHmr, isActive }) {
  async function read() {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) fail('UNSAFE_PATH');
    const bytes = await readFile(path);
    return { bytes, revision: hash(bytes), doc: parse(yaml, bytes) };
  }
  const gate = () => { const h = getHmr(); return h && typeof h.runExclusive === 'function' && typeof h.reconcileProfile === 'function' ? h : undefined; };
  async function describe() {
    try {
      const state = await read();
      const entries = [...rows(yaml, state.doc)].map(([id, config]) => {
        const fields = {}; const protectedFields = [];
        for (const key of FIELDS) { const value = field(yaml, config, key); if (value === undefined) protectedFields.push(key); else fields[key] = value; }
        const canSave = !!gate() && isActive(id, fields) && Object.keys(fields).length > 0;
        return { id, fields, protectedFields, canSave, gate: canSave ? 'available' : 'inactive_or_restart_required' };
      });
      const canSave = entries.some(entry => entry.canSave);
      return { ok: true, revision: state.revision, entries, canSave, gate: canSave ? 'available' : 'inactive_or_restart_required' };
    } catch { return { ok: false, code: 'UNAVAILABLE' }; }
  }
  async function statusRows() {
    const state = await read();
    return [...rows(yaml, state.doc)].map(([id, config]) => {
      const value = config.get('serverName');
      return { id, serverName: typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : '' };
    });
  }
  async function mutate(payload, signal) {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !['serverId', 'expectedRevision', 'patch'].includes(k)) || typeof payload.serverId !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expectedRevision) || !payload.patch || typeof payload.patch !== 'object' || Array.isArray(payload.patch)) fail('INVALID_REQUEST');
      const keys = Object.keys(payload.patch);
      if (keys.some(k => !FIELDS.includes(k) || !valid(k, payload.patch[k]))) fail('INVALID_REQUEST');
      const hmr = gate();
      if (!hmr) fail('RESTART_REQUIRED');
      return await hmr.runExclusive(() => atomic.withFileLock(path, async () => {
        signal?.throwIfAborted();
        const state = await read();
        if (state.revision !== payload.expectedRevision) fail('CONFLICT');
        const config = rows(yaml, state.doc).get(payload.serverId);
        if (!config) fail('UNKNOWN_SERVER');
        const previous = {};
        for (const key of FIELDS) { const value = field(yaml, config, key); if (value !== undefined) previous[key] = value; }
        if (!isActive(payload.serverId, previous)) fail('RESTART_REQUIRED');
        const replacements = [];
        for (const key of keys) {
          const old = field(yaml, config, key);
          if (old === undefined) fail('PROTECTED_FIELD');
          if (JSON.stringify(old) === JSON.stringify(payload.patch[key])) continue;
          const node = config.get(key, true);
          const rendered = yaml.stringify(payload.patch[key], { flowCollectionPadding: false, collectionStyle: 'flow', lineWidth: 0 }).trimEnd();
          replacements.push({ start: node.range[0], end: node.range[1], rendered });
        }
        if (!replacements.length) return { ok: true, changed: false, revision: state.revision };
        let text = state.bytes.toString('utf8');
        for (const r of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start) + r.rendered + text.slice(r.end);
        const next = Buffer.from(text);
        const nextConfig = rows(yaml, parse(yaml, next)).get(payload.serverId);
        if (!nextConfig || keys.some(k => JSON.stringify(field(yaml, nextConfig, k)) !== JSON.stringify(payload.patch[k]))) fail('INVALID_DOCUMENT');
        await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
        const dir = await lstat(recoveryDir);
        if (!dir.isDirectory() || dir.isSymbolicLink() || await realpath(recoveryDir) !== recoveryDir) fail('UNSAFE_PATH');
        await chmod(recoveryDir, 0o700);
        const backup = join(recoveryDir, `recovery-${randomUUID()}.yml`);
        await atomic.writeFileAtomic(backup, state.bytes, { mode: 0o600, dirMode: 0o700 });
        signal?.throwIfAborted();
        if ((await read()).revision !== state.revision) fail('CONFLICT');
        await atomic.writeFileAtomic(path, next, { mode: 0o600 });
        try {
          const activation = await hmr.reconcileProfile([payload.serverId]);
          if (activation.restartReason || activation.pending?.length || activation.warnings?.length || !isActive(payload.serverId, payload.patch)) fail('ACTIVATION_FAILED');
          return { ok: true, changed: true, revision: hash(next) };
        } catch {
          try {
            if (hash(await readFile(path)) !== hash(next)) return { ok: false, code: 'RECOVERY_UNCERTAIN' };
            await atomic.writeFileAtomic(path, state.bytes, { mode: 0o600 });
            const restored = await hmr.reconcileProfile([payload.serverId]);
            if (restored.restartReason || restored.pending?.length || restored.warnings?.length || !isActive(payload.serverId, previous)) throw new Error('restore failed');
            return { ok: false, code: 'ACTIVATION_ROLLED_BACK', effects: 'uncertain' };
          } catch { return { ok: false, code: 'RECOVERY_UNCERTAIN' }; }
        }
      }, { signal, waitMs: 10000 }));
    } catch (error) {
      const codes = ['INVALID_REQUEST', 'RESTART_REQUIRED', 'CONFLICT', 'UNKNOWN_SERVER', 'PROTECTED_FIELD', 'INVALID_DOCUMENT', 'AMBIGUOUS_ID', 'UNSUPPORTED_DOCUMENT', 'UNSAFE_PATH'];
      return { ok: false, code: codes.includes(error?.code) ? error.code : 'UNAVAILABLE' };
    }
  }
  return { describe, mutate, statusRows };
}
