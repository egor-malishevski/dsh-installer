'use strict';
/*
 * Запасные модели: чистая логика клиента Slim (client.js) и сквозная передача в установщике (core.js).
 * client.js — ModuleLoader-бандл; здесь он грузится с заглушками React и UI-примитивов.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../core.js');

const CLIENT = path.join(__dirname, '../../payload/plugins/oh-my-dsh-slim/client/client.js');

function loadClient() {
  let mod = null;
  const stub = new Proxy({}, { get: () => () => null });
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { mod = def.factory((name) => (name === 'react' ? { createElement: () => null, useState: () => [], useEffect: () => {}, useRef: () => ({}), Fragment: 'f' } : stub)); } } },
    console,
  };
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox);
  // Объекты из vm-контекста имеют другие прототипы: результаты приводим к обычным значениям.
  const toPlain = (v) => JSON.parse(JSON.stringify(v));
  return {
    ...mod,
    // Остальные поля ролей (enabled и т. д.) здесь не проверяются: только операции с fallbacks.
    planUserOps: (...args) => toPlain(mod.planUserOps(...args)).filter((op) => op.path.includes('fallbacks')),
    fallbackIssues: (...args) => toPlain(mod.fallbackIssues(...args)),
    FALLBACK_ROLE_IDS: toPlain(mod.FALLBACK_ROLE_IDS),
  };
}

const groups = [
  { id: 'cliproxy', name: 'CLIProxy', models: [
    { id: 'a', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
    { id: 'b', reasoning: { efforts: [] } },
    { id: 'c' },
  ] },
];
// Объекты из vm-контекста имеют другие прототипы: сравниваем через JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));
const role = (extra) => ({ enabled: true, provider: 'cliproxy', model: 'a', ...extra });

test('клиент Slim: версия совпадает с package.json', () => {
  let client;
  try { client = loadClient(); } catch (e) { return assert.fail('client.js не загрузился: ' + e.message); }
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(CLIENT), '../package.json'), 'utf8'));
  assert.equal(client.VERSION, pkg.version);
});

test('клиент Slim: проверка запасных маршрутов', () => {
  const c = loadClient();
  const kinds = (r, id) => plain(c.fallbackIssues(id || 'oracle', r, groups).map((i) => i.kind));
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: 'cliproxy', model: 'b' }] })), []);
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: 'cliproxy', model: 'b', effort: 'high' }] })), ['effort'], 'уровень, которого нет у модели');
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: 'cliproxy', model: 'a', effort: 'high' }, { provider: 'cliproxy', model: 'b' }] })), ['primary']);
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: 'cliproxy', model: 'b' }, { provider: 'cliproxy', model: 'b' }] })), ['duplicate']);
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: 'cliproxy', model: undefined }] })), ['half']);
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: undefined, model: 'b' }] })), ['half']);
  const four = ['b', 'c', 'x', 'y'].map((model) => ({ provider: 'cliproxy', model }));
  assert.ok(kinds(role({ fallbacks: four })).includes('tooMany'));
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: 'cliproxy', model: 'b' }] }), 'observer'), [], 'observer не получает запасных');
  assert.deepEqual(kinds(role({ fallbacks: [{ provider: 'cliproxy' }] }), 'councillor-alpha'), []);
});

test('клиент Slim: запись списка целиком, наследование и порядок', () => {
  const c = loadClient();
  const base = { preset: 'p', presets: { p: { oracle: { enabled: true, provider: 'cliproxy', model: 'a' } } } };
  const draftFor = (fallbacks) => {
    const d = c.buildDraft(base, undefined, base, {});
    d.roles.oracle = { ...d.roles.oracle, fallbacks };
    return d;
  };
  const planUserOps = (b, u, d) => plain(c.planUserOps(b, u, d));
  const f1 = [{ provider: 'cliproxy', model: 'b' }, { provider: 'cliproxy', model: 'c', effort: 'low' }];
  const ops = c.planUserOps(base, {}, draftFor(f1));
  assert.deepEqual(ops, [{ op: 'set', path: ['presets', 'p', 'oracle', 'fallbacks'], value: f1 }]);
  // Сохранённый порядок меняется целиком, а не по элементам.
  const user = { presets: { p: { oracle: { fallbacks: f1 } } } };
  const swapped = [f1[1], f1[0]];
  const ops2 = c.planUserOps(base, user, draftFor(swapped));
  assert.deepEqual(ops2, [{ op: 'set', path: ['presets', 'p', 'oracle', 'fallbacks'], value: swapped }]);
  // Без изменений — без операций; пустой список без сохранённого — тоже.
  assert.deepEqual(c.planUserOps(base, user, c.buildDraft(user, undefined, base, user)), []);
  assert.deepEqual(c.planUserOps(base, {}, draftFor([])), []);
  // Очистка сохранённого списка снимает поле.
  assert.deepEqual(c.planUserOps(base, user, draftFor([])), [{ op: 'unset', path: ['presets', 'p', 'oracle', 'fallbacks'] }]);
  // Роль в compact roles остаётся там же; advanced имеет приоритет.
  const compact = { roles: { oracle: { fallbacks: f1 } } };
  assert.deepEqual(c.planUserOps(base, compact, draftFor(swapped)), [{ op: 'set', path: ['roles', 'oracle', 'fallbacks'], value: swapped }]);
  const adv = { advanced: { roles: { oracle: { fallbacks: f1 } } } };
  assert.deepEqual(c.planUserOps(base, adv, draftFor(swapped)), [{ op: 'set', path: ['advanced', 'roles', 'oracle', 'fallbacks'], value: swapped }]);
});

test('клиент Slim: очистка унаследованного непустого списка пишет явный [], а не снимает поле', () => {
  const c = loadClient();
  const shipped = [{ provider: 'cliproxy', model: 'b' }];
  const base = { preset: 'p', presets: { p: { oracle: { enabled: true, provider: 'cliproxy', model: 'a', fallbacks: shipped } } } };
  const draftFor = (user, fallbacks) => {
    const d = c.buildDraft(base, undefined, base, user);
    d.roles.oracle = { ...d.roles.oracle, fallbacks };
    return d;
  };
  // В пользовательском слое поля нет, в пресете список есть: очистка = явный пустой список в слой пользователя.
  assert.deepEqual(c.planUserOps(base, {}, draftFor({}, [])), [{ op: 'set', path: ['presets', 'p', 'oracle', 'fallbacks'], value: [] }]);
  // Тот же результат, если роль лежит в compact roles или в advanced.
  assert.deepEqual(c.planUserOps(base, { roles: { oracle: { model: 'a' } } }, draftFor({ roles: { oracle: { model: 'a' } } }, [])),
    [{ op: 'set', path: ['roles', 'oracle', 'fallbacks'], value: [] }]);
  // Уже сохранённый явный [] остаётся (без лишних операций) и не превращается в наследование.
  const stored = { presets: { p: { oracle: { fallbacks: [] } } } };
  assert.deepEqual(c.planUserOps(base, stored, draftFor(stored, [])), []);
  // Возврат к списку пресета снимает поле: снова наследуется.
  assert.deepEqual(c.planUserOps(base, stored, draftFor(stored, shipped)), [{ op: 'unset', path: ['presets', 'p', 'oracle', 'fallbacks'] }]);
  // Без изменений относительно пресета — ничего не пишется.
  assert.deepEqual(c.planUserOps(base, {}, draftFor({}, shipped)), []);
});

test('клиент Slim: основная модель, роли совета и observer не получают fallbacks', () => {
  const c = loadClient();
  const base = { preset: 'p', presets: { p: {} } };
  const d = c.buildDraft(base, undefined, base, {});
  for (const id of ['observer', 'councillor-alpha', 'council']) {
    d.roles[id] = { ...d.roles[id], fallbacks: [{ provider: 'cliproxy', model: 'b' }] };
  }
  const written = c.planUserOps(base, {}, d).filter((op) => op.path.includes('fallbacks'));
  assert.deepEqual(written, []);
  assert.deepEqual(c.FALLBACK_ROLE_IDS, ['oracle', 'designer', 'fixer', 'explorer', 'librarian']);
});

test('установщик: запасные маршруты сервера доходят до /api/install без потерь', () => {
  const reserves = [{ provider: 'cliproxy', model: 'b', effort: 'low' }, { provider: 'cliproxy', model: 'c' }];
  const cfg = C.buildConfig({
    apiUrl: 'https://x.example', apiKey: 'key-123456',
    roles: {
      oracle: { model: 'cliproxy/a', effort: 'high', fallbacks: reserves },
      fixer: { model: 'cliproxy/a', effort: '', fallbacks: [] },
      designer: { model: 'cliproxy/a', effort: '' },
      orchestrator: { model: '', effort: 'high', fallbacks: reserves },
    },
  });
  assert.deepEqual(cfg.roles.oracle.fallbacks, reserves);
  assert.deepEqual(cfg.roles.fixer.fallbacks, [], 'явный пустой список сохраняется');
  assert.equal('fallbacks' in cfg.roles.designer, false);
  assert.equal('fallbacks' in cfg.roles.orchestrator, false, 'роутер наследует основную модель');
  const review = C.buildReview({ roles: { oracle: { model: 'cliproxy/a', effort: 'high', fallbacks: reserves } } });
  assert.deepEqual(review.roles[0].fallbacks, ['cliproxy/b · low', 'cliproxy/c']);
});
