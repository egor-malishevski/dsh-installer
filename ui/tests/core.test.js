'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

test('токен читается из фрагмента', () => {
  assert.equal(C.parseFragmentToken('#token=abcdef123456'), 'abcdef123456');
  assert.equal(C.parseFragmentToken('#abcdef123456'), 'abcdef123456');
  assert.equal(C.parseFragmentToken('#x'), '');
  assert.equal(C.parseFragmentToken(''), '');
  assert.equal(C.parseFragmentToken('#token=<script>alert(1)</script>'), '');
});

test('адрес API: проверки', () => {
  assert.equal(C.validateApiUrl('').ok, false);
  assert.equal(C.validateApiUrl('ftp://x.y').ok, false);
  assert.equal(C.validateApiUrl('https://user:pw@x.y').ok, false);
  assert.equal(C.validateApiUrl('https://x.y/?key=1').ok, false);
  assert.equal(C.validateApiUrl('https://x.y').ok, true);
  assert.equal(C.validateApiUrl('http://example.com').ok, false);
  assert.equal(C.validateApiUrl('http://localhost:8317').ok, true);
});

test('маскирование и вычищение секретов', () => {
  assert.equal(C.maskSecret('abc'), C.MASK);
  assert.equal(C.maskSecret(''), '—');
  assert.equal(C.redactSecrets('ключ sk-secret-1 неверен', ['sk-secret-1']), 'ключ ' + C.MASK + ' неверен');
});

test('ошибки сервера нормализуются и не содержат секретов', () => {
  const p = C.normalizeProblems({ status: 400, data: { ok: false, errors: [{ field: 'apiKey', message: 'bad sk-secret-1' }] } }, ['sk-secret-1']);
  assert.equal(p.messages[0].field, 'apiKey');
  assert.ok(!p.messages[0].message.includes('sk-secret-1'));
  const net = C.normalizeProblems({ status: 0, networkError: true }, []);
  assert.match(net.messages[0].message, /локальн/);
});

test('ревью не содержит сырых секретов', () => {
  const mcps = [{ id: 'a', label: 'a', fields: [{ key: 'url', label: 'URL', secret: false }, { key: 'token', label: 'Токен', secret: true }] }];
  const r = C.buildReview({
    apiUrl: 'https://x.y', apiKey: 'sk-secret-1', mcps, selected: ['a'],
    values: { a: { url: 'https://u', token: 'tok-secret-2' } },
    roles: { oracle: { model: 'm', effort: 'high' } },
  });
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes('sk-secret-1'));
  assert.ok(!dump.includes('tok-secret-2'));
  assert.ok(dump.includes('https://u'));
});

test('конфиг включает только выбранные MCP', () => {
  const mcps = [
    { id: 'a', fields: [{ key: 'k' }] },
    { id: 'b', fields: [{ key: 'k' }] },
  ];
  const cfg = C.buildConfig({
    apiUrl: ' https://x.y ', apiKey: ' key ', mcps, selected: ['b'], values: { a: { k: 'zzz' }, b: { k: ' v ' } },
    roles: { r: { model: ' m ', effort: '' } },
  });
  assert.deepEqual(cfg.mcps, [{ id: 'b', values: { k: 'v' } }]);
  assert.deepEqual(cfg.roles, { r: { model: 'm', effort: '' } });
  assert.equal(cfg.apiUrl, 'https://x.y');
  assert.equal(cfg.apiKey, 'key');
});

test('блокировки установки', () => {
  assert.deepEqual(C.installBlockers({ platform: 'darwin', harness: { running: false, pinned: true } }), []);
  assert.ok(C.installBlockers({ harness: { running: true } }).length === 1);
  assert.ok(C.installBlockers({ platform: 'linux' }).length === 1);
  assert.ok(C.installBlockers({ harness: { pinned: false } }).length === 1);
  assert.deepEqual(C.installBlockers(null), []);
});

test('результат установки чистится от секретов', () => {
  const r = C.extractInstallResult({ ok: true, backupPath: '/tmp/b', rollback: { steps: ['s sk-1234'] } }, ['sk-1234']);
  assert.equal(r.backupPath, '/tmp/b');
  assert.ok(!r.rollback.steps[0].includes('sk-1234'));
});

