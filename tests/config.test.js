import test from 'node:test';
import assert from 'node:assert/strict';
import { mcps, roles, validateConfig } from '../lib/config.js';

const config = () => ({ apiUrl: 'https://api.example.com', apiKey: 'secret', mcps: [], roles: structuredClone(roles) });
const selection = (id, values) => ({ id, values });

test('accepts defaults and all MCPs including both Git providers', () => {
  const c = config();
  c.mcps = mcps.map(m => selection(m.id, Object.fromEntries(m.fields.map(f => [f.key,
    f.key === 'url' ? 'https://example.com' : f.key.endsWith('Path') ? '/tmp/file' : 'value']))));
  assert.deepEqual(validateConfig(c), { apiUrl: 'https://api.example.com/v1' });
  c.roles.fixer.model = 'deepseek-account/custom-model.1';
  assert.doesNotThrow(() => validateConfig(c));
});

test('rejects invalid roles and ignored overrides', () => {
  for (const change of [
    c => { c.roles.extra = { model: '', effort: '' }; },
    c => { c.roles.fixer.extra = true; },
    c => { c.roles.fixer.model = 'unknown/model'; },
    c => { c.roles.fixer.model = 'cliproxy/model;bad'; },
    c => { c.roles.fixer.model = ''; },
    c => { c.roles.fixer.effort = 'xhigh'; },
    c => { c.roles.main.effort = 'high'; },
    c => { c.roles.orchestrator.model = 'cliproxy/model'; },
  ]) {
    const c = config(); change(c); assert.throws(() => validateConfig(c));
  }
});

test('rejects invalid MCP fields, URLs, paths and duplicate selections', () => {
  for (const entry of [
    selection('google-sheets', { credentialsPath: '/ok', tokenPath: 42 }),
    selection('google-sheets', { credentialsPath: '~/file' }),
    selection('obscura', { binaryPath: 'relative' }),
    selection('jira', { url: 'http://example.com', token: 'x' }),
    selection('jira', { url: 'https://user:pass@example.com', token: 'x' }),
    selection('jira', { url: 'https://example.com/?q=x', token: 'x' }),
    selection('gitlab', { url: 'https://example.com/path', token: 'x' }),
    selection('memory', JSON.parse('{"__proto__":"bad"}')),
    selection('jira', { url: 'https://example.com', token: 'x\nheader' }),
  ]) {
    const c = config(); c.mcps = [entry]; assert.throws(() => validateConfig(c));
  }
  const c = config(); c.mcps = [selection('memory', {}), selection('memory', {})];
  assert.throws(() => validateConfig(c));
});

test('never includes API key or MCP secrets in validation errors', () => {
  const c = config(); c.apiKey = 'secret\nInjected';
  assert.throws(() => validateConfig(c), error => !error.message.includes('secret'));
  c.apiKey = 'ok'; c.mcps = [selection('jira', { url: 'https://example.com', token: 'secret\nInjected' })];
  assert.throws(() => validateConfig(c), error => !error.message.includes('secret'));
});
