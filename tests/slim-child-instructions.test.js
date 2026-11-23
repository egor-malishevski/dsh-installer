import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { apply, composeChild, replaceRolePersona } from '../payload/plugins/oh-my-dsh-slim/preset/role-composition.js';
import { ROLE_PERSONAS, shellQuoteForBashTool } from '../payload/plugins/oh-my-dsh-slim/preset/preset.js';
import { apply as applyOrchestrator } from '../payload/plugins/oh-my-dsh-slim/preset/orchestrator-tools.js';
import { effectiveRoleFilter } from '../payload/plugins/oh-my-dsh-slim/preset/roles.js';
import { loadConfig, TOOL_NAMES } from '../payload/plugins/oh-my-dsh-slim/preset/config.js';

const roles = ['explorer', 'librarian', 'oracle', 'designer', 'fixer', 'tester'];
const manager = 'You are a workflow manager. Keep your own tool use to orchestration:';

test('tester persona wires absolute qa-report generator from loaded preset dir', () => {
  const expected = fileURLToPath(new URL('../payload/plugins/oh-my-dsh-slim/preset/qa-report.mjs', import.meta.url));
  const quoted = shellQuoteForBashTool(expected);
  const text = ROLE_PERSONAS.tester;
  assert.equal(quoted[0], "'", 'Bash-tool path must be single-quoted, not JSON double-quoted');
  assert.ok(text.includes(`node ${quoted}`), `missing absolute generator CLI node ${quoted}`);
  assert.ok(text.includes(`node ${quoted} --help`), 'missing --help schema instruction');
  assert.doesNotMatch(text, /JSON\.stringify\(QA_REPORT_GENERATOR\)/);
  assert.doesNotMatch(text, /node "[^"]*qa-report\.mjs"/);
  assert.match(text, /do not author your own markup/);
  assert.match(text, /CLI refuses overwrite/);
  assert.match(text, /Report renderer errors\/blockers \(including overwrite refusal\) instead of hand-writing HTML/);
  assert.doesNotMatch(text, /Write an HTML QA report to the path the Orchestrator requested/);
});