test('MCP-обязательные поля', () => {
  const m = { fields: [{ key: 'a', required: true }, { key: 'b' }] };
  assert.equal(C.missingRequired(m, { a: ' ' }).length, 1);
  assert.equal(C.missingRequired(m, { a: 'x' }).length, 0);
});

test('сообщения сервера переводятся, секреты вычищаются', () => {
  assert.match(C.translateServerText('Quit DeepSeek Harness before installation.'), /Закройте Harness/);
  const p = C.normalizeProblems({ status: 501, data: { ok: false, error: 'Installation is not yet available; no files were changed.' } }, []);
  assert.match(p.messages[0].message, /Файлы не изменены/);
  const b = C.installBlockers({ platform: 'darwin', blockers: ['macOS is required.'] });
  assert.deepEqual(b, ['Установщик работает только на macOS.']);
});

test('группы ролей: main, router, helpers', () => {
  assert.equal(C.roleGroup('main'), 'main');
  assert.equal(C.roleGroup('orchestrator'), 'router');
  assert.equal(C.roleGroup('oracle'), 'helpers');
});

test('окружение: checks → блокировки и строки на русском', () => {
  const env = { ok: false, checks: [{ id: 'uvx', ok: false, message: 'uvx is required and was not found on the target PATH.' }, { id: 'app', ok: true, message: 'x' }] };
  assert.deepEqual(C.installBlockers(env), ['uvx не найден в PATH. Установите его вручную и нажмите «Проверить снова».']);
  assert.equal(C.describeEnvironment(env)[0].tone, 'bad');
  assert.deepEqual(C.installBlockers({ ok: true, checks: [{ id: 'app', ok: true, message: 'x' }] }), []);
});

test('effort только из метаданных модели', () => {
  const e = C.normalizeEfforts({ efforts: { 'a/b': ['low', 'high'] }, models: [{ id: 'c/d', efforts: ['medium'] }] }, {});
  assert.deepEqual(C.effortsFor('a/b', e).list, ['low', 'high']);
  assert.deepEqual(C.effortsFor('c/d', e).list, ['medium']);
  assert.equal(C.effortsFor('zzz', e, ['x']).specific, false);
  assert.deepEqual(C.effortsFor('zzz', e, ['x']).list, []);
});

test('требования MCP: статус из checks, только https-ссылки', () => {
  const reqs = C.normalizeRequirements([{ id: 'uvx' }, { id: 'ob', url: 'http://evil.test', instructions: 'ручная установка' }, { id: 'ok2', url: 'https://example.test/doc' }]);
  assert.equal(reqs[1].url, '');
  assert.equal(reqs[2].url, 'https://example.test/doc');
  const st = C.mcpRequirementStatus({ requires: reqs }, { checks: [{ id: 'uvx', ok: true, message: 'uvx found.' }] });
  assert.equal(st[0].status, 'ok');
  assert.equal(st[1].status, 'unknown');
});

test('каталог: известные подписи переводятся, неизвестные остаются', () => {
  assert.equal(C.translateCatalog('Server URL'), 'Адрес сервера');
  assert.match(C.translateCatalog('Alternative to Bitbucket. Use a token with read permissions as described in the server documentation.'), /Альтернатива Bitbucket/);
  assert.equal(C.translateCatalog('Something New'), 'Something New');
  assert.match(C.translateServerText('GitLab URL must be an HTTPS origin or its /api/v4 endpoint, without credentials, query, or fragment.'), /Адрес GitLab/);
  assert.equal(C.translateServerText('GitLab: Token is required.'), 'GitLab: заполните поле «Токен».');
});

test('поле url: проверяется только форма адреса', () => {
  const m = { fields: [{ key: 'url', label: 'Адрес' }, { key: 'token' }] };
  assert.equal(C.invalidUrlFields(m, { url: 'нет' }).length, 1);
  assert.equal(C.invalidUrlFields(m, { url: 'https://a:b@x.test' }).length, 1);
  assert.equal(C.invalidUrlFields(m, { url: 'https://x.test/api/v4' }).length, 0);
  assert.equal(C.invalidUrlFields(m, { url: '' }).length, 0);
});

