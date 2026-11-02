'use strict';
/*
 * Тестовый макет бэкенда: отдаёт статику ui/ и имитирует /api/*.
 * Данные ниже — ТОЛЬКО тестовые заглушки, не настоящие значения установщика.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const UI_DIR = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const MCP_IDS = ['obscura', 'bitbucket', 'gitlab', 'kibana', 'jira', 'confluence', 'sequential-thinking', 'memory', 'google-sheets'];
const FIELDS = {
  bitbucket: [
    { key: 'url', label: 'Адрес Bitbucket', secret: false, required: true, placeholder: 'https://git.example.test' },
    { key: 'token', label: 'Токен', secret: true, required: true, placeholder: '' },
  ],
  gitlab: [
    { key: 'url', label: 'Server URL', secret: false, required: true, placeholder: 'https://example.com' },
    { key: 'token', label: 'Token', secret: true, required: true, placeholder: '' },
  ],
  jira: [
    { key: 'url', label: 'Адрес Jira', secret: false, required: true, placeholder: '' },
    { key: 'token', label: 'Токен', secret: true, required: false, placeholder: '' },
  ],
};

function defaults(o) {
  return {
    apiUrl: '',
    // Повторяет форму ответа реального сервера: main и orchestrator, пустая модель у orchestrator.
    roles: {
      orchestrator: { model: '', effort: 'high' },
      oracle: { model: 'test-oracle-model', effort: 'high' },
      designer: { model: 'test-mid-model', effort: 'medium' },
      fixer: { model: 'test-mid-model', effort: 'medium' },
      explorer: { model: 'test-deepseek-flash', effort: 'low' },
      librarian: { model: 'cliproxy/grok-4.7', effort: '' },
      main: { model: 'test-main-model', effort: '' },
    },
    mcps: MCP_IDS.map((id) => ({
      id, label: id === 'gitlab' ? 'GitLab' : id, description: id === 'gitlab' ? 'Alternative to Bitbucket. Use a token with read permissions as described in the server documentation.' : 'Описание ' + id, fields: FIELDS[id] || [],
      requires: id === 'kibana' || id === 'jira' ? [{ id: 'uvx' }] : id === 'obscura' ? [{ id: 'obscura-bin', label: 'Obscura', instructions: ['Установите совместимый бинарник вручную'] }] : [],
    })),
  };
}

// Форма окружения повторяет lib/environment.js: checks[{id,ok,message}], blockers[], targetHome.
function env(o) {
  const checks = [
    { id: 'platform', ok: true, message: 'macOS detected.' },
    { id: 'app', ok: true, message: 'Supported DeepSeek Harness app verified.' },
    { id: 'node', ok: true, message: 'Bundled Node.js 20 or newer verified.' },
    { id: 'uvx', ok: !o.missingUvx, message: o.missingUvx ? 'uvx is required and was not found on the target PATH.' : 'uvx found.' },
    { id: 'process', ok: !o.harnessRunning, message: o.harnessRunning ? 'Quit the target DeepSeek Harness application and its main host before installation.' : 'Target DeepSeek Harness processes are stopped.' },
  ];
  const blockers = checks.filter((c) => !c.ok).map((c) => c.message);
  return { ok: blockers.length === 0, checks, blockers, targetHome: '/Users/test/.dsh' };
}

function createServer(opts) {
  const o = Object.assign({ token: 'test-token-12345678', harnessRunning: false, validateOk: true, installOk: true, withModels: true, installStatus: 200 }, opts);
  const log = { requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const headerToken = req.headers['x-dsh-setup-token'];
        log.requests.push({ method: req.method, path: url.pathname, token: headerToken, body: body ? JSON.parse(body) : null });
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (headerToken !== o.token) return send(403, { ok: false, error: 'forbidden' });
        if (url.pathname === '/api/bootstrap') {
          const d = defaults(o);
          // withEfforts: false — как реальный bootstrap сейчас: уровней по моделям нет совсем.
          if (o.withEfforts !== false) d.efforts = { 'test-main-model': ['low', 'high'], 'test-oracle-model': ['low', 'medium', 'high'], 'test-no-effort-model': [] };
          if (o.withModels) d.models = ['test-main-model', 'test-oracle-model', 'test-mid-model', 'test-deepseek-flash', 'test-no-effort-model', 'cliproxy/grok-4.7'];
          return send(200, { ok: true, defaults: d, environment: env(o) });
        }
        if (url.pathname === '/api/validate') {
          if (!o.validateOk) return send(400, { ok: false, error: 'Ключ отклонён: ' + JSON.parse(body).apiKey });
          // Форма как в server.js: blockers бывают и при ok:true.
          return send(200, {
            ok: true, apiUrl: JSON.parse(body).apiUrl + '/v1',
            environment: env(o),
            blockers: o.validateBlockers || [],
            warnings: o.validateWarnings || [],
            preview: { fileCount: 7, relayPort: 41234 },
            message: 'Configuration is structurally valid. No network request was made.',
          });
        }
        if (url.pathname === '/api/install') {
          if (!o.installOk) return send(o.installStatus, { ok: false, code: 'harness_running', error: 'Quit DeepSeek Harness before installation.' });
          if (o.preflightFail) return send(409, { ok: false, code: 'PREFLIGHT_FAILED', error: 'Installation prerequisites are not satisfied.', blockers: ['BLOCKER: Native profile generation is not implemented.'] });
          // Форма успеха как в server.js: backupPath: null, rollback.instructions.
          if (o.realShapeInstall) return send(200, { ok: true, profilePath: '/Users/test/.dsh/profiles/desktop', backupPath: null, rollback: { instructions: 'Remove the installed profile and installer files only after confirming they are no longer needed.' }, warnings: [] });
          return send(200, { ok: true, profilePath: '/Users/test/.dsh', backupPath: '/tmp/dsh-backup-test', rollback: { steps: ['Остановите DSH', 'Верните файлы из копии'] } });
        }
        return send(404, { ok: false });
      });
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(UI_DIR, rel);
    if (!file.startsWith(UI_DIR) || rel.includes('tests/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return { server, log, options: o };
}

function listen(opts) {
  const s = createServer(opts);
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => {
    resolve({ ...s, port: s.server.address().port, close: () => new Promise((r) => s.server.close(r)) });
  }));
}

module.exports = { listen };

if (require.main === module) {
  listen().then((s) => {
    process.stdout.write('http://127.0.0.1:' + s.port + '/#token=' + s.options.token + '\n');
  });
}
