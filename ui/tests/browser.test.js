'use strict';
/*
 * Браузерные проверки мастера. Playwright не скачивается: берётся из node_modules
 * (или из пути в DSH_PLAYWRIGHT_PATH). Если браузера нет — тесты пропускаются.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { listen } = require('./mock-server.js');

let chromium = null;
for (const p of [process.env.DSH_PLAYWRIGHT_PATH, 'playwright', 'playwright-core']) {
  if (!p) continue;
  try { chromium = require(p).chromium; if (chromium) break; } catch (_) { /* следующий */ }
}

const API_KEY = 'sk-test-API-KEY-0001';
const MCP_SECRET = 'mcp-secret-TOKEN-0002';

// Если headless-оболочка не скачана, пробуем полный Chrome for Testing из кэша Playwright
// или путь из DSH_CHROMIUM_PATH. Ничего не скачиваем.
function fallbackExecutables() {
  const fs = require('node:fs');
  const os = require('node:os');
  const list = [process.env.DSH_CHROMIUM_PATH];
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    for (const d of fs.readdirSync(root)) {
      if (!d.startsWith('chromium-')) continue;
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
        list.push(path.join(root, d, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
      }
    }
  } catch (_) { /* нет кэша */ }
  list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return list.filter((p) => p && fs.existsSync(p));
}

async function launch() {
  try { return await chromium.launch(); } catch (_) { /* пробуем запасной вариант */ }
  for (const executablePath of fallbackExecutables()) {
    try { return await chromium.launch({ executablePath }); } catch (_) { /* следующий */ }
  }
  return null;
}

async function checkModels(page) {
  await page.click('#btn-validate');
  await page.waitForSelector('#validation-status .callout--ok');
}