test('токен MCP вычищается из сообщений сервера', () => {
  const secrets = C.collectSecrets({ apiKey: 'k-12345678', mcps: [{ id: 'gitlab', fields: [{ key: 'token', secret: true }] }], values: { gitlab: { token: 'glpat-secret-1' } } });
  const p = C.normalizeProblems({ status: 400, data: { error: 'bad glpat-secret-1' } }, secrets);
  assert.ok(!p.messages[0].message.includes('glpat-secret-1'));
});

test('buildConfig: модель роутера и effort main уходят пустыми при любом вводе', () => {
  const cfg = C.buildConfig({
    apiUrl: 'https://x.y', apiKey: 'k', mcps: [], selected: [],
    roles: {
      orchestrator: { model: 'cliproxy/x', effort: 'high' },
      main: { model: 'cliproxy/m', effort: 'high' },
      oracle: { model: 'cliproxy/o', effort: 'low' },
    },
  });
  assert.deepEqual(cfg.roles.orchestrator, { model: '', effort: 'high' });
  assert.deepEqual(cfg.roles.main, { model: 'cliproxy/m', effort: '' });
  assert.deepEqual(cfg.roles.oracle, { model: 'cliproxy/o', effort: 'low' });
});

test('effort: Grok без уровней, данные сервера важнее, смена модели сбрасывает', () => {
  const none = C.normalizeEfforts({}, {});
  assert.equal(C.effortsFor('cliproxy/grok-4.7', none, ['low']).none, true);
  assert.equal(C.effortsFor('cliproxy/claude-x', none, ['low']).none, true);
  // сервер явно прислал уровни для модели — запасное правило не применяется
  const withServer = C.normalizeEfforts({ efforts: { 'cliproxy/grok-9': ['low'] } }, {});
  assert.deepEqual(C.effortsFor('cliproxy/grok-9', withServer).list, ['low']);
  // пустой список от сервера = «уровней нет»
  assert.equal(C.effortsFor('m', C.normalizeEfforts({ efforts: { m: [] } }, {})).none, true);

  const r1 = C.reconcileEffort('cliproxy/grok-4.7', 'medium', none, ['low', 'medium', 'high']);
  assert.deepEqual(r1, { effort: '', reset: true, previous: 'medium', none: true });
  assert.equal(C.reconcileEffort('cliproxy/claude-x', 'medium', none, ['low', 'medium', 'high']).reset, true);
  assert.equal(C.reconcileEffort('cliproxy/claude-x', 'xhigh', none, ['low', 'medium', 'high']).reset, true);
  assert.equal(C.reconcileEffort('anything', '', none).reset, false);
});

test('ревью: роутер наследует модель, main — effort в сессии', () => {
  const r = C.buildReview({ apiUrl: 'https://x.y', apiKey: 'k', mcps: [], selected: [], roles: { orchestrator: { model: '', effort: 'high' }, main: { model: 'cliproxy/m', effort: '' } } });
  assert.equal(r.roles[0].model, 'наследует основную модель');
  assert.equal(r.roles[0].effort, 'high');
  assert.equal(r.roles[1].effort, 'настраивается в сессии');
});

test('ответы установки: 409 blockers, коды отказов, backupPath null', () => {
  const p = C.normalizeProblems({ status: 409, data: { ok: false, code: 'PREFLIGHT_FAILED', error: 'Installation prerequisites are not satisfied.', blockers: ['BLOCKER: Something is missing sk-secret-9'] } }, ['sk-secret-9']);
  assert.equal(p.code, 'PREFLIGHT_FAILED');
  assert.ok(!p.messages[0].message.includes('BLOCKER:') && !p.messages[0].message.includes('sk-secret-9'));
  assert.match(C.normalizeProblems({ status: 409, data: { ok: false, code: 'EXISTING_PROFILE', error: 'Installation could not be completed.' } }, []).messages[0].message, /не перезаписывает/);
  const r = C.extractInstallResult({ ok: true, profilePath: '/h/.dsh/profiles/desktop', backupPath: null, rollback: { instructions: 'Remove the installed profile and installer files only after confirming they are no longer needed.' }, warnings: [] }, []);
  assert.equal(r.backupPath, '');
  assert.match(r.rollback.text, /Удаляйте установленный профиль/);
  assert.equal(r.profilePath, '/h/.dsh/profiles/desktop');
});

