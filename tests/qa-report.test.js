import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const generator = fileURLToPath(new URL('../payload/plugins/oh-my-dsh-slim/preset/qa-report.mjs', import.meta.url));

function sample(overrides = {}) {
  return {
    title: 'Вход <QA> & "smoke"',
    surface: 'hybrid',
    summary: "Пройдено с <script>alert('x')</script>",
    environment: { Браузер: 'chromium', Устройство: "iPhone '15'" },
    requirements: [{ requirement: 'Авторизация', status: 'pass', details: 'готово & ок' }],
    scenarios: [{
      name: 'Успешный вход',
      status: 'pass',
      steps: ['Открыть приложение', "Нажать 'Войти'"],
      expected: 'Главный экран',
      actual: 'Главный экран',
      evidence: [{ label: 'снимок', path: 'evidence/shot.png' }],
    }],
    defects: [{
      title: 'Кнопка не отвечает',
      severity: 'high',
      steps: ['Открыть экран входа', 'Нажать Войти'],
      evidence: [{ label: 'лог', path: 'evidence/shot.png' }],
    }],
    rerun: ['npx playwright test'],
    risks: ['нестабильная сеть'],
    ...overrides,
  };
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'evidence'), { recursive: true });
  await mkdir(join(dir, 'out'), { recursive: true });
  await writeFile(join(dir, 'evidence', 'shot.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return dir;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [generator, ...args], { cwd, encoding: 'utf8' });
}

async function render(dir, data, out = 'out/report.html') {
  await writeFile(join(dir, 'data.json'), JSON.stringify(data));
  const result = run(dir, ['data.json', out]);
  return { result, html: result.status === 0 ? await readFile(join(dir, out), 'utf8') : null };
}

test('qa-report writes escaped Russian HTML and refuses overwrite', async t => {
  const dir = await workspace(t);
  const { result: first, html } = await render(dir, sample());
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Report written: out\/report\.html/);
  assert.ok(html);
  assert.match(html, /lang="ru"/);
  assert.match(html, /Гибридное приложение/);
  assert.match(html, /Вход &lt;QA&gt; &amp; &quot;smoke&quot;/);
  assert.match(html, /Пройдено с &lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(html, /iPhone &#39;15&#39;/);
  assert.match(html, /Окружение/);
  assert.match(html, /Итоги/);
  assert.match(html, /Требования/);
  assert.match(html, /Сценарии/);
  assert.match(html, /Дефекты/);
  assert.match(html, /Пройдено/);
  assert.match(html, /Серьёзность: Высокая/);
  assert.doesNotMatch(html, /Оценка готовности/);
  assert.doesNotMatch(html, /<script>alert\('x'\)<\/script>/);
  assert.doesNotMatch(html, />hybrid</);
  const second = run(dir, ['data.json', 'out/report.html']);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /qa-report:/);
  assert.equal(await readFile(join(dir, 'out/report.html'), 'utf8'), html);
});

test('qa-report renders readiness, not_checked, surfaces, and safe anchors', async t => {
  const dir = await workspace(t);
  const data = sample({
    readiness: {
      verdict: 'ready_with_reservations',
      reasons: ['Критичный native-сценарий не проверен', 'Нет полного зелёного покрытия'],
    },
    requirements: [{
      id: 'REQ <1>',
      requirement: 'Авторизация',
      status: 'fail',
      details: 'детали & "ссылки"',
      scenarioIds: ['SCN-MOB', 'SCN-WEB', 'SCN-MISSING'],
    }],
    scenarios: [
      {
        id: 'SCN-MOB',
        name: 'Вход на устройстве',
        status: 'fail',
        surface: 'mobile',
        steps: ['Открыть приложение'],
        expected: 'Главный экран',
        actual: 'Ошибка',
        evidence: [{ label: 'снимок', path: 'evidence/shot.png' }],
      },
      {
        id: 'SCN-WEB',
        name: 'Вход в браузере',
        status: 'not_checked',
        surface: 'web',
        steps: ['Открыть URL'],
        expected: 'Форма входа',
        actual: 'Не запускалось',
      },
    ],
    defects: [{
      id: 'DEF <A>',
      title: 'Кнопка не отвечает',
      severity: 'high',
      scenarioId: 'SCN-MOB',
      requirementId: 'REQ <1>',
      build: 'build-42',
      preconditions: ['Симулятор запущен'],
      steps: ['Нажать Войти'],
      expected: 'Переход на главный экран',
      actual: 'Нет реакции',
      evidence: [{ label: 'лог', path: 'evidence/shot.png' }],
    }],
  });
  const { result, html } = await render(dir, data, 'out/extended.html');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(html);
  const readinessAt = html.indexOf('aria-label="Оценка готовности"');
  const sectionAt = html.indexOf('id="section-1"');
  assert.ok(readinessAt > 0 && sectionAt > readinessAt, 'readiness must appear before sections');
  assert.match(html, /Готовность подтверждена с оговорками/);
  assert.match(html, /Критичный native-сценарий не проверен/);
  assert.match(html, /Не проверено/);
  assert.match(html, /Мобильное приложение/);
  assert.match(html, />Веб</);
  assert.match(html, /id="requirement-1"/);
  assert.match(html, /id="scenario-1"/);
  assert.match(html, /id="scenario-2"/);
  assert.match(html, /href="#scenario-1"/);
  assert.match(html, /href="#scenario-2"/);
  assert.match(html, /href="#requirement-1"/);
  assert.match(html, /REQ &lt;1&gt;/);
  assert.match(html, /DEF &lt;A&gt;/);
  assert.match(html, /SCN-MISSING[\s\S]*\(ссылка не найдена или неоднозначна\)/);
  assert.doesNotMatch(html, /href="[^"]*SCN-MISSING/);
  assert.match(html, /Сборка:<\/strong> build-42/);
  assert.match(html, /Предусловия/);
  assert.match(html, /Симулятор запущен/);
  assert.match(html, /Ожидаемый результат:<\/strong> Переход на главный экран/);
  assert.match(html, /Фактический результат:<\/strong> Нет реакции/);
  assert.match(html, /evidence\/shot\.png/);
});

