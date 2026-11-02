import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMcps } from '../lib/mcps.js';

const options = { targetHome: '/home/a "quoted"', runtimePaths: { npx: '/bin/npx', uvx: '/bin/uvx' } };
const selections = [
  { id: 'bitbucket', values: { url: 'https://bb.example', username: 'u', token: 'bb-secret' } },
  { id: 'gitlab', values: { url: 'https://git.example', token: 'git-secret' } },
  { id: 'kibana', values: { url: 'https://k.example', username: 'u', password: 'k-secret' } },
  { id: 'jira', values: { url: 'https://jira.example', token: 'jira-secret' } },
  { id: 'confluence', values: { url: 'https://conf.example', token: 'conf-secret' } },
  { id: 'obscura', values: { binaryPath: '/bin/obscura' } },
  { id: 'memory', values: {} },
  { id: 'google-sheets', values: { credentialsPath: '/credentials.json' } },
  { id: 'sequential-thinking', values: {} },
  { id: 'figma', values: { apiKey: 'figd_fake-secret' } },
  { id: 'context7', values: {} },
];
test('generates actual pinned servers, secret references and exact selected grants', () => {
  const result = generateMcps({ mcps: selections }, options);
  assert.equal(result.rows.length, 11);
  const row = id => result.rows.find(r => r.id === `mcp-${id}`).config;
  assert.deepEqual(row('figma').args, ['--yes', '--package=figma-developer-mcp@0.13.2', 'figma-developer-mcp', '--stdio']);
  assert.match(row('figma').env.FIGMA_API_KEY, /^__DSH_SECRET_figma-api-key__$/);
  assert.equal(row('figma').toolCallTimeoutMs, 120000);
  assert.deepEqual(row('context7').args, ['--yes', '--package=@upstash/context7-mcp@4.4.4', 'context7-mcp']);
  assert.deepEqual(row('context7').env, {});
  assert.ok(result.files.some(f => f.path === '.dsh/secrets/installer/figma-api-key' && f.secret && f.content === 'figd_fake-secret\n'));
  assert.ok(!result.files.some(f => f.path.includes('context7')));
  assert.ok(result.sharedMcpTools.designer.includes('mcp__figma__get_figma_data'));
  assert.deepEqual(result.sharedMcpTools.explorer, ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs']);
  assert.deepEqual(row('bitbucket').args, ['--yes', '--package=@nexus2520/bitbucket-mcp-server@4.0.0', 'bitbucket-mcp-server']);
  assert.deepEqual(row('gitlab').args, ['--yes', '--package=@zereight/mcp-gitlab@2.3.19', 'zereight-mcp-gitlab']);
  assert.equal(row('gitlab').env.GITLAB_PERMISSION_MODE, 'readonly');
  assert.equal(row('gitlab').env.GITLAB_API_URL, 'https://git.example/api/v4');
  assert.deepEqual(row('jira').args, ['mcp-atlassian@0.23.1']);
  assert.equal(row('confluence').env.CONFLUENCE_SSL_VERIFY, 'true');
  for (const id of ['jira', 'confluence', 'google-sheets']) {
    assert.equal(row(id).toolCallTimeoutMs, 120000);
    assert.equal(Object.hasOwn(row(id), 'timeout'), false);
  }
  assert.deepEqual(row('google-sheets').args, ['--with', 'mcp<2', 'mcp-google-sheets@0.6.3']);
  assert.equal(row('google-sheets').env.ENABLED_TOOLS.split(',').length, 10);
  assert.deepEqual(row('obscura').args, ['--storage-dir', '/home/a "quoted"/.dsh/data/obscura', 'mcp']);
  assert.equal(row('memory').env.MEMORY_FILE_PATH, '/home/a "quoted"/.dsh/data/memory/data.jsonl');
  const nonFiles = JSON.stringify({ ...result, files: [] });
  for (const value of ['bb-secret', 'git-secret', 'k-secret', 'jira-secret', 'conf-secret', 'figd_fake-secret']) assert.ok(!nonFiles.includes(value));
  assert.equal(Object.keys(result.secretExpressions).length, 6);
  assert.ok(Object.values(result.secretExpressions).every(expr => expr.includes('readFileSync') && expr.includes('/.dsh/secrets/installer/')));
  assert.equal(result.sharedMcpTools.oracle.filter(x => x.startsWith('mcp__bitbucket__')).length, 6);
  assert.equal(result.sharedMcpTools.librarian.filter(x => x.startsWith('mcp__bitbucket__')).length, 3);
  assert.ok(result.sharedMcpTools.oracle.includes('mcp__kibana__get_status'));
  assert.ok(result.files.every(f => f.path.startsWith('.dsh/') && typeof f.secret === 'boolean'));
});
test('memory and sequential thinking require verified Node.js 24', () => {
  const mcps = selections.filter(s => ['memory', 'sequential-thinking'].includes(s.id));
  const generate = nodeVersion => generateMcps({ mcps }, { ...options, runtimePaths: { ...options.runtimePaths, nodeVersion } });
  assert.equal(generate('v20.19.0').requirements.filter(r => r.startsWith('BLOCKER:')).length, 2);
  assert.equal(generate('v24.0.0').requirements.filter(r => r.startsWith('BLOCKER:')).length, 0);
  assert.equal(generate(undefined).requirements.filter(r => r.includes('must be verified')).length, 2);
});
test('missing runtime blocks corresponding rows and grants', () => {
  const result = generateMcps({ mcps: selections }, { targetHome: '/home/test' });
  assert.deepEqual(result.rows.map(r => r.id), ['mcp-obscura']);
  assert.equal(Object.keys(result.sharedMcpTools).length, 0);
  assert.equal(result.requirements.filter(r => r.startsWith('BLOCKER:')).length, 10);
});
test('filters grants and rejects unsafe URLs and paths', () => {
  const result = generateMcps({ mcps: [selections[3]] }, options);
  assert.deepEqual(Object.keys(result.sharedMcpTools).sort(), ['designer', 'fixer', 'oracle']);
  assert.throws(() => generateMcps({ mcps: [{ id: 'jira', values: { url: 'http://example.com', token: 'x' } }] }, options));
  assert.throws(() => generateMcps({ mcps: [{ id: 'google-sheets', values: { credentialsPath: 'relative' } }] }, options));
  assert.throws(() => generateMcps({ mcps: [{ id: 'obscura', values: { binaryPath: 'relative' } }] }, options));
});

test('context7 stores an optional API key as a secret file', () => {
  const result = generateMcps({ mcps: [{ id: 'context7', values: { apiKey: 'ctx7-fake-secret' } }] }, options);
  assert.equal(result.rows[0].config.env.CONTEXT7_API_KEY, '__DSH_SECRET_context7-api-key__');
  assert.equal(result.files[0].path, '.dsh/secrets/installer/context7-api-key');
  assert.throws(() => generateMcps({ mcps: [{ id: 'figma', values: {} }] }, options));
});