test('installBlockers: окружение из bootstrap с необязательными checks', () => {
  // Реальный bootstrap фильтрует uvx/npx/pnpm/cli, checks может быть пустым или отсутствовать.
  assert.deepEqual(C.installBlockers({ ok: true, checks: [], blockers: [], warnings: ['x'] }), []);
  assert.deepEqual(C.installBlockers({ ok: true, blockers: [], warnings: [] }), []);
  assert.deepEqual(C.installBlockers({ ok: true, checks: [{ id: 'node', ok: true, message: 'fine' }] }), []);
  assert.equal(C.installBlockers({ ok: false, checks: [] }).length, 1, 'ok:false без причин всё равно блокирует');
});

test('normalizePreflight: blockers при ok:true, префиксы и секреты', () => {
  const p = C.normalizePreflight({
    ok: true,
    blockers: ['BLOCKER: uvx is required for jira.', 'BLOCKER: Node.js 24 or newer is required for memory. sk-secret-1'],
    warnings: ['WARNING: gitlab may require network access on first launch.'],
    preview: { fileCount: 7, relayPort: 1 },
  }, ['sk-secret-1']);
  assert.equal(p.blockers.length, 2);
  assert.match(p.blockers[0], /«jira»,/);
  assert.ok(p.blockers.every((b) => !/BLOCKER:|sk-secret-1/.test(b)));
  assert.match(p.blockers[0], /uvx нужен/);
  assert.deepEqual(p.tools, ['uvx']);
  assert.match(p.warnings[0], /gitlab при первом запуске/);
  assert.equal(p.fileCount, 7);
  assert.deepEqual(C.normalizePreflight({ ok: true }, []).blockers, []);
  assert.equal(C.normalizePreflight(null, []).fileCount, null);
});

test('обновление: предпросмотр разбирается, применить можно только чистый план с отпечатком', () => {
  const good = C.normalizeUpdatePreview({ ok: true, dryRun: true, planHash: 'hash-12345678', actions: [
    { path: 'a.json', op: 'replace', reason: 'x' }, { path: 'b', op: 'skip' }], conflicts: [], requiresRestart: true }, []);
  assert.equal(good.canApply, true);
  assert.equal(good.changeCount, 1);
  assert.equal(C.normalizeUpdatePreview({ ok: true, actions: [], conflicts: ['USER_MODIFIED'], planHash: 'hash-12345678' }, []).canApply, false);
  assert.equal(C.normalizeUpdatePreview({ ok: true, actions: [], conflicts: [] }, []).canApply, false, 'без planHash');
  assert.equal(C.normalizeUpdatePreview({ ok: true, planHash: 'hash-12345678' }, []).canApply, false, 'без actions');
  assert.equal(C.normalizeUpdatePreview({ ok: false, actions: [], planHash: 'hash-12345678' }, []).canApply, false);
  assert.equal(C.normalizeUpdatePreview({ ok: true, dryRun: false, actions: [], planHash: 'hash-12345678' }, []).canApply, false);
});

test('обновление: тело apply строится только из пригодного плана и подтверждения', () => {
  const p = C.normalizeUpdatePreview({ ok: true, actions: [], conflicts: [], planHash: 'hash-12345678' }, []);
  assert.deepEqual(C.buildUpdateApplyBody(p, true), { dryRun: false, planHash: 'hash-12345678', acknowledgeManagedFiles: true, migrateNativeFallbacks: false });
  assert.equal(C.buildUpdateApplyBody({ ...p, migrateNativeFallbacks: true }, true).migrateNativeFallbacks, true);
  assert.deepEqual(C.buildUpdatePreviewBody(), { dryRun: true, migrateNativeFallbacks: false });
  assert.deepEqual(C.buildUpdatePreviewBody(true), { dryRun: true, migrateNativeFallbacks: true });
  assert.deepEqual(C.buildUpdatePreviewBody('yes'), { dryRun: true, migrateNativeFallbacks: false }, 'только строгий true');
  const options = C.buildUpdatePreviewBody(false, true, 'gpt-6.1-sol');
  assert.deepEqual(options, { dryRun: true, migrateNativeFallbacks: true, cleanupLegacyFallbacks: true, mainModel: 'gpt-6.1-sol' });
  assert.deepEqual(C.buildUpdateApplyBody({ ...p, ...options }, true), { ...options, dryRun: false, planHash: p.planHash, acknowledgeManagedFiles: true });
  assert.throws(() => C.buildUpdatePreviewBody(false, true, 'fallback-main'), /CLEANUP_MAIN_MODEL_INVALID/);
  assert.match(C.normalizeUpdatePreview({ ok: true, actions: [], planHash: 'hash-12345678', warnings: ['NATIVE_FALLBACK_MIGRATION', 'ALIAS_STILL_REFERENCED'] }, []).warnings.join(' '), /перенесены в Oh My DSH Slim[\s\S]*алиас/);
  assert.throws(() => C.buildUpdateApplyBody(p, false), /CONFIRMATION_REQUIRED/);
  assert.throws(() => C.buildUpdateApplyBody(null, true), /PREVIEW_REQUIRED/);
  const bad = C.normalizeUpdatePreview({ ok: true, actions: [], conflicts: ['X'], planHash: 'hash-12345678' }, []);
  assert.throws(() => C.buildUpdateApplyBody(bad, true), /PREVIEW_REQUIRED/);
});

