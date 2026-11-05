/*
 * DSH Setup — чистая логика интерфейса (без DOM, без сети).
 * Подключается и как обычный <script>, и как CommonJS-модуль для node:test.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSHCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MASK = '••••••••';
  const TOKEN_RE = /^[A-Za-z0-9._~+\-/=]{8,512}$/;

  /* ---------- Токен из фрагмента ---------- */

  function parseFragmentToken(hash) {
    let h = String(hash || '');
    if (h.startsWith('#')) h = h.slice(1);
    if (!h) return '';
    const params = new URLSearchParams(h);
    for (const name of ['token', 't', 'capability', 'cap']) {
      if (params.has(name)) {
        const v = params.get(name) || '';
        return TOKEN_RE.test(v) ? v : '';
      }
    }
    let raw = h;
    try { raw = decodeURIComponent(h); } catch (_) { /* оставляем как есть */ }
    return TOKEN_RE.test(raw) ? raw : '';
  }

  /* ---------- Секреты и сообщения ---------- */

  function maskSecret(value) {
    return value ? MASK : '—';
  }

  function redactSecrets(text, secrets) {
    let out = String(text == null ? '' : text);
    const list = (secrets || [])
      .filter((s) => typeof s === 'string' && s.length >= 4)
      .sort((a, b) => b.length - a.length);
    for (const s of list) out = out.split(s).join(MASK);
    return out;
  }

  function sanitizeText(text, secrets, max) {
    const limit = max || 500;
    let out = String(text == null ? '' : text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    out = redactSecrets(out, secrets);
    if (out.length > limit) out = out.slice(0, limit - 1) + '…';
    return out;
  }

  /** Известные сообщения локального сервера установщика -> по-русски. Остальное остаётся как есть. */
  const KNOWN_TEXT = [
    [/^Installation is not yet available; no files were changed\.?$/i, 'Установка пока недоступна на стороне сервера установщика. Файлы не изменены.'],
    [/^Clean-profile installation is not yet available; no files will be changed\.?$/i, 'Установка в чистый профиль пока недоступна в этой сборке. Файлы не будут изменены.'],
    [/^macOS is required\.?$/i, 'Установщик работает только на macOS.'],
    [/^DeepSeek Harness (\S+) is required in \/Applications\.?$/i, 'Нужен Harness $1 в папке «Программы» (/Applications).'],
    [/^Could not verify that DeepSeek Harness is stopped\.?$/i, 'Не удалось проверить, что Harness закрыт.'],
    [/^Quit DeepSeek Harness before installation\.?$/i, 'Закройте Harness и нажмите «Проверить снова».'],
    [/^Home directory could not be determined\.?$/i, 'Не удалось определить домашнюю папку.'],
    [/^Existing \.dsh profile is not empty; this installer will not modify it\.?$/i, 'В ~/.dsh уже есть данные. Установщик не изменяет непустой профиль.'],
    [/^Could not inspect the target profile safely\.?$/i, 'Не удалось безопасно проверить целевой профиль.'],
    [/^Configuration is structurally valid\. No network request was made\.?$/i, 'Структура настроек корректна. Сетевой запрос к CLIProxyAPI не выполнялся.'],
    [/^macOS detected\.?$/i, 'macOS обнаружена.'],
    [/^Supported DeepSeek Harness app verified\.?$/i, 'Поддерживаемая версия Harness найдена.'],
    [/^DeepSeek Harness (\S+) with bundle ID \S+ is required\.?$/i, 'Нужен Harness $1 (точно эта версия) в «Программах».'],
    [/^Bundled Node\.js 20 or newer verified\.?$/i, 'Встроенный Node.js 20+ работает.'],
    [/^The Harness bundled Node\.js 20 or newer could not be executed\.?$/i, 'Не удалось запустить встроенный Node.js 20+ из Harness.'],
    [/^Bundled (\S+) found\.?$/i, 'Встроенный $1 найден.'],
    [/^Bundled (\S+) not found\.?$/i, 'Встроенный $1 не найден.'],
    [/^(\S+) found\.?$/i, '$1 найден.'],
    [/^(\S+) is required and was not found on the target PATH\.?$/i, '$1 не найден в PATH. Установите его вручную и нажмите «Проверить снова».'],
    [/^Quit the target DeepSeek Harness application and its main host before installation\.?$/i, 'Закройте Harness и его main host и нажмите «Проверить снова».'],
    [/^Target DeepSeek Harness processes are stopped\.?$/i, 'Harness закрыт.'],
    [/^Could not safely inspect DeepSeek Harness processes\.?$/i, 'Не удалось безопасно проверить процессы Harness.'],
    [/^Invalid MCP selection\.?$/i, 'Некорректный выбор MCP.'],
    [/^MCP and role selections are required\.?$/i, 'Нужны выбор MCP и настройки ролей.'],
    [/^JSON required$/i, 'Сервер ожидает JSON (ошибка установщика).'],
    [/^GitLab URL is invalid\.?$/i, 'Адрес GitLab выглядит неверно.'],
    [/^GitLab URL must be an HTTPS origin or its \/api\/v4 endpoint, without credentials, query, or fragment\.?$/i, 'Адрес GitLab: только HTTPS, адрес сервера или его /api/v4, без логина, пароля, «?» и «#».'],
    [/^([\w .-]+): (.+) is required\.?$/i, (m, a, b) => a + ': заполните поле «' + translateCatalog(b) + '».'],
    [/^Invalid (\w+) role\.?$/i, 'Некорректные настройки роли $1.'],
    [/^Forbidden$/i, 'Сессия установщика недействительна. Закройте вкладку и запустите установщик заново.'],
    [/^Request too large$/i, 'Запрос слишком большой для сервера.'],
    [/^Installation prerequisites are not satisfied\.?$/i, 'Условия для установки не выполнены.'],
    [/^Installation could not be completed\.?$/i, 'Установку завершить не удалось.'],
    [/^Invalid configuration or installation plan\.?$/i, 'Сервер не принял настройки. Проверьте заполненные поля.'],
    [/^Environment inspection failed\.?$/i, 'Не удалось проверить окружение.'],
    [/^Orchestrator model override is not supported; use an empty model to inherit\.?$/i, 'Модель роутера задать нельзя: он наследует основную.'],
    [/^Main role effort is not supported; leave it empty\.?$/i, 'Уровень усилия основной модели задаётся в сессии, а не при установке.'],
    [/^Invalid (\w+) model route\.?$/i, 'Модель роли $1 указана неверно: нужен вид «провайдер/модель» с поддерживаемым провайдером.'],
    [/^Invalid (\w+) effort for Grok\.?$/i, 'Для Grok у роли $1 уровень усилия задавать нельзя.'],
    [/^Remove the installed profile and installer files only after confirming they are no longer needed\.?$/i, 'Удаляйте установленный профиль и файлы установщика только после того, как убедитесь, что они больше не нужны.'],
    [/^(uvx|npx) is required for ([\w-]+)\.?$/i, '$1 нужен для «$2», но не найден. Установите его вручную и нажмите «Проверить снова».'],
    [/^Node\.js 24 or newer is required for ([\w-]+)\.?$/i, 'Для «$1» нужен Node.js 24 или новее.'],
    [/^A verified Node\.js 24 or newer for npx is required\.?$/i, 'Для npx нужен проверенный Node.js 24 или новее.'],
    [/^Executable for ([\w-]+) is unavailable\.?$/i, 'Исполняемый файл для «$1» недоступен.'],
    [/^(\S+) may require network access on first launch\.?$/i, '$1 при первом запуске может скачиваться из сети.'],
    [/^Node\.js 24 or newer must be verified for ([\w-]+)\.?$/i, 'Версию Node.js (нужен 24 или новее) для «$1» не удалось проверить.'],
    [/^Invalid JSON$/i, 'Сервер не смог прочитать запрос (некорректный JSON).'],
    [/^API key is required\.?$/i, 'Укажите API-ключ.'],
    [/^API URL is required\.?$/i, 'Укажите адрес CLIProxyAPI.'],
    [/^API URL is invalid\.?$/i, 'Адрес выглядит неверно.'],
    [/^API URL must not contain credentials, query, or fragment\.?$/i, 'В адресе не должно быть логина, пароля, «?» и «#».'],
    [/^Use HTTPS, or HTTP for localhost only\.?$/i, 'Используйте HTTPS. HTTP допустим только для localhost.'],
  ];
  function translateServerText(text) {
    const t = String(text == null ? '' : text).trim();
    for (const [re, ru] of KNOWN_TEXT) if (re.test(t)) return t.replace(re, ru);
    return translateCatalog(t) === t ? t : translateCatalog(t);
  }

  /**
   * Подписи и описания из каталога MCP приходят от сервера на английском.
   * Известные строки переводим, остальное показываем как есть — ничего не выдумываем.
   */
  const CATALOG_TEXT = [
    [/^Server URL$/i, 'Адрес сервера'],
    [/^Token$/i, 'Токен'],
    [/^Username$/i, 'Имя пользователя'],
    [/^Password$/i, 'Пароль'],
    [/^Binary path$/i, 'Путь к бинарнику'],
    [/^OAuth credentials JSON path$/i, 'Путь к JSON с OAuth-данными'],
    [/^OAuth token JSON path$/i, 'Путь к JSON с OAuth-токеном'],
    [/^Alternative to Bitbucket\. Use a token with read permissions as described in the server documentation\.?$/i, 'Альтернатива Bitbucket. Используйте токен с правами на чтение, как описано в документации сервера.'],
    [/^Connect to (Bitbucket|Kibana|Jira|Confluence)\.?$/i, 'Подключение к $1.'],
    [/^Requires a separately installed compatible binary\.?$/i, 'Нужен отдельно установленный совместимый бинарник.'],
    [/^Create a new local memory store\.?$/i, 'Создаёт новое локальное хранилище памяти.'],
    [/^Connect using Google OAuth credentials and a token file\.?$/i, 'Подключение через OAuth-данные Google и файл токена.'],
    [/^Local reasoning tools\.?$/i, 'Локальные инструменты рассуждения.'],
    [/^Sequential thinking$/i, 'Sequential thinking'],
    [/^API key$/i, 'API-ключ'],
    [/^Figma personal access token$/i, 'Персональный токен Figma'],
    [/^Read Figma designs with a personal access token\.?$/i, 'Чтение макетов Figma по персональному токену.'],
    [/^Up-to-date library documentation\. The API key is optional and raises rate limits\.?$/i, 'Актуальная документация библиотек. API-ключ необязателен, он повышает лимиты запросов.'],
  ];
  function translateCatalog(text) {
    const t = String(text == null ? '' : text).trim();
    for (const [re, ru] of CATALOG_TEXT) if (re.test(t)) return t.replace(re, ru);
    return t;
  }

  function httpStatusMessage(status) {
    if (!status) return 'Не удалось связаться с локальным сервером установщика. Убедитесь, что скрипт запуска ещё работает в Терминале.';
    if (status === 401 || status === 403) return 'Сессия установщика недействительна. Закройте вкладку и запустите установщик заново.';
    if (status === 404) return 'Локальный сервер не поддерживает этот запрос (404).';
    if (status === 409) return 'Сервер отклонил действие из-за текущего состояния (409). Проверьте, что Harness закрыт, и повторите.';
    if (status === 400 || status === 422) return 'Сервер не принял настройки. Проверьте заполненные поля.';
    if (status === 413) return 'Запрос слишком большой для сервера (413).';
    if (status >= 500) return 'Ошибка локального сервера установщика (' + status + ').';
    return 'Неожиданный ответ сервера (' + status + ').';
  }

  /** Служебные строки плана приходят с префиксом BLOCKER:/WARNING: — убираем его и переводим. */
  function cleanRequirement(text, secrets) {
    const raw = String(text == null ? '' : text).replace(/^\s*(BLOCKER|WARNING):\s*/i, '');
    return sanitizeText(translateServerText(raw), secrets || [], 300);
  }

  /**
   * Ответ /api/validate (и блок blockers/warnings из него).
   * blockers бывают и при ok:true — по ним установка запрещается.
   * tools — инструменты, которые сервер не нашёл (uvx/npx): для подсказки «поставьте вручную».
   */
  function normalizePreflight(data, secrets) {
    const d = data && typeof data === 'object' ? data : {};
    const list = (a) => (Array.isArray(a) ? a.slice(0, 20) : []);
    const text = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof x.message === 'string' ? x.message : '');
    const rawBlockers = list(d.blockers).map(text).filter(Boolean);
    const tools = [];
    for (const b of rawBlockers) {
      const m = /^\s*(?:BLOCKER:\s*)?(uvx|npx) is required/i.exec(b);
      if (m && !tools.includes(m[1].toLowerCase())) tools.push(m[1].toLowerCase());
    }
    const clean = (arr) => Array.from(new Set(arr.map((x) => cleanRequirement(x, secrets)).filter(Boolean)));
    const preview = d.preview && typeof d.preview === 'object' ? d.preview : {};
    return {
      blockers: clean(rawBlockers),
      warnings: clean(list(d.warnings).map(text).filter(Boolean)),
      tools,
      fileCount: Number.isInteger(preview.fileCount) && preview.fileCount >= 0 ? preview.fileCount : null,
    };
  }

  /** Коды отказов установки из server.js → понятное объяснение. Файлы при отказе не остаются наполовину записанными. */
  const ERROR_CODES = {
    PREFLIGHT_FAILED: 'Установка не началась: условия не выполнены. Закройте Harness и проверьте блок «Этот Mac и зависимости».',
    EXISTING_PROFILE: 'В ~/.dsh уже есть профиль. Установщик не перезаписывает существующие данные, файлы не изменены.',
    EXISTING_FILE: 'Один из файлов установки уже существует. Установщик ничего не перезаписывает.',
    LOCKED: 'Установка уже выполняется в другом окне. Дождитесь её окончания и повторите.',
    UNSAFE_PATH: 'Установщик отказался писать по небезопасному пути (например, через символическую ссылку).',
    INVALID_PLAN: 'Установщик не смог собрать безопасный план из этих настроек. Проверьте введённые значения.',
    ROLLBACK_FAILED: 'Установка не удалась, и откат не завершился полностью. Проверьте папку ~/.dsh вручную.',
    INSTALL_FAILED: 'Установка не удалась. Сервер откатил изменения.',
    MODEL_UNAVAILABLE: 'Список моделей изменился. Вернитесь к CLIProxyAPI, нажмите «Проверить настройки» и проверьте роли.',
    MODEL_DISCOVERY_FAILED: 'Не удалось получить список моделей CLIProxyAPI. Проверьте адрес и ключ и повторите проверку.',
    NO_MODELS: 'CLIProxyAPI не вернул моделей. Добавьте модель и повторите проверку.',
  };

  /**
   * Приводит любой ответ с ошибкой к безопасному виду.
   * Возвращает { code, messages: [{ field, message }] }
   */
  function normalizeProblems(res, secrets) {
    const status = res && res.status;
    const data = res && res.data && typeof res.data === 'object' ? res.data : null;
    const out = [];
    const push = (message, field) => {
      const m = sanitizeText(translateServerText(message), secrets);
      if (m) out.push({ field: field ? sanitizeText(field, secrets, 120) : '', message: m });
    };
    let code = '';
    if (data) {
      const c = data.code || (data.error && typeof data.error === 'object' && data.error.code);
      if (typeof c === 'string') code = sanitizeText(c, secrets, 80);
      if (Array.isArray(data.errors)) {
        for (const e of data.errors.slice(0, 20)) {
          if (typeof e === 'string') push(e);
          else if (e && typeof e === 'object') push(e.message || e.error || e.detail || '', e.field || e.path || e.key);
        }
      }
      // 409 PREFLIGHT_FAILED: конкретные причины лежат в blockers, а не в общем error.
      if (Array.isArray(data.blockers)) {
        for (const b of data.blockers.slice(0, 10)) {
          if (typeof b === 'string') push(b.replace(/^\s*(BLOCKER|WARNING):\s*/i, ''));
          else if (b && typeof b === 'object' && typeof b.message === 'string') push(b.message);
        }
      }
      if (!out.length && code && ERROR_CODES[code]) push(ERROR_CODES[code]);
      if (!out.length && data.error) {
        if (typeof data.error === 'string') push(data.error);
        else if (typeof data.error === 'object') push(data.error.message || '', data.error.field);
      }
      if (!out.length && typeof data.message === 'string') push(data.message);
    }
    if (!out.length) {
      if (res && res.aborted) push('Сервер не ответил вовремя. Проверьте подключение и повторите.');
      else push(httpStatusMessage(res && res.networkError ? 0 : status));
    }
    return { code, messages: out };
  }

  /* ---------- Адрес API ---------- */

  function validateApiUrl(value) {
    const v = String(value || '').trim();
    if (!v) return { ok: false, message: 'Укажите адрес CLIProxyAPI.' };
    let u;
    try { u = new URL(v); } catch (_) {
      return { ok: false, message: 'Адрес выглядит неверно. Пример: https://my-proxy.onrender.com' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { ok: false, message: 'Адрес должен начинаться с https:// или http://' };
    }
    if (u.username || u.password) {
      return { ok: false, message: 'Не вписывайте логин и пароль в адрес. Ключ вводится отдельно.' };
    }
    if (u.search || u.hash) {
      return { ok: false, message: 'Уберите из адреса часть после «?» или «#».' };
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    // Сервер установщика принимает HTTP только для localhost — проверяем так же.
    if (u.protocol === 'http:' && !local) {
      return { ok: false, message: 'Используйте HTTPS. HTTP допустим только для localhost.' };
    }
    return { ok: true, value: v, warning: '' };
  }

  /* ---------- Модели ---------- */

  function normalizeModels(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      let id = '';
      if (typeof item === 'string') id = item;
      else if (item && typeof item === 'object') id = item.id || item.model || item.name || '';
      id = String(id).trim();
      if (id && id.length <= 200 && !seen.has(id)) { seen.add(id); out.push(id); }
      if (out.length >= 2000) break;
    }
    return out;
  }

  /**
   * Допустимые effort. Возвращает { list, byModel }:
   * list — общий набор, byModel — набор для конкретной модели (если сервер его передал).
   * Источники: defaults.efforts (массив или {модель: [..]}), defaults.modelEfforts,
   * defaults.models / models — объекты вида { id, efforts }.
   */
  function normalizeEfforts(defaults, data) {
    const clean = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').map((x) => x.trim()) : null);
    const out = { list: [], byModel: {} };
    const d = defaults && typeof defaults === 'object' ? defaults : {};
    const top = data && typeof data === 'object' ? data : {};
    const addMap = (m) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      for (const [k, v] of Object.entries(m)) {
        const c = clean(v);
        if (c) out.byModel[k] = c;
      }
    };
    const g = clean(d.efforts);
    if (g) out.list = g.filter(Boolean);
    else addMap(d.efforts);
    addMap(d.modelEfforts);
    addMap(top.modelEfforts);
    for (const list of [d.models, top.models]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = item.id || item.model || item.name;
        const c = clean(item.efforts || item.supportedEfforts || item.reasoningEfforts);
        if (typeof id === 'string' && c) out.byModel[id] = c;
      }
    }
    return out;
  }

  /**
   * Запасное правило, пока сервер не прислал список effort по моделям:
   * у семейства Grok нет перечня уровней, сервер принимает для него только пустой effort.
   * Данные сервера по модели (в том числе пустой список) важнее этого правила.
   */
  const NO_EFFORT_MODEL = /(^|\/)grok-/i;

  /**
   * Список effort для модели: данные сервера по модели, затем запасное правило, затем общий набор.
   * none = true — у модели нет уровней: допустим только «не задан».
   */
  function effortsFor(model, efforts, fallback) {
    const m = String(model || '').trim();
    if (efforts && efforts.byModel && Array.isArray(efforts.byModel[m])) {
      const list = efforts.byModel[m].filter(Boolean);
      return { list, specific: true, none: list.length === 0 };
    }
    if (NO_EFFORT_MODEL.test(m)) return { list: [], specific: false, none: true };
    return { list: [], specific: false, none: true };
  }

  /** Совместим ли выбранный effort с моделью. Если нет — вернёт effort '' и reset: true. */
  function reconcileEffort(model, effort, efforts, fallback) {
    const cur = String(effort || '').trim();
    if (!cur) return { effort: '', reset: false, previous: '', none: false };
    const a = effortsFor(model, efforts, fallback);
    if (a.none || (a.list.length && !a.list.includes(cur))) return { effort: '', reset: true, previous: cur, none: a.none };
    return { effort: cur, reset: false, previous: '', none: false };
  }

  /** Требования MCP к зависимостям (то, что сервер передал в mcp.requires). */
  function normalizeRequirements(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw.slice(0, 12)) {
      const o = typeof r === 'string' ? { id: r } : r && typeof r === 'object' ? r : null;
      if (!o) continue;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id) continue;
      let instructions = [];
      const ins = o.instructions !== undefined ? o.instructions : o.manual;
      if (typeof ins === 'string') instructions = [ins];
      else if (Array.isArray(ins)) instructions = ins.filter((x) => typeof x === 'string');
      let url = '';
      if (typeof o.url === 'string') {
        try { const u = new URL(o.url); if (u.protocol === 'https:') url = u.href; } catch (_) { /* не ссылка */ }
      }
      out.push({
        id,
        label: typeof o.label === 'string' ? sanitizeText(o.label, [], 80) : '',
        message: typeof o.message === 'string' ? sanitizeText(translateServerText(o.message), [], 300) : '',
        ok: typeof o.ok === 'boolean' ? o.ok : null,
        instructions: instructions.slice(0, 6).map((x) => sanitizeText(translateServerText(x), [], 400)).filter(Boolean),
        url,
      });
    }
    return out;
  }

  const CHECK_LABELS = {
    platform: 'macOS',
    app: 'Harness (нужная версия)',
    node: 'Node.js из Harness',
    pnpm: 'pnpm из Harness',
    cli: 'CLI dsh из Harness',
    uvx: 'uvx (из uv)',
    npx: 'npx (из Node.js)',
    process: 'Harness закрыт',
    profile: 'Папка ~/.dsh',
  };

  function checkLabel(id) {
    return CHECK_LABELS[id] || sanitizeText(id, [], 60);
  }

  function findCheck(env, id) {
    if (!env || !Array.isArray(env.checks)) return null;
    return env.checks.find((c) => c && c.id === id) || null;
  }

  /** Состояние требований выбранного MCP относительно проверок окружения. */
  function mcpRequirementStatus(mcp, env) {
    return (mcp.requires || []).map((r) => {
      const check = findCheck(env, r.id);
      let status = 'unknown';
      if (check) status = check.ok ? 'ok' : 'bad';
      else if (r.ok === true) status = 'ok';
      else if (r.ok === false) status = 'bad';
      const message = check && typeof check.message === 'string'
        ? sanitizeText(translateServerText(check.message), [], 300)
        : r.message;
      return { id: r.id, label: r.label || checkLabel(r.id), status, message, instructions: r.instructions, url: r.url };
    });
  }

  /* ---------- Роли ---------- */

  const ROLE_INFO = {
    // lockEffort / lockModel повторяют правила lib/config.js: этих полей в профиле нет, сервер их отклонит.
    main: { label: 'Основная модель (main)', hint: 'Ведёт сессию', main: true, lockEffort: true },
    orchestrator: { label: 'Роутер (orchestrator)', hint: 'Распределяет задачи между ролями', router: true, lockModel: true },
    oracle: { label: 'Oracle', hint: 'Советник для сложных решений и ревью' },
    designer: { label: 'Designer', hint: 'Интерфейсы и визуальные задачи' },
    fixer: { label: 'Fixer', hint: 'Быстрые точечные правки' },
    explorer: { label: 'Explorer', hint: 'Поиск по коду проекта' },
    librarian: { label: 'Librarian', hint: 'Документация и внешние источники' },
  };

  function roleInfo(key) {
    const k = String(key).toLowerCase();
    return ROLE_INFO[k] || { label: String(key), hint: '' };
  }

  /** Какие поля роли не настраиваются: model (наследуется от main) и/или effort (выбирается в сессии). */
  function roleLocks(key) {
    const i = roleInfo(key);
    return { model: !!i.lockModel, effort: !!i.lockEffort };
  }

  function isMainRole(key) {
    return !!roleInfo(key).main;
  }

  /** main — основная конфигурация, router — роутер, helpers — остальные роли. */
  function roleGroup(key) {
    const i = roleInfo(key);
    return i.main ? 'main' : i.router ? 'router' : 'helpers';
  }

  /* ---------- Конфигурация ---------- */

  function trimmedValues(mcp, values) {
    const out = {};
    for (const f of mcp.fields || []) {
      const v = values && typeof values[f.key] === 'string' ? values[f.key].trim() : '';
      if (v) out[f.key] = v;
    }
    return out;
  }

  /**
   * Запасные маршруты роли: [{provider, model, effort?}]. Не массив → undefined (поле не отправляется).
   * Пустые «половинки» не чиним и не выбрасываем молча: их отклонит сервер.
   */
  function normalizeFallbacks(list) {
    if (!Array.isArray(list)) return undefined;
    return list.slice(0, 20).map((x) => {
      const e = x && typeof x === 'object' ? x : {};
      const out = { provider: String(e.provider || '').trim(), model: String(e.model || '').trim() };
      if (typeof e.effort === 'string' && e.effort.trim()) out.effort = e.effort.trim();
      return out;
    });
  }

  function fallbackLabel(f) {
    return f.provider + '/' + f.model + (f.effort ? ' · ' + f.effort : '');
  }

  function buildConfig(input) {
    const selected = new Set(input.selected || []);
    const mcps = (input.mcps || [])
      .filter((m) => selected.has(m.id))
      .map((m) => ({ id: m.id, values: trimmedValues(m, (input.values || {})[m.id]) }));
    const roles = {};
    for (const [key, r] of Object.entries(input.roles || {})) {
      // effort передаётся всегда (пустая строка = не задан): сервер требует строку.
      // Ненастраиваемые поля (модель роутера, effort main) уходят пустыми при любом состоянии формы.
      const locks = roleLocks(key);
      roles[key] = {
        model: locks.model ? '' : String(r.model || '').trim(),
        effort: locks.effort ? '' : String(r.effort || '').trim(),
      };
      // Запасные маршруты, присланные сервером, не теряем: массив (в том числе пустой) уходит как есть.
      const fb = normalizeFallbacks(r.fallbacks);
      if (fb && !locks.model) roles[key].fallbacks = fb;
    }
    return { apiUrl: String(input.apiUrl || '').trim(), apiKey: String(input.apiKey || '').trim(), mcps, roles };
  }

  /** Поля с ключом url: проверяем только форму адреса. Остальные правила (HTTPS, /api/v4) — на сервере. */
  function invalidUrlFields(mcp, values) {
    const bad = [];
    for (const f of mcp.fields || []) {
      if (f.key !== 'url') continue;
      const v = values && typeof values[f.key] === 'string' ? values[f.key].trim() : '';
      if (!v) continue;
      let u = null;
      try { u = new URL(v); } catch (_) { /* неверный адрес */ }
      let msg = '';
      if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) msg = 'введите адрес вида https://…';
      else if (u.username || u.password) msg = 'уберите логин и пароль из адреса — токен вводится отдельно';
      else if (u.search || u.hash) msg = 'уберите из адреса часть после «?» или «#»';
      if (msg) bad.push({ field: f, message: msg });
    }
    return bad;
  }

  function missingRequired(mcp, values) {
    const miss = [];
    for (const f of mcp.fields || []) {
      if (f.required && !(values && typeof values[f.key] === 'string' && values[f.key].trim())) miss.push(f);
    }
    return miss;
  }

  /** Все секреты, которые нужно вычищать из сообщений. */
  function collectSecrets(input) {
    const out = [];
    if (input.apiKey && String(input.apiKey).trim()) out.push(String(input.apiKey).trim());
    for (const m of input.mcps || []) {
      for (const f of m.fields || []) {
        const v = input.values && input.values[m.id] && input.values[m.id][f.key];
        if (f.secret && typeof v === 'string' && v.trim()) out.push(v.trim());
      }
    }
    return out;
  }

  /* ---------- Итоговая проверка (без сырых секретов) ---------- */

  function buildReview(input) {
    const selected = new Set(input.selected || []);
    const api = [
      { label: 'Адрес', value: String(input.apiUrl || '').trim() || '—' },
      { label: 'API-ключ', value: maskSecret(String(input.apiKey || '').trim()), masked: true },
    ];
    const mcps = (input.mcps || [])
      .filter((m) => selected.has(m.id))
      .map((m) => ({
        id: m.id,
        label: m.label || m.id,
        rows: (m.fields || []).map((f) => {
          const raw = input.values && input.values[m.id] ? input.values[m.id][f.key] : '';
          const has = typeof raw === 'string' && raw.trim();
          if (f.secret) return { label: f.label || f.key, value: maskSecret(has), masked: true };
          return { label: f.label || f.key, value: has ? raw.trim() : '—' };
        }),
      }));
    const meta = input.roleMeta || {};
    const roles = Object.entries(input.roles || {}).map(([key, r]) => {
      const locks = roleLocks(key);
      return {
        key,
        label: (meta[key] && meta[key].label) || roleInfo(key).label,
        main: meta[key] && typeof meta[key].main === 'boolean' ? meta[key].main : isMainRole(key),
        model: locks.model ? 'наследует основную модель' : String(r.model || '').trim() || 'не указана',
        effort: locks.effort ? 'настраивается в сессии' : String(r.effort || '').trim() || 'не задан',
        fallbacks: (normalizeFallbacks(r.fallbacks) || []).map(fallbackLabel),
      };
    });
    return { api, mcps, roles };
  }

  /* ---------- Среда ---------- */

  function isHarnessBlocked(env) {
    if (!env || typeof env !== 'object') return false;
    const h = env.harness && typeof env.harness === 'object' ? env.harness : {};
    return h.running === true || env.harnessRunning === true || env.harness_running === true;
  }

  function describeEnvironment(env) {
    const rows = [];
    if (!env || typeof env !== 'object') return rows;
    if (Array.isArray(env.checks) && env.checks.length) {
      for (const c of env.checks.slice(0, 20)) {
        if (!c || typeof c.id !== 'string') continue;
        rows.push({
          id: c.id,
          label: checkLabel(c.id),
          value: c.ok ? 'в порядке' : (typeof c.message === 'string' ? sanitizeText(translateServerText(c.message), [], 200) : 'не пройдена'),
          tone: c.ok ? 'ok' : 'bad',
        });
      }
      if (typeof env.targetHome === 'string' && env.targetHome) rows.push({ id: 'targetHome', label: 'Профиль DSH', value: sanitizeText(env.targetHome, [], 300) });
      return rows;
    }
    const h = env.harness && typeof env.harness === 'object' ? env.harness : {};
    const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
    const str = (v) => sanitizeText(v, [], 120);

    const platform = pick(env.platform, env.os);
    if (platform !== undefined && typeof platform !== 'object') rows.push({ id: 'platform', label: 'Система', value: str(platform) });

    const version = pick(h.version, env.harnessVersion, env.harness_version);
    if (version !== undefined && typeof version !== 'object') rows.push({ id: 'harnessVersion', label: 'Версия Harness', value: str(version) });

    const pinned = pick(h.pinned, env.harnessPinned, env.pinned);
    if (typeof pinned === 'boolean') {
      rows.push({ id: 'pinned', label: 'Закреплённая версия', value: pinned ? 'совпадает' : 'не совпадает', tone: pinned ? 'ok' : 'bad' });
    }

    const adapter = pick(h.statusAdapter, env.statusAdapter, env.status_adapter);
    if (adapter !== undefined) {
      let value = '';
      let tone;
      if (typeof adapter === 'boolean') { value = adapter ? 'готов' : 'не готов'; tone = adapter ? 'ok' : 'bad'; }
      else if (typeof adapter === 'string') value = str(adapter);
      else if (typeof adapter === 'object') {
        const ok = pick(adapter.ok, adapter.pinned, adapter.ready);
        const ver = pick(adapter.version);
        value = [typeof ok === 'boolean' ? (ok ? 'готов' : 'не готов') : '', ver !== undefined ? str(ver) : '']
          .filter(Boolean).join(', ');
        if (typeof ok === 'boolean') tone = ok ? 'ok' : 'bad';
      }
      if (value) rows.push({ id: 'adapter', label: 'Status-адаптер', value, tone });
    }

    const running = pick(h.running, env.harnessRunning, env.harness_running);
    if (typeof running === 'boolean') {
      rows.push({ id: 'harnessRunning', label: 'Harness сейчас', value: running ? 'запущен — закройте его' : 'закрыт', tone: running ? 'bad' : 'ok' });
    }

    return rows;
  }

  /* ---------- Результат установки ---------- */

  function extractInstallResult(res, secrets) {
    const data = res && typeof res === 'object' ? res : {};
    const s = (v, max) => sanitizeText(translateServerText(v), secrets, max || 600);
    let backupPath = '';
    const b = data.backupPath || data.backup_path || data.backupDir || data.backup;
    if (typeof b === 'string') backupPath = s(b, 1000);
    else if (b && typeof b === 'object') backupPath = s(b.path || b.dir || '', 1000);

    const rb = data.rollback;
    const rollback = { text: '', steps: [], command: '' };
    if (typeof rb === 'string') rollback.text = s(rb, 1500);
    else if (Array.isArray(rb)) rollback.steps = rb.map((x) => s(x)).filter(Boolean).slice(0, 12);
    else if (rb && typeof rb === 'object') {
      rollback.text = s(rb.instructions || rb.text || rb.message || '', 1500);
      if (Array.isArray(rb.steps)) rollback.steps = rb.steps.map((x) => s(x)).filter(Boolean).slice(0, 12);
      if (typeof rb.command === 'string') rollback.command = s(rb.command, 500);
    }
    const warnings = Array.isArray(data.warnings)
      ? data.warnings.map((w) => cleanRequirement(typeof w === 'string' ? w : (w && w.message) || '', secrets)).filter(Boolean).slice(0, 12)
      : [];
    const pp = data.profilePath || data.targetHome || data.profile;
    const profilePath = typeof pp === 'string' ? s(pp, 1000) : '';
    return { backupPath, profilePath, rollback, warnings };
  }

  /** Что мешает установке по данным сервера. Пустой список — блокировок нет. */
  function installBlockers(env) {
    const out = [];
    if (!env || typeof env !== 'object') return out;
    const h = env.harness && typeof env.harness === 'object' ? env.harness : {};
    const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
    const platform = pick(env.platform, env.os);
    if (typeof platform === 'string' && !/^(darwin|macos|mac os|mac)/i.test(platform.trim())) {
      out.push('Установщик работает только на macOS.');
    }
    if (isHarnessBlocked(env)) out.push('Закройте Harness и нажмите «Проверить снова».');
    const pinned = pick(h.pinned, env.harnessPinned, env.pinned);
    if (pinned === false) out.push('Версия Harness не совпадает с закреплённой (rc5).');
    const adapter = pick(h.statusAdapter, env.statusAdapter, env.status_adapter);
    if (adapter === false || (adapter && typeof adapter === 'object' && (adapter.ok === false || adapter.ready === false || adapter.pinned === false))) {
      out.push('Status-адаптер не готов или не совпадает с закреплённой версией.');
    }
    if (Array.isArray(env.checks)) {
      for (const c of env.checks.slice(0, 20)) {
        if (c && c.ok === false && typeof c.message === 'string') out.push(sanitizeText(translateServerText(c.message), [], 300));
      }
    }
    const blockers = pick(env.blockers, env.problems);
    if (Array.isArray(blockers)) {
      for (const b of blockers.slice(0, 10)) {
        if (typeof b === 'string') out.push(sanitizeText(translateServerText(b), [], 300));
        else if (b && typeof b === 'object' && typeof b.message === 'string') out.push(sanitizeText(translateServerText(b.message), [], 300));
      }
    }
    if (!out.length && env.ok === false) out.push('Сервер сообщил, что окружение не готово к установке.');
    return Array.from(new Set(out.filter(Boolean)));
  }

  /** Ссылки «общий доступ на чтение» по ролям — только если их передал сервер. */
  function normalizeAccess(defaults) {
    const out = {};
    if (!defaults || typeof defaults !== 'object') return out;
    const num = (v) => {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
      if (v && typeof v === 'object') {
        for (const k of ['sharedRead', 'shared_read', 'read', 'count']) {
          if (typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0) return Math.floor(v[k]);
        }
      }
      return null;
    };
    const map = defaults.roleAccess || defaults.access || defaults.sharedRead;
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [k, v] of Object.entries(map)) {
        const n = num(v);
        if (n !== null) out[k] = n;
      }
    }
    if (defaults.roles && typeof defaults.roles === 'object') {
      for (const [k, v] of Object.entries(defaults.roles)) {
        if (out[k] !== undefined || !v || typeof v !== 'object') continue;
        const n = num(v.sharedRead !== undefined ? v.sharedRead : v.access);
        if (n !== null) out[k] = n;
      }
    }
    return out;
  }

  function isDeepSeekModel(id) {
    return /deepseek/i.test(String(id || ''));
  }

  function pluralRu(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  /* ---------- Обновление существующей установки ---------- */

  const UPDATE_OPS = {
    create: 'Создать', add: 'Создать', write: 'Записать', replace: 'Заменить', update: 'Обновить',
    overwrite: 'Заменить', symlink: 'Ссылка', remove: 'Удалить', delete: 'Удалить', skip: 'Пропустить', keep: 'Оставить',
    unchanged: 'Без изменений', preserve: 'Оставить', merge: 'Объединить',
  };
  // Только пометки «ничего не пишется»: по ним считаем, сколько файлов реально изменится.
  const UPDATE_REASONS = {
    RELAY_WORKAROUND_PRESERVED: 'Ваша настройка relay сохранена.',
    EXTRA_FILE_PRESERVED: 'Дополнительный файл не из установщика сохранён.',
    YAML_ALIAS_PRESERVED: 'Прежние алиасы моделей специалистов в каталоге сохранены на случай ссылок и комментариев; роли используют собственные резервные модели.',
  };
  const UPDATE_NOOP_OPS = ['skip', 'keep', 'unchanged', 'preserve'];

  const UPDATE_CODES = {
    PREVIEW_REQUIRED: 'Сначала постройте предпросмотр: применять можно только его результат.',
    PLAN_REQUIRED: 'Сначала постройте предпросмотр: применять можно только его результат.',
    STALE_PLAN: 'План устарел: файлы изменились после предпросмотра. Постройте предпросмотр заново.',
    PLAN_STALE: 'План устарел: файлы изменились после предпросмотра. Постройте предпросмотр заново.',
    PLAN_MISMATCH: 'План не совпадает с текущим состоянием файлов. Постройте предпросмотр заново.',
    PLAN_HASH_MISMATCH: 'План не совпадает с текущим состоянием файлов. Постройте предпросмотр заново.',
    CONFIRMATION_REQUIRED: 'Нужно подтвердить замену файлов, которыми управляет установщик.',
    ACKNOWLEDGEMENT_REQUIRED: 'Нужно подтвердить замену файлов, которыми управляет установщик.',
    CONFLICTS: 'В плане есть конфликты. Применить его нельзя, пока они не устранены.',
    PLAN_CONFLICTS: 'В плане есть конфликты. Применить его нельзя, пока они не устранены.',
    HARNESS_RUNNING: 'Harness запущен. Закройте его и постройте предпросмотр заново.',
    APP_RUNNING: 'Harness запущен. Закройте его и постройте предпросмотр заново.',
    ACK_REQUIRED: 'Нужно подтвердить замену файлов, которыми управляет установщик.',
    PATCH_UNPARSEABLE: 'Не удалось безопасно разобрать профиль. Проверьте синтаксис JSON/YAML.',
    PATCH_YAML_UNSUPPORTED: 'Профиль содержит YAML-конструкции, которые пока нельзя безопасно изменить. Файлы не изменены.',
    PREFLIGHT_FAILED: 'Условия для обновления не выполнены. Закройте Harness и проверьте окружение.',
    NO_PROFILE: 'Существующая установка не найдена. Для нового профиля используйте «Новая установка».',
    PROFILE_NOT_FOUND: 'Существующая установка не найдена. Для нового профиля используйте «Новая установка».',
    NOT_INSTALLED: 'Существующая установка не найдена. Для нового профиля используйте «Новая установка».',
    LOCKED: 'Обновление уже выполняется в другом окне. Дождитесь окончания и повторите.',
    UNSAFE_PATH: 'Установщик отказался писать по небезопасному пути (например, через символическую ссылку).',
    ROLLBACK_FAILED: 'Обновление не удалось, и откат не завершился полностью. Проверьте папку ~/.dsh вручную.',
    UPDATE_FAILED: 'Обновление не удалось. Постройте предпросмотр заново.',
    PROFILE_MISSING: 'Существующая установка не найдена. Для нового профиля используйте «Новая установка».',
    TREE_VERSION_MISMATCH: 'Версия установленного плагина неизвестна или не совпадает с ожидаемой, поэтому перезаписывать его файлы нельзя. Файлы не тронуты.',
    PIN_CONFLICT: 'Версия или привязка в профиле не совпадает с ожидаемой. Автоматически обновить нельзя, файлы не тронуты.',
    LINK_CONFLICT: 'Символическая ссылка в профиле ведёт не туда, куда ожидалось. Файлы не тронуты.',
    UNEXPECTED_LOCK: 'Найден неожиданный файл блокировки. Дождитесь окончания другой операции или проверьте ~/.dsh вручную.',
    APP_INCOMPATIBLE: 'Установленная версия Harness не подходит для этого обновления. Файлы не тронуты.',
    ENV_CHECK_FAILED: 'Не удалось проверить окружение. Закройте Harness и повторите предпросмотр.',
    PACKAGE_UNPARSEABLE: 'Не удалось прочитать файл package.json в профиле. Файлы не тронуты.',
    PACKAGE_SHAPE: 'Структура package.json в профиле отличается от ожидаемой. Файлы не тронуты.',
    PATCH_SHAPE: 'Структура файла настроек отличается от ожидаемой, изменить его автоматически нельзя. Файлы не тронуты.',
    PATCH_ENTRY_MISSING: 'В файле настроек нет записи, которую нужно обновить. Файлы не тронуты.',
    DUPLICATE_ENTRY: 'В файле настроек запись повторяется. Автоматически обновить нельзя, файлы не тронуты.',
    UNSAFE_PAYLOAD: 'Установщик отказался записывать небезопасное содержимое. Файлы не тронуты.',
    READ_FAILED: 'Не удалось прочитать файлы профиля. Проверьте доступ к ~/.dsh и повторите.',
    CLEANUP_INPUT_INVALID: 'Не удалось безопасно подготовить очистку. Проверьте настройки.',
    CLEANUP_CATALOG_INVALID: 'Каталог моделей имеет неподдерживаемую структуру или повторяющиеся идентификаторы.',
    CLEANUP_MAIN_MODEL_INVALID: 'Выберите существующий идентификатор обычной модели из каталога, не fallback-алиас.',
    CLEANUP_ALIAS_REFERENCED: 'На fallback-алиас остаются ссылки в настройках. Удалите их вручную и повторите предпросмотр.',
    RELAY_HASH_MISMATCH: 'Relay отличается от ожидаемой версии. Автоматически заменить его нельзя.',
  };
  const UPDATE_CONFLICT_TEXT = {
    HARNESS_RUNNING: 'Harness запущен — его нужно закрыть.',
    APP_RUNNING: 'Harness запущен — его нужно закрыть.',
    PATCH_UNPARSEABLE: 'Не удалось безопасно разобрать профиль. Проверьте синтаксис JSON/YAML.',
    PATCH_YAML_UNSUPPORTED: 'Профиль содержит YAML-конструкции, которые пока нельзя безопасно изменить. Файлы не изменены.',
    USER_MODIFIED: 'Файл изменён вручную и не совпадает с тем, что записал установщик.',
    MODIFIED_MANAGED_FILE: 'Файл изменён вручную и не совпадает с тем, что записал установщик.',
    UNMANAGED_FILE: 'По этому пути лежит файл, который установщик не создавал.',
    UNSAFE_PATH: 'Небезопасный путь (например, символическая ссылка).',
    MANIFEST_MISSING: 'Не найден манифест установки.',
    NOT_INSTALLED: 'Существующая установка не найдена.',
    PROFILE_MISSING: 'Существующая установка не найдена.',
    TREE_VERSION_MISMATCH: 'Версия установленного плагина неизвестна или не совпадает с ожидаемой, поэтому перезаписывать его файлы нельзя.',
    PIN_CONFLICT: 'Версия или привязка в профиле не совпадает с ожидаемой.',
    LINK_CONFLICT: 'Символическая ссылка ведёт не туда, куда ожидалось.',
    UNEXPECTED_LOCK: 'Найден неожиданный файл блокировки.',
    APP_INCOMPATIBLE: 'Установленная версия Harness не подходит для обновления.',
    ENV_CHECK_FAILED: 'Не удалось проверить окружение.',
    PACKAGE_UNPARSEABLE: 'Не удалось прочитать package.json.',
    PACKAGE_SHAPE: 'Структура package.json отличается от ожидаемой.',
    PATCH_SHAPE: 'Структура файла настроек отличается от ожидаемой.',
    PATCH_ENTRY_MISSING: 'В файле настроек нет нужной записи.',
    DUPLICATE_ENTRY: 'Запись в файле настроек повторяется.',
    UNSAFE_PAYLOAD: 'Небезопасное содержимое для записи.',
    READ_FAILED: 'Не удалось прочитать файл.',
  };

  const UPDATE_WARNING_TEXT = {
    NATIVE_FALLBACK_MIGRATION: 'Резервные модели ролей будут перенесены в Oh My DSH Slim (пять специалистов).',
    ALIAS_STILL_REFERENCED: 'На прежний алиас модели всё ещё есть ссылки, поэтому он сохранён. Проверьте настройки после обновления.',
  };

  const PLAN_HASH_RE = /^[A-Za-z0-9._:\-]{8,200}$/;

  function updateOpLabel(op) {
    const key = String(op || '').toLowerCase();
    return UPDATE_OPS[key] || sanitizeText(op, [], 40) || '—';
  }

  function safeCode(code, secrets) {
    return sanitizeText(code, secrets, 80).replace(/[^A-Za-z0-9_.:\- ]/g, '');
  }

  /**
   * Ответ /api/update {dryRun:true} → безопасная модель предпросмотра.
   * canApply — только если ok:true, есть planHash, нет конфликтов и разбор не нашёл странностей.
   */
  function normalizeUpdatePreview(data, secrets) {
    const d = data && typeof data === 'object' ? data : {};
    const rawActions = Array.isArray(d.actions) ? d.actions : null;
    const actions = (rawActions || []).slice(0, 500).map((a) => {
      const x = a && typeof a === 'object' ? a : {};
      const op = String(x.op || '').toLowerCase();
      return {
        op,
        label: updateOpLabel(x.op),
        path: sanitizeText(x.path, secrets, 300),
        reason: UPDATE_REASONS[String(x.reason || '').toUpperCase()] || sanitizeText(translateServerText(x.reason || ''), secrets, 300),
        noop: UPDATE_NOOP_OPS.includes(op),
        needsAck: x.needsAck === true && !UPDATE_NOOP_OPS.includes(op),
      };
    });
    const conflicts = (Array.isArray(d.conflicts) ? d.conflicts : []).slice(0, 50).map((c) => {
      const code = safeCode(c && typeof c === 'object' ? (c.code || c.id || '') : c, secrets);
      const detail = c && typeof c === 'object' ? sanitizeText(translateServerText(c.message || c.path || ''), secrets, 300) : '';
      return { code, text: UPDATE_CONFLICT_TEXT[code.toUpperCase()] || UPDATE_CODES[code.toUpperCase()] || '', detail };
    }).filter((c) => (c.code || c.detail) && c.code.toUpperCase() !== 'ACK_REQUIRED');
    const warnings = Array.from(new Set((Array.isArray(d.warnings) ? d.warnings : []).slice(0, 20)
      .map((w) => {
        const raw = typeof w === 'string' ? w : w && (w.code || w.message);
        return UPDATE_WARNING_TEXT[String(raw || '').trim().toUpperCase()] || cleanRequirement(typeof w === 'string' ? w : w && w.message, secrets);
      }).filter(Boolean)));
    const planHash = typeof d.planHash === 'string' && PLAN_HASH_RE.test(d.planHash) ? d.planHash : '';
    const shapeOk = d.ok === true && d.dryRun !== false && !!rawActions;
    return {
      shapeOk,
      actions,
      changeCount: actions.filter((a) => !a.noop).length,
      conflicts,
      warnings,
      planHash,
      requiresRestart: d.requiresRestart !== false,
      canApply: shapeOk && !!planHash && conflicts.length === 0 && d.canApply !== false,
    };
  }

  /** Тело apply-запроса. Бросает, если предпросмотра нет, он с конфликтами или нет подтверждения. */
  function buildUpdateApplyBody(preview, acknowledged) {
    if (!preview || !preview.canApply || !preview.planHash) throw new Error('PREVIEW_REQUIRED');
    if (acknowledged !== true) throw new Error('CONFIRMATION_REQUIRED');
    // Выбор переноса берётся из самого предпросмотра: хэш плана привязан именно к нему.
    const options = buildUpdatePreviewBody(preview.migrateNativeFallbacks, preview.cleanupLegacyFallbacks, preview.mainModel);
    return { ...options, dryRun: false, planHash: preview.planHash, acknowledgeManagedFiles: true };
  }

  /** Очистка включает перенос; модель сохраняется в плане только при очистке. */
  function buildUpdatePreviewBody(migrateNativeFallbacks, cleanupLegacyFallbacks, mainModel) {
    const cleanup = cleanupLegacyFallbacks === true;
    const body = { dryRun: true, migrateNativeFallbacks: cleanup || migrateNativeFallbacks === true };
    if (cleanup) {
      if (typeof mainModel !== 'string' || !mainModel || mainModel !== mainModel.trim() || mainModel.includes('fallback-')) throw new Error('CLEANUP_MAIN_MODEL_INVALID');
      body.cleanupLegacyFallbacks = true;
      body.mainModel = mainModel;
    }
    return body;
  }

  /** Ошибка /api/update: код + понятный текст. Код всегда проходит чистку. */
  function normalizeUpdateProblems(res, secrets) {
    const p = normalizeProblems(res, secrets);
    const raw = res && res.data && typeof res.data === 'object' ? res.data : {};
    const rawCode = typeof raw.code === 'string' ? raw.code : (raw.error && typeof raw.error === 'object' && typeof raw.error.code === 'string' ? raw.error.code : '');
    const code = safeCode(rawCode, secrets);
    const known = UPDATE_CODES[code.toUpperCase()];
    // Текст ошибки от сервера не показываем как есть: только известное объяснение по коду или общее по HTTP-статусу.
    const status = res && res.networkError ? 0 : res && res.status;
    const messages = [{ field: '', message: known || (res && res.aborted
      ? 'Сервер не ответил вовремя. Проверьте подключение и повторите.'
      : httpStatusMessage(status)) }];
    const conflicts = (Array.isArray(raw.conflicts) ? raw.conflicts : []).slice(0, 20)
      .map((c) => safeCode(c && typeof c === 'object' ? c.code : c, secrets)).filter(Boolean);
    return { code, messages, conflicts, stale: /^(STALE_PLAN|PLAN_STALE|PLAN_REQUIRED|PLAN_MISMATCH|PLAN_HASH_MISMATCH|PREVIEW_REQUIRED)$/i.test(code) };
  }

  function extractUpdateResult(data, secrets) {
    const d = data && typeof data === 'object' ? data : {};
    return {
      backupPath: typeof d.backupPath === 'string' && d.backupPath ? sanitizeText(d.backupPath, secrets, 400) : '',
      requiresRestart: d.requiresRestart !== false,
      applied: (Array.isArray(d.actions) ? d.actions : []).filter((a) => a && !UPDATE_NOOP_OPS.includes(String(a.op || '').toLowerCase())).length,
    };
  }

  return {
    normalizeFallbacks,
    fallbackLabel,
    buildUpdatePreviewBody,
    UPDATE_CODES,
    normalizeUpdatePreview,
    buildUpdateApplyBody,
    normalizeUpdateProblems,
    extractUpdateResult,
    updateOpLabel,
    MASK,
    parseFragmentToken,
    maskSecret,
    redactSecrets,
    sanitizeText,
    translateServerText,
    roleGroup,
    httpStatusMessage,
    normalizeProblems,
    validateApiUrl,
    normalizeModels,
    roleInfo,
    isMainRole,
    cleanRequirement,
    normalizePreflight,
    roleLocks,
    reconcileEffort,
    buildConfig,
    missingRequired,
    invalidUrlFields,
    translateCatalog,
    collectSecrets,
    buildReview,
    isHarnessBlocked,
    installBlockers,
    normalizeAccess,
    normalizeEfforts,
    effortsFor,
    normalizeRequirements,
    mcpRequirementStatus,
    checkLabel,
    isDeepSeekModel,
    describeEnvironment,
    extractInstallResult,
    pluralRu,
  };
});
