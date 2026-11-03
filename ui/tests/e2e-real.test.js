'use strict';
/*
 * Сквозная проверка мастера на НАСТОЯЩЕМ server.js (без макета) во временном HOME.
 * Окружение подменено заглушкой inspectEnvironmentFn (проходит проверки, пути рантайма
 * указывают на /usr/bin/true), assertStoppedFn разрешает установку. Ни DSH, ни MCP не запускаются,
 * к моделям и сети никто не обращается. Реальный ~/.dsh не затрагивается.
 * Секретные поля не фотографируются: скриншотов в тесте нет.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let chromium = null;
for (const p of [process.env.DSH_PLAYWRIGHT_PATH, 'playwright', 'playwright-core']) {
  if (!p) continue;
  try { chromium = require(p).chromium; if (chromium) break; } catch (_) { /* следующий */ }
}

async function launch() {
  const existsSync = require('node:fs').existsSync;
  try { return await chromium.launch(); } catch (_) { /* запасной вариант */ }
  const list = [process.env.DSH_CHROMIUM_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const executablePath of list.filter((p) => p && existsSync(p))) {
    try { return await chromium.launch({ executablePath }); } catch (_) { /* следующий */ }
  }
  return null;
}

const API_KEY = 'sk-e2e-FIXTURE-key-0001';
const GITLAB_TOKEN = 'glpat-e2e-FIXTURE-0002';
const GITLAB_URL = 'https://gitlab.example.test';

function fakeEnvironment({ uvx = false } = {}) {
  return async () => ({
    ok: true,
    blockers: [],
    warnings: [],
    checks: [
      { id: 'platform', ok: true, message: 'macOS detected.' },
      { id: 'app', ok: true, message: 'Supported DeepSeek Harness app verified.' },
      { id: 'node', ok: true, message: 'Bundled Node.js 20 or newer verified.' },
    ],
    // /usr/bin/true только проходит проверку X_OK, ничего не запускается.
    runtimePaths: { npx: '/usr/bin/true', ...(uvx ? { uvx: '/usr/bin/true' } : {}), nodeVersion: '24.0.0', npxPath: '/usr/bin:/bin' },
  });
}

async function walk(dir, base = dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(path.relative(base, full) + (e.isSymbolicLink() ? ' -> ' + await fs.readlink(full) : ''));
  }
  return out.sort();
}