test('обновление: коды ошибок чистятся и не пропускают секреты', () => {
  const r = C.normalizeUpdateProblems({ status: 500, data: { ok: false, code: 'UPDATE_FAILED<b>', error: 'bad sk-secret-1234' } }, ['sk-secret-1234']);
  assert.ok(!/[<>]/.test(r.code));
  assert.ok(!JSON.stringify(r).includes('sk-secret-1234'));
  assert.equal(C.normalizeUpdateProblems({ status: 409, data: { ok: false, code: 'STALE_PLAN' } }, []).stale, true);
  assert.equal(C.extractUpdateResult({ ok: true, backupPath: '/tmp/b', requiresRestart: true, actions: [{ op: 'replace' }, { op: 'skip' }] }, []).applied, 1);
});

test('обновление: сообщения для YAML и сохранённого алиаса', () => {
  const text = (code) => C.normalizeUpdateProblems({ status: 409, data: { code } }, []).messages[0].message;
  assert.equal(text('PATCH_UNPARSEABLE'), 'Не удалось безопасно разобрать профиль. Проверьте синтаксис JSON/YAML.');
  assert.equal(text('PATCH_YAML_UNSUPPORTED'), 'Профиль содержит YAML-конструкции, которые пока нельзя безопасно изменить. Файлы не изменены.');
  const p = C.normalizeUpdatePreview({ ok: true, actions: [{ op: 'skip', path: 'profile.yaml', reason: 'YAML_ALIAS_PRESERVED' }], conflicts: ['PATCH_YAML_UNSUPPORTED'], planHash: 'hash-12345678' }, []);
  assert.match(p.actions[0].reason, /алиасы моделей специалистов.*ссылок и комментариев/);
  assert.match(p.conflicts[0].text, /YAML-конструкции/);
  assert.equal(p.canApply, false);
});

test('обновление: реальные коды API получают русский текст', () => {
  const codes = ['PROFILE_MISSING', 'PIN_CONFLICT', 'LINK_CONFLICT', 'UNEXPECTED_LOCK', 'APP_INCOMPATIBLE', 'ENV_CHECK_FAILED',
    'PACKAGE_UNPARSEABLE', 'PACKAGE_SHAPE', 'PATCH_UNPARSEABLE', 'PATCH_SHAPE', 'PATCH_ENTRY_MISSING', 'DUPLICATE_ENTRY',
    'UNSAFE_PATH', 'UNSAFE_PAYLOAD', 'READ_FAILED', 'APP_RUNNING', 'LOCKED'];
  for (const code of codes) {
    const r = C.normalizeUpdateProblems({ status: 409, data: { ok: false, code, error: 'raw english' } }, []);
    assert.equal(r.code, code);
    assert.match(r.messages[0].message, /[А-Яа-я]/, code);
    assert.ok(!/raw english/.test(r.messages[0].message), code);
    const prev = C.normalizeUpdatePreview({ ok: true, actions: [], conflicts: [code], planHash: 'hash-12345678' }, []);
    assert.equal(prev.canApply, false);
    if (code !== 'LOCKED') assert.match(prev.conflicts[0].text, /[А-Яа-я]/, 'конфликт ' + code);
  }
});