test('мастер: шаги, клавиатура, секреты не попадают в итог', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    page.on('pageerror', (e) => consoleLines.push('pageerror: ' + e.message));
    const external = [];
    page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:' + srv.port)) external.push(r.url()); });

    await page.goto('http://127.0.0.1:' + srv.port + '/#token=' + srv.options.token);
    await page.waitForSelector('#panelTitle');
    assert.equal(await page.evaluate(() => location.hash), '', 'фрагмент очищен');
    assert.ok(srv.log.requests.every((r) => r.token === srv.options.token), 'токен передаётся заголовком');

    // Шаг 1: нельзя продолжить без выбора
    await page.click('#btn-next');
    assert.match(await page.textContent('#errsum'), /Выберите/);
    // Ссылка источника
    const link = page.locator('a[href^="https://help.router-for.me"]');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/);
    // Клавиатура: выбор радио и Enter
    await page.focus('#tutorial-skip');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#apiUrl');

    // Шаг 2
    await page.click('#btn-next');
    assert.ok(await page.locator('#errsum').isVisible());
    await page.fill('#apiUrl', 'https://proxy.example.test');
    await page.fill('#apiKey', API_KEY);
    assert.equal(await page.getAttribute('#apiKey', 'type'), 'password');
    await page.click('#btn-validate');
    await page.waitForSelector('#validation-status .callout--ok');
    const vtext = await page.textContent('#validation-status');
    assert.match(vtext, /Список моделей CLIProxyAPI получен/);
    assert.match(vtext, /Запрос к модели не выполнялся/);
    await page.click('#btn-next');

    // Шаг 3: по умолчанию ничего не выбрано, все 8 на месте
    await page.waitForSelector('#mcp-counter');
    assert.equal(await page.locator('.mcp__check').count(), 9);
    assert.equal(await page.locator('.mcp__check:checked').count(), 0);
    // Выбираем bitbucket с обязательными полями
    await page.check('#mcp-obscura');
    assert.match(await page.textContent('#mcp-reqs-obscura'), /проверьте вручную/);
    assert.match(await page.textContent('#mcp-reqs-obscura'), /Установите совместимый бинарник/);
    await page.fill('#mcp-obscura-binaryPath', '/tmp/x').catch(() => {});
    await page.uncheck('#mcp-obscura');
    await page.check('#mcp-bitbucket');
    await page.click('#btn-next');
    assert.ok(await page.locator('#errsum').isVisible(), 'обязательные поля MCP проверяются');
    await page.fill('#mcp-bitbucket-url', 'https://git.example.test');
    await page.fill('#mcp-bitbucket-token', MCP_SECRET);
    await page.click('#btn-next');

    // Шаг 4: значения по умолчанию из bootstrap
    await page.waitForSelector('#model-oracle');
    assert.equal(await page.inputValue('#model-oracle'), 'cliproxy/test-oracle-model');
    assert.equal(await page.inputValue('#effort-oracle'), 'high');
    // effort main задаётся в сессии: поле заблокировано, списка уровней нет
    assert.deepEqual(await page.locator('#effort-main option').allTextContents(), ['Настраивается в сессии']);
    assert.equal(await page.isDisabled('#effort-main'), true);
    await page.selectOption('#effort-oracle', 'medium');
    await page.selectOption('#model-oracle', 'cliproxy/test-main-model');
    assert.match(await page.textContent('#effort-oracle-hint'), /данных сервера/);
    assert.deepEqual(await page.locator('#effort-oracle option').allTextContents(), ['не задан', 'low', 'high'], 'список сменился вместе с моделью');
    assert.equal(await page.inputValue('#effort-oracle'), '', 'несовместимый уровень сброшен сразу, а не при отправке');
    assert.match(await page.textContent('#effort-oracle-hint'), /Уровень «medium» сброшен/, 'сброс объяснён в интерфейсе');
    await page.selectOption('#effort-oracle', 'high');
    await page.selectOption('#model-oracle', 'cliproxy/test-oracle-model');
    assert.ok(await page.locator('#model-oracle option').count() > 1);
    assert.equal(await page.inputValue('#model-main'), 'cliproxy/test-main-model');
    assert.equal(await page.inputValue('#model-orchestrator'), 'Наследует основную модель');
    assert.equal(await page.isDisabled('#model-orchestrator'), true);
    assert.ok(await page.locator('#h-main').isVisible() && await page.locator('#h-router').isVisible(), 'основная и роутер отдельно');
    assert.match(await page.inputValue('#model-explorer'), /^cliproxy\//);
    await page.click('#btn-next');
    assert.equal(await page.locator('#errsum').count(), 0, 'роутер наследует модель: ошибок нет');

    // Шаг 5: секреты не показаны
    await page.waitForSelector('#btn-install');
    const text = await page.locator('#panel').innerText();
    const html = await page.locator('#panel').innerHTML();
    for (const s of [API_KEY, MCP_SECRET]) {
      assert.ok(!text.includes(s) && !html.includes(s), 'секрет не должен быть в итоге');
    }
    assert.ok(text.includes('proxy.example.test'));
    assert.ok(!/\b(null|undefined|\[object)/.test(text), 'в тексте нет служебных значений');
    assert.ok(text.includes('git.example.test'));

    await page.click('#btn-install');
    await page.waitForSelector('#h-backup');
    assert.ok((await page.textContent('#panel')).includes('/tmp/dsh-backup-test'));
    const install = srv.log.requests.find((r) => r.path === '/api/install');
    assert.equal(install.body.apiKey, API_KEY);
    assert.deepEqual(install.body.mcps.map((m) => m.id), ['bitbucket']);
    assert.deepEqual(install.body.roles.orchestrator, { model: '', effort: 'high' });
    assert.equal(install.body.roles.main.effort, '');
    assert.ok(!(await page.locator('body').innerHTML()).includes(API_KEY));

    assert.deepEqual(external, [], 'нет внешних запросов');
    assert.deepEqual(consoleLines, [], 'в консоль ничего не пишется');
    const storage = await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length);
    assert.equal(storage, 0, 'ничего не хранится в браузере');
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('Harness запущен: установка заблокирована', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ harnessRunning: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + srv.port + '/#token=' + srv.options.token);
    await page.check('#tutorial-skip');
    await page.click('#btn-next');
    await page.fill('#apiUrl', 'https://proxy.example.test');
    await page.fill('#apiKey', API_KEY);
    await checkModels(page);
    await page.click('#btn-next');
    await page.click('#btn-next');
    await page.click('#btn-next');
    await page.waitForSelector('#btn-install');
    assert.equal(await page.isDisabled('#btn-install'), true);
    assert.match(await page.textContent('#env-blockers'), /Harness/);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('ошибка сервера не раскрывает ключ', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ validateOk: false });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + srv.port + '/#token=' + srv.options.token);
    await page.check('#tutorial-done');
    await page.click('#btn-next');
    await page.fill('#apiUrl', 'https://proxy.example.test');
    await page.fill('#apiKey', API_KEY);
    await page.click('#btn-validate');
    await page.waitForSelector('#validation-status .callout--bad');
    const text = await page.textContent('#validation-status');
    assert.ok(!text.includes(API_KEY));
    assert.ok(text.includes('•'));
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('мобильный и узкий экран: без горизонтальной прокрутки', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen();
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
    await page.goto('http://127.0.0.1:' + srv.port + '/#token=' + srv.options.token);
    await page.waitForSelector('#panelTitle');
    const check = async (label) => {
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      assert.ok(w[0] <= w[1], label + ': горизонтальная прокрутка ' + w.join('>'));
    };
    await check('шаг 1');
    await page.check('#tutorial-skip');
    await page.click('#btn-next');
    await check('шаг 2');
    await page.fill('#apiUrl', 'https://proxy.example.test');
    await page.fill('#apiKey', API_KEY);
    await checkModels(page);
    await page.click('#btn-next');
    await check('шаг 3');
    await page.click('#btn-next');
    await check('шаг 4');
    await page.click('#btn-next');
    await check('шаг 5');
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('без токена сервер отказывает — показана честная ошибка', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen();
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + srv.port + '/');
    await page.waitForSelector('#btn-retry');
    assert.match(await page.textContent('#panel'), /Сессия установщика недействительна|forbidden/);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('нет uvx: требование MCP и блокировка видны, ручные инструкции без автоматики', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ missingUvx: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + srv.port + '/#' + srv.options.token);
    await page.check('#tutorial-skip');
    await page.click('#btn-next');
    await page.fill('#apiUrl', 'https://proxy.example.test');
    await page.fill('#apiKey', API_KEY);
    await checkModels(page);
    await page.click('#btn-next');
    await page.check('#mcp-jira');
    assert.match(await page.textContent('#mcp-reqs-jira'), /не найдено/);
    await page.uncheck('#mcp-jira');
    await page.click('#btn-next');
    await page.click('#btn-next');
    await page.waitForSelector('#btn-install');
    assert.equal(await page.isDisabled('#btn-install'), true);
    const text = await page.textContent('#panel');
    assert.match(text, /uvx не найден в PATH/);
    assert.match(text, /Установщик их не скачивает/);
    assert.ok(!/\b(null|undefined)\b/.test(text));
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('GitLab и Bitbucket: можно выбрать любой, оба или ни одного', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const GL_TOKEN = 'glpat-test-TOKEN-0003';
  const srv = await listen();
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + srv.port + '/#' + srv.options.token);
    await page.check('#tutorial-skip');
    await page.click('#btn-next');
    await page.fill('#apiUrl', 'https://proxy.example.test');
    await page.fill('#apiKey', API_KEY);
    await checkModels(page);
    await page.click('#btn-next');

    // карточка GitLab из каталога, описание переведено, по умолчанию не выбрана
    assert.equal(await page.isChecked('#mcp-gitlab'), false);
    assert.equal(await page.isChecked('#mcp-bitbucket'), false);
    assert.match(await page.textContent('#mcp-gitlab-d'), /Альтернатива Bitbucket/);

    // только GitLab: поля из каталога, Bitbucket не требует данных
    await page.check('#mcp-gitlab');
    assert.match(await page.textContent('#mcp-fields-gitlab'), /Адрес сервера/);
    await page.click('#btn-next');
    assert.match(await page.textContent('#errsum'), /GitLab: заполните поле «Адрес сервера»/);
    await page.fill('#mcp-gitlab-url', 'https://user:pw@gitlab.example.test');
    await page.fill('#mcp-gitlab-token', GL_TOKEN);
    await page.click('#btn-next');
    assert.match(await page.textContent('#errsum'), /уберите логин и пароль/);
    await page.fill('#mcp-gitlab-url', 'https://gitlab.example.test');

    // оба сразу
    await page.check('#mcp-bitbucket');
    await page.fill('#mcp-bitbucket-url', 'https://git.example.test');
    await page.fill('#mcp-bitbucket-token', MCP_SECRET);
    await page.click('#btn-next');
    await page.click('#btn-next');
    await page.waitForSelector('#btn-install');
    const text = await page.locator('#panel').innerText();
    assert.ok(text.includes('GitLab') && text.includes('Bitbucket'));
    assert.ok(text.includes('gitlab.example.test'));
    for (const s of [GL_TOKEN, MCP_SECRET, API_KEY]) assert.ok(!text.includes(s));
    await page.click('#btn-install');
    await page.waitForSelector('#h-backup');
    const body = srv.log.requests.find((r) => r.path === '/api/install').body;
    assert.deepEqual(body.mcps.map((m) => m.id).sort(), ['bitbucket', 'gitlab']);
    assert.equal(body.mcps.find((m) => m.id === 'gitlab').values.token, GL_TOKEN);

    // новая вкладка: без выбора MCP установка допустима, в итоге написано «Не выбрано»
    const page2 = await browser.newPage();
    await page2.goto('http://127.0.0.1:' + srv.port + '/#' + srv.options.token);
    await page2.check('#tutorial-done');
    await page2.click('#btn-next');
    await page2.fill('#apiUrl', 'https://proxy.example.test');
    await page2.fill('#apiKey', API_KEY);
    await checkModels(page2);
    await page2.click('#btn-next');
    await page2.click('#btn-next');
    await page2.click('#btn-next');
    await page2.waitForSelector('#btn-install');
    assert.match(await page2.textContent('#panel'), /Не выбрано — MCP не подключаются/);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('реальный каталог бэкенда: GitLab и Google Sheets рисуются из bootstrap', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  let createServer;
  try { ({ createServer } = await import('../../server.js')); } catch (_) { return t.skip('server.js не найден'); }
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const inst = createServer();
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const GL_TOKEN = 'glpat-real-TOKEN-0004';
  try {
    const page = await browser.newPage();
    await page.route('**/api/validate', async (route) => {
      const roles = {};
      for (const key of ['orchestrator', 'oracle', 'designer', 'fixer', 'explorer', 'librarian', 'main']) {
        roles[key] = { model: key === 'orchestrator' ? '' : 'cliproxy/test-model', effort: '' };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, discovery: 'ok', networkChecked: true, models: [{ id: 'test-model' }], roles }) });
    });
    await page.goto(inst.origin + '/#' + inst.token);
    await page.check('#tutorial-skip');
    await page.click('#btn-next');
    await page.fill('#apiUrl', 'https://proxy.example.test');
    await page.fill('#apiKey', API_KEY);
    await checkModels(page);
    await page.click('#btn-next');

    assert.equal(await page.locator('.mcp__check:checked').count(), 0, 'по умолчанию ничего не выбрано');
    // GitLab: URL + секретный токен, Bitbucket остаётся независимым
    await page.check('#mcp-gitlab');
    assert.equal(await page.getAttribute('#mcp-gitlab-url', 'type'), 'text');
    assert.equal(await page.getAttribute('#mcp-gitlab-token', 'type'), 'password');
    assert.equal(await page.isChecked('#mcp-bitbucket'), false);
    assert.match(await page.textContent('#mcp-gitlab-d'), /права на чтение|прав.* на чтение/);
    assert.ok(!/read_api/.test(await page.locator('#panel').innerText()), 'область токена не утверждается');
    for (const url of ['https://gitlab.example.test', 'https://gitlab.example.test/api/v4']) {
      await page.fill('#mcp-gitlab-url', url);
      await page.fill('#mcp-gitlab-token', GL_TOKEN);
      await page.click('#btn-next');
      await page.waitForSelector('#mcp-google-sheets, #model-oracle', { state: 'attached' });
      assert.equal(await page.locator('#errsum').count(), 0, url + ' принят интерфейсом');
      await page.click('.step-btn >> nth=2');
      await page.waitForSelector('#mcp-gitlab');
      assert.equal(await page.isChecked('#mcp-gitlab'), true, 'выбор сохранился');
    }

    // Google Sheets: пути к OAuth-файлам, не секреты; tokenPath необязателен
    await page.check('#mcp-google-sheets');
    assert.equal(await page.getAttribute('#mcp-google-sheets-credentialsPath', 'type'), 'text');
    assert.equal(await page.getAttribute('#mcp-google-sheets-tokenPath', 'type'), 'text');
    assert.equal(await page.locator('#mcp-google-sheets-tokenPath[aria-required="true"]').count(), 0);
    assert.match(await page.textContent('#mcp-fields-google-sheets'), /Путь к JSON с OAuth-данными/);
    await page.click('#btn-next');
    assert.match(await page.textContent('#errsum'), /Google Sheets: заполните поле/);
    await page.fill('#mcp-google-sheets-credentialsPath', '/Users/test/oauth-credentials.json');
    await page.click('#btn-next');
    await page.waitForSelector('#model-oracle');
  } finally {
    await browser.close();
    inst.server.close();
  }
});