test('shellQuoteForBashTool is literal for $, backtick, and apostrophe paths', () => {
  const samples = [
    "/tmp/qa$report.mjs",
    "/tmp/qa`report.mjs",
    "/tmp/qa'report.mjs",
    "/tmp/qa $`'.mjs",
  ];
  for (const sample of samples) {
    const quoted = shellQuoteForBashTool(sample);
    assert.equal(quoted[0], "'");
    assert.equal(quoted.at(-1), "'");
    assert.doesNotMatch(quoted, /^"/);
    if (process.platform === 'win32') {
      assert.equal(quoted, "'" + sample.replace(/'/g, "''") + "'");
    } else {
      assert.equal(quoted, "'" + sample.replace(/'/g, "'\\''") + "'");
      // single-quoted POSIX literals keep $ / backticks as literal characters
      if (sample.includes('$')) assert.match(quoted, /\$/);
      if (sample.includes('`')) assert.match(quoted, /`/);
      if (sample.includes("'")) assert.ok(quoted.includes("'\\''"));
    }
  }
});

function assembly() {
  return {
    sections: [{ name: 'deployment:persona-prefix', text: manager }, { name: 'plan-policy', text: 'Do not mutate in plan mode.' }],
    contexts: [{ name: 'sandbox', text: 'workspace-write' }, { name: 'approval', text: 'never' }],
    tools: [{ name: 'read' }], variables: { model: 'test' },
  };
}

for (const role of roles) {
  test(`${role}: fresh and cold-resumed child replaces manager identity and preserves safety`, async () => {
    for (const resumed of [false, true]) {
      let listener;
      let restricted;
      const own = [{ type: 'subagent/descriptor', data: { label: `${role} · regression` } }];
      const agent = {
        session: { header: { origin: 'subagent', delegationDepth: 1 }, ownEvents: () => own },
        options: resumed ? {} : { dshRoleId: role },
        ctx: {
          // The preset already owns this slot. The previous implementation
          // swallowed this error and left the manager instructions active.
          systemPrompt: { section() { throw new Error('already registered in this scope'); } },
          on(name, callback) { assert.equal(name, 'system-prompt/assemble'); listener = callback; },
          tools: { view: () => ({ restrictableNames: [...TOOL_NAMES] }), restrict(filter) { restricted = filter; } },
        },
      };
      assert.equal(await composeChild(agent, {}, () => undefined), 'ok');
      assert.equal(await composeChild(agent, {}, () => undefined), 'skipped');
      assert.equal(typeof listener, 'function');
      const input = assembly();
      const contexts = input.contexts;
      const tools = input.tools;
      const safeSection = input.sections[1];
      const output = await listener(input, { scope: agent }, async () => ({ ...input }));
      assert.match(output.sections[0].text, new RegExp(`oh-my-dsh-slim-role:${role}`));
      assert.ok(output.sections[0].text.includes(ROLE_PERSONAS[role]));
      assert.doesNotMatch(output.sections[0].text, /workflow manager|Keep your own tool use to orchestration/);
      assert.equal(output.sections[0].interpolate, false);
      assert.equal(output.sections[1], safeSection);
      assert.equal(output.contexts, contexts);
      assert.equal(output.tools, tools);
      const policy = loadConfig().roles[role];
      const expected = effectiveRoleFilter(role, policy);
      assert.ok(restricted.deny.includes('subagent_fixer'));
      assert.ok(!restricted.deny.includes('send_message'));
      assert.equal(restricted.deny.includes('write'), expected.deny.includes('write'));
      for (const name of ['glob', 'grep', 'read']) assert.ok(!restricted.deny.includes(name), `${role} retains ${name}`);
    }
  });
}

test('root identity is unchanged and missing child persona fails closed', async () => {
  const root = { session: { header: {} } };
  assert.equal(await composeChild(root, {}, () => undefined), 'skipped');
  assert.throws(() => replaceRolePersona({ sections: [] }, 'specialist'), /persona section is missing/);
});

const modules = process.env.DSH_PROFILE_MODULES;
const installedHost = { skip: modules ? false : 'set DSH_PROFILE_MODULES for installed-host check' };
async function hostModules() {
  // Resolve from the installed package's real location, not this checkout's
  // node_modules. Electron's ASAR support is required for the packaged host.
  const requireHost = createRequire(realpathSync(`${modules}/@deepseek-ai/dsh-system-prompt/package.json`));
  const host = name => import(pathToFileURL(requireHost.resolve(`@deepseek-ai/${name}`)).href);
  return {
    ...await host('cordis'), ...await host('dsh-scope'),
    ...await host('dsh-system-prompt'),
    importHost: specifier => import(pathToFileURL(requireHost.resolve(specifier)).href),
  };
}

function childInScope(createScope, parent, role, resumed = false) {
  const agent = {
    session: {
      header: { origin: 'subagent', delegationDepth: 1 },
      ownEvents: () => [{ type: 'subagent/descriptor', data: { label: `${role} · installed regression` } }],
    },
    options: resumed ? {} : { dshRoleId: role },
  };
  const scope = createScope(parent.ctx, agent, { parent: parent.key });
  agent.ctx = scope.ctx;
  return { agent, scope };
}

test('installed Cordis lifecycle: orchestrator skip does not bail before child composition or following observers', installedHost, async () => {
  const { Context, Service, createScope, scopeOf, scopeTarget, importHost } = await hostModules();
  const ctx = new Context();
  try {
    const restrictions = [];
    class Tools extends Service {
      constructor(ctx) { super(ctx, 'tools'); }
      view() { return { restrictableNames: [...TOOL_NAMES] }; }
      restrict(filter) { restrictions.push({ scope: scopeOf(this.ctx), filter }); }
      guard() {}
    }
    new Tools(ctx);
    const registry = new Service(ctx, 'regressionRegistry');
    const owner = {};
    const preset = createScope(ctx, owner);
    const observer = createScope(preset.ctx, owner);
    // Only the module loader is a bridge fixture; dispatch, services, scopes,
    // event ordering and disposal all come from the installed host modules.
    const compositionCtx = observer.ctx.extend({ agents: { list: () => [] }, loader: {
      config: { baseUrl: pathToFileURL(`${modules}/`).href },
      internal: { import: importHost },
    } });
    await applyOrchestrator(compositionCtx);
    await apply(compositionCtx);
    const reached = [];
    ctx.on('agent/created', ({ agent }) => { reached.push(agent); });
    const first = childInScope(createScope, { ctx: preset.ctx, key: owner }, 'explorer');
    const second = childInScope(createScope, { ctx: preset.ctx, key: owner }, 'fixer', true);
    const parent = { session: { header: {} } };
    parent.ctx = createScope(preset.ctx, parent, { parent: owner }).ctx;
    const stop = compositionCtx.on('agent/created', () => 'skipped', { prepend: true });
    assert.equal(await ctx.serial(scopeTarget(registry, first.agent), 'agent/created', { agent: first.agent }), 'skipped');
    assert.equal(restrictions.length, 0, 'negative control: a private skipped status really prevents child composition');
    assert.equal(reached.length, 0, 'negative control: serial dispatch bails before following observers');
    stop();
    for (const agent of [first.agent, second.agent, parent, first.agent]) {
      assert.equal(await ctx.serial(scopeTarget(registry, agent), 'agent/created', { agent }), undefined, 'lifecycle observers must not return private ok/skipped statuses');
    }
    assert.deepEqual(reached, [first.agent, second.agent, parent, first.agent], 'both successful and skipped composition must leave the serial chain running');
    assert.deepEqual(restrictions.filter(entry => entry.scope !== parent).map(entry => entry.scope), [first.agent, second.agent], 'fresh and resumed children each compose exactly once');
    assert.ok(restrictions.filter(entry => entry.scope !== parent).every(entry => entry.filter.deny.includes('subagent_fixer')));
    await observer.dispose();
    const late = childInScope(createScope, { ctx: preset.ctx, key: owner }, 'designer');
    const count = restrictions.length;
    await ctx.serial(scopeTarget(registry, late.agent), 'agent/created', { agent: late.agent });
    assert.equal(restrictions.length, count, 'disposed lifecycle observers cannot compose another child');
    assert.equal(reached.at(-1), late.agent, 'independent host observer remains installed');
  } finally { await ctx.fiber.dispose(); }
});

test('installed SystemPrompt: isolated child callbacks replace only their own persona and are removed on disposal', installedHost, async () => {
  const { Context, Service, createScope, scopeOf, SystemPrompt, renderPrompt } = await hostModules();
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: manager });
    new class extends Service {
      constructor(ctx) { super(ctx, 'tools'); }
      view() { return { restrictableNames: [...TOOL_NAMES] }; }
      restrict() {}
    }(ctx);
    ctx.systemPrompt.context({ name: 'sandbox', order: 0, required: true, text: 'workspace-write' });
    ctx.systemPrompt.section({ name: 'plan-policy', order: 10, text: 'Do not mutate in plan mode.' });
    const owner = {};
    const preset = createScope(ctx, owner);
    const parent = { session: { header: {} } };
    const parentScope = createScope(preset.ctx, parent, { parent: owner });
    parent.ctx = parentScope.ctx;
    const baseline = await ctx.systemPrompt.assemble({ scope: parent });
    assert.equal(await composeChild(parent, {}, scopeOf), 'skipped');
    const children = [
      { ...childInScope(createScope, { ctx: preset.ctx, key: owner }, 'explorer'), role: 'explorer' },
      { ...childInScope(createScope, { ctx: preset.ctx, key: owner }, 'fixer', true), role: 'fixer' },
    ];
    const calls = new Map(children.map(({ agent }) => [agent, 0]));
    for (const { agent } of children) {
      agent.ctx.on('system-prompt/assemble', async (_input, context, next) => {
        assert.equal(context.scope, agent, 'scoped callback never observes siblings or parent');
        calls.set(agent, calls.get(agent) + 1);
        return next();
      });
      // Reproduce the preset-owned slot and duplicate collision in this exact
      // agent layer, rather than only colliding with the global registration.
      const prompt = agent.ctx.get('systemPrompt');
      prompt.section({ name: 'deployment:persona-prefix', order: 0, text: manager });
      assert.throws(() => prompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'replacement' }), /already registered/);
    }
    const before = await ctx.systemPrompt.assemble({ scope: children[0].agent });
    assert.match(renderPrompt(before), /workflow manager/);
    assert.equal(calls.get(children[0].agent), 1);
    assert.equal(calls.get(children[1].agent), 0);
    for (const { agent } of children) assert.equal(await composeChild(agent, {}, scopeOf), 'ok');
    for (const { agent, role } of children) {
      const result = await ctx.systemPrompt.assemble({ scope: agent });
      assert.ok(renderPrompt(result).includes(ROLE_PERSONAS[role]));
      assert.match(renderPrompt(result), new RegExp(`oh-my-dsh-slim-role:${role}`));
      const other = children.find(child => child.agent !== agent);
      assert.ok(!renderPrompt(result).includes(ROLE_PERSONAS[other.role]), 'sibling persona must not leak through scoped listeners');
      assert.doesNotMatch(renderPrompt(result), /workflow manager|Keep your own tool use to orchestration/);
      assert.deepEqual(result.contexts, before.contexts);
      assert.deepEqual(result.tools, before.tools);
      assert.deepEqual(result.variables, before.variables);
      assert.deepEqual(result.sections.filter(section => section.name !== 'deployment:persona-prefix'), before.sections.filter(section => section.name !== 'deployment:persona-prefix'));
    }
    assert.deepEqual(await ctx.systemPrompt.assemble({ scope: parent }), baseline, 'scoped child callbacks leave parent unchanged');
    await children[0].scope.dispose();
    const callsBefore = [...calls.values()];
    const disposed = await ctx.systemPrompt.assemble({ scope: children[0].agent });
    assert.deepEqual([...calls.values()], callsBefore, 'disposed callback is gone and sibling is excluded');
    assert.match(renderPrompt(disposed), /workflow manager/, 'disposed child composition no longer changes its prompt');
    assert.ok(renderPrompt(await ctx.systemPrompt.assemble({ scope: children[1].agent })).includes(ROLE_PERSONAS.fixer));
  } finally { await ctx.fiber.dispose(); }
});
