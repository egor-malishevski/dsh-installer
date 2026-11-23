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

test('qa-report writes escaped Russian HTML and refuses overwrite', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'data.json'), JSON.stringify(sample()));
  const first = run(dir, ['data.json', 'out/report.html']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Report written: out\/report\.html/);
  const html = await readFile(join(dir, 'out/report.html'), 'utf8');
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
  assert.doesNotMatch(html, /<script>alert\('x'\)<\/script>/);
  assert.doesNotMatch(html, />hybrid</);
  const second = run(dir, ['data.json', 'out/report.html']);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /qa-report:/);
  assert.equal(await readFile(join(dir, 'out/report.html'), 'utf8'), html);
});

test('qa-report --help prints schema without writing files', async t => {
  const dir = await workspace(t);
  const help = run(dir, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /surface": "mobile" \| "web" \| "hybrid"/);
  assert.match(help.stdout, /<data\.json> <output\.html>/);
});