async function toRoles(page, srv) {
  await page.goto('http://127.0.0.1:' + srv.port + '/#token=' + srv.options.token);
  await page.check('#tutorial-skip');
  await page.click('#btn-next');
  await page.fill('#apiUrl', 'https://proxy.example.test');
  await page.fill('#apiKey', API_KEY);
  await checkModels(page);
  await page.click('#btn-next');
  await page.click('#btn-next');
  await page.waitForSelector('#model-oracle');
}

test('роли: нет полей, которые сервер отклонит (orchestrator.model, main.effort, xhigh, Grok)', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ realShapeInstall: true });
  try {
    const page = await browser.newPage();
    await toRoles(page, srv);

    // orchestrator: модель не редактируется, effort — можно
    assert.equal(await page.isDisabled('#model-orchestrator'), true);
    assert.equal(await page.inputValue('#model-orchestrator'), 'Наследует основную модель');
    assert.equal(await page.isDisabled('#effort-orchestrator'), false);
    assert.equal(await page.inputValue('#effort-orchestrator'), 'high');
    // main: модель можно менять, effort — «Настраивается в сессии»
    assert.equal(await page.isDisabled('#model-main'), false);
    assert.equal(await page.isDisabled('#effort-main'), true);
    assert.deepEqual(await page.locator('#effort-main option').allTextContents(), ['Настраивается в сессии']);

    // xhigh нигде не предлагается
    const all = await page.locator('select option').allTextContents();
    assert.ok(!all.some((x) => /xhigh/i.test(x)), 'xhigh не предлагается');

    // Grok: уровней нет, список заблокирован, можно только «не задан»
    assert.equal(await page.inputValue('#model-librarian'), 'cliproxy/grok-4.7');
    assert.equal(await page.isDisabled('#effort-librarian'), true);
    assert.deepEqual(await page.locator('#effort-librarian option').allTextContents(), ['не задан']);

    // смена модели на Grok сбрасывает уровень сразу и объясняет почему
    await page.selectOption('#effort-fixer', 'medium');
    await page.selectOption('#model-fixer', 'cliproxy/grok-4.7');
    assert.equal(await page.inputValue('#effort-fixer'), '');
    assert.equal(await page.isDisabled('#effort-fixer'), true);
    assert.match(await page.textContent('#effort-fixer-hint'), /Уровень «medium» сброшен/);
    // и возвращается выбор, когда модель снова поддерживает уровни
    await page.selectOption('#model-fixer', 'cliproxy/test-oracle-model');
    assert.equal(await page.isDisabled('#effort-fixer'), false);

    // что уходит на сервер
    await page.click('#btn-next');
    await page.waitForSelector('#btn-install');
    const review = await page.locator('#panel').innerText();
    assert.match(review, /наследует основную модель/);
    assert.match(review, /настраивается в сессии/);
    await page.click('#btn-install');
    await page.waitForSelector('#h-backup');
    const body = srv.log.requests.find((r) => r.path === '/api/install').body;
    assert.deepEqual(body.roles.orchestrator, { model: '', effort: 'high' });
    assert.equal(body.roles.main.effort, '');
    assert.equal(body.roles.librarian.effort, '');
    for (const [k, r] of Object.entries(body.roles)) {
      assert.deepEqual(Object.keys(r).sort(), ['effort', 'model'], k + ': только model и effort');
      assert.ok(['', 'off', 'low', 'medium', 'high'].includes(r.effort), k + ': effort из набора сервера');
    }

    // успех в форме настоящего server.js: backupPath = null
    const done = await page.locator('#panel').innerText();
    assert.match(done, /\/Users\/test\/\.dsh\/profiles\/desktop/);
    assert.match(done, /Резервная копия не создавалась/);
    assert.match(done, /Файлы профиля записаны/);
    assert.match(done, /Вход и авторизации выполняются вручную/);
    assert.ok(!/подключен|соединен|установлен\b/i.test(await page.locator('h1').innerText()), 'в заголовке нет ложных обещаний');
    assert.match(done, /Удаляйте установленный профиль/);
    assert.ok(!/\b(null|undefined|\[object)/.test(done));
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('неизвестная модель не получает выдуманные уровни усилия', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ discoveryModels: [{ id: 'unknown-model' }] });
  try {
    const page = await browser.newPage();
    await toRoles(page, srv);
    assert.deepEqual(await page.locator('#effort-oracle option').allTextContents(), ['не задан']);
    assert.equal(await page.isDisabled('#effort-oracle'), true);
  } finally { await browser.close(); await srv.close(); }
});