async function setup(t, envOptions) {
  const { createServer } = await import('../../server.js');
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-e2e-')));
  const token = 'e2e-capability-' + Math.random().toString(16).slice(2);
  const inst = createServer({ home, token, inspectEnvironmentFn: fakeEnvironment(envOptions), assertStoppedFn: async () => ({ ok: true }), discoveryModelsFn: async () => [{ id: 'claude-opus-5-5', name: 'Claude', input: ['text', 'image'], reasoningEfforts: ['low', 'medium', 'high'] }] });
  await new Promise((resolve) => inst.server.listen(0, '127.0.0.1', resolve));
  const browser = await launch();
  t.after(async () => {
    if (browser) await browser.close();
    await new Promise((resolve) => inst.server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  return { inst, home, token, browser };
}

async function realHomeMarker() {
  try { const s = await fs.stat(path.join(os.homedir(), '.dsh')); return s.mtimeMs; } catch (_) { return null; }
}

async function toReview(page, ctx, { gitlab = false, jira = false } = {}) {
  await page.goto(ctx.inst.origin + '/#token=' + ctx.token);
  await page.waitForSelector('#panelTitle');
  assert.equal(await page.evaluate(() => location.hash), '', 'фрагмент с токеном очищен');
  await page.check('#tutorial-skip');
  await page.click('#btn-next');
  await page.fill('#apiUrl', 'https://proxy.example.test');
  await page.fill('#apiKey', API_KEY);
  await page.click('#btn-validate');
  await page.waitForSelector('#validation-status .callout--ok');
  await page.click('#btn-next');
  await page.waitForSelector('#mcp-counter');
  assert.equal(await page.locator('input[type=checkbox]:checked').count(), 0, 'по умолчанию MCP не выбраны');
  if (gitlab) {
    await page.check('#mcp-gitlab');
    await page.fill('#mcp-gitlab-url', GITLAB_URL);
    await page.fill('#mcp-gitlab-token', GITLAB_TOKEN);
  }
  if (jira) {
    await page.check('#mcp-jira');
    await page.fill('#mcp-jira-url', 'https://jira.example.test');
    await page.fill('#mcp-jira-token', 'jira-e2e-FIXTURE-0003');
  }
  await page.click('#btn-next');
  await page.waitForSelector('#model-oracle');
  await page.click('#btn-next'); // роли — значения по умолчанию из bootstrap
  assert.equal(await page.locator('#errsum').count(), 0, 'значения по умолчанию проходят проверку');
  await page.waitForSelector('#btn-install');
  await page.waitForFunction(() => !document.querySelector('#rv-preflight + .loading'), null, { timeout: 15000 });
}

function assertNoSecrets(text, list) {
  for (const s of list) assert.ok(!text.includes(s), 'секрет не должен быть в странице');
}

test('E2E: без MCP — настоящий server.js записывает файлы, UI говорит правду', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const before = await realHomeMarker();
  const ctx = await setup(t);
  if (!ctx.browser) return t.skip('Chromium не установлен');
  const page = await ctx.browser.newPage({ viewport: { width: 1200, height: 900 } });
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith(ctx.inst.origin)) external.push(r.url()); });

  await toReview(page, ctx);
  await page.waitForSelector('#preflight-ok');
  const review = await page.locator('#panel').innerText();
  assert.match(review, /Блокировок нет\. Будет записано файлов: \d+/);
  assertNoSecrets(review, [API_KEY]);
  assert.equal(await page.isDisabled('#btn-install'), false);
  const planned = Number(/Будет записано файлов: (\d+)/.exec(review)[1]);

  // до установки на диске пусто
  assert.deepEqual(await fs.readdir(ctx.home), []);

  await page.click('#btn-install');
  await page.waitForSelector('#h-backup');
  const done = await page.locator('#panel').innerText();
  assertNoSecrets(done, [API_KEY]);
  assert.match(done, /Файлы профиля записаны/);
  assert.ok(done.includes(path.join(ctx.home, '.dsh/profiles/desktop')), 'путь профиля — из ответа сервера');
  assert.match(done, /Резервная копия не создавалась/);
  assert.match(done, /Вход и авторизации выполняются вручную/);
  assert.match(done, /Удаляйте установленный профиль/);
  assert.ok(!/подключен|резервная копия сохранена|сохранены здесь/i.test(done), 'нет ложных заверений');
  assert.ok(!/\b(null|undefined|\[object)/.test(done));
  assert.equal(await page.locator('#no-backup').count(), 1);

  // что реально записано
  const files = await walk(path.join(ctx.home, '.dsh'));
  t.diagnostic('записано файлов: ' + files.length + ' (по плану ' + planned + ', включая 2 symlink)');
  assert.equal(await fs.readFile(path.join(ctx.home, '.dsh/secrets/installer/cliproxy-key'), 'utf8'), API_KEY + '\n');
  assert.ok(files.some((f) => f.startsWith('profiles/desktop/cordis.patch.yml')));
  assert.equal(await fs.readlink(path.join(ctx.home, '.dsh/profiles/desktop/node_modules/dsh-integrations')), '../../../bundles/dsh-integrations');
  assert.ok(!files.some((f) => f.includes('gitlab-token')), 'без выбора MCP токенов MCP нет');
  assert.equal(files.length, planned, 'на диске ровно столько записей (файлы и symlink), сколько обещал план');
  const patch = await fs.readFile(path.join(ctx.home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8');
  assert.ok(!patch.includes(API_KEY), 'ключа нет в профиле: он только в файле секрета');

  // повторная установка в тот же HOME отказывает и ничего не трогает
  const page2 = await ctx.browser.newPage();
  await toReview(page2, ctx);
  await page2.click('#btn-install');
  await page2.waitForSelector('#install-errors');
  assert.match(await page2.textContent('#install-errors'), /не перезаписывает|уже существует/);
  assert.equal(await fs.readFile(path.join(ctx.home, '.dsh/secrets/installer/cliproxy-key'), 'utf8'), API_KEY + '\n');
  assert.equal(await page2.locator('#h-backup').count(), 0, 'экран «готово» не показан');

  assert.deepEqual(external, [], 'внешних запросов нет');
  assert.equal(await realHomeMarker(), before, 'реальный ~/.dsh не изменён');
});

test('E2E: GitLab с тестовыми данными — токен только в файле секрета', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const ctx = await setup(t);
  if (!ctx.browser) return t.skip('Chromium не установлен');
  const page = await ctx.browser.newPage();
  await toReview(page, ctx, { gitlab: true });
  await page.waitForSelector('#preflight-ok');
  const review = await page.locator('#panel').innerText();
  assertNoSecrets(review, [API_KEY, GITLAB_TOKEN]);
  assert.ok(review.includes('gitlab.example.test'));
  // GitLab из npx даёт предупреждение «может скачиваться из сети при первом запуске»
  assert.match(await page.textContent('#preflight-warnings'), /при первом запуске/);
  assert.ok(!(await page.textContent('#panel')).includes('WARNING:'));

  await page.click('#btn-install');
  await page.waitForSelector('#h-backup');
  const done = await page.locator('#panel').innerText();
  assertNoSecrets(done, [API_KEY, GITLAB_TOKEN]);
  assertNoSecrets(await page.locator('#panel').innerHTML(), [API_KEY, GITLAB_TOKEN]);
  assert.match(done, /GitLab/, 'авторизации перечислены');

  const home = ctx.home;
  assert.equal(await fs.readFile(path.join(home, '.dsh/secrets/installer/gitlab-token'), 'utf8'), GITLAB_TOKEN + '\n');
  assert.equal(await fs.readFile(path.join(home, '.dsh/secrets/installer/cliproxy-key'), 'utf8'), API_KEY + '\n');
  const bundlePatch = await fs.readFile(path.join(home, '.dsh/bundles/dsh-integrations/cordis.patch.yml'), 'utf8');
  assert.ok(bundlePatch.includes('gitlab.example.test') && !bundlePatch.includes(GITLAB_TOKEN), 'в патче адрес есть, токена нет');
  const profile = await fs.readFile(path.join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8');
  assert.ok(!profile.includes(GITLAB_TOKEN) && !profile.includes(API_KEY));
  for (const f of await walk(path.join(home, '.dsh'))) {
    if (f.startsWith('secrets/')) continue;
    if (f.includes(' -> ')) continue;
    const text = await fs.readFile(path.join(home, '.dsh', f.split(' -> ')[0])).then((b) => b.toString('latin1'));
    assert.ok(!text.includes(GITLAB_TOKEN) && !text.includes(API_KEY), 'секрет только в secrets/: ' + f);
  }
  const mode = (await fs.stat(path.join(home, '.dsh/secrets/installer/gitlab-token'))).mode & 0o777;
  assert.equal(mode & 0o077, 0, 'файл секрета закрыт для других пользователей');
});

test('E2E: validate с blockers при ok:true — установка заблокирована, на диске пусто', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  // uvx не найден, а Jira его требует: сервер вернёт ok:true и BLOCKER в blockers.
  const ctx = await setup(t, { uvx: false });
  if (!ctx.browser) return t.skip('Chromium не установлен');
  const page = await ctx.browser.newPage();
  const requests = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) requests.push(r.method() + ' ' + new URL(r.url()).pathname); });
  await toReview(page, ctx, { jira: true });
  await page.waitForSelector('#env-blockers');
  assert.equal(await page.isDisabled('#btn-install'), true);
  const blockers = await page.textContent('#env-blockers');
  assert.match(blockers, /uvx нужен для «jira»/);
  assert.ok(!blockers.includes('BLOCKER:'));
  assert.match(await page.textContent('#panel'), /установите сами/);
  // Enter в форме не обходит блокировку
  await page.focus('#btn-refresh');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert.ok(!requests.includes('POST /api/install'), 'запрос установки не отправлялся');
  assert.deepEqual(await fs.readdir(ctx.home), [], 'на диске ничего нет');
});
