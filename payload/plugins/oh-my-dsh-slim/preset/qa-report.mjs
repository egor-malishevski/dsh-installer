#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const help = `Usage: node qa-report.mjs <data.json> <output.html>
Output must be a workspace-relative path under the current directory.
JSON schema (all fields required except where marked optional):
{
  "title": string, "surface": "mobile" | "web" | "hybrid", "summary": string,
  "environment": { "<name>": string },
  "requirements": [{ "requirement": string, "status": status, "details": string }],
  "scenarios": [{ "name": string, "status": status, "steps": [string] (optional),
    "expected": string (optional), "actual": string (optional),
    "evidence": [{ "label": string, "path": string }] (optional) }],
  "defects": [{ "title": string, "severity": string, "steps": [string] (optional),
    "evidence": [{ "label": string, "path": string }] (optional) }],
  "rerun": [string], "risks": [string]
}
status = "pass" | "fail" | "blocked" | "skipped". Arrays may be empty.
Evidence must exist within the workspace (including symlink targets); allowed extensions:\n.png, .jpg, .jpeg, .webp, .gif, .txt, .log, .json, .zip. Links are not embedded.
`;
const statuses = ['pass', 'fail', 'blocked', 'skipped'];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fail(message) { throw new Error(message); }
function object(v, at) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${at} must be an object`); }
function string(v, at) { if (typeof v !== 'string') fail(`${at} must be a string`); }
function array(v, at) { if (!Array.isArray(v)) fail(`${at} must be an array`); }
function localPath(v, at) {
  string(v, at);
  if (!v || /[\x00-\x1f\x7f\\]/.test(v) || v.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.split('/').some(part => part === '..' || part === '.' || !part)) fail(`${at} must be a workspace-relative local path without traversal`);
}
function stringList(v, at) { array(v, at); v.forEach((x, i) => string(x, `${at}[${i}]`)); }
function evidence(v, at) {
  array(v, at);
  v.forEach((item, i) => {
    const location = `${at}[${i}].path`;
    object(item, `${at}[${i}]`); string(item.label, `${at}[${i}].label`); localPath(item.path, location);
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.txt', '.log', '.json', '.zip'].includes(path.extname(item.path).toLowerCase())) fail(`${location} has an unsupported evidence extension`);
    const root = fs.realpathSync(process.cwd());
    let target;
    try { target = fs.realpathSync(path.resolve(root, item.path)); } catch { fail(`${location} does not exist or cannot be resolved`); }
    if (!target.startsWith(root + path.sep) || !fs.statSync(target).isFile()) fail(`${location} must resolve to a file inside the workspace`);
  });
}
function validate(d) {
  object(d, 'data'); string(d.title, 'title'); string(d.summary, 'summary');
  if (!['mobile', 'web', 'hybrid'].includes(d.surface)) fail('surface must be mobile, web or hybrid');
  object(d.environment, 'environment'); Object.entries(d.environment).forEach(([k, v]) => string(v, `environment.${k}`));
  array(d.requirements, 'requirements'); d.requirements.forEach((r, i) => { object(r, `requirements[${i}]`); string(r.requirement, `requirements[${i}].requirement`); string(r.details, `requirements[${i}].details`); if (!statuses.includes(r.status)) fail(`requirements[${i}].status is invalid`); });
  array(d.scenarios, 'scenarios'); d.scenarios.forEach((s, i) => { const at = `scenarios[${i}]`; object(s, at); string(s.name, `${at}.name`); if (!statuses.includes(s.status)) fail(`${at}.status is invalid`); for (const key of ['expected', 'actual']) if (s[key] !== undefined) string(s[key], `${at}.${key}`); if (s.steps !== undefined) stringList(s.steps, `${at}.steps`); if (s.evidence !== undefined) evidence(s.evidence, `${at}.evidence`); });
  array(d.defects, 'defects'); d.defects.forEach((d, i) => { const at = `defects[${i}]`; object(d, at); string(d.title, `${at}.title`); string(d.severity, `${at}.severity`); if (d.steps !== undefined) stringList(d.steps, `${at}.steps`); if (d.evidence !== undefined) evidence(d.evidence, `${at}.evidence`); });
  stringList(d.rerun, 'rerun'); stringList(d.risks, 'risks');
}
const css = `
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--soft:#f0f2f5;--text:#14181f;--muted:#596473;--border:#dfe3e9;--accent:#2f5bd0;--pass:#08704c;--pass-bg:#e3f5ec;--fail:#a7142a;--fail-bg:#fce4e7;--blocked:#705400;--blocked-bg:#f7efd2}
@media(prefers-color-scheme:dark){:root{--bg:#12151a;--surface:#181c23;--soft:#222831;--text:#e7ebf2;--muted:#aab4c2;--border:#343d49;--accent:#a3bdff;--pass:#68dfb0;--pass-bg:#12312a;--fail:#ff9da9;--fail-bg:#3a1720;--blocked:#f2d788;--blocked-bg:#332b12}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,-apple-system,sans-serif}.page{max-width:1120px;margin:auto;padding:32px 24px 80px;overflow-wrap:anywhere}a{color:var(--accent)}a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}h1,h2,h3{line-height:1.25}h1{font-size:clamp(2rem,5vw,3rem);letter-spacing:-.035em;margin:10px 0 16px}h2{font-size:1.3rem;margin:44px 0 16px;padding-top:20px;border-top:1px solid var(--border);scroll-margin-top:20px}h3{font-size:1.05rem;margin:0 0 12px}.eyebrow,.label{font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;font-weight:700;color:var(--muted)}.intro{max-width:75ch;font-size:1.05rem;white-space:pre-wrap}.surface{display:inline-block;border:1px solid var(--border);border-radius:99px;padding:3px 10px;font-size:.75rem;text-transform:uppercase;font-weight:700}.toc,.meta,.card,.summary{background:var(--surface);border:1px solid var(--border);border-radius:12px}.toc{margin:28px 0;padding:18px 20px}.toc ol{display:flex;flex-wrap:wrap;gap:6px 24px;margin:8px 0 0;padding-left:20px}.toc li{padding-right:4px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:24px 0}.stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px}.stat strong{display:block;font-size:1.7rem;line-height:1.2}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;padding:20px}.meta dt{color:var(--muted);font-size:.75rem;text-transform:uppercase;font-weight:700;letter-spacing:.05em}.meta dd{margin:4px 0 0;white-space:pre-wrap}.summary{padding:18px 20px;border-left:4px solid var(--accent);white-space:pre-wrap}.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface)}table{border-collapse:collapse;width:100%;min-width:540px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid var(--border);white-space:pre-wrap}th{background:var(--soft);color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}tr:last-child td{border-bottom:0}.badge{display:inline-block;border:1px solid currentColor;border-radius:99px;padding:2px 9px;font-size:.72rem;font-weight:700;text-transform:uppercase;white-space:nowrap}.pass{color:var(--pass);background:var(--pass-bg)}.fail{color:var(--fail);background:var(--fail-bg)}.blocked{color:var(--blocked);background:var(--blocked-bg)}.skipped,.severity{color:var(--muted);background:var(--soft)}.card{padding:20px;margin:12px 0;border-left:4px solid var(--border)}.defect{border-left-color:var(--fail)}.card-header{display:flex;align-items:start;justify-content:space-between;gap:12px}.card p{white-space:pre-wrap}.card ol,.card ul{padding-left:22px}.empty{color:var(--muted);font-style:italic}.evidence a{overflow-wrap:anywhere}@media(max-width:600px){.page{padding:24px 16px 60px}.stats{grid-template-columns:repeat(2,1fr)}.card-header{display:block}.card-header .badge{margin-bottom:10px}}@media print{:root{color-scheme:light;--bg:#fff;--surface:#fff;--soft:#f2f2f2;--text:#111;--muted:#444;--border:#aaa;--accent:#183c99;--pass:#075b3e;--pass-bg:#fff;--fail:#8a1222;--fail-bg:#fff;--blocked:#604800;--blocked-bg:#fff}.page{max-width:none;padding:0}.card,.meta,.stat{break-inside:avoid}.table-wrap{overflow:visible}table{min-width:0}a{color:inherit}h2{break-after:avoid}}
`;
function render(d, output) {
  const empty = '<p class="empty">Не указано.</p>';
  const statusLabels = { pass: 'Пройдено', fail: 'Не пройдено', blocked: 'Заблокировано', skipped: 'Пропущено' };
  const surfaceLabels = { mobile: 'Мобильное приложение', web: 'Веб', hybrid: 'Гибридное приложение' };
  const severityLabels = new Map(Object.entries({ highest: 'Наивысшая', high: 'Высокая', medium: 'Средняя', low: 'Низкая', critical: 'Критическая', blocker: 'Блокирующая', major: 'Значительная', minor: 'Незначительная', trivial: 'Тривиальная' }));
  const list = (items, ordered = false) => items?.length ? `<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${esc(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : empty;
  const badge = s => `<span class="badge ${s}">${esc(statusLabels[s])}</span>`;
  const links = items => items?.length ? `<ul class="evidence">${items.map(x => { const relative = path.relative(path.dirname(output), path.resolve(process.cwd(), x.path)).split(path.sep).map(encodeURIComponent).join('/'); return `<li><a href="${esc(relative)}">${esc(x.label)}</a> <span class="label">(${esc(x.path)})</span></li>`; }).join('')}</ul>` : empty;
  const sections = ['Окружение', 'Итоги', 'Требования', 'Сценарии', 'Дефекты', 'Повторная проверка', 'Риски'];
  const counts = statuses.map(s => `<div class="stat"><strong>${d.scenarios.filter(x => x.status === s).length}</strong>${badge(s)}</div>`).join('');
  const meta = Object.entries(d.environment).map(([k,v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const req = d.requirements.length ? `<div class="table-wrap" role="region" aria-label="Таблица требований" tabindex="0"><table><thead><tr><th scope="col">Требование</th><th scope="col">Статус</th><th scope="col">Подробности</th></tr></thead><tbody>${d.requirements.map(r => `<tr><td>${esc(r.requirement)}</td><td>${badge(r.status)}</td><td>${esc(r.details)}</td></tr>`).join('')}</tbody></table></div>` : empty;
  const scenarios = d.scenarios.length ? d.scenarios.map(s => `<article class="card"><div class="card-header"><h3>${esc(s.name)}</h3>${badge(s.status)}</div><div class="label">Шаги</div>${list(s.steps, true)}<p><strong>Ожидаемый результат:</strong> ${s.expected === undefined ? 'Не указан.' : esc(s.expected)}</p><p><strong>Фактический результат:</strong> ${s.actual === undefined ? 'Не указан.' : esc(s.actual)}</p><div class="label">Материалы</div>${links(s.evidence)}</article>`).join('') : empty;
  const defects = d.defects.length ? d.defects.map(x => `<article class="card defect"><div class="card-header"><h3>${esc(x.title)}</h3><span class="badge severity">Серьёзность: ${esc(severityLabels.get(x.severity.trim().toLowerCase()) ?? x.severity)}</span></div><div class="label">Шаги</div>${list(x.steps, true)}<div class="label">Материалы</div>${links(x.evidence)}</article>`).join('') : empty;
  const blocks = [meta ? `<dl class="meta">${meta}</dl>` : empty, `<div class="summary">${esc(d.summary)}</div>`, req, scenarios, defects, list(d.rerun), list(d.risks)];
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(d.title)}</title><style>${css}</style></head><body><main class="page"><header><div class="eyebrow">Отчёт о тестировании</div><h1>${esc(d.title)}</h1><span class="surface">${esc(surfaceLabels[d.surface])}</span><p class="intro">Результаты сценариев</p><div class="stats" aria-label="Количество сценариев по результатам">${counts}</div></header><nav class="toc" aria-label="Содержание отчёта"><div class="label">Содержание</div><ol>${sections.map((s,i) => `<li><a href="#section-${i+1}">${s}</a></li>`).join('')}</ol></nav>${sections.map((s,i) => `<section aria-labelledby="section-${i+1}"><h2 id="section-${i+1}">${i+1}. ${s}</h2>${blocks[i]}</section>`).join('')}</main></body></html>`;
}
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); }
  else {
    if (args.length !== 2) fail('Expected <data.json> <output.html>; use --help for schema');
    localPath(args[1], 'output');
    const root = fs.realpathSync(process.cwd());
    const output = path.resolve(root, args[1]);
    const parent = fs.realpathSync(path.dirname(output));
    if (parent !== root && !parent.startsWith(root + path.sep)) fail('output directory must be inside the workspace');
    if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) fail('output cannot be a symbolic link');
    const input = fs.realpathSync(args[0]);
    if (fs.existsSync(output) && fs.realpathSync(output) === input) fail('output cannot overwrite input');
    const data = JSON.parse(fs.readFileSync(input, 'utf8')); validate(data);
    fs.writeFileSync(output, render(data, output), { encoding: 'utf8', flag: 'wx' });
    console.log(`Report written: ${args[1]}`);
  }
} catch (error) { console.error(`qa-report: ${error.message}`); process.exitCode = 1; }