test('409 PREFLIGHT_FAILED: причины из blockers показаны на шаге проверки', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ installOk: true, preflightFail: true });
  try {
    const page = await browser.newPage();
    await toRoles(page, srv);
    await page.click('#btn-next');
    await page.waitForSelector('#btn-install');
    await page.click('#btn-install');
    await page.waitForSelector('#install-errors');
    const text = await page.textContent('#install-errors');
    assert.match(text, /Native profile generation is not implemented/);
    assert.ok(!/BLOCKER:/.test(text), 'служебный префикс убран');
    assert.ok(!text.includes(API_KEY));
    assert.equal(await page.locator('#h-backup').count(), 0, 'экран «Готово» не показан');
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('validate вернул ok:true, но с blockers: установка запрещена, в запросе install нет', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ validateBlockers: ['BLOCKER: uvx is required for jira.'], validateWarnings: ['WARNING: gitlab may require network access on first launch.'] });
  try {
    const page = await browser.newPage();
    await toRoles(page, srv);
    await page.click('#btn-next');
    await page.waitForSelector('#preflight-warnings');
    assert.equal(await page.isDisabled('#btn-install'), true);
    assert.match(await page.textContent('#env-blockers'), /uvx нужен для «jira»/);
    assert.match(await page.textContent('#preflight-warnings'), /при первом запуске/);
    assert.ok(!(await page.textContent('#panel')).includes('BLOCKER:'));
    // Enter в форме не обходит блокировку
    await page.focus('#btn-refresh');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.equal(srv.log.requests.filter((r) => r.path === '/api/install').length, 0);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('validate без blockers: число файлов показано, установка доступна', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch();
  if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ realShapeInstall: true });
  try {
    const page = await browser.newPage();
    await toRoles(page, srv);
    await page.click('#btn-next');
    await page.waitForSelector('#preflight-ok');
    assert.match(await page.textContent('#preflight-ok'), /Будет записано файлов: 7/);
    assert.equal(await page.isDisabled('#btn-install'), false);
  } finally {
    await browser.close();
    await srv.close();
  }
});


