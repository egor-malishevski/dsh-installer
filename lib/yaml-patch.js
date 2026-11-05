import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('./vendor/yaml/dist/index.js');
const options = { version: '1.2', schema: 'core', merge: false, customTags: false, resolveKnownTags: false, uniqueKeys: true, strict: true, stringKeys: true, keepSourceTokens: true, logLevel: 'error' };
const fail = code => Object.assign(new Error(code), { code });
const invalid = () => { throw fail('PATCH_UNPARSEABLE'); };
const unsupported = () => { throw fail('PATCH_YAML_UNSUPPORTED'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Only project YAML nodes ourselves: never invoke the library's object conversion APIs.
export function parsePatch(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) invalid();
  let json;
  try { json = JSON.parse(source); } catch { /* YAML */ }
  if (json !== undefined) return { rows: json, opaque: false, preserveCatalogAliases: false, render: next => same(json, next) ? source : JSON.stringify(next, null, 2) + '\n' };
  return parseYaml(source);
}

function parseYaml(source) {
  let docs;
  try { docs = yaml.parseAllDocuments(source, options); } catch { invalid(); }
  if (docs.length !== 1 || docs[0].errors.length || /^\s*%/m.test(source)) invalid();
  let count = 0, opaque = false;
  const managed = new Set(['id', 'config', 'roles', 'advanced', 'provider', 'model', 'effort', 'fallbacks', 'providers', 'cliproxy', 'models', 'oracle', 'designer', 'fixer', 'explorer', 'librarian']);
  function project(node, depth, path = []) {
    if (++count > 50000 || depth > 32) invalid();
    if (!node) return null;
    if (yaml.isAlias(node) || node.anchor) invalid();
    if (node.tag) {
      if (!yaml.isScalar(node) || managed.has(path.at(-1))) unsupported();
      opaque = true;
      return String(node.value ?? '');
    }
    if (yaml.isScalar(node)) {
      if (typeof node.value === 'number' && !Number.isFinite(node.value)) invalid();
      if (!['string', 'number', 'boolean'].includes(typeof node.value) && node.value !== null) invalid();
      return node.value;
    }
    if (yaml.isSeq(node)) return node.items.map((v, i) => project(v, depth + 1, [...path, i]));
    if (yaml.isMap(node)) {
      const result = {};
      for (const pair of node.items) {
        const key = pair.key;
        if (!yaml.isScalar(key) || key.tag || key.anchor || typeof key.value !== 'string') invalid();
        const k = key.value;
        if (k === '<<' || k === '__proto__' || k === 'prototype' || k === 'constructor' || own(result, k)) invalid();
        Object.defineProperty(result, k, { value: project(pair.value, depth + 1, [...path, k]), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    invalid();
  }
  const root = docs[0].contents;
  const rows = project(root, 0);
  if (!Array.isArray(rows) || rows.length > 1000 || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) invalid();
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  function render(next) {
    if (same(rows, next)) return source;
    const edits = [];
    const add = (start, end, text) => {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) unsupported();
      edits.push({ start, end, text });
    };
    const lineStart = pos => source.lastIndexOf('\n', pos - 1) + 1;
    function diff(node, before, after, path = []) {
      if (same(before, after)) return;
      if (!node || node.tag) unsupported();
      if (yaml.isScalar(node)) {
        if (path.at(-1) !== 'model' || typeof after !== 'string' || !node.range) unsupported();
        // A multiline scalar can include its header comment inside the value range.
        if (/[\r\n]/.test(source.slice(node.range[0], node.range[1]))) unsupported();
        add(node.range[0], node.range[1], JSON.stringify(after));
        return;
      }
      if (yaml.isSeq(node)) {
        if (path.length === 0 && Array.isArray(after) && after.length === before.length + 1) {
          const index = after.findIndex((row, i) => row?.id === 'agent-preset-registry' && before.every((old, j) => old?.id === after[j < i ? j : j + 1]?.id));
          if (index < 0 || node.flow) unsupported();
          const pos = index < node.items.length ? lineStart(node.items[index].range[0]) : node.range[2];
          if (pos > 0 && source[pos - 1] !== '\n') unsupported();
          add(pos, pos, `- ${JSON.stringify(after[index])}${newline}`);
          for (let i = 0; i < before.length; i++) diff(node.items[i], before[i], after[i < index ? i : i + 1], [i]);
          return;
        }
        if (path.at(-1) === 'models' && before.length === 0 && Array.isArray(after) && node.range) {
          // The collection's value range can contain comments even when it has no items.
          if (source.slice(node.range[0], node.range[1]).includes('#')) unsupported();
          add(node.range[0], node.range[1], JSON.stringify(after));
          return;
        }
        if (Array.isArray(after) && after.length < before.length && path.length === 5 &&
            path[1] === 'config' && path[2] === 'providers' && path[3] === 'cliproxy' && path[4] === 'models' &&
            rows[path[0]]?.id === 'llm-pi-ai') {
          const aliases = new Set(['fallback-main', 'fallback-oracle', 'fallback-designer', 'fallback-fixer', 'fallback-explorer', 'fallback-librarian']);
          const ids = before.map(v => v?.id);
          if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) unsupported();
          if (node.flow) {
            const cst = node.srcToken;
            if (cst?.type !== 'flow-collection' || cst.start?.type !== 'flow-seq-start' ||
                source.slice(node.range[0], node.range[1]).includes('#')) unsupported();
            const safe = n => {
              if (!n || n.tag || n.anchor || n.comment || n.commentBefore || yaml.isAlias(n)) return false;
              if (yaml.isScalar(n)) return !!n.range && !/[\r\n]/.test(source.slice(n.range[0], n.range[1]));
              if (yaml.isSeq(n)) return n.items.every(safe);
              if (yaml.isMap(n)) return n.items.every(p => safe(p.key) && safe(p.value));
              return false;
            };
            const removed = []; let j = 0;
            for (let i = 0; i < before.length; i++) {
              if (j < after.length && same(before[i], after[j])) { j++; removed.push(false); }
              else {
                if (!aliases.has(ids[i]) || !yaml.isMap(node.items[i]) || !safe(node.items[i]) || !node.items[i].range || !cst.items[i]?.value) unsupported();
                removed.push(true);
              }
            }
            if (j !== after.length) unsupported();
            const comma = i => {
              const tokens = cst.items[i]?.start?.filter(t => t.type === 'comma') ?? [];
              if (tokens.length !== 1 || tokens[0].source !== ',') unsupported();
              return tokens[0].offset;
            };
            for (let i = 0; i < removed.length;) {
              if (!removed[i]) { i++; continue; }
              const first = i;
              while (i + 1 < removed.length && removed[i + 1]) i++;
              const last = i++;
              let start = node.items[first].range[0], end = node.items[last].range[1];
              if (last + 1 < before.length) end = comma(last + 1) + 1;
              else if (first > 0) start = comma(first);
              else if (cst.items[before.length]) end = comma(before.length) + 1;
              if (source.slice(start, end).includes('#')) unsupported();
              add(start, end, '');
            }
            return;
          }
          if (node.srcToken?.type !== 'block-seq') unsupported();
          let j = 0;
          for (let i = 0; i < before.length; i++) {
            if (j < after.length && same(before[i], after[j])) { j++; continue; }
            const item = node.items[i], token = node.srcToken.items[i];
            if (!aliases.has(ids[i]) || !yaml.isMap(item) || item.flow || item.commentBefore || (i === 0 && node.commentBefore) || !item.range || token?.value?.type !== 'block-map') unsupported();
            const safeNode = n => {
              if (!n || n.tag || n.anchor || n.comment || n.commentBefore || n.flow || yaml.isAlias(n)) return false;
              if (yaml.isScalar(n)) return !/[\r\n]/.test(source.slice(n.range[0], n.range[1]));
              if (yaml.isSeq(n)) return n.items.every(safeNode);
              if (yaml.isMap(n)) return n.items.every(p => safeNode(p.key) && safeNode(p.value));
              return false;
            };
            if (!safeNode(item)) unsupported();
            const indicators = token.start.filter(t => t.type === 'seq-item-ind');
            if (indicators.length !== 1) unsupported();
            const indicator = indicators[0], start = lineStart(indicator.offset), end = item.range[2];
            const prefix = source.slice(start, indicator.offset);
            if (!/^ *$/.test(prefix) || indicator.indent !== prefix.length ||
                source.slice(indicator.offset, item.range[0]) !== '- ' ||
                (end < source.length && source[end - 1] !== '\n') ||
                /#/.test(source.slice(start, end))) unsupported();
            // Refuse ambiguous whitespace or comment lines within the removed item.
            const lines = source.slice(start, end).split(/\r?\n/);
            if (lines.slice(0, -1).some(line => !line.trim())) unsupported();
            add(start, end, '');
          }
          if (j !== after.length) unsupported();
          return;
        }
        if (!Array.isArray(after) || before.length !== after.length) unsupported();
        before.forEach((v, i) => diff(node.items[i], v, after[i], [...path, i]));
        return;
      }
      if (!yaml.isMap(node) || !after || typeof after !== 'object' || Array.isArray(after)) unsupported();
      const keys = Object.keys(before), added = Object.keys(after).filter(k => !own(before, k));
      if (keys.some(k => !own(after, k)) || added.some(k => !['fallbacks', 'models'].includes(k))) unsupported();
      for (const pair of node.items) diff(pair.value, before[pair.key.value], after[pair.key.value], [...path, pair.key.value]);
      if (!added.length) return;
      if (node.flow) {
        const end = node.range[1];
        if (source[end - 1] !== '}' || source.slice(node.range[0], end).includes('#')) unsupported();
        add(end - 1, end - 1, `${keys.length ? ', ' : ''}${added.map(k => `${JSON.stringify(k)}: ${JSON.stringify(after[k])}`).join(', ')}`);
      } else {
        if (!node.items.length) unsupported();
        const last = node.items.at(-1), start = last.key.range[0], indent = source.slice(lineStart(start), start);
        if (!/^ *$/.test(indent)) unsupported();
        const pos = last.value?.range?.[2] ?? last.key.range[2];
        if (pos > 0 && source[pos - 1] !== '\n') unsupported();
        add(pos, pos, added.map(k => `${indent}${k}: ${JSON.stringify(after[k])}${newline}`).join(''));
      }
    }
    diff(root, rows, next);
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let result = source, limit = source.length;
    for (const e of edits) {
      if (e.end > limit) unsupported();
      result = result.slice(0, e.start) + e.text + result.slice(e.end);
      limit = e.start;
    }
    let check;
    try { check = parseYaml(result); } catch { unsupported(); }
    if (!same(check.rows, next)) unsupported();
    return result;
  }
  return { rows, opaque, preserveCatalogAliases: true, render };
}
