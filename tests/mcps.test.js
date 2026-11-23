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
  { id: 'google-sheets', values: { credentialsPath: '/credentials.json' } },
  { id: 'figma', values: { apiKey: 'figd_fake-secret' } },
];
test('generates actual pinned servers, secret references and exact selected grants', () => {
  const result = generateMcps({ mcps: selections }, options);
  assert.equal(result.rows.length, 7);
  const row = id => result.rows.find(r => r.id === `mcp-${id}`).config;
  assert.deepEqual(row('figma').args, ['--yes', '--package=figma-developer-mcp@0.13.2', 'figma-developer-mcp', '--stdio']);
  assert.match(row('figma').env.FIGMA_API_KEY, /^__DSH_SECRET_figma-api-key__$/);
  assert.equal(row('figma').toolCallTimeoutMs, 120000);
  assert.ok(result.files.some(f => f.path === '.dsh/secrets/installer/figma-api-key' && f.secret && f.content === 'figd_fake-secret\n'));
  assert.ok(result.sharedMcpTools.designer.includes('mcp__figma__get_figma_data'));
  assert.equal(result.sharedMcpTools.explorer, undefined);
  assert.throws(() => generateMcps({ mcps: [{ id: 'context7', values: {} }] }, options));
  assert.throws(() => generateMcps({ mcps: [{ id: 'obscura', values: { binaryPath: '/bin/obscura' } }] }, options));
  assert.throws(() => generateMcps({ mcps: [{ id: 'memory', values: {} }] }, options));
  assert.throws(() => generateMcps({ mcps: [{ id: 'sequential-thinking', values: {} }] }, options));
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
  const nonFiles = JSON.stringify({ ...result, files: [] });
  for (const value of ['bb-secret', 'git-secret', 'k-secret', 'jira-secret', 'conf-secret', 'figd_fake-secret']) assert.ok(!nonFiles.includes(value));
  assert.equal(Object.keys(result.secretExpressions).length, 6);
  assert.ok(Object.values(result.secretExpressions).every(expr => expr.includes('readFileSync') && expr.includes('/.dsh/secrets/installer/')));
  assert.equal(result.sharedMcpTools.oracle.filter(x => x.startsWith('mcp__bitbucket__')).length, 6);
  assert.equal(result.sharedMcpTools.librarian.filter(x => x.startsWith('mcp__bitbucket__')).length, 3);
  assert.ok(result.sharedMcpTools.oracle.includes('mcp__kibana__get_status'));
  assert.ok(result.files.every(f => f.path.startsWith('.dsh/') && typeof f.secret === 'boolean'));
});
test('missing runtime blocks corresponding rows and grants', () => {
  const result = generateMcps({ mcps: selections }, { targetHome: '/home/test' });
  assert.deepEqual(result.rows.map(r => r.id), []);
  assert.equal(Object.keys(result.sharedMcpTools).length, 0);
  assert.equal(result.requirements.filter(r => r.startsWith('BLOCKER:')).length, 7);
});
test('filters grants and rejects unsafe URLs and paths', () => {
  const result = generateMcps({ mcps: [selections[3]] }, options);
  assert.deepEqual(Object.keys(result.sharedMcpTools).sort(), ['designer', 'fixer', 'oracle', 'tester']);
  assert.throws(() => generateMcps({ mcps: [{ id: 'jira', values: { url: 'http://example.com', token: 'x' } }] }, options));
  assert.throws(() => generateMcps({ mcps: [{ id: 'google-sheets', values: { credentialsPath: 'relative' } }] }, options));
  assert.throws(() => generateMcps({ mcps: [{ id: 'figma', values: {} }] }, options));
});

test('agent-device is optional: tester grants without CLI, server row when CLI provided', () => {
  const missing = generateMcps({ mcps: [{ id: 'agent-device', values: {} }] }, { targetHome: '/home/a', agentDeviceCli: null });
  assert.equal(missing.rows.length, 0);
  assert.ok(missing.requirements.some(r => r.includes('agent-device CLI not found')));
  assert.deepEqual(missing.sharedMcpTools.tester, [
    'mcp__agent-device__devices',
    'mcp__agent-device__boot',
    'mcp__agent-device__open',
    'mcp__agent-device__snapshot',
    'mcp__agent-device__screenshot',
    'mcp__agent-device__logs',
    'mcp__agent-device__appstate',
    'mcp__agent-device__find',
    'mcp__agent-device__apps',
    'mcp__agent-device__press',
    'mcp__agent-device__fill',
    'mcp__agent-device__type',
    'mcp__agent-device__get',
    'mcp__agent-device__is',
    'mcp__agent-device__wait',
    'mcp__agent-device__close',
    'mcp__agent-device__scroll',
    'mcp__agent-device__back',
    'mcp__agent-device__alert',
    'mcp__agent-device__keyboard',
  ]);
  assert.ok(!missing.sharedMcpTools.tester.includes('mcp__agent-device__install'));
  assert.ok(!missing.sharedMcpTools.tester.includes('mcp__agent-device__settings'));
  assert.ok(!missing.sharedMcpTools.tester.includes('mcp__agent-device__batch'));
  const cli = '/usr/local/lib/node_modules/agent-device/bin/agent-device.mjs';
  const present = generateMcps({ mcps: [{ id: 'agent-device', values: {} }] }, { targetHome: '/home/a', agentDeviceCli: cli, workspaceDir: '/home/a/ws' });
  assert.equal(present.rows.length, 1);
  assert.equal(present.rows[0].id, 'mcp-agent-device');
  assert.equal(present.rows[0].config.serverName, 'agent-device');
  assert.deepEqual(present.rows[0].config.args.slice(-2), [cli, 'mcp']);
  assert.equal(present.rows[0].config.env.AGENT_DEVICE_STATE_DIR, '/home/a/ws/.agent-device');
  assert.equal(present.rows[0].config.env.AGENT_DEVICE_NO_UPDATE_NOTIFIER, '1');
  assert.equal(present.rows[0].config.toolCallTimeoutMs, 300000);
  assert.ok(!present.rows[0].config.args.includes('/Users/developer/.nvm'));
  assert.match(present.rows[0].config.args[0], /agent-device-mcp-adapter\.mjs$/);
});

test('jira/confluence grants include tester subsets', () => {
  const result = generateMcps({ mcps: [
    { id: 'jira', values: { url: 'https://jira.example', token: 't' } },
    { id: 'confluence', values: { url: 'https://conf.example', token: 't' } },
  ] }, options);
  assert.deepEqual(result.sharedMcpTools.tester, ['mcp__jira__jira_get_issue', 'mcp__confluence__confluence_search', 'mcp__confluence__confluence_get_page']);
  assert.ok(!result.sharedMcpTools.tester.includes('mcp__jira__jira_search'));
  assert.ok(!result.sharedMcpTools.tester.includes('mcp__confluence__confluence_get_page_children'));
});