test('без Grok: доступны только модели proxy, Explorer тоже использует CLIProxyAPI', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch(); if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ discoveryModels: [
    { id: 'test-main-model', reasoningEfforts: ['low', 'high'] },
    { id: 'test-oracle-model', reasoningEfforts: ['low', 'high'] },
  ] });
  try {
    const page = await browser.newPage(); await toRoles(page, srv);
    assert.equal(await page.locator('#model-librarian option[value*="grok"]').count(), 0);
    for (const role of ['main', 'oracle', 'designer', 'fixer', 'explorer', 'librarian']) {
      assert.match(await page.inputValue('#model-' + role), /^cliproxy\/(test-main-model|test-oracle-model)$/);
    }
    assert.equal(await page.locator('#model-explorer').evaluate((el) => el.tagName), 'SELECT');
    assert.equal(await page.locator('#model-explorer option[value="cliproxy/unavailable"]').count(), 0);
    await page.evaluate(() => { const el = document.querySelector('#model-explorer'); el.value = 'cliproxy/unavailable'; el.dispatchEvent(new Event('change')); });
    await page.click('#btn-next');
    assert.match(await page.textContent('#errsum'), /выберите модель из проверенного списка/);
  } finally { await browser.close(); await srv.close(); }
});

test('одна модель proxy назначается всем ролям с допустимым effort', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch(); if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ discoveryModels: [{ id: 'only-model', reasoningEfforts: ['low'] }] });
  try {
    const page = await browser.newPage(); await toRoles(page, srv);
    for (const role of ['main', 'oracle', 'designer', 'fixer', 'explorer', 'librarian']) {
      assert.equal(await page.inputValue('#model-' + role), 'cliproxy/only-model');
      if (role !== 'main') assert.ok(['', 'low'].includes(await page.inputValue('#effort-' + role)));
    }
    await page.click('#btn-next'); await page.waitForSelector('#preflight-ok');
    assert.equal(await page.isDisabled('#btn-install'), false);
  } finally { await browser.close(); await srv.close(); }
});

