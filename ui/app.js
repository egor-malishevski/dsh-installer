/*
 * DSH Setup — мастер установки (браузерная часть).
 * Только textContent / createElement, никакого innerHTML.
 * Состояние живёт в памяти вкладки: localStorage, sessionStorage, cookie и console не используются.
 */
(function () {
  'use strict';

  const Core = window.DSHCore;
  const TUTORIAL_URL = 'https://help.router-for.me/hands-on/tutorial-10.html';
  const TOKEN_HEADER = 'X-DSH-Setup-Token';
  const STEPS = [
    { id: 'tutorial', title: 'Инструкция', sub: 'Сервис CLIProxyAPI' },
    { id: 'api', title: 'CLIProxyAPI', sub: 'Адрес и ключ' },
    { id: 'mcp', title: 'MCP', sub: 'Что подключить' },
    { id: 'roles', title: 'Роли и модели', sub: 'Oh My DSH Slim' },
    { id: 'review', title: 'Проверка', sub: 'И установка' },
  ];
  // Общий набор, пока сервер не прислал уровни по моделям. Только то, что принимает lib/config.js
  // для всех семейств; «off» добавляется, только если его передал bootstrap.
  const DEFAULT_EFFORTS = ['low', 'medium', 'high'];

  const state = {
    phase: 'loading', // loading | fatal | wizard | done
    fatal: [],
    step: 0,
    maxStep: 0,
    token: '',
    env: null,
    envError: '',
    mcps: [],
    roleOrder: [],
    roleMeta: {},
    efforts: { list: DEFAULT_EFFORTS.slice(), byModel: {} },
    effortsFromServer: false,
    access: {},
    models: [],
    modelsFromServer: false,
    tutorial: '',
    apiUrl: '',
    apiKey: '',
    validation: { status: 'none', messages: [], note: '' },
    // Проверка сервером на шаге 5: none | checking | ok | fail. Блокировки бывают и при ok.
    preflight: { status: 'none', blockers: [], warnings: [], tools: [], fileCount: null, messages: [] },
    selected: new Set(),
    values: {},
    roles: {},
    errors: {},
    errorSummary: [],
    busy: '',
    installErrors: [],
    result: null,
    animate: true,
  };

  const $panel = document.getElementById('panel');
  const $steps = document.getElementById('steps');
  const $compact = document.getElementById('railCompact');
  const $live = document.getElementById('live');

  /* ---------- Мелкие помощники DOM ---------- */

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function announce(text) {
    $live.textContent = '';
    window.setTimeout(() => { $live.textContent = text; }, 30);
  }

  function focusId(id) {
    const node = id && document.getElementById(id);
    if (node) { node.focus({ preventScroll: false }); return true; }
    return false;
  }

  function secrets() {
    return Core.collectSecrets({ apiKey: state.apiKey, mcps: state.mcps, values: state.values });
  }

  function currentConfig() {
    return Core.buildConfig({
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
      mcps: state.mcps,
      selected: Array.from(state.selected),
      values: state.values,
      roles: state.roles,
    });
  }

  /* ---------- Сеть ---------- */

  async function api(method, path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    const headers = { Accept: 'application/json' };
    if (state.token) headers[TOKEN_HEADER] = state.token;
    const init = {
      method,
      headers,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      signal: ctrl.signal,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      const resp = await fetch(path, init);
      let data = null;
      try { data = JSON.parse(await resp.text()); } catch (_) { data = null; }
      return { status: resp.status, httpOk: resp.ok, data };
    } catch (err) {
      return { status: 0, httpOk: false, data: null, networkError: true, aborted: !!(err && err.name === 'AbortError') };
    } finally {
      window.clearTimeout(timer);
    }
  }

  function problems(res) {
    return Core.normalizeProblems(res, secrets());
  }

  /* ---------- Загрузка данных ---------- */

  function applyBootstrap(data) {
    const d = data.defaults;
    if (!d || typeof d !== 'object') return 'Сервер не передал настройки по умолчанию.';
    if (!Array.isArray(d.mcps) || !d.mcps.length) return 'Сервер не передал список MCP.';
    if (!d.roles || typeof d.roles !== 'object' || !Object.keys(d.roles).length) return 'Сервер не передал роли и модели.';

    const mcps = [];
    for (const m of d.mcps) {
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      const fields = Array.isArray(m.fields)
        ? m.fields.filter((f) => f && typeof f.key === 'string' && f.key).map((f) => ({
          key: f.key,
          label: typeof f.label === 'string' ? Core.translateCatalog(f.label) : f.key,
          secret: f.secret === true,
          required: f.required === true,
          placeholder: typeof f.placeholder === 'string' ? f.placeholder : '',
        }))
        : [];
      mcps.push({
        id: m.id,
        label: typeof m.label === 'string' && m.label ? Core.translateCatalog(m.label) : m.id,
        description: typeof m.description === 'string' ? Core.translateCatalog(m.description) : '',
        fields,
        requires: Core.normalizeRequirements(m.requires || m.dependencies),
      });
    }
    if (!mcps.length) return 'Список MCP от сервера не содержит ни одной записи.';

    state.mcps = mcps;
    state.roleOrder = Object.keys(d.roles);
    state.roleMeta = {};
    for (const key of state.roleOrder) {
      const entry = d.roles[key] && typeof d.roles[key] === 'object' ? d.roles[key] : {};
      const info = Core.roleInfo(key);
      state.roleMeta[key] = {
        label: typeof entry.label === 'string' && entry.label ? entry.label : info.label,
        hint: typeof entry.description === 'string' ? entry.description : info.hint,
        locks: Core.roleLocks(key),
        main: entry.main === true || d.mainRole === key || (entry.main !== false && info.main === true),
        router: entry.router === true || (entry.router !== false && info.router === true),
      };
      if (!state.roles[key]) {
        state.roles[key] = {
          model: typeof entry.model === 'string' ? entry.model : '',
          effort: typeof entry.effort === 'string' ? entry.effort : '',
        };
      }
      // Поля, которых нет в профиле, всегда пустые — независимо от того, что прислал сервер.
      if (state.roleMeta[key].locks.model) state.roles[key].model = '';
      if (state.roleMeta[key].locks.effort) state.roles[key].effort = '';
    }
    const eff = Core.normalizeEfforts(d, data);
    state.effortsFromServer = eff.list.length > 0 || Object.keys(eff.byModel).length > 0;
    if (!eff.list.length) eff.list = DEFAULT_EFFORTS.slice();
    state.efforts = eff;
    state.access = Core.normalizeAccess(d);

    const models = Core.normalizeModels(d.models || data.models);
    if (models.length) { state.models = models; state.modelsFromServer = true; }

    if (!state.apiUrl && typeof d.apiUrl === 'string') state.apiUrl = d.apiUrl;
    if (data.environment && typeof data.environment === 'object') state.env = data.environment;

    const t = data.csrfToken || data.csrf || data.sessionToken || data.token;
    if (typeof t === 'string' && /^[A-Za-z0-9._~+\-/=]{8,512}$/.test(t)) state.token = t;
    return '';
  }

  async function bootstrap() {
    state.phase = 'loading';
    render();
    const res = await api('GET', '/api/bootstrap');
    if (!res.data || res.data.ok !== true) {
      state.fatal = problems(res).messages.map((m) => m.message);
      state.phase = 'fatal';
      render();
      return;
    }
    const bad = applyBootstrap(res.data);
    if (bad) {
      state.fatal = [bad, 'Это ошибка на стороне установщика, а не ваших данных.'];
      state.phase = 'fatal';
      render();
      return;
    }
    state.phase = 'wizard';
    state.animate = true;
    render();
  }

  async function refreshEnvironment() {
    state.busy = 'env';
    state.envError = '';
    render();
    const res = await api('GET', '/api/bootstrap');
    if (res.data && res.data.ok === true && res.data.environment && typeof res.data.environment === 'object') {
      state.env = res.data.environment;
    } else if (res.data && res.data.ok === true) {
      state.envError = 'Сервер не прислал состояние окружения.';
    } else {
      state.envError = problems(res).messages[0].message;
    }
    state.busy = '';
    state.animate = false;
    render(null, 'btn-refresh');
    announce(state.envError || 'Состояние Mac обновлено');
    if (state.phase === 'wizard' && state.step === STEPS.length - 1) await refreshPreflight();
  }

  /* ---------- Навигация ---------- */

  function goto(step, focusTarget) {
    state.step = step;
    state.maxStep = Math.max(state.maxStep, step);
    state.errors = {};
    state.errorSummary = [];
    state.installErrors = [];
    state.animate = true;
    if (step === STEPS.length - 1) state.preflight = { status: 'checking', blockers: [], warnings: [], tools: [], fileCount: null, messages: [] };
    render(focusTarget);
    announce('Шаг ' + (step + 1) + ' из ' + STEPS.length + ': ' + STEPS[step].title);
    if (step === STEPS.length - 1) refreshPreflight();
  }

  /* ---------- Проверка сервером перед установкой ---------- */

  let preflightSeq = 0;

  /** Спрашивает /api/validate и кладёт результат в state.preflight. Ничего не рисует. */
  async function fetchPreflight() {
    const seq = ++preflightSeq;
    const res = await api('POST', '/api/validate', currentConfig(), 45000);
    if (seq !== preflightSeq) return state.preflight;
    if (res.data && res.data.ok === true) {
      const p = Core.normalizePreflight(res.data, secrets());
      state.preflight = { status: 'ok', blockers: p.blockers, warnings: p.warnings, tools: p.tools, fileCount: p.fileCount, messages: [] };
    } else {
      const p = Core.normalizePreflight(res.data, secrets());
      state.preflight = { status: 'fail', blockers: p.blockers, warnings: p.warnings, tools: p.tools, fileCount: null, messages: problems(res).messages };
    }
    return state.preflight;
  }

  async function refreshPreflight() {
    state.preflight = { status: 'checking', blockers: [], warnings: [], tools: [], fileCount: null, messages: [] };
    const active = document.activeElement && document.activeElement.id;
    if (state.phase === 'wizard' && state.step === STEPS.length - 1) { state.animate = false; render(null, active); }
    await fetchPreflight();
    if (state.phase === 'wizard' && state.step === STEPS.length - 1 && !state.busy) {
      state.animate = false;
      render(null, document.activeElement && document.activeElement.id ? document.activeElement.id : active);
      announce(state.preflight.blockers.length ? 'Есть блокировки установки' : state.preflight.status === 'ok' ? 'Проверка пройдена' : 'Проверка не пройдена');
    }
  }

  /** Всё, что запрещает установку: окружение из bootstrap + блокировки /api/validate (даже при ok:true). */
  function allBlockers() {
    return Array.from(new Set(Core.installBlockers(state.env).concat(state.preflight.blockers)));
  }

  /** Установка разрешена только после успешной проверки сервером без блокировок. */
  function installReady() {
    return state.preflight.status === 'ok' && allBlockers().length === 0;
  }

  function next() {
    const errs = validateStep(state.step);
    if (errs.length) {
      state.errors = {};
      for (const e of errs) state.errors[e.id] = e.message;
      state.errorSummary = errs;
      state.animate = false;
      render('errsum');
      announce('Исправьте ошибки: ' + errs.length);
      return;
    }
    goto(state.step + 1);
  }

  function back() {
    if (state.step > 0) goto(state.step - 1);
  }

  function validateStep(step) {
    const errs = [];
    if (step === 0) {
      if (!state.tutorial) errs.push({ id: 'tutorial-done', message: 'Выберите один из вариантов, чтобы продолжить.' });
    }
    if (step === 1) {
      const u = Core.validateApiUrl(state.apiUrl);
      if (!u.ok) errs.push({ id: 'apiUrl', message: u.message });
      if (!state.apiKey.trim()) errs.push({ id: 'apiKey', message: 'Укажите API-ключ.' });
    }
    if (step === 2) {
      for (const m of state.mcps) {
        if (!state.selected.has(m.id)) continue;
        for (const f of Core.missingRequired(m, state.values[m.id])) {
          errs.push({ id: 'mcp-' + m.id + '-' + f.key, message: m.label + ': заполните поле «' + f.label + '».' });
        }
        for (const b of Core.invalidUrlFields(m, state.values[m.id])) {
          errs.push({ id: 'mcp-' + m.id + '-' + b.field.key, message: m.label + ', «' + b.field.label + '»: ' + b.message + '.' });
        }
      }
    }
    if (step === 3) {
      for (const key of state.roleOrder) {
        const meta = state.roleMeta[key];
        const r = state.roles[key];
        // Модель обязательна везде, кроме роутера: он наследует основную.
        if (!meta.locks.model && !String(r.model || '').trim()) {
          errs.push({ id: 'model-' + key, message: meta.label + ': укажите модель.' });
        }
        if (!meta.locks.effort) {
          const fit = Core.reconcileEffort(r.model, r.effort, state.efforts);
          if (fit.reset) {
            errs.push({ id: 'effort-' + key, message: meta.label + ': ' + (fit.none ? 'у этой модели нет уровней усилия' : 'уровень «' + fit.previous + '» не поддерживается этой моделью') + '. Выберите «не задан» или другой уровень.' });
          }
        }
      }
    }
    return errs;
  }

  /* ---------- Каркас: левая колонка ---------- */

  function renderRail() {
    $steps.textContent = '';
    const wizard = state.phase === 'wizard' || state.phase === 'done';
    $compact.textContent = state.phase === 'done'
      ? 'Установка завершена'
      : wizard ? 'Шаг ' + (state.step + 1) + ' из ' + STEPS.length + ' — ' + STEPS[state.step].title : '';
    STEPS.forEach((s, i) => {
      const done = state.phase === 'done' || i < state.step;
      const current = state.phase === 'wizard' && i === state.step;
      const reachable = state.phase === 'wizard' && i <= state.maxStep && !state.busy;
      const btn = el('button', {
        type: 'button',
        class: 'step-btn',
        'aria-current': current ? 'step' : false,
        'aria-disabled': reachable ? false : 'true',
        onclick: () => { if (reachable && i !== state.step) goto(i); },
      },
      el('span', { class: 'step-btn__dot', 'aria-hidden': 'true', text: done ? '✓' : String(i + 1) }),
      el('span', { class: 'step-btn__label' },
        s.title,
        el('small', { text: s.sub }),
        done ? el('span', { class: 'sr-only', text: ' — пройден' }) : null));
      $steps.append(el('li', { class: (done ? 'is-done ' : '') + (current ? 'is-current' : '') }, btn));
    });
  }

  /* ---------- Повторно используемые блоки ---------- */

  function callout(kind, title, body) {
    const icon = { ok: '✓', warn: '!', bad: '×', info: 'i' }[kind] || 'i';
    return el('div', { class: 'callout callout--' + kind, role: kind === 'bad' ? 'alert' : null },
      el('span', { class: 'callout__icon', 'aria-hidden': 'true', text: icon }),
      el('div', null, title ? el('p', null, el('strong', { text: title })) : null, body));
  }

  function heading(eyebrow, title, lead) {
    const out = [
      el('p', { class: 'eyebrow', text: eyebrow }),
      el('h1', { id: 'panelTitle', tabindex: '-1', text: title }),
    ];
    if (lead) out.push(el('p', { class: 'lead', text: lead }));
    return out;
  }

  function errorSummary() {
    // Пустой фрагмент вместо null: Element.append(null) вставил бы текст «null».
    if (!state.errorSummary.length) return document.createDocumentFragment();
    return el('div', { class: 'callout callout--bad errsum', id: 'errsum', tabindex: '-1', role: 'alert' },
      el('span', { class: 'callout__icon', 'aria-hidden': 'true', text: '×' }),
      el('div', null,
        el('p', null, el('strong', { text: 'Не хватает данных для продолжения' })),
        el('ul', null, state.errorSummary.map((e) => el('li', null,
          el('a', { href: '#' + e.id, onclick: (ev) => { ev.preventDefault(); focusId(e.id); }, text: e.message }))))));
  }

  function navActions(opts) {
    const o = opts || {};
    return el('div', { class: 'actions' },
      el('div', { class: 'actions__group' },
        state.step > 0 ? el('button', { type: 'button', class: 'btn btn--ghost', onclick: back, disabled: !!state.busy, text: 'Назад' }) : null),
      el('div', { class: 'actions__group' },
        o.extra || null,
        el('button', { type: 'submit', class: 'btn btn--primary', id: 'btn-next', disabled: !!state.busy, text: o.nextLabel || 'Далее' })));
  }

  function fieldNode(opts) {
    const id = opts.id;
    const err = state.errors[id];
    const describedBy = [opts.hint ? id + '-hint' : '', err ? id + '-err' : ''].filter(Boolean).join(' ');
    const input = el('input', {
      id,
      type: opts.secret ? 'password' : 'text',
      class: opts.mono ? 'mono-input' : null,
      placeholder: opts.placeholder || null,
      autocomplete: opts.secret ? 'new-password' : 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      inputmode: opts.inputmode || null,
      list: opts.list || null,
      'aria-required': opts.required ? 'true' : null,
      'aria-invalid': err ? 'true' : null,
      'aria-describedby': describedBy || null,
      'data-lpignore': 'true',
      'data-1p-ignore': 'true',
    });
    input.value = opts.value || '';
    input.addEventListener('input', () => opts.onInput(input.value));

    let control = input;
    if (opts.secret) {
      const toggle = el('button', {
        type: 'button', class: 'btn btn--small btn--ghost', 'aria-pressed': 'false',
        'aria-controls': id, text: 'Показать',
        onclick: () => {
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          toggle.textContent = show ? 'Скрыть' : 'Показать';
          toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
        },
      });
      control = el('div', { class: 'secret' }, input, toggle);
    }
    return el('div', { class: 'field' },
      el('label', { for: id }, opts.label,
        opts.required ? el('span', { class: 'req', 'aria-hidden': 'true', text: '*' }) : null,
        opts.required ? el('span', { class: 'sr-only', text: ' (обязательное)' }) : null,
        !opts.required && opts.optionalMark ? el('span', { class: 'opt', text: 'необязательно' }) : null),
      control,
      opts.hint ? el('p', { class: 'hint', id: id + '-hint', text: opts.hint }) : null,
      err ? el('p', { class: 'err', id: id + '-err', text: err }) : null);
  }

  /* ---------- Шаг 1: инструкция ---------- */

  function renderTutorial() {
    const root = el('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); next(); } });
    root.append(...heading('Шаг 1 из 5', 'Сначала — сервис CLIProxyAPI',
      'Установщик настраивает DSH на этом Mac и подключает его к вашему CLIProxyAPI. Сам сервис нужно развернуть заранее — вручную, по инструкции.'));

    root.append(callout('info', 'Как это работает',
      el('p', { text: 'Скрипт запуска открыл эту страницу в браузере; сервер установщика слушает только ваш Mac. Для установки нужен Harness rc5 (закреплённая версия) и подходящий status-адаптер — состояние покажем на последнем шаге. Во время установки Harness должен быть закрыт.' })));

    const guide = el('details', { class: 'guide', open: state.tutorial !== 'skip' },
      el('summary', null, el('span', { text: 'Развёртывание на Render (GitHub как хранилище)' })),
      el('div', { class: 'guide__body' },
        el('p', { class: 'small muted', style: null }, 'Краткий пересказ, у оригинала — скриншоты. Источник: ',
          el('a', { href: TUTORIAL_URL, target: '_blank', rel: 'noopener noreferrer', text: 'help.router-for.me — Render (Git Storage)' }), '.'),
        el('ol', { class: 'recipe' },
          el('li', null,
            el('h3', { text: 'Закрытый репозиторий на GitHub' }),
            el('p', null, 'Создайте пустой репозиторий и обязательно сделайте его ', el('strong', { text: 'private' }), ': в нём будут лежать настройки и ключи.')),
          el('li', null,
            el('h3', { text: 'Fine-grained токен для этого репозитория' }),
            el('p', null, 'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.'),
            el('ul', null,
              el('li', null, 'Repository access: ', el('strong', { text: 'Only select repositories' }), ' — только созданный репозиторий.'),
              el('li', null, 'Permissions → ', el('strong', { text: 'Contents: Read and write' }), '.'),
              el('li', null, 'Токен показывается один раз — сохраните его.')),
            el('p', null, 'Этот токен нужен только Render. Установщик его не просит и не принимает.')),
          el('li', null,
            el('h3', { text: 'Web Service на Render' }),
            el('p', null, 'New → Web Service → Existing Image. Образ: ', el('code', { text: 'eceasy/cli-proxy-api:latest' }),
              '. Если закрепляете версию — не ниже ', el('code', { text: 'v6.2.2' }), ': хранение в Git появилось там.'),
            el('p', null, 'Добавьте 4 переменные окружения:'),
            el('dl', { class: 'kv' },
              el('dt', null, el('code', { text: 'GITSTORE_GIT_URL' })), el('dd', { text: 'адрес вашего репозитория' }),
              el('dt', null, el('code', { text: 'GITSTORE_GIT_USERNAME' })), el('dd', { text: 'имя пользователя GitHub' }),
              el('dt', null, el('code', { text: 'GITSTORE_GIT_TOKEN' })), el('dd', { text: 'fine-grained токен из прошлого шага' }),
              el('dt', null, el('code', { text: 'MANAGEMENT_PASSWORD' })), el('dd', { text: 'пароль входа в панель управления' }))),
          el('li', null,
            el('h3', { text: 'Дождитесь статуса Live' }),
            el('p', null, 'Откройте адрес сервиса с ', el('code', { text: '/management.html' }), ' и войдите с паролем ', el('code', { text: 'MANAGEMENT_PASSWORD' }),
              '. Там же добавьте API-ключ для клиентов. Адрес сервиса и этот ключ понадобятся на следующем шаге.'))),
        callout('warn', 'Не путайте пароль и ключ',
          el('p', { text: 'MANAGEMENT_PASSWORD — это вход в панель управления. Он не равен API-ключу клиента, и в установщик его вводить не нужно.' })),
        el('ul', { class: 'small muted' },
          el('li', { text: 'Один контейнер на один репозиторий: не подключайте один репозиторий к нескольким экземплярам сразу.' }),
          el('li', { text: 'Не правьте файлы в репозитории вручную, пока контейнер работает: такие правки теряются. Сначала остановите сервис.' }),
          el('li', { text: 'Пароль управления меняется только через переменную MANAGEMENT_PASSWORD, раздел remote-management в конфиге не действует.' }),
          el('li', { text: 'Развёртывание ручное: установщик ничего не создаёт на GitHub и Render.' }))));
    root.append(guide);

    const group = el('fieldset', null,
      el('legend', { id: 'tutorial-legend', text: 'Как продолжить' }),
      choice('done', 'Я прошёл(ла) инструкцию', 'Сервис работает, адрес и API-ключ у меня есть.'),
      choice('skip', 'CLIProxyAPI уже развёрнут — пропустить инструкцию',
        'Подтверждаю: у меня есть адрес и API-ключ работающего сервиса, разворачивать заново не нужно.'));
    if (state.errors['tutorial-done']) group.append(el('p', { class: 'err', id: 'tutorial-done-err', text: state.errors['tutorial-done'] }));
    root.append(errorSummary(), group, navActions());
    return root;
  }

  function choice(value, title, desc) {
    const id = value === 'done' ? 'tutorial-done' : 'tutorial-skip';
    const input = el('input', {
      type: 'radio', name: 'tutorial', value, id,
      checked: state.tutorial === value,
      'aria-describedby': id + '-d',
      onchange: () => { state.tutorial = value; state.errors = {}; state.errorSummary = []; render(null, id); },
    });
    input.checked = state.tutorial === value;
    return el('label', { class: 'choice', for: id },
      input,
      el('span', { class: 'choice__body' },
        el('span', { class: 'choice__title', text: title }),
        el('span', { class: 'choice__desc', id: id + '-d', text: desc })));
  }

  /* ---------- Шаг 2: адрес и ключ ---------- */

  function renderApi() {
    const root = el('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); next(); } });
    root.append(...heading('Шаг 2 из 5', 'Адрес и ключ CLIProxyAPI',
      'Эти данные DSH будет использовать для запросов к моделям.'));
    const status = el('div', { id: 'validation-status', 'aria-live': 'polite' });

    const urlField = fieldNode({
      id: 'apiUrl', label: 'Адрес (API URL)', required: true, mono: true, inputmode: 'url',
      placeholder: 'https://my-proxy.onrender.com', value: state.apiUrl,
      hint: 'Адрес сервиса на Render или другой, где развёрнут CLIProxyAPI.',
      onInput: (v) => { state.apiUrl = v; invalidateValidation(); },
    });
    const keyField = fieldNode({
      id: 'apiKey', label: 'API-ключ', required: true, secret: true, mono: true, value: state.apiKey,
      hint: 'Ключ клиента из панели управления. Это не MANAGEMENT_PASSWORD.',
      onInput: (v) => { state.apiKey = v; invalidateValidation(); },
    });

    const warn = Core.validateApiUrl(state.apiUrl);
    root.append(errorSummary(), el('div', { class: 'card' }, urlField, keyField,
      warn.ok && warn.warning ? callout('warn', null, el('p', { text: warn.warning })) : null,
      el('div', null,
        el('button', {
          type: 'button', class: 'btn', id: 'btn-validate', disabled: !!state.busy,
          onclick: runValidate,
        }, state.busy === 'validate' ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Проверяем…'] : 'Проверить настройки'),
        el('p', { class: 'hint', text: 'Проверка необязательна. Данные уходят только на локальный сервер установщика; будет ли он обращаться к вашему адресу, покажет результат — мы ничего не выдумываем.' })),
      status));
    root.append(navActions());
    queueMicrotask(() => paintValidation(status));
    return root;
  }

  function invalidateValidation() {
    if (state.validation.status === 'none') return;
    state.validation = { status: 'none', messages: [], note: '' };
    paintValidation(document.getElementById('validation-status'));
  }

  function paintValidation(box) {
    if (!box) return;
    box.textContent = '';
    const v = state.validation;
    if (v.status === 'ok') {
      box.append(callout('ok', v.title || 'Настройки приняты', el('p', { text: v.note })));
      if (v.blockers && v.blockers.length) {
        box.append(callout('warn', 'Но установка пока заблокирована', el('ul', null, v.blockers.map((b) => el('li', { text: b })))));
      }
    } else if (v.status === 'fail') {
      box.append(callout('bad', 'Проверка не пройдена',
        el('ul', null, v.messages.map((m) => el('li', { text: (m.field ? m.field + ': ' : '') + m.message })))));
    }
  }

  async function runValidate() {
    const u = Core.validateApiUrl(state.apiUrl);
    state.errors = {};
    state.errorSummary = [];
    const errs = [];
    if (!u.ok) errs.push({ id: 'apiUrl', message: u.message });
    if (!state.apiKey.trim()) errs.push({ id: 'apiKey', message: 'Укажите API-ключ.' });
    if (errs.length) {
      for (const e of errs) state.errors[e.id] = e.message;
      state.errorSummary = errs;
      state.animate = false;
      render('errsum');
      return;
    }
    state.busy = 'validate';
    state.validation = { status: 'none', messages: [], note: '' };
    state.animate = false;
    render('btn-validate');
    const res = await api('POST', '/api/validate', currentConfig(), 45000);
    state.busy = '';
    if (res.data && res.data.ok === true) {
      const models = Core.normalizeModels(res.data.models);
      const d = res.data;
      // Сетевую проверку считаем выполненной только если сервер прямо об этом сказал.
      const network = d.networkChecked === true || d.network === true || (d.network && d.network.ok === true);
      const parts = [];
      if (typeof d.message === 'string' && d.message) parts.push(Core.sanitizeText(Core.translateServerText(d.message), secrets()));
      else parts.push(network ? 'Сервер связался с CLIProxyAPI.' : 'Сетевой запрос к CLIProxyAPI не выполнялся.');
      if (typeof d.apiUrl === 'string' && d.apiUrl) parts.push('Адрес, который будет записан: ' + Core.sanitizeText(d.apiUrl, secrets(), 300));
      if (models.length) {
        state.models = models;
        state.modelsFromServer = true;
        parts.push('Получено моделей: ' + models.length + '.');
      }
      const pf = Core.normalizePreflight(d, secrets());
      state.validation = {
        status: 'ok', title: network ? 'Подключение проверено' : 'Формат настроек корректен', messages: [], note: parts.join(' '),
        blockers: pf.blockers,
      };
    } else {
      state.validation = { status: 'fail', messages: problems(res).messages, note: '' };
    }
    state.animate = false;
    render('btn-validate');
    announce(state.validation.status === 'ok' ? (state.validation.title || 'Настройки приняты') : 'Проверка не пройдена');
  }

  /* ---------- Шаг 3: MCP ---------- */

  function renderMcp() {
    const root = el('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); next(); } });
    root.append(...heading('Шаг 3 из 5', 'Какие MCP подключить',
      'По умолчанию ничего не выбрано: отметьте только то, что вам нужно. Данные для доступа понадобятся только у выбранных.'));
    const counter = el('p', { class: 'counter', id: 'mcp-counter', 'aria-live': 'polite' });
    const paintCounter = () => {
      const n = state.selected.size;
      counter.textContent = n
        ? 'Выбрано: ' + n + ' из ' + state.mcps.length
        : 'Ничего не выбрано — можно продолжить без MCP.';
    };
    paintCounter();
    root.append(errorSummary(), counter);

    for (const m of state.mcps) {
      const checked = state.selected.has(m.id);
      const fieldsBox = el('div', { class: 'mcp__fields', id: 'mcp-fields-' + m.id, hidden: !checked });
      const reqBox = el('div', { class: 'reqs', id: 'mcp-reqs-' + m.id });
      // Поля создаются только у выбранного MCP: так в форме нет лишних скрытых полей пароля.
      const fillFields = () => {
        fieldsBox.textContent = '';
        fieldsBox.append(reqBox);
        paintReqs(reqBox, m);
        if (!m.fields.length && !m.requires.length) {
          fieldsBox.append(el('p', { class: 'hint', text: 'Для этого MCP дополнительные данные не нужны.' }));
        }
        for (const f of m.fields) {
          fieldsBox.append(fieldNode({
            id: 'mcp-' + m.id + '-' + f.key, label: f.label, required: f.required, optionalMark: true,
            secret: f.secret, mono: true, placeholder: f.placeholder,
            value: (state.values[m.id] || {})[f.key] || '',
            onInput: (v) => { (state.values[m.id] = state.values[m.id] || {})[f.key] = v; },
          }));
        }
      };
      if (checked) fillFields();
      const cb = el('input', {
        type: 'checkbox', class: 'mcp__check', id: 'mcp-' + m.id, 'aria-describedby': 'mcp-' + m.id + '-d',
        onchange: () => {
          if (cb.checked) { state.selected.add(m.id); fillFields(); } else { state.selected.delete(m.id); fieldsBox.textContent = ''; }
          fieldsBox.hidden = !cb.checked;
          paintCounter();
        },
      });
      cb.checked = checked;
      root.append(el('div', { class: 'mcp' },
        el('label', { class: 'mcp__head', for: 'mcp-' + m.id },
          cb,
          el('span', null,
            el('span', { class: 'mcp__name', text: m.label }),
            el('span', { class: 'mcp__desc', id: 'mcp-' + m.id + '-d', text: m.description }))),
        fieldsBox));
    }
    root.append(navActions());
    return root;
  }

  function paintReqs(box, mcp) {
    box.textContent = '';
    const list = Core.mcpRequirementStatus(mcp, state.env);
    if (!list.length) return;
    const icon = { ok: '✓', bad: '×', unknown: '?' };
    const word = { ok: 'найдено', bad: 'не найдено', unknown: 'проверьте вручную' };
    box.append(el('p', { class: 'sub', text: 'Что нужно для работы' }),
      el('ul', { class: 'dep-list' }, list.map((r) => el('li', { class: 'dep dep--' + r.status },
        el('span', { class: 'dep__icon', 'aria-hidden': 'true', text: icon[r.status] }),
        el('span', null,
          el('strong', { text: r.label }), ' — ' + word[r.status] + (r.message && r.status !== 'ok' ? '. ' + r.message : ''),
          r.instructions.length ? el('ul', { class: 'small' }, r.instructions.map((t) => el('li', { text: t }))) : null,
          r.url ? el('span', { class: 'small' }, ' ', el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', text: 'Инструкция' })) : null)))),
      el('p', { class: 'hint', text: 'Установщик ничего не скачивает сам: недостающее ставится вручную.' }));
  }

  /* ---------- Шаг 4: роли ---------- */

  function renderRoles() {
    const root = el('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); next(); } });
    root.append(...heading('Шаг 4 из 5', 'Роли и модели Oh My DSH Slim',
      'Здесь подставлены текущие значения. Меняйте, только если знаете, зачем.'));

    const dl = el('datalist', { id: 'models-list' }, state.models.map((m) => el('option', { value: m })));
    root.append(errorSummary(), dl);

    const group = (g) => state.roleOrder.filter((k) => groupOf(k) === g);
    const mainKeys = group('main');
    const routerKeys = group('router');
    const otherKeys = group('helpers');

    const modelsNote = state.modelsFromServer
      ? 'Подсказки в списке — модели, которые вернул сервер. Это не гарантия, что маршрут к модели работает.'
      : 'Список моделей недоступен: сервер его не передал. Введите идентификатор модели вручную.';

    if (mainKeys.length) {
      root.append(el('section', { class: 'card', 'aria-labelledby': 'h-main' },
        el('h2', { id: 'h-main', text: 'Основная конфигурация' }),
        el('p', { class: 'muted small', text: 'Модель, с которой вы работаете в сессии.' }),
        mainKeys.map(roleRow)));
    }
    if (routerKeys.length) {
      root.append(el('section', { class: 'card', 'aria-labelledby': 'h-router' },
        el('h2', { id: 'h-router', text: 'Конфигурация роутера' }),
        el('p', { class: 'muted small', text: 'Отдельная настройка того, кто распределяет задачи между ролями.' }),
        routerKeys.map(roleRow)));
    }
    if (otherKeys.length) {
      root.append(el('section', { class: 'card', 'aria-labelledby': 'h-helpers' },
        el('h2', { id: 'h-helpers', text: 'Роли-помощники' }),
        el('p', { class: 'muted small', text: 'Специалисты, которым передаются отдельные задачи.' }),
        otherKeys.map(roleRow)));
    }
    root.append(el('p', { class: 'hint models-note', text: modelsNote }));

    root.append(accessCard());
    if (hasDeepSeek()) {
      const note = callout('warn', 'DeepSeek: нужен ручной вход',
        el('p', { text: 'Для моделей DeepSeek аккаунт подключается вручную: войдите в него самостоятельно. Установщик вход не выполняет и пароли от DeepSeek не просит.' }));
      note.id = 'deepseek-note';
      root.append(note);
    }
    root.append(navActions());
    return root;
  }

  function groupOf(key) {
    const m = state.roleMeta[key];
    return m.main ? 'main' : m.router ? 'router' : 'helpers';
  }

  function hasDeepSeek() {
    return state.roleOrder.some((k) => Core.isDeepSeekModel(state.roles[k].model));
  }

  function paintDeepSeek() {
    const existing = document.getElementById('deepseek-note');
    const need = hasDeepSeek();
    if (need && !existing) {
      const note = callout('warn', 'DeepSeek: нужен ручной вход',
        el('p', { text: 'Для моделей DeepSeek аккаунт подключается вручную: войдите в него самостоятельно. Установщик вход не выполняет и пароли от DeepSeek не просит.' }));
      note.id = 'deepseek-note';
      const actions = $panel.querySelector('.actions');
      if (actions) actions.before(note);
    } else if (!need && existing) {
      existing.remove();
    }
  }

  function roleRow(key) {
    const meta = state.roleMeta[key];
    const role = state.roles[key];
    const modelId = 'model-' + key;
    const effId = 'effort-' + key;
    const select = el('select', { id: effId, 'aria-describedby': effId + '-hint', onchange: () => { role.effort = select.value; } });
    // aria-live: сообщение о сбросе уровня озвучивается сразу, а не только при отправке формы.
    const effHint = el('p', { class: 'hint', id: effId + '-hint', 'aria-live': 'polite' });
    const paintEffort = (resetNote) => {
      select.textContent = '';
      if (meta.locks.effort) {
        // У main уровень выбирается в самой сессии: в профиле такого поля нет.
        select.append(el('option', { value: '', text: 'Настраивается в сессии' }));
        select.disabled = true;
        effHint.textContent = 'Уровень усилия основной модели меняется в сессии, установщик его не задаёт.';
        return;
      }
      const allowed = Core.effortsFor(role.model, state.efforts);
      const list = allowed.list.slice();
      if (role.effort && !list.includes(role.effort)) list.push(role.effort); // не прячем текущее значение
      select.textContent = '';
      select.append(el('option', { value: '', text: 'не задан' }));
      for (const e of list) select.append(el('option', { value: e, text: e }));
      select.value = role.effort || '';
      select.disabled = allowed.none; // у модели нет уровней: единственный вариант — «не задан»
      const base = allowed.none
        ? 'У этой модели нет уровней усилия — можно только «не задан».'
        : allowed.specific ? 'Список из данных сервера для этой модели.'
          : state.effortsFromServer ? '' : 'Сервер не передал список по модели — общий набор.';
      effHint.textContent = (resetNote ? resetNote + ' ' : '') + base;
    };
    // Смена модели: несовместимый уровень сбрасывается сразу и с пояснением.
    const onModel = (v) => {
      role.model = v;
      let note = '';
      if (!meta.locks.effort) {
        const fit = Core.reconcileEffort(role.model, role.effort, state.efforts);
        if (fit.reset) {
          role.effort = '';
          note = 'Уровень «' + fit.previous + '» сброшен: ' + (fit.none ? 'у этой модели нет уровней усилия.' : 'эта модель его не поддерживает.');
        }
      }
      paintDeepSeek();
      paintEffort(note);
    };
    paintEffort();

    const modelField = meta.locks.model
      ? el('div', { class: 'field' },
        el('label', { for: modelId, text: 'Модель' }),
        el('input', { id: modelId, type: 'text', disabled: true, 'aria-describedby': modelId + '-hint', value: 'Наследует основную модель' }),
        el('p', { class: 'hint', id: modelId + '-hint', text: 'Отдельную модель роутеру задать нельзя: он использует основную.' }))
      : fieldNode({
        id: modelId, label: 'Модель', required: true,
        mono: true, list: 'models-list', value: role.model,
        placeholder: 'провайдер/модель',
        hint: 'Полный идентификатор: провайдер/модель.',
        onInput: onModel,
      });
    return el('div', { class: 'role' },
      el('div', { class: 'role__head' },
        el('span', { class: 'role__name', text: meta.label }),
        meta.hint ? el('span', { class: 'muted small', text: meta.hint }) : null),
      el('div', { class: 'role__grid' },
        modelField,
        el('div', { class: 'field' },
          el('label', { for: effId, text: 'Усилие (effort)' }),
          select, effHint)));
  }

  function accessCard() {
    const known = Object.keys(state.access);
    const body = [];
    if (known.length) {
      body.push(el('ul', { class: 'access-chips' }, state.roleOrder.filter((k) => state.access[k] !== undefined).map((k) =>
        el('li', null, state.roleMeta[k].label + ': ', el('b', { text: String(state.access[k]) })))));
    } else {
      body.push(el('p', { class: 'small', text: 'Общее чтение по ролям: 13 / 11 / 5 / 6, у Explorer — 0. Сервер установщика не передал разбивку по ролям, поэтому показаны только итоговые числа.' }));
    }
    return el('section', { class: 'card card--flat', 'aria-labelledby': 'h-access' },
      el('h2', { id: 'h-access', text: 'Доступ ролей' }),
      el('p', { class: 'small muted', text: 'Сводка общего доступа на чтение (shared read). Установщик не создаёт новых подключений и не расширяет права ролей.' }),
      body);
  }

  /* ---------- Шаг 5: проверка и установка ---------- */

  function renderReview() {
    const root = el('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); install(); } });
    root.append(...heading('Шаг 5 из 5', 'Проверьте и установите',
      'Секреты скрыты. Установка создаст новый профиль DSH на этом Mac. Существующий профиль в ~/.dsh установщик не перезаписывает.'));

    const review = Core.buildReview({
      apiUrl: state.apiUrl, apiKey: state.apiKey, mcps: state.mcps, selected: Array.from(state.selected),
      values: state.values, roles: state.roles, roleMeta: state.roleMeta,
    });
    const rows = (list) => el('dl', { class: 'rows' }, list.map((r) => [
      el('dt', { text: r.label }),
      el('dd', { class: r.masked ? 'masked' : null, text: r.value }),
    ]));

    root.append(el('section', { class: 'card review-group', 'aria-labelledby': 'rv-api' },
      el('h2', { id: 'rv-api' }, 'CLIProxyAPI', editBtn(1)),
      rows(review.api),
      el('p', { class: 'hint', text: state.validation.status === 'ok' ? 'Шаг 2: ' + state.validation.title.toLowerCase() + '.' : 'Настройки отдельно не проверялись.' })));

    root.append(el('section', { class: 'card review-group', 'aria-labelledby': 'rv-mcp' },
      el('h2', { id: 'rv-mcp' }, 'MCP', editBtn(2)),
      review.mcps.length
        ? review.mcps.map((m) => [el('p', { class: 'sub', text: m.label }), m.rows.length ? rows(m.rows) : el('p', { class: 'hint', text: 'Без дополнительных данных.' })])
        : el('p', { class: 'muted', text: 'Не выбрано — MCP не подключаются.' })));

    root.append(el('section', { class: 'card review-group', 'aria-labelledby': 'rv-roles' },
      el('h2', { id: 'rv-roles' }, 'Роли и модели', editBtn(3)),
      el('dl', { class: 'rows' }, review.roles.map((r) => [
        el('dt', { text: r.label + (r.main ? ' (основной)' : '') }),
        el('dd', null, r.model, el('span', { class: 'muted', text: ' · effort: ' + r.effort })),
      ]))));

    root.append(envCard());
    root.append(preflightCard());
    root.append(el('p', { class: 'hint', text: 'Если в ~/.dsh уже есть данные, сервер может отказать в установке: установщик не перезаписывает чужой профиль. Причина появится в блоке выше.' }));

    const blockers = allBlockers();
    const ready = installReady();
    if (state.installErrors.length) {
      root.append(el('div', { id: 'install-errors', tabindex: '-1' }, callout('bad', 'Установка не выполнена',
        el('ul', null, state.installErrors.map((m) => el('li', { text: (m.field ? m.field + ': ' : '') + m.message }))))));
    }

    root.append(el('div', { class: 'actions' },
      el('div', { class: 'actions__group' },
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: back, disabled: !!state.busy, text: 'Назад' })),
      el('div', { class: 'actions__group' },
        el('button', {
          type: 'submit', class: 'btn btn--primary', id: 'btn-install',
          disabled: !!state.busy || !ready,
          'aria-describedby': blockers.length ? 'env-blockers' : (state.preflight.status === 'fail' ? 'preflight-fail' : null),
        }, state.busy === 'install' ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Устанавливаем…'] : 'Установить'))));
    return root;
  }

  function editBtn(step) {
    return el('button', { type: 'button', class: 'link-btn', onclick: () => goto(step), text: 'Изменить' });
  }

  function envCard() {
    const rows = Core.describeEnvironment(state.env);
    const blockers = allBlockers();
    const card = el('section', { class: 'card review-group', 'aria-labelledby': 'rv-env' },
      el('h2', { id: 'rv-env' }, 'Этот Mac и зависимости',
        el('button', {
          type: 'button', class: 'link-btn', id: 'btn-refresh', disabled: !!state.busy, onclick: refreshEnvironment,
          text: state.busy === 'env' ? 'Проверяем…' : 'Проверить снова',
        })));
    if (!state.env) {
      card.append(callout('warn', null, el('p', { text: 'Сервер не передал состояние окружения. Установку всё равно проверит сервер: если Harness запущен или версия не подходит, он откажет.' })));
    } else if (rows.length) {
      card.append(el('ul', { class: 'status-list' }, rows.map((r) =>
        el('li', null, el('span', { text: r.label }), el('b', { class: r.tone ? 'tone-' + r.tone : null, text: r.value })))));
    }
    if (state.envError) card.append(callout('warn', null, el('p', { text: state.envError })));
    const missingTools = ['uvx', 'npx'].filter((id) => {
      const c = state.env && Array.isArray(state.env.checks) && state.env.checks.find((x) => x && x.id === id);
      return (c && c.ok === false) || state.preflight.tools.includes(id);
    });
    if (missingTools.length) {
      card.append(callout('info', 'Что сделать вручную',
        el('p', { text: 'Недостающие инструменты (' + missingTools.join(', ') + ') установите сами: uvx входит в uv, npx — в Node.js. Установщик их не скачивает. После установки нажмите «Проверить снова».' })));
    }
    if (blockers.length) {
      const c = callout('bad', 'Установка сейчас заблокирована', el('ul', null, blockers.map((b) => el('li', { text: b }))));
      c.id = 'env-blockers';
      card.append(c);
    }
    return card;
  }

  /** Итог проверки сервером: статус, число файлов и предупреждения. Блокировки показывает envCard. */
  function preflightCard() {
    const p = state.preflight;
    const card = el('section', { class: 'card review-group', 'aria-labelledby': 'rv-preflight' },
      el('h2', { id: 'rv-preflight', text: 'Проверка сервером' }));
    if (p.status === 'checking' || p.status === 'none') {
      card.append(el('p', { class: 'loading', role: 'status', text: 'Сервер проверяет настройки и зависимости. Ничего пока не записывается.' }));
      return card;
    }
    if (p.status === 'fail') {
      const c = callout('bad', 'Проверка не пройдена', el('ul', null, p.messages.map((m) => el('li', { text: (m.field ? m.field + ': ' : '') + m.message }))));
      c.id = 'preflight-fail';
      card.append(c);
      return card;
    }
    if (!p.blockers.length) {
      card.append(el('p', { class: 'small', id: 'preflight-ok', text: 'Блокировок нет.' + (p.fileCount !== null ? ' Будет записано файлов: ' + p.fileCount + '.' : '') }));
    } else if (p.fileCount !== null) {
      card.append(el('p', { class: 'small muted', text: 'Файлов в плане: ' + p.fileCount + ', но пока есть блокировки, ничего записано не будет.' }));
    }
    if (p.warnings.length) {
      card.append(el('ul', { class: 'status-list', id: 'preflight-warnings' }, p.warnings.map((w) => el('li', null, el('span', { text: w })))));
    }
    return card;
  }

  async function install() {
    if (state.busy) return;
    if (!installReady()) return;
    const cfg = currentConfig();
    state.busy = 'install';
    state.installErrors = [];
    state.animate = false;
    render('btn-install');
    announce('Установка началась');
    const known = secrets();
    const res = await api('POST', '/api/install', cfg, 240000);
    state.busy = '';
    if (res.data && res.data.ok === true) {
      state.result = Core.extractInstallResult(res.data, known);
      state.phase = 'done';
      // Секреты больше не нужны: убираем их из памяти вкладки.
      state.apiKey = '';
      state.values = {};
      state.animate = true;
      render('panelTitle');
      announce('Установка завершена');
      return;
    }
    const p = problems(res);
    state.installErrors = p.messages;
    state.animate = false;
    if (res.status === 409 || /harness/i.test(p.code)) {
      render('install-errors');
      announce('Установка не выполнена');
      refreshEnvironment();
      return;
    }
    render('install-errors');
    announce('Установка не выполнена');
  }

  /* ---------- Готово ---------- */

  function renderDone() {
    const r = state.result || { backupPath: '', rollback: { text: '', steps: [], command: '' }, warnings: [] };
    const root = el('div');
    root.append(el('div', { class: 'done-mark', 'aria-hidden': 'true', text: '✓' }));
    root.append(...heading('Готово', 'Файлы профиля записаны',
      'Установщик записал профиль и ничего не запускал: не открывал DSH, не стартовал MCP и не обращался к модели. Работу связи с CLIProxyAPI и MCP он не проверял.'));

    root.append(el('section', { class: 'card', 'aria-labelledby': 'h-next' },
      el('h2', { id: 'h-next', text: 'Что дальше' }),
      el('ol', { class: 'next-list' },
        el('li', { text: 'Откройте DSH сами — установщик его не запускает.' }),
        el('li', { text: 'Начните новую сессию: старые сессии не подхватят новые настройки.' }),
        el('li', { text: 'Вход и авторизации выполняются вручную: аккаунт DeepSeek, Google OAuth, токены GitLab, Bitbucket, Jira и Confluence — только для того, что вы выбрали.' }),
        el('li', { text: 'MCP-пакеты могут скачиваться из сети при первом запуске, поэтому первый старт может занять время.' }))));

    if (r.warnings.length) {
      root.append(callout('warn', 'Предупреждения сервера', el('ul', null, r.warnings.map((w) => el('li', { text: w })))));
    }

    const rb = r.rollback;
    const hasRb = rb.text || rb.steps.length || rb.command;
    root.append(el('section', { class: 'card', 'aria-labelledby': 'h-backup' },
      el('h2', { id: 'h-backup', text: 'Резервная копия и откат' }),
      r.profilePath ? [el('p', { class: 'small muted', text: 'Новый профиль DSH:' }), el('code', { class: 'path-box', text: r.profilePath })] : null,
      r.backupPath
        ? [el('p', { class: 'small muted', text: 'Предыдущие настройки сохранены здесь:' }), el('code', { class: 'path-box', text: r.backupPath })]
        : el('p', { id: 'no-backup', class: 'muted', text: 'Резервная копия не создавалась: это чистая установка, существующие файлы установщик не перезаписывал.' }),
      hasRb ? el('div', null,
        el('h3', { text: 'Как откатить' }),
        rb.text ? el('p', { text: rb.text }) : null,
        rb.steps.length ? el('ol', { class: 'next-list' }, rb.steps.map((s) => el('li', { text: s }))) : null,
        rb.command ? el('code', { class: 'path-box', text: rb.command }) : null) : el('p', { class: 'muted small', text: 'Инструкцию по откату сервер не передал.' })));

    root.append(el('p', { class: 'muted small', text: 'Эту вкладку можно закрыть.' }));
    return root;
  }

  /* ---------- Общие экраны ---------- */

  function renderLoading() {
    return el('div', null, el('h1', { id: 'panelTitle', tabindex: '-1', text: 'Подключаемся к установщику…' }),
      el('p', { class: 'loading', role: 'status', text: 'Загружаем данные с локального сервера.' }));
  }

  function renderFatal() {
    return el('div', null, ...heading('Ошибка', 'Не удалось запустить мастер'),
      callout('bad', null, el('ul', null, state.fatal.map((m) => el('li', { text: m })))),
      el('div', { class: 'actions' }, el('span'),
        el('button', { type: 'button', class: 'btn btn--primary', id: 'btn-retry', onclick: bootstrap, text: 'Повторить' })));
  }

  /* ---------- Рендер ---------- */

  function render(focusTarget, keepFocusId) {
    renderRail();
    const content = state.phase === 'loading' ? renderLoading()
      : state.phase === 'fatal' ? renderFatal()
        : state.phase === 'done' ? renderDone()
          : [renderTutorial, renderApi, renderMcp, renderRoles, renderReview][state.step]();

    $panel.textContent = '';
    $panel.classList.remove('enter');
    if (state.animate) { void $panel.offsetWidth; $panel.classList.add('enter'); }
    $panel.append(content);
    document.title = 'DSH Setup — ' + (state.phase === 'wizard' ? STEPS[state.step].title : 'установка');

    const target = focusTarget || keepFocusId;
    if (target && focusId(target)) return;
    if (state.animate) {
      const h = document.getElementById('panelTitle');
      if (h) h.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  /* ---------- Старт ---------- */

  function start() {
    // Одноразовый токен из фрагмента: забираем и сразу убираем из адресной строки и истории.
    const fragToken = Core.parseFragmentToken(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    if (fragToken) state.token = fragToken;
    bootstrap();
  }

  start();
})();
