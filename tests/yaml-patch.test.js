import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch } from '../lib/yaml-patch.js';

test('block edits preserve comments, opaque tags, unicode and CRLF', () => {
  const source = '# top\r\n- id: oh-my-dsh-slim\r\n  config:\r\n    roles:\r\n      fixer:\r\n        provider: cliproxy\r\n        model: fallback-fixer # inline\r\n        note: !!js/function "throw new Error(\'oops\')" # сохранить\r\n# end\r\n';
  const p = parsePatch(source);
  assert.equal(p.opaque, true);
  const next = structuredClone(p.rows);
  next[0].config.roles.fixer.model = 'new-model';
  next[0].config.roles.fixer.fallbacks = [{ provider: 'cliproxy', model: 'reserve' }];
  const out = p.render(next);
  assert.match(out, /model: "new-model" # inline/);
  assert.ok(out.includes('note: !!js/function "throw new Error(\'oops\')" # сохранить\r\n'));
  assert.ok(out.includes('# end\r\n'));
  assert.deepEqual(parsePatch(out).rows, next);
  assert.equal(parsePatch(out).render(next), out);
});

test('registry insertion and flow role addition', () => {
  const source = '- id: llm-pi-ai\n  config: {providers: {cliproxy: {models: []}}}\n- id: oh-my-dsh-slim\n  config: {roles: {fixer: {provider: cliproxy, model: fallback-fixer}}}\n';
  const p = parsePatch(source), next = structuredClone(p.rows);
  next[0].config.providers.cliproxy.models = [{ id: 'a' }];
  next[1].config.roles.fixer.model = 'primary';
  next[1].config.roles.fixer.fallbacks = [{ model: 'reserve' }];
  next.splice(1, 0, { id: 'agent-preset-registry', config: {} });
  const out = p.render(next);
  assert.deepEqual(parsePatch(out).rows, next);
});

test('empty catalogue with an internal comment is never overwritten', () => {
  const source = '- id: llm-pi-ai\n  config: {providers: {cliproxy: {models: [ # MUST_KEEP\n        ]}}}\n';
  const p = parsePatch(source), next = structuredClone(p.rows);
  next[0].config.providers.cliproxy.models = [{ id: 'a' }];
  assert.throws(() => p.render(next), { code: 'PATCH_YAML_UNSUPPORTED' });
  assert.equal(p.render(p.rows), source);
});

test('multiline model scalar with header comment is never overwritten', () => {
  const source = '- id: oh-my-dsh-slim\n  config:\n    roles:\n      fixer:\n        model: >- # MUST_KEEP\n          fallback-fixer\n';
  const p = parsePatch(source), next = structuredClone(p.rows);
  next[0].config.roles.fixer.model = 'primary';
  assert.throws(() => p.render(next), { code: 'PATCH_YAML_UNSUPPORTED' });
  assert.equal(p.render(p.rows), source);
});

test('block catalogue cleanup preserves all other bytes', () => {
  const aliases = ['fallback-main', 'fallback-oracle', 'fallback-designer', 'fallback-fixer', 'fallback-explorer', 'fallback-librarian'];
  for (const newline of ['\n', '\r\n']) for (const finalNewline of [true, false]) {
    const lines = ['# верх', '- id: llm-pi-ai', '  config:', '    providers:', '      cliproxy:', '        models:',
      ...aliases.slice(0, 3).flatMap(id => [`          - id: ${id}`, '            name: alias']),
      '          # retain this comment', '          - id: real-модель', '            name: custom',
      ...aliases.slice(3).flatMap(id => [`          - id: ${id}`, '            name: alias']),
      '          - id: custom', '            name: keep'];
    const source = lines.join(newline) + (finalNewline ? newline : '');
    for (const removed of [[aliases[0]], [aliases[2]], [aliases[5]], aliases]) {
      const p = parsePatch(source), next = structuredClone(p.rows);
      next[0].config.providers.cliproxy.models = next[0].config.providers.cliproxy.models.filter(x => !removed.includes(x.id));
      const expected = lines.filter((line, i) => !removed.some(id => line === `          - id: ${id}` || (line === '            name: alias' && lines[i - 1] === `          - id: ${id}`))).join(newline) + (finalNewline ? newline : '');
      const out = p.render(next);
      assert.equal(out, expected);
      assert.deepEqual(parsePatch(out).rows, next);
      assert.equal(parsePatch(out).render(next), out);
    }
  }
});

test('catalogue cleanup refuses comments, flow and unintended changes', () => {
  const prefix = '- id: llm-pi-ai\n  config:\n    providers:\n      cliproxy:\n        models:\n';
  for (const items of [
    '          - id: fallback-main # keep\n          - id: real\n',
    '          # attached\n          - id: fallback-main\n          - id: real\n',
    '          - {id: fallback-main}\n          - id: real\n',
    '          - id: fallback-main\n            note: !!custom hi\n          - id: real\n',
  ]) {
    const p = parsePatch(prefix + items), next = structuredClone(p.rows);
    next[0].config.providers.cliproxy.models.shift();
    assert.throws(() => p.render(next), { code: 'PATCH_YAML_UNSUPPORTED' });
  }
  const p = parsePatch(prefix + '          - id: fallback-main\n          - id: real\n          - id: custom\n');
  for (const models of [[{ id: 'fallback-main' }, { id: 'custom' }], [{ id: 'custom' }, { id: 'real' }]]) {
    const next = structuredClone(p.rows); next[0].config.providers.cliproxy.models = models;
    assert.throws(() => p.render(next), { code: 'PATCH_YAML_UNSUPPORTED' });
  }
});

test('flow catalogue cleanup preserves nested values and outside bytes', () => {
  const aliases = ['fallback-main', 'fallback-oracle', 'fallback-designer', 'fallback-fixer', 'fallback-explorer', 'fallback-librarian'];
  for (const nl of ['\n', '\r\n']) for (const trailing of ['', ',']) for (const eof of ['', nl]) {
    const values = [aliases[0], aliases[1], 'real', aliases[2], aliases[3], 'custom', aliases[4], aliases[5]]
      .map(id => `{id: ${id}, meta: {list: ["a,b", "}тест"], enabled: true}}`);
    const source = `- id: llm-pi-ai${nl}  config:${nl}    providers:${nl}      cliproxy:${nl}        models: [${nl}          ${values.join(',' + nl + '          ')}${trailing}${nl}        ]${nl}- id: other${nl}  note: !!js/function "do nothing"${eof}`;
    for (const selected of [[aliases[0]], [aliases[2]], [aliases[5]], aliases]) {
      const p = parsePatch(source), next = structuredClone(p.rows);
      next[0].config.providers.cliproxy.models = next[0].config.providers.cliproxy.models.filter(v => !selected.includes(v.id));
      const out = p.render(next);
      assert.deepEqual(parsePatch(out).rows, next);
      assert.equal(parsePatch(out).render(next), out);
      assert.ok(out.includes('note: !!js/function "do nothing"'));
      for (const value of values) assert.equal(out.includes(value), !selected.some(id => value.startsWith(`{id: ${id},`)));
    }
  }
});

test('flow catalogue refuses comments and tagged removed items', () => {
  for (const value of ['[{id: fallback-main}, # comment\n    {id: real}]', '[{id: fallback-main, note: !!custom hi}, {id: real}]']) {
    const source = `- id: llm-pi-ai\n  config: {providers: {cliproxy: {models: ${value}}}}\n`;
    const p = parsePatch(source), next = structuredClone(p.rows);
    next[0].config.providers.cliproxy.models.shift();
    assert.throws(() => p.render(next), { code: 'PATCH_YAML_UNSUPPORTED' });
    assert.equal(p.render(p.rows), source);
  }
});

test('dangerous YAML is refused without exposing input', () => {
  for (const source of ['- id: &a x\n  v: *a\n', '- id: x\n  <<: {}\n', '- id: x\n  id: y\n', '- id: x\n---\n- id: y\n', '- id: x\n  __proto__: {}\n', '- id: !!js/function evil\n', '- id: x\n  config: !!js/function evil\n']) {
    assert.throws(() => parsePatch(source), e => /^PATCH_(UNPARSEABLE|YAML_UNSUPPORTED)$/.test(e.code) && e.message === e.code);
  }
  const deep = '- id: x\n  value: ' + '['.repeat(35) + 'x' + ']'.repeat(35) + '\n';
  assert.throws(() => parsePatch(deep), { code: 'PATCH_UNPARSEABLE' });
});