test('изменение URL или ключа требует новой проверки', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch(); if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen();
  try {
    const page = await browser.newPage(); await toRoles(page, srv);
    for (const [field, value] of [['#apiUrl', 'https://another.example.test'], ['#apiKey', 'new-key-12345']]) {
      await page.click('.step-btn >> nth=1'); await page.fill(field, value);
      await page.click('#btn-next');
      assert.match(await page.textContent('#errsum'), /Проверьте подключение/);
      assert.equal(await page.locator('#mcp-counter').count(), 0);
      await checkModels(page); await page.click('#btn-next'); await page.click('#btn-next');
      await page.waitForSelector('#model-explorer');
    }
    assert.equal(srv.log.requests.filter((r) => r.path === '/api/install').length, 0);
  } finally { await browser.close(); await srv.close(); }
});

for (const [label, options] of [['ошибка discovery', { validateOk: false }], ['пустой список', { discoveryModels: [] }]]) {
  test(label + ': продолжение и установка заблокированы', async (t) => {
    if (!chromium) return t.skip('Playwright не найден');
    const browser = await launch(); if (!browser) return t.skip('Chromium не установлен');
    const srv = await listen(options);
    try {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + srv.port + '/#token=' + srv.options.token);
      await page.check('#tutorial-skip'); await page.click('#btn-next');
      await page.fill('#apiUrl', 'https://proxy.example.test'); await page.fill('#apiKey', API_KEY);
      await page.click('#btn-validate'); await page.waitForSelector('#validation-status .callout--bad');
      await page.click('#btn-next'); assert.match(await page.textContent('#errsum'), /Проверьте подключение/);
      assert.equal(srv.log.requests.filter((r) => r.path === '/api/install').length, 0);
    } finally { await browser.close(); await srv.close(); }
  });
}

test('список изменился при установке: нет успеха, требуется повторная проверка', async (t) => {
  if (!chromium) return t.skip('Playwright не найден');
  const browser = await launch(); if (!browser) return t.skip('Chromium не установлен');
  const srv = await listen({ installModelUnavailable: true });
  try {
    const page = await browser.newPage(); await toRoles(page, srv);
    await page.click('#btn-next'); await page.waitForSelector('#preflight-ok');
    await page.click('#btn-install'); await page.waitForSelector('#install-errors');
    assert.match(await page.textContent('#install-errors'), /Список моделей изменился/);
    assert.equal(await page.locator('#h-backup').count(), 0);
    assert.equal(await page.isDisabled('#btn-install'), true);
  } finally { await browser.close(); await srv.close(); }
});