test('qa-report omits broken links for ambiguous ids', async t => {
  const dir = await workspace(t);
  const data = sample({
    requirements: [
      { id: 'DUP', requirement: 'A', status: 'pass', details: 'x', scenarioIds: ['DUP'] },
      { id: 'DUP', requirement: 'B', status: 'pass', details: 'y' },
    ],
    scenarios: [
      { id: 'DUP', name: 'S1', status: 'pass' },
      { id: 'DUP', name: 'S2', status: 'not_checked', surface: 'web' },
    ],
    defects: [{
      title: 'Связь',
      severity: 'low',
      scenarioId: 'DUP',
      requirementId: 'DUP',
      steps: ['шаг'],
    }],
  });
  const { result, html } = await render(dir, data, 'out/ambiguous.html');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(html);
  assert.match(html, /\(ссылка не найдена или неоднозначна\)/);
  assert.doesNotMatch(html, /href="#requirement-/);
  assert.doesNotMatch(html, /href="#scenario-/);
});

test('qa-report rejects malformed readiness and unknown status', async t => {
  const dir = await workspace(t);
  const badVerdict = await render(dir, sample({ readiness: { verdict: 'ship_it', reasons: ['x'] } }), 'out/bad-verdict.html');
  assert.notEqual(badVerdict.result.status, 0);
  assert.match(badVerdict.result.stderr, /readiness\.verdict is invalid/);
  const emptyReasons = await render(dir, sample({ readiness: { verdict: 'ready', reasons: [] } }), 'out/bad-reasons.html');
  assert.notEqual(emptyReasons.result.status, 0);
  assert.match(emptyReasons.result.stderr, /readiness\.reasons must not be empty/);
  const badStatus = await render(dir, sample({
    scenarios: [{ name: 'X', status: 'maybe' }],
  }), 'out/bad-status.html');
  assert.notEqual(badStatus.result.status, 0);
  assert.match(badStatus.result.stderr, /scenarios\[0\]\.status is invalid/);
  const badSurface = await render(dir, sample({
    scenarios: [{ name: 'X', status: 'pass', surface: 'hybrid' }],
  }), 'out/bad-surface.html');
  assert.notEqual(badSurface.result.status, 0);
  assert.match(badSurface.result.stderr, /scenarios\[0\]\.surface is invalid/);
});

test('qa-report --help prints schema without writing files', async t => {
  const dir = await workspace(t);
  const help = run(dir, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /surface": "mobile" \| "web" \| "hybrid"/);
  assert.match(help.stdout, /not_checked/);
  assert.match(help.stdout, /readiness/);
  assert.match(help.stdout, /<data\.json> <output\.html>/);
});
