import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../payload/plugins/oh-my-dsh-slim/client/client.js', import.meta.url), 'utf8');
function loadClient() {
  let client;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) {
    client = factory(name => name === 'react' ? React : {});
  } } } });
  return client;
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}

test('advanced rules editor renders for every role and updates personaAppend', () => {
  const client = loadClient();
  const draft = client.buildDraft({});
  for (const roleId of Object.keys(draft.roles)) {
    const changes = [];
    const tree = client.RoleRow({ roleId, draft, advOpen: true, onChange: (...args) => changes.push(args), t: key => key });
    const field = nodes(tree).find(node => node.type === 'textarea' && node.props.className === 'omds-textarea');
    assert.ok(field, `${roleId} has a rules editor`);
    assert.equal(field.props.disabled, roleId === 'observer');
    if (roleId === 'observer') continue; // Existing release lock is preserved.
    field.props.onChange({ target: { value: 'Keep reports concise.' } });
    assert.equal(changes[0][0], roleId);
    assert.equal(changes[0][1].personaAppend, 'Keep reports concise.');
    field.props.onChange({ target: { value: '' } });
    assert.equal(changes[1][1].personaAppend, undefined);
  }
});

test('rules survive profile save and reload without changing tool grants', () => {
  const client = loadClient();
  const original = { roles: { fixer: { sharedMcpTools: ['mcp__jira__jira_get_issue'] } } };
  const draft = client.buildDraft(original);
  draft.roles.fixer.personaAppend = 'Run only scoped checks.';
  // Defaults and user overrides are separate layers in the real editor.
  const saved = client.draftToConfig(draft, original, {});
  const reloaded = client.buildDraft(saved, saved.advanced);
  assert.equal(reloaded.roles.fixer.personaAppend, 'Run only scoped checks.');
  assert.equal(JSON.stringify(reloaded.roles.fixer.sharedMcpTools), JSON.stringify(draft.roles.fixer.sharedMcpTools));
});
