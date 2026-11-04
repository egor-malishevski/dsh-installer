// oh-my-dsh-slim settings card — the browser half of the npm package.
//
// A hand-written ModuleLoader bundle (archive/docs/PLAN-CONFIG-CARD.md §2): no build chain,
// no JSX. React and the UI primitives are host-provided platform seeds; the
// settings namespace is registered by the host half (lib/index.js) with the
// shipped defaults.json as its BASE layer, so the bundled profile is edited as
// the USER layer only — a field written back equal to the base value is unset
// (inherits) rather than stored.
//
// Multi-preset profiles: the card exposes a roster of native agent presets
// (bundled "Oh My DSH Slim" + the user's custom profiles) behind the /omds RPC.
// The dropdown only picks WHICH configuration is being edited; which preset a
// new session actually runs is DSH's own agent-preset picker + default
// setting. The bundled profile writes through the settings namespace (hot,
// conflict-fenced); custom profiles write their config snapshot (profile.json
// beside the native preset directory) through profile-save with a revision
// fence, and creating one first copies the bundled preset under a generated
// stable id (display name only — no id field, no pinyin/translation deps).
window.__ModuleLoader__.load({
  id: 'oh-my-dsh-slim',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    // Host generations rename primitives (0.2 dropped the `16` icon suffix and
    // some glyphs entirely). An unknown name would otherwise be `undefined`,
    // which makes React throw #130 and the whole settings section render empty.
    // Structural components are still checked below; unknown names render nothing.
    const uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');
    // ONE sentinel for "absent", because `icon()` below has to tell a real
    // component from the stand-in. Returning a fresh `() => null` per unknown
    // name made every candidate look present, so the fallback chain stopped at
    // its first entry — that is how the advanced toggle lost its chevron on
    // 0.2.1, where every icon now ends in `Outline(Medium|Regular)`.
    const MISSING_PRIMITIVE = () => null;
    const ui = new Proxy(uiPrimitives, {
      get: (target, prop) => (prop in target ? target[prop] : MISSING_PRIMITIVE),
    });

    const NS = 'oh-my-dsh-slim';
    // Shipped package version, shown in the card header. The browser bundle has
    // no build step or package metadata, so this is a literal; T0 and
    // client-card.test.mjs compare it with package.json so a release bump
    // cannot silently leave the header stale.
    const VERSION = '0.8.7';
    const UPSTREAM_ROLE_IDS = ['oracle', 'designer', 'fixer', 'explorer', 'librarian', 'observer'];
    const COUNCILLOR_ROLE_IDS = ['councillor-alpha', 'councillor-beta', 'councillor-gamma'];
    // Council's synthesizer has no user-facing enable switch: it is active
    // exactly when at least two councillors are. Never persist its enabled bit.
    const COUNCIL_ROLE_ID = 'council';
    const COUNCIL_ROLE_IDS = [...COUNCILLOR_ROLE_IDS, COUNCIL_ROLE_ID];
    const MIN_COUNCIL_SEATS = 2;
    const ROLE_IDS = [...UPSTREAM_ROLE_IDS, ...COUNCILLOR_ROLE_IDS, COUNCIL_ROLE_ID];
    const DERIVED_ENABLED_ROLES = new Set([COUNCIL_ROLE_ID]);
    const COUNCIL_DESC_KEYS = {
      'councillor-alpha': 'roleCouncillorAlpha',
      'councillor-beta': 'roleCouncillorBeta',
      'councillor-gamma': 'roleCouncillorGamma',
      council: 'roleCouncil',
    };
    const EFFORTS = ['none', 'off', 'low', 'medium', 'high', 'max'];

    // Reasoning-effort selection is MODEL-scoped: the host model catalog
    // exposes each model's supported reasoning.efforts (adapter-authoritative
    // — e.g. DeepSeek supports Off/Low/High/Max, no medium). Offering a fixed
    // list regardless of model produced the flash+medium failure, and also
    // hid host levels the preset never listed (e.g. intelalloc xhigh).
    // 'none' (omit reasoningEffort) is always offered where a model is known:
    // it never sends the field, so no model can reject it.
    function findModelEntry(groups, provider, model) {
      const group = (groups ?? []).find((entry) => entry?.id === provider);
      return group?.models?.find((entry) => entry.id === model);
    }

    /** Effort dropdown options for one role row's selected model. */
    function effortOptionsFor(groups, provider, model) {
      const entry = findModelEntry(groups, provider, model);
      if (entry === undefined) {
        // Model unknown (catalog loading/error, or a configured value outside
        // the catalog): fall back to the fixed list — behavior unchanged.
        return EFFORTS.map((id) => ({ value: id, label: id }));
      }
      const efforts = entry.reasoning?.efforts;
      if (!Array.isArray(efforts) || efforts.length === 0) {
        // Known model without declared effort control: only 'none' — let the
        // model use its own default instead of sending an unverifiable level.
        return [{ value: 'none', label: 'none' }];
      }
      // 'none' stays FIRST (same placement the fixed list had); the model's
      // own levels follow in the catalog's order.
      const options = efforts.some((effort) => effort.id === 'none')
        ? []
        : [{ value: 'none', label: 'none' }];
      for (const effort of efforts) {
        options.push({
          value: effort.id,
          label: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id,
        });
      }
      return options;
    }

    /**
     * Display label for one effort option.
     *
     * The plugin's `none` token means "do not specify": the request keeps the
     * session-resolved level, or the adapter default when the session has none.
     * Rendering the raw token made it read like a model level (`off` is the
     * level that actually disables thinking), so the dropdown names the
     * behaviour instead. `off` is the adapter's explicit "no reasoning" level
     * and reads as such. Other adapter-declared levels keep the catalog label.
     */
    const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
    function effortLabel(option, t) {
      if (option?.value === 'none') return t('effortInherit');
      if (option?.value === 'off') return t('effortOff');
      const label = option?.label;
      // A catalog-provided display name is authoritative.
      if (typeof label === 'string' && label !== option?.value) return label;
      if (EFFORT_LEVELS.includes(option?.value)) return t('effortLevel_' + option.value);
      // Unknown level from the host or an older config: keep the id, readable.
      return typeof label === 'string' && label !== '' ? label[0].toUpperCase() + label.slice(1) : label;
    }

    /**
     * The value the effort select must display.
     *
     * `undefined` and `none` are the same runtime state ("send no level"), so an
     * unset role must SELECT the follow-session option rather than falling
     * through to the placeholder — otherwise the control shows "Select…" while
     * the configuration is simply "unspecified" (the issue-#9 failure mode).
     * A stored level the selected model does not declare selects the disabled
     * placeholder, and the error line names the level.
     */
    function effortSelectValue(role, effortBad) {
      return effortBad ? '' : (role?.effort ?? 'none');
    }

    /**
     * Whether a role carries its own model route. A route is both halves or
     * neither (issue #11); the same predicate decides display, persistence and
     * which spawn-time controls still apply.
     */
    function roleRouted(role) {
      return typeof role?.provider === 'string' && role.provider !== ''
        && typeof role?.model === 'string' && role.model !== '';
    }

    /**
     * The explanatory line under an effort control set to `none`.
     *
     * `none` means "send no level", and the outcome depends on the route: an
     * inherited route keeps the session's effort (the host merges the parent's
     * resolved level into the child), while a pinned route makes the host drop
     * that inherited level, leaving the model's own default. Only the
     * inheriting case follows the session, so the line must say which one
     * applies instead of claiming both.
     * @returns a locale key, or undefined when the effort is not `none`.
     */
    function effortHintKey(role) {
      if (role?.effort !== 'none') return undefined;
      return roleRouted(role) ? 'effortModelDefaultHint' : 'effortFollowHint';
    }

    /**
     * The role patch applied when the model dropdown changes.
     *
     * Choosing "inherit" is the default coupling: the role's own effort AND
     * output-token cap are cleared in the SAME edit, so "follow the model"
     * cannot leave a stale route-bound value behind for the next session's
     * main model. The user can pin them again afterwards. Picking a concrete
     * model keeps whatever the row already has.
     */
    function roleModelPatch(provider, model) {
      const routed = typeof provider === 'string' && provider !== ''
        && typeof model === 'string' && model !== '';
      return routed
        ? { provider, model }
        : { provider: undefined, model: undefined, effort: 'none', maxTokens: undefined };
    }

    /**
    * Whether an explicitly configured effort cannot be taken by the selected
    * model (per the catalog). Unknown models never mismatch (the fixed-list
    * fallback applies); undefined/''/'none' never mismatch.
    */
    function effortMismatch(effort, groups, provider, model) {
      if (effort === undefined || effort === null || effort === '' || effort === 'none') return false;
      if (findModelEntry(groups, provider, model) === undefined) return false;
      return !effortOptionsFor(groups, provider, model).some((option) => option.value === effort);
    }

    /**
     * Whether a role's stored effort must block saving and render the error.
     *
     * A switched-off role is never dispatched, so its effort cannot fail at
     * dispatch and must not gate the card: observer ships disabled with
     * effort "high", and a model without that level would otherwise lock every
     * save — including the roles the user is actually editing.
     */
    function effortGatesSave(role, groups) {
      return role?.enabled !== false
        && effortMismatch(role?.effort, groups, role?.provider, role?.model);
    }

    // Fields the card manages on the preset layer (inherit-or-override vs the
    // base) and on the advanced layer (user-only; no shipped default).
    const PRESET_FIELDS = ['enabled', 'provider', 'model', 'effort'];
    const ADVANCED_FIELDS = ['maxTokens', 'temperature'];
    // String-valued advanced fields (no numeric parsing, no shipped base).
    const ADVANCED_TEXT_FIELDS = ['personaAppend'];
    // Tool/MCP policy fields, edited per role. `tools`/`mcps` replace the lower
    // layer; `deny` is a union across layers (an entry can be added, never
    // removed by an override), so only entries beyond the shipped list are written.
    const LIST_FIELDS = ['tools', 'deny', 'mcps'];
    const TOOL_NAMES = [
      'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh',
      'web_search', 'web_fetch', 'skill', 'job_kill', 'job_list', 'job_output',
      'todo_write', 'ask_user_question', 'present',
      'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
      'list_agents', 'interrupt_agent', 'send_message', 'subagent_result',
      'subagent_oracle', 'subagent_designer', 'subagent_fixer', 'subagent_explorer',
      'subagent_librarian', 'subagent_observer', 'subagent_councillor_alpha',
      'subagent_councillor_beta', 'subagent_councillor_gamma', 'subagent_council',
    ];
    // Councillor seats carry a read-only ceiling; the synthesizer is tool-less.
    const FIXED_ALLOW = ['read', 'glob', 'grep'];
    const NO_MCP_ROLES = new Set([...COUNCIL_ROLE_IDS]);
    const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
    // Tool names are mcp__<server>__<tool>: a '__' (or a trailing '_') in the server
    // name makes the boundary ambiguous, so its tools could never be matched.
    const serverNameUsable = (name) => SERVER_NAME_RE.test(name) && !name.includes('__') && !name.endsWith('_');
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const EFFORT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
    const PERSONA_APPEND_MAX = 8000;
    // Exact MCP tool name, same shape the backend accepts (<= 64 chars).
    const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]{1,32}__[A-Za-z0-9_-]+$/;
    // A '__' inside the server or tool part makes the server boundary ambiguous;
    // the backend policy fails closed on it, so the card refuses to stage one.
    const isMcpToolNameUi = (name) => typeof name === 'string' && name.length <= 64 && MCP_TOOL_RE.test(name)
      && name.slice(5).split('__').length === 2;
    const mcpServerOf = (name) => name.slice(5).split('__')[0];

    /**
     * Why a role cannot mount MCP tools, or undefined when it may.
     * Council seats are read-only and the synthesizer is tool-less, so a
     * non-empty list is rejected by the backend; the orchestrator has no
     * mounting path and is not a role row. Every other role may mount the
     * servers it is assigned: the backend guard then lets a tool through only
     * when its server is assigned, the role is enabled, deny does not name it
     * and — if the role has a non-empty allow-list — the list names it exactly.
     * @returns 'council' | undefined
     */
    function mcpBlockReason(roleId) {
      return NO_MCP_ROLES.has(roleId) ? 'council' : undefined;
    }
    /** Selected MCP servers a role is not allowed to keep: blocks Save, never dropped silently. */
    const mcpViolation = (roleId, role) => (role?.mcps ?? []).length > 0 && mcpBlockReason(roleId) !== undefined;

    /**
     * Advisory findings about a role's tool / MCP combination (never errors).
     * - allowlistExcludes: a non-empty allow-list names no tool of an assigned
     *   server, so every tool of that server is filtered out;
     * - unassigned: an allow-list names an MCP tool of a server the role is
     *   not assigned, so the entry never takes effect;
     * - denyWins: a tool is in both lists; deny wins.
     * @returns {{kind: string, detail: string}[]}
     */
    function mcpPolicyWarnings(roleId, role) {
      const out = [];
      if (mcpBlockReason(roleId) !== undefined) return out;
      const tools = Array.isArray(role?.tools) ? role.tools : undefined;
      const deny = role?.deny ?? [];
      const mcps = role?.mcps ?? [];
      // tools === undefined: defaults are inherited, nothing to flag.
      if (tools !== undefined && tools.length === 0 && mcps.length === 0) out.push({ kind: 'emptyAllow', detail: '' });
      if (tools !== undefined) {
        for (const server of mcps) {
          if (!tools.some((name) => isMcpToolNameUi(name) && mcpServerOf(name) === server)) out.push({ kind: 'allowlistExcludes', detail: server });
        }
        for (const name of tools) {
          // A shared grant makes a name of an unassigned server effective.
          if (isMcpToolNameUi(name) && !mcps.includes(mcpServerOf(name)) && !(role?.sharedMcpTools ?? []).includes(name)) out.push({ kind: 'unassigned', detail: name });
        }
      }
      for (const name of tools ?? []) if (deny.includes(name)) out.push({ kind: 'denyWins', detail: name });
      return out;
    }
    const isKnownToolName = (name) => TOOL_NAMES.includes(name) || isMcpToolNameUi(name);

    /**
     * Findings about a role's shared grants (`sharedMcpTools`): exact names of
     * tools that already exist in the session. A grant never edits `tools`; the
     * backend lets it through only when the role is enabled, deny does not name
     * it and any FINITE allow-list (including []) names it as well. An absent
     * allow-list inherits and does not block. Never errors, never invents
     * availability: nothing here says the tool exists.
     * @returns {{kind: string, detail: string}[]}
     */
    function sharedMcpWarnings(roleId, role) {
      const out = [];
      const grants = role?.sharedMcpTools ?? [];
      if (mcpBlockReason(roleId) !== undefined || grants.length === 0) return out;
      if (role.enabled === false) out.push({ kind: 'disabled', detail: '' });
      const tools = Array.isArray(role.tools) ? role.tools : undefined;
      for (const name of grants) {
        if ((role.deny ?? []).includes(name)) out.push({ kind: 'denied', detail: name });
        else if (tools !== undefined && !tools.includes(name)) out.push({ kind: 'notAllowed', detail: name });
      }
      return out;
    }
    /** Granted names that are not an exact, unambiguous MCP tool name: they block Save, never dropped silently. */
    const sharedMcpInvalid = (role) => (role?.sharedMcpTools ?? []).filter((name) => !isMcpToolNameUi(name));

    /** Stored server document -> the row/text form the editor edits. */
    function serverToForm(server) {
      const s = server ?? {};
      return {
        transport: s.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        url: s.url ?? '',
        command: s.command ?? '',
        argsText: Array.isArray(s.args) ? s.args.join('\n') : '',
        env: Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value })),
        envFiles: Object.entries(s.envFiles ?? {}).map(([key, value]) => ({ key, value })),
        toolCallTimeoutMs: s.toolCallTimeoutMs === undefined ? '' : String(s.toolCallTimeoutMs),
      };
    }

    /** Editor form -> { server, errors }. Pure; never touches the filesystem. */
    function formToServer(form) {
      const errors = [];
      const f = form ?? {};
      const server = { transport: f.transport === 'streamable-http' ? 'streamable-http' : 'stdio' };
      const pairs = (rows, field) => {
        const out = {};
        for (const row of rows ?? []) {
          const key = String(row.key ?? '').trim();
          if (key === '' && String(row.value ?? '') === '') continue;
          if (!ENV_KEY_RE.test(key)) { errors.push(`${field}.key`); continue; }
          if (Object.hasOwn(out, key)) { errors.push(`${field}.duplicate`); continue; }
          if (field === 'envFiles' && String(row.value ?? '').trim() === '') { errors.push('envFiles.path'); continue; }
          out[key] = field === 'envFiles' ? String(row.value).trim() : String(row.value ?? '');
        }
        return out;
      };
      if (server.transport === 'streamable-http') {
        if (String(f.url ?? '').trim() === '') errors.push('url');
        server.url = String(f.url ?? '').trim();
        if ((f.envFiles ?? []).some((row) => String(row.key ?? '').trim() !== '' || String(row.value ?? '') !== '')) errors.push('envFiles.transport');
      } else {
        if (String(f.command ?? '').trim() === '') errors.push('command');
        server.command = String(f.command ?? '').trim();
        server.args = String(f.argsText ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
        const envFiles = pairs(f.envFiles, 'envFiles');
        if (Object.keys(envFiles).length > 0) server.envFiles = envFiles;
      }
      const env = pairs(f.env, 'env');
      if (Object.keys(env).length > 0) server.env = env;
      const raw = String(f.toolCallTimeoutMs ?? '').trim();
      if (raw !== '') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 2147483647) errors.push('toolCallTimeoutMs');
        else server.toolCallTimeoutMs = n;
      }
      return { server, errors };
    }
    // The host rejects these too; the card must not stage them in the first place.
    const personaAppendInvalid = (value) =>
      typeof value === 'string' && (value.length > PERSONA_APPEND_MAX || value.includes('{{'));

    /**
     * Warning keys for the Council group, derived from the draft.
     * - one seat: needs a second seat to be a council at all;
     * - >= 2 seats with an inherited route: the seats fall back to the
     *   session's model, so the council may be a repeat sample (this is the
     *   default path — no provider/model is shipped — and the explicit-route
     *   comparison alone used to stay silent about it);
     * - >= 2 seats, all explicit and identical: same repeat-sample warning.
     */
    function councilWarningKeys(draft) {
      const seats = COUNCILLOR_ROLE_IDS.filter((roleId) => {
        const role = draft.roles?.[roleId];
        return role !== undefined && role.enabled !== false;
      });
      const keys = [];
      if (seats.length === 1) keys.push('councilNeedsSeats');
      if (seats.length >= MIN_COUNCIL_SEATS) {
        // "Repeat sample" needs BOTH axes to be identical. Three seats on one
        // model with three different seat prompts are still correlated samples,
        // but they are not the same question asked three times — and the plain
        // warning said exactly that, which made it fire on every default
        // configuration once roles began inheriting the session model.
        const prompts = seats.map((roleId) => String(draft.roles[roleId].personaAppend ?? '').trim());
        const distinctPrompts = prompts.every((prompt) => prompt !== '') && new Set(prompts).size === seats.length;
        const inherited = seats.filter((roleId) => !draft.roles[roleId].provider || !draft.roles[roleId].model);
        if (inherited.length > 0) keys.push(distinctPrompts ? 'councilInheritedModelsDistinct' : 'councilInheritedModels');
        else if (new Set(seats.map((roleId) => `${draft.roles[roleId].provider}/${draft.roles[roleId].model}`)).size === 1) {
          keys.push(distinctPrompts ? 'councilSameModelDistinct' : 'councilSameModel');
        }
      }
      return keys;
    }

    // Profile management lives behind the /omds RPC (registered by the seeder
    // host half). The card never writes a native preset directory itself — no
    // id field, no path, just the display name the user types.
    const BUNDLED_PROFILE_ID = 'oh-my-dsh-slim';
    // A proper noun, identical in every language: the host's picker and the
    // registry carry the same string, so no locale ever shows a translated copy.
    const BUNDLED_PROFILE_NAME = 'Oh My DSH Slim';
    const NEW_PROFILE_SENTINEL = '__new__';
    const PROFILE_RPC_PATH = '/omds';
    const PROFILE_RPC_METHODS = Object.freeze({
      list: 'profile-list',
      create: 'profile-create',
      save: 'profile-save',
      setDefault: 'profile-set-default',
      migrate: 'profile-migrate',
      delete: 'profile-delete',
    });

    const REQUIRED_PRIMITIVES = ['Button', 'Input', 'Modal', 'Toast'];
    // Icon names differ across host generations (0.2 primitives dropped the
    // `16` suffix). Icons are cosmetic: resolve the first available name and
    // render nothing when the host ships none of them, instead of disabling
    // the whole card over a missing glyph.
    const ICON_CHECK = ['IconCheckOutline16', 'IconCheckOutlineMedium', 'IconCheckOutline', 'IconCheckOutlineRegular'];
    const ICON_WARNING = ['IconWarningOutline16', 'IconWarningOutlineMedium', 'IconWarningOutline', 'IconWarningOutlineRegular'];
    const ICON_CHEVRON = ['IconChevronDownOutline14', 'IconChevronDownOutlineMedium', 'IconChevronDownOutline', 'IconChevronDownOutlineRegular'];
    function icon(mod, names) {
      for (const name of names) {
        const candidate = mod?.[name];
        // The proxy answers every unknown name with MISSING_PRIMITIVE, so the
        // sentinel — not `undefined` — is what a missing glyph looks like here.
        if (candidate !== undefined && candidate !== null && candidate !== MISSING_PRIMITIVE) return candidate;
      }
      return null;
    }
    function renderIcon(mod, names, props) {
      const component = icon(mod, names);
      return component === null ? null : React.createElement(component, props);
    }
    // Stable fallbacks for the settings snapshot fields: each render must NOT
    // mint a new object for values used in effect dependencies (a fresh {}
    // per render would refire the roster-load effect forever).
    const EMPTY_BASE = Object.freeze({});
    const EMPTY_EFFECTIVE = Object.freeze({});
    const EMPTY_USER = Object.freeze({});

    function missingPrimitives(mod, required = REQUIRED_PRIMITIVES) {
      return required.filter((name) => mod[name] === undefined);
    }

    // ---------------------------------------------------------------- locale
    const zh = {
      desc: '专家角色Subagent委派预设和设置。',
      orchestratorNote: '编排器就是当前会话的主模型：请在输入框旁的模型选择器中更换，默认模型在“设置 \u2192 模型”中维护。没有单独选模型或档位的角色会跟随它；如果固定档位不被该模型支持，委派时会改用会话档位。',
      enabled: '启用',
      model: '模型',
      modelInherit: '继承会话模型（跟随主模型）',
      effort: '思考强度',
      effortInherit: '跟随会话（不指定）',
      effortOff: '关闭思考',
      effortFollowHint: '使用主对话当前的思考档位：主对话换档后，下一次委派自动跟随，无需新建会话。',
      effortModelDefaultHint: '使用该模型自己的默认思考档位。',
      effortPlaceholder: '请选择',
      advanced: '高级',
      advancedWarn: '非必要不要修改默认值，可能改变插件行为。',
      maxTokens: 'token 上限',
      maxTokensFollowHint: '跟随会话模型时，输出上限由主对话决定；固定模型后留空，则使用该模型自己的默认上限。',
      maxTokensEmptyHint: '留空 = 使用该模型自己的默认上限；只有需要限制输出长度时才填。',
      temperature: '温度',
      observerLocked: '本版本锁定：待上游支持委派附件转发（deepseek-harness #4297）后重新评估。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      dirty: '有未保存更改',
      reset: '恢复默认',
      resetConfirm: '确认恢复默认？',
      resetDone: '已恢复默认',
      resetDiscards: '未保存的更改也会被丢弃。',
      sharedMcp: '共享的现有工具',
      sharedMcpNote: '共享现有工具，不新建连接：只对这里逐个写出的完整工具名放行，不支持通配符，也不按整个服务器放行。这里无法确认这些工具是否存在或已连接。',
      sharedMcpNone: '未授权任何共享工具（默认全部拒绝）。',
      sharedMcpRemoveHint: '点击名称即可移除该授权。',
      sharedMcpAdd: '添加授权',
      sharedMcpInvalid: '共享工具名无效：{names}。请使用完整的 mcp__server__tool 名称（服务器名和工具名中都不能含“__”）。移除后才能保存。',
      sharedWarn_disabled: '此角色已停用，共享工具授权不会生效。',
      sharedWarn_denied: '“{name}”在拒绝列表中，拒绝优先，授权不会生效。',
      sharedWarn_notAllowed: '允许列表是精确列表，但没有包含“{name}”，因此授权被拦截。授权不会自动写入允许列表，请在“允许的工具”中也写出它。',
      agentsPanel: '智能体',
      agentsTitle: '智能体',
      effectiveHint: '保存后，修改过的模型、思考强度或温度会在当前会话的下一次子代理请求中生效；角色启停、token 上限、MCP 服务器、工具和指令从新会话开始生效，已在运行的子代理可能保留原有设置。',
      effectiveHintProfile: '保存只会更新这份已存储的配置，不会改变正在运行的会话；只有在新会话中把它选为 Agent 预设后才会使用。',
      advancedSummary: 'token 上限、温度、工具与指令',
      readOnly: '当前连接只读，无法在此修改配置。',
      modelsLoading: '模型目录加载中…',
      modelsEmpty: '未发现可用模型：请先在 设置-模型 导入 provider。',
      modelsError: '模型目录不可用（当前会话/宿主未提供枚举）；已配置的模型值可正常查看与保存。',
      currentValueTag: '当前值',
      invalidMaxTokens: '需为正整数',
      invalidTemperature: '需在 0–2 之间',
      effortMismatch: '当前模型不支持思考强度「{effort}」：请在下拉中重新选择。',
      roleOracle: '架构 / 攻坚 / 代码审查（只读）',
      roleDesigner: 'UI/UX 与视觉实现（可写）',
      roleFixer: '代码实现、修复与重构（可写）',
      roleExplorer: '代码库扫描与调研（只读）',
      roleLibrarian: '外部文档检索（context7 / gh_grep）',
      roleObserver: '视觉分析（本版锁定）',
      roleCouncillorAlpha: '议会席位 α（只读评审）',
      roleCouncillorBeta: '议会席位 β（只读评审）',
      roleCouncillorGamma: '议会席位 γ（只读评审）',
      roleCouncil: '议会合成器（无工具，汇总各席位）',
      councilGroup: 'Council 议会',
      councilOn: '已启用：{seats}',
      councilOff: '未启用（至少需要 2 个议员）',
      councilAutoOn: '随席位自动启用',
      councilAutoOff: '需要至少 2 个议员',
      councilNeedsSeats: 'Council 需要至少 2 个议员；只开 1 个时该席位作为普通只读委派使用。',
      councilInheritedModels: '部分席位跟随会话模型。如果所有席位都跟随，议会就只是同一个模型的重复采样。',
      councilSameModel: '建议为议员选择不同模型：相同模型的“议会”只是重复采样。',
      councilInheritedModelsDistinct: '部分席位跟随会话模型。它们的席位提示不同，所以角度不同，但同一模型的采样仍然相互关联。',
      councilSameModelDistinct: '各席位提示词不同、视角有别；但相同模型的样本仍高度相关，要真正多模型评审请为席位选择不同模型。',
      personaAppend: '席位提示词（追加）',
      personaAppendHint: '留空：由主模型按任务给各席分配视角；填写后该视角固定生效。例如：特别关注并发与失败恢复。',
      councilPrompt: '合成提示词（追加）',
      councilPromptHint: '例如：先列出分歧点，再给出结论。',
      personaAppendInvalid: '提示词不能包含 {{...}}，且不超过 8000 字符。',
      profile: '委派配置',
      bundledProfile: 'Oh My DSH Slim',
      newProfile: '新建配置',
      newProfileHint: '点击后直接下方修改，记得保存',
      draft: '草稿',
      newSessionDefault: '新会话默认',
      setNewSessionDefault: '设为新会话默认',
      selectionHint: '这里只编辑配置，不会切换当前会话；实际用哪个预设由 Agent 预设选择器决定。',
      draftNote: '正在编辑新配置草稿，保存时命名',
      nameTitle: '命名配置',
      nameDescription: '仅填写显示名称，配置 ID 将自动生成且不再改变。',
      displayName: '显示名称',
      nameRequired: '请输入显示名称。',
      nameTooLong: '显示名称不能超过 64 个字符。',
      nameConflict: '该显示名称已存在，请换一个。',
      create: '创建并保存',
      cancel: '取消',
      discard: '放弃更改',
      saveAndSwitch: '保存后切换',
      switchTitle: '有未保存更改',
      switchDescription: '切换配置会离开当前编辑内容。要先保存吗？',
      profileUnavailable: '当前宿主未提供配置列表接口，自定义配置暂不可保存。',
      profileListFailed: '配置列表读取失败。',
      profileMigrationNeeded: '此配置是旧格式（DSH 0.1.5 的 persona 字段已改名），不迁移将无法在新版宿主上加载。迁移会改写 agent.cordis.yml 并保留备份。',
      profileMigrate: '迁移',
      profileMigrated: '已迁移该配置',
      profileMigrateFailed: '迁移失败，请查看宿主日志后重试。',
      profileSaveFailed: '配置保存失败，请检查后重试；当前编辑内容已保留。',
      profileConflict: '保存被拒绝：配置可能已被其他窗口修改，或该取值不被接受。已重新载入最新配置，请再保存一次。',
      profileDefaultFailed: '新会话默认设置失败，请重试。',
      defaultSet: '已设为新会话默认',
      deleteProfile: '删除',
      deleteProfileTitle: '删除配置',
      deleteProfileDescription: '删除后无法恢复。已经开始的会话继续运行；之后重新打开该配置下的会话时，会改用当前的新会话默认配置。',
      deleteProfileConfirm: '确认删除',
      deleteProfileDone: '已删除该配置',
      deleteProfileFailed: '删除失败，请重试。',
      deleteProfileNotFound: '该配置已不存在，可能已在其他窗口被删除。',
      deleteProfileIsDefault: '这是当前新会话默认配置，请先把其他配置设为默认再删除。',
      deleteProfileDirty: '该配置还有未保存的修改，删除会一并丢弃。',
      mcpsViolation: '此角色列出了它无法使用的 MCP 服务器，请移除后再保存。',
      mcpsSemantics: '只有已分配的服务器可用：未分配服务器的工具始终被拦截。对已分配的服务器，被拒绝的工具仍然被拦截；若允许列表有内容，必须逐个写出工具的完整名称。',
      mcpToolName: 'MCP 工具名',
      mcpToolAdd: '添加工具',
      mcpToolNameInvalid: '请使用 mcp__server__tool 的格式，只含字母、数字、“_”或“-”（最长 64 个字符）。',
      mcpWarn_allowlistExcludes: '允许列表里没有服务器“{name}”的任何工具，它的全部工具都会被过滤。请添加完整的 mcp__{name}__tool 名称，或清空允许列表。',
      mcpWarn_unassigned: '“{name}”在允许列表中，但它所属的服务器没有分配给此角色，因此不会生效。',
      mcpWarn_denyWins: '“{name}”同时被允许和拒绝，拒绝优先。',
      toolsExplicit: '设置精确的允许工具列表',
      toolsInheritHint: '默认：角色保留常规工具，并加上已分配 MCP 服务器的全部工具。打开开关即可指定精确列表。',
      toolsExplicitHint: '只允许列表中的工具。MCP 工具必须以 mcp__server__tool 的完整名称写在这里才算数。',
      toolsEmptyExplicit: '空列表表示此角色完全不能使用任何工具，这与保持默认（保留常规工具）不同。',
      toolUnknown: '未知的工具名：{names}。请使用内置工具，或完整的 mcp__server__tool 名称（服务器名和工具名中都不能含“__”）。移除后才能保存。',
      mcpWarn_emptyAllow: '允许列表为空，也没有分配 MCP 服务器，因此此角色没有任何工具。',
      policyTitle: '工具与 MCP',
      tools: '允许的工具',
      deny: '禁止的工具',
      denyHint: '拒绝始终优先，即使该工具也在允许列表中。内置的禁止项已锁定：可以追加（工具名或完整的 mcp__server__tool），但不能移除。',
      denyLocked: '内置',
      mcps: 'MCP 服务器',
      mcpsNone: '尚未定义 MCP 服务器，请先在“MCP 服务器”部分添加。',
      mcpsCouncilLocked: '议会角色不能使用 MCP 工具，否则会破坏它们只读、仅做综合的限制。',
      toolsSeatCeiling: '席位最多只能使用 read、glob、grep，此列表只能进一步收窄。',
      toolsSynthLocked: '综合角色不使用工具，工具列表会被忽略。',
      observerRestriction: 'observer 保持停用，在附件可以转发给子代理之前，无法在此启用。',
      councilRestriction: '启用 2 个及以上席位时，综合角色会自动启用；它没有开关，不使用工具，也不使用 MCP。',
      orchestratorTitle: '编排器',
      orchestratorEffort: '编排器思考强度',
      orchestratorMcps: '编排器 MCP 服务器',
      orchestratorMcpsLocked: '暂不支持：编排器无法在此挂载 MCP 服务器（请在宿主中配置），因此加载配置时会拒绝非空列表。',
      serversTitle: 'MCP 服务器',
      serversHint: '这里只保存连接信息，不会安装或启动任何内容。',
      serverAdd: '添加服务器',
      serverRemove: '移除',
      serverName: '名称',
      serverTransport: '传输方式',
      serverUrl: 'URL',
      serverCommand: '命令',
      serverArgs: '参数（每行一个）',
      serverEnv: '环境变量',
      serverEnvWarn: '变量值会以明文保存在此配置中。机密信息请改用环境变量文件路径。',
      serverEnvFiles: '来自文件的环境变量',
      serverEnvFilesHint: '变量名 \u2192 文件路径。文件只在服务器启动时读取，内容不会在此加载或显示。',
      serverEnvFilesHttp: '环境变量文件需要 stdio 传输方式。',
      serverTimeout: '工具调用超时（毫秒）',
      serverTimeoutHint: '留空 = 宿主默认值（60000）。',
      serverKey: '变量名',
      serverValue: '值',
      serverPath: '文件路径',
      serverRowAdd: '添加',
      serverNameInvalid: '请使用 1\u201332 个字母、数字、“_”或“-”；名称不能重复，不能含“__”，也不能以“_”结尾（否则 mcp__server__tool 会有歧义，其工具会被拦截）。',
      serverInvalid: '请检查此服务器：{fields}',
      serverInUse: '正被以下角色使用：{roles}。请先从这些角色中移除。',
      overridesTitle: '根级覆盖',
      overridesHint: '优先级从高到低：advanced 中的角色 \u2192 roles \u2192 所选预设 \u2192 内置默认值。roles 中的条目会整体替换预设里该角色的条目。在此编辑字段时，会修改已包含该字段的那一层。',
      overridesNone: '此配置中没有根级角色覆盖。',
      overridesShadow: '{role}：roles 条目（{fields}）替换了预设中的条目。',
      overridesPlain: '{role}：roles 条目（{fields}）。',
      identityTitle: '标识与日志',
      presetName: '预设名称',
      presetNameHint: '使用 presets 下的哪一项。加载时会拒绝未知名称。',
      presetId: '预设 ID',
      verbose: '详细日志',
      identityReadOnly: '预设 ID（旧版报告标签）和详细日志只在插件启动时读取一次。此卡片只能修改实时设置，因此这里只读显示。如需修改，请编辑配置文件中本插件的条目并重启。',
      resetKeepsServers: 'MCP 服务器定义会保留。',
      notSet: '（未设置）',
      invalidEffort: '请使用字母、数字、“-”或“_”，以字母开头，最长 32 个字符。',
      effortUnset: '未设置',
      effortLevel_low: '低',
      effortLevel_medium: '中',
      effortLevel_high: '高',
      effortLevel_xhigh: '超高',
      effortLevel_max: '最大',
    };

    const en = {
      desc: 'Expert-role subagent delegation preset and settings.',
      orchestratorNote: 'The orchestrator is the session\u2019s main model. Change it in the model picker next to the message box; default models are set under Settings \u2192 Models. Roles with no model or level of their own follow it. If a fixed level is not offered by the model, the session\u2019s level is used instead.',
      enabled: 'Enabled',
      model: 'Model',
      modelInherit: 'Inherit session model (follows the main model)',
      effort: 'Reasoning effort',
      effortInherit: 'Follow session (unspecified)',
      effortOff: 'Thinking off',
      effortFollowHint: 'Uses the main conversation\u2019s current effort; a later change applies to the next delegation, no new session needed.',
      effortModelDefaultHint: 'Uses the model\u2019s own default effort.',
      effortPlaceholder: 'Select\u2026',
      advanced: 'Advanced',
      advancedWarn: 'Avoid changing these defaults; they can alter plugin behavior.',
      maxTokens: 'Max tokens',
      maxTokensFollowHint: 'With an inherited model the main conversation decides the output cap; a pinned model uses the model default when left empty.',
      maxTokensEmptyHint: 'Empty = the model\u2019s own default output cap; fill this only to bound the output.',
      temperature: 'Temperature',
      observerLocked: 'Locked in this version: it will be reconsidered once delegated subagents can receive attachments (deepseek-harness #4297).',
      save: 'Save',
      saving: 'Saving\u2026',
      saved: 'Saved',
      dirty: 'Unsaved changes',
      reset: 'Reset to defaults',
      resetConfirm: 'Reset to defaults?',
      resetDone: 'Reset to defaults',
      resetDiscards: 'Unsaved changes are discarded too.',
      sharedMcp: 'Shared existing tools',
      sharedMcpNote: 'Shared existing tools — no new connection. Only the exact tool names listed here are let through; there are no wildcards and no whole-server grants. This list cannot tell whether a tool exists or is connected.',
      sharedMcpNone: 'No shared tools granted (everything is denied by default).',
      sharedMcpRemoveHint: 'Click a name to remove that grant.',
      sharedMcpAdd: 'Add grant',
      sharedMcpInvalid: 'Invalid shared tool name: {names}. Use an exact mcp__server__tool name with no "__" inside the server or tool part. Remove it to save.',
      sharedWarn_disabled: 'This role is disabled, so its shared tool grants have no effect.',
      sharedWarn_denied: '"{name}" is in the denied list; deny wins, so the grant has no effect.',
      sharedWarn_notAllowed: 'The allowed list is exact and does not include "{name}", so the grant is blocked. Grants are never added to the allowed list for you; add it under Allowed tools too.',
      agentsPanel: 'Agents',
      agentsTitle: 'Agents',
      effectiveHint: 'After saving, a changed model, effort or temperature is picked up by the next subagent request in the current session. Role on/off, token limits, MCP servers, tools and instructions apply to new sessions; subagents that are already running may keep their previous values.',
      effectiveHintProfile: 'Saving only updates this stored configuration. It does not change a running session; a new session uses it when this configuration is chosen as its Agent preset.',
      advancedSummary: 'Token limit, temperature, tools and instructions',
      readOnly: 'This connection is read-only; configuration cannot be edited here.',
      modelsLoading: 'Loading model catalog\u2026',
      modelsEmpty: 'No models found: import a provider under Settings \u2192 Models first.',
      modelsError: 'The model list is unavailable here (this session or host cannot provide it). Configured model values still display and save.',
      currentValueTag: 'Current',
      invalidMaxTokens: 'Must be a positive integer',
      invalidTemperature: 'Must be between 0 and 2',
      effortMismatch: 'This model does not support the reasoning effort "{effort}": pick another level from the list.',
      roleOracle: 'Architecture / hard problems / code review (read-only)',
      roleDesigner: 'UI/UX and visual implementation (writable)',
      roleFixer: 'Code implementation, fixes, and refactoring (writable)',
      roleExplorer: 'Codebase scan and research (read-only)',
      roleLibrarian: 'External docs (context7 / gh_grep)',
      roleObserver: 'Vision analysis (locked this release)',
      roleCouncillorAlpha: 'Council seat alpha (read-only review)',
      roleCouncillorBeta: 'Council seat beta (read-only review)',
      roleCouncillorGamma: 'Council seat gamma (read-only review)',
      roleCouncil: 'Council synthesizer (no tools, merges the seats)',
      councilGroup: 'Council',
      councilOn: 'Active: {seats}',
      councilOff: 'Off (needs at least 2 seats)',
      councilAutoOn: 'Auto-enabled by the seats',
      councilAutoOff: 'Needs at least 2 seats',
      councilNeedsSeats: 'A council needs at least 2 seats; a single enabled seat runs as an ordinary read-only delegation.',
      councilInheritedModels: 'Some seats follow the session model. If every seat does, the council is just repeated samples of one model.',
      councilSameModel: 'Give the seats different models: identical models make the council a repeat sample.',
      councilInheritedModelsDistinct: 'Some seats follow the session model. Their seat prompts differ, so the angles do, but samples from one model stay correlated.',
      councilSameModelDistinct: 'The seat prompts differ, so the angles do; samples from one model still stay correlated. Pick different models for a true multi-model review.',
      personaAppend: 'Seat prompt (appended)',
      personaAppendHint: 'Empty: the main model assigns each seat a focus per task; a value here fixes the angle. e.g. Focus on concurrency and failure recovery.',
      councilPrompt: 'Synthesis prompt (appended)',
      councilPromptHint: 'e.g. List the disagreements first, then the verdict.',
      personaAppendInvalid: 'Prompt must not contain {{...}} and must stay under 8000 characters.',
      profile: 'Delegation configuration',
      bundledProfile: 'Oh My DSH Slim',
      newProfile: 'New configuration',
      newProfileHint: 'edit right below, then save',
      draft: 'Draft',
      newSessionDefault: 'Default for new sessions',
      setNewSessionDefault: 'Set as default for new sessions',
      selectionHint: 'This only edits a configuration; it does not switch the current session. Which preset a new session uses is the Agent preset picker\u2019s decision.',
      draftNote: 'Editing an unsaved new profile; it is named on save',
      nameTitle: 'Name configuration',
      nameDescription: 'Enter a display name only. The configuration ID is generated automatically and never changes.',
      displayName: 'Display name',
      nameRequired: 'Enter a display name.',
      nameTooLong: 'Display name must be 64 characters or fewer.',
      nameConflict: 'That display name already exists. Choose another.',
      create: 'Create and save',
      cancel: 'Cancel',
      discard: 'Discard changes',
      saveAndSwitch: 'Save and switch',
      switchTitle: 'Unsaved changes',
      switchDescription: 'Switching configurations will leave the current edits. Save them first?',
      profileUnavailable: 'This host does not provide the profile API; custom configurations cannot be saved yet.',
      profileListFailed: 'Failed to read the configuration list.',
      profileMigrationNeeded: 'This configuration uses the old format (the persona field changed in DSH 0.1.5) and will not load on the new host. Migrating rewrites agent.cordis.yml and keeps a backup.',
      profileMigrate: 'Migrate',
      profileMigrated: 'Configuration migrated',
      profileMigrateFailed: 'Migration failed; check the host log and retry.',
      profileSaveFailed: 'Could not save the configuration. Your edits are still here.',
      profileConflict: 'The save was rejected: the configuration may have changed in another window, or a value was refused. The latest configuration has been reloaded \u2014 try saving again.',
      profileDefaultFailed: 'Could not change the new-session default. Try again.',
      defaultSet: 'Default for new sessions set',
      deleteProfile: 'Delete',
      deleteProfileTitle: 'Delete configuration',
      deleteProfileDescription: 'This cannot be undone. Sessions already running keep working; reopening a session created with this configuration falls back to the current new-session default.',
      deleteProfileConfirm: 'Delete',
      deleteProfileDone: 'Configuration deleted',
      deleteProfileFailed: 'Could not delete the configuration. Try again.',
      deleteProfileNotFound: 'That configuration no longer exists; another window may have deleted it.',
      deleteProfileIsDefault: 'This is the new-session default. Set another configuration as the default first.',
      deleteProfileDirty: 'This configuration has unsaved edits; deleting also discards them.',
      mcpsViolation: 'This role lists MCP servers it cannot use. Remove them to save.',
      mcpsSemantics: 'Only assigned servers are available: tools from a server that is not assigned are always blocked. For an assigned server, a denied tool stays blocked, and if the allowed list has entries it must name each tool exactly.',
      mcpToolName: 'MCP tool name',
      mcpToolAdd: 'Add tool',
      mcpToolNameInvalid: 'Use the form mcp__server__tool, with letters, digits, "_" or "-" (up to 64 characters).',
      mcpWarn_allowlistExcludes: 'The allowed list contains no tool from server "{name}", so all of its tools are filtered out. Add exact mcp__{name}__tool names, or clear the list.',
      mcpWarn_unassigned: '"{name}" is allowed, but its server is not assigned to this role, so it has no effect.',
      mcpWarn_denyWins: '"{name}" is both allowed and denied. Denied wins.',
      toolsExplicit: 'Set an exact list of allowed tools',
      toolsInheritHint: 'Default: the role keeps its usual tools plus every tool of its assigned MCP servers. Turn this on to choose the exact list.',
      toolsExplicitHint: 'Only the tools listed here are allowed. MCP tools count only when named exactly, as mcp__server__tool.',
      toolsEmptyExplicit: 'An empty list means this role can use no tools at all. This is different from the default, where the role keeps its usual tools.',
      toolUnknown: 'Unknown tool name: {names}. Use a built-in tool, or an exact mcp__server__tool name with no "__" inside the server or tool part. Remove it to save.',
      mcpWarn_emptyAllow: 'The allowed list is empty and no MCP server is assigned, so this role has no tools.',
      policyTitle: 'Tools and MCP',
      tools: 'Allowed tools',
      deny: 'Denied tools',
      denyHint: 'Denied always wins, even over a tool in the allowed list. Built-in denials are locked: you can add more (a tool name or an exact mcp__server__tool) but not remove them.',
      denyLocked: 'built-in',
      mcps: 'MCP servers',
      mcpsNone: 'No MCP servers are defined yet. Add one in the MCP servers section.',
      mcpsCouncilLocked: 'Council roles cannot use MCP tools; that would break their read-only, synthesis-only limits.',
      toolsSeatCeiling: 'Seats can use at most read, glob and grep; this list can only narrow that.',
      toolsSynthLocked: 'The synthesizer uses no tools, so tool lists are ignored.',
      observerRestriction: 'Observer stays off and cannot be enabled here until attachments can be passed to subagents.',
      councilRestriction: 'The synthesizer turns on automatically when 2 or more seats are on. It has no switch, tools or MCP servers.',
      orchestratorTitle: 'Orchestrator',
      orchestratorEffort: 'Orchestrator effort',
      orchestratorMcps: 'Orchestrator MCP servers',
      orchestratorMcpsLocked: 'Not supported: the orchestrator cannot mount MCP servers from here (set them up in the host), so a non-empty list is rejected when the configuration loads.',
      serversTitle: 'MCP servers',
      serversHint: 'Connection details only. Nothing is installed or started from here.',
      serverAdd: 'Add server',
      serverRemove: 'Remove',
      serverName: 'Name',
      serverTransport: 'Transport',
      serverUrl: 'URL',
      serverCommand: 'Command',
      serverArgs: 'Arguments (one per line)',
      serverEnv: 'Environment variables',
      serverEnvWarn: 'Values are saved as plain text in this configuration. For secrets, use an environment file path instead.',
      serverEnvFiles: 'Environment from files',
      serverEnvFilesHint: 'Variable name \u2192 file path. The file is read only when the server starts; its contents are never loaded or shown here.',
      serverEnvFilesHttp: 'Environment files require the stdio transport.',
      serverTimeout: 'Tool call timeout (ms)',
      serverTimeoutHint: 'Empty = host default (60000).',
      serverKey: 'Variable',
      serverValue: 'Value',
      serverPath: 'File path',
      serverRowAdd: 'Add',
      serverNameInvalid: 'Use 1\u201332 letters, digits, "_" or "-". Names must be unique, must not contain "__" or end with "_" (that would make mcp__server__tool ambiguous and block its tools).',
      serverInvalid: 'Check this server: {fields}',
      serverInUse: 'Used by: {roles}. Remove it from those roles first.',
      overridesTitle: 'Root overrides',
      overridesHint: 'Priority, highest first: advanced roles \u2192 roles \u2192 the selected preset \u2192 built-in defaults. A "roles" entry replaces the preset\u2019s whole entry for that role. Editing a field here changes the layer that already holds it.',
      overridesNone: 'No root-level role overrides in this configuration.',
      overridesShadow: '{role}: a roles entry ({fields}) replaces the preset entry.',
      overridesPlain: '{role}: roles entry ({fields}).',
      identityTitle: 'Identity and logging',
      presetName: 'Preset name',
      presetNameHint: 'Which entry under "presets" is used. Unknown names are rejected when loading.',
      presetId: 'Preset id',
      verbose: 'Verbose logging',
      identityReadOnly: 'Preset id (a legacy report label) and verbose logging are read once when the plugin starts. This card can only change live settings, so they are read-only here. To change them, edit this plugin\u2019s entry in the profile configuration file and restart.',
      resetKeepsServers: 'MCP server definitions are kept.',
      notSet: '(not set)',
      invalidEffort: 'Use letters, digits, "-" or "_"; start with a letter; up to 32 characters.',
      effortUnset: 'Not set',
      effortLevel_low: 'Low',
      effortLevel_medium: 'Medium',
      effortLevel_high: 'High',
      effortLevel_xhigh: 'Extra high',
      effortLevel_max: 'Max',
    };

    // ------------------------------------------------------------- utilities
    function getPath(obj, path) {
      let cursor = obj;
      for (const key of path) {
        if (cursor === undefined || cursor === null || typeof cursor !== 'object') return undefined;
        cursor = cursor[key];
      }
      return cursor;
    }

    function deepEqualJson(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    /**
     * A cleared input reports '' where the stored document has no field. Both mean
     * "unset", so the dirty check must not treat clearing a field back to empty
     * as a change. Only role fields are normalised; server forms compare as typed.
     */
    function semanticDraft(draft) {
      const roles = {};
      for (const [roleId, role] of Object.entries(draft?.roles ?? {})) {
        // Absent and [] grants are the same policy (deny), so they compare equal.
        roles[roleId] = Object.fromEntries(Object.entries(role).map(([key, value]) => [key, value === '' || (key === 'sharedMcpTools' && Array.isArray(value) && value.length === 0) ? undefined : value]));
      }
      return { ...draft, roles };
    }

    function cloneJson(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function parseAdvancedNumber(raw, kind) {
      if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
      const n = Number(raw);
      if (kind === 'maxTokens') return Number.isSafeInteger(n) && n >= 1 ? n : null; // null = invalid
      return Number.isFinite(n) && n >= 0 && n <= 2 ? n : null;
    }

    const uniq = (list) => [...new Set(list)];
    const asList = (value) => (Array.isArray(value) ? value : undefined);

    /**
     * Role override object that is ACTIVE for one role in a user document. The
     * backend replaces whole role entries: `roles[role]` (compact) wins over
     * `presets[preset][role]` as a unit, it is not merged field by field.
     */
    function activeRoleOverride(doc, presetName, roleId) {
      return doc?.roles?.[roleId] ?? doc?.presets?.[presetName]?.[roleId] ?? {};
    }

    /** The stored sharedMcpTools of a role in a user/profile document (advanced wins), or undefined when absent. */
    function storedSharedMcpTools(doc, presetName, roleId) {
      return asList(doc?.advanced?.roles?.[roleId]?.sharedMcpTools) ?? asList(activeRoleOverride(doc, presetName, roleId).sharedMcpTools);
    }

    /** Orchestrator override chain: roles.orchestrator > presets[p].orchestrator > orchestrator. */
    function activeOrchestratorPath(doc, presetName) {
      if (doc?.roles?.orchestrator !== undefined) return ['roles', 'orchestrator'];
      if (doc?.presets?.[presetName]?.orchestrator !== undefined) return ['presets', presetName, 'orchestrator'];
      if (doc?.orchestrator !== undefined) return ['orchestrator'];
      return undefined;
    }

    function buildDraft(value, advanced, base, user) {
      const presetName = value?.preset ?? base?.preset ?? 'my-dsh-slim-default';
      const basePreset = base?.presets?.[presetName] ?? {};
      // With the raw user document, overrides are read from it (the settings
      // snapshot `value` already folds the base into presets and would hide
      // which layer an override lives in). Otherwise `value` is the effective doc.
      const src = user ?? value;
      const roles = {};
      for (const roleId of ROLE_IDS) {
        const baseRole = basePreset[roleId] ?? {};
        const ov = activeRoleOverride(src, presetName, roleId);
        const adv = advanced?.roles?.[roleId] ?? base?.advanced?.roles?.[roleId] ?? {};
        const eff = { ...baseRole, ...ov, ...adv };
        // A route is provider AND model, or neither (issue #11). A half route
        // is unreachable — never pair one provider's id with another
        // provider's model — so the editor renders it as "inherit" and the
        // next save clears both fields.
        const provider = eff.provider;
        const model = eff.model;
        const routed = typeof provider === 'string' && provider !== ''
          && typeof model === 'string' && model !== '';
        roles[roleId] = {
          enabled: eff.enabled ?? true,
          provider: routed ? provider : undefined,
          model: routed ? model : undefined,
          effort: eff.effort,
          maxTokens: adv.maxTokens ?? ov.maxTokens,
          temperature: adv.temperature ?? ov.temperature,
          personaAppend: adv.personaAppend ?? ov.personaAppend,
          // Tri-state, as the backend reads it: absent inherits the defaults,
          // [] is an exhaustive EMPTY allow-list, a non-empty list is exact.
          tools: asList(adv.tools) ?? asList(ov.tools) ?? asList(baseRole.tools),
          // deny is a union across layers: an override can add, never remove.
          deny: uniq([...(baseRole.deny ?? []), ...(ov.deny ?? []), ...(adv.deny ?? [])]),
          mcps: [...(asList(adv.mcps) ?? asList(ov.mcps) ?? asList(baseRole.mcps) ?? [])],
          // Exact grants of tools that already exist in the session. Absent and
          // [] both deny, but they stay distinct here so a stored [] is not
          // rewritten and an absent field is not turned into one.
          sharedMcpTools: asList(adv.sharedMcpTools) ?? asList(ov.sharedMcpTools) ?? asList(baseRole.sharedMcpTools),
        };
      }
      const orchPath = activeOrchestratorPath(src, presetName);
      const orchOv = orchPath === undefined ? {} : (getPath(src, orchPath) ?? {});
      const orchestrator = { effort: orchOv.effort ?? basePreset.orchestrator?.effort, mcps: [] };
      const servers = {};
      for (const [name, server] of Object.entries(value?.mcpServers ?? {})) servers[name] = serverToForm(server);
      return { preset: presetName, roles, orchestrator, servers };
    }

    /**
     * Root-level overrides that the preset cards would otherwise not show:
     * `roles[...]` (beats `presets[preset][role]` as a whole entry),
     * `advanced.roles[...]` fields other than the three advanced inputs, and the
     * top-level `orchestrator`. Pure; for display and tests.
     */
    function rootOverrides(doc, presetName) {
      const out = [];
      for (const roleId of ROLE_IDS) {
        const roots = doc?.roles?.[roleId];
        if (roots !== undefined) {
          out.push({ roleId, layer: 'roles', fields: Object.keys(roots), shadowsPreset: doc?.presets?.[presetName]?.[roleId] !== undefined });
        }
      }
      if (doc?.roles?.orchestrator !== undefined) {
        out.push({ roleId: 'orchestrator', layer: 'roles', fields: Object.keys(doc.roles.orchestrator), shadowsPreset: false });
      } else if (doc?.orchestrator !== undefined) {
        out.push({ roleId: 'orchestrator', layer: 'orchestrator', fields: Object.keys(doc.orchestrator), shadowsPreset: false });
      }
      return out;
    }

    const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

    /**
     * Minimal user-layer write plan moving `user` toward `draft`, treating any
     * field equal to the base (shipped default) as inherit (unset). Fields are
     * written to the layer that already holds them, highest layer first
     * (advanced.roles > roles > presets[preset]); nothing is ever written to a
     * lower layer under a higher one, so a hidden override cannot silently win.
     * Exported for unit tests; pure.
     * @returns ops shaped like the settings mutate contract.
     */
    function planUserOps(base, user, draft) {
      const ops = [];
      const presetName = draft.preset;
      const basePreset = base?.presets?.[presetName] ?? {};
      if (draft.preset !== undefined) {
        const has = user?.preset !== undefined;
        if (draft.preset === base?.preset) { if (has) ops.push({ op: 'unset', path: ['preset'] }); }
        else if (user?.preset !== draft.preset) ops.push({ op: 'set', path: ['preset'], value: draft.preset });
      }
      for (const roleId of ROLE_IDS) {
        const d = draft.roles?.[roleId] ?? {};
        const baseRole = basePreset[roleId] ?? {};
        const ovPath = user?.roles?.[roleId] !== undefined ? ['roles', roleId] : ['presets', presetName, roleId];
        const advPath = ['advanced', 'roles', roleId];
        const ov = getPath(user, ovPath) ?? {};
        const adv = getPath(user, advPath) ?? {};
        const scalar = (field, dv, defaultPath, equal = deepEqualJson) => {
          const bv = baseRole[field];
          const target = adv[field] !== undefined ? advPath : ov[field] !== undefined ? ovPath : defaultPath;
          if (dv === undefined || equal(dv, bv)) {
            for (const path of [advPath, ovPath]) {
              if (getPath(user, [...path, field]) !== undefined) ops.push({ op: 'unset', path: [...path, field] });
            }
          } else if (!equal(getPath(user, [...target, field]), dv)) {
            ops.push({ op: 'set', path: [...target, field], value: dv });
          }
        };
        for (const field of PRESET_FIELDS) {
          // council.enabled is derived from the seats; never write it.
          if (field === 'enabled' && DERIVED_ENABLED_ROLES.has(roleId)) continue;
          scalar(field, d[field], ovPath);
        }
        for (const field of ADVANCED_FIELDS) {
          // The draft holds what the input element reports: a STRING, and ''
          // once the user clears it. The namespace document requires a number,
          // so coerce here (the card gates saving on validity) and treat an
          // empty box as "unset".
          const raw = d[field];
          const dv = raw === undefined || raw === '' ? undefined : parseAdvancedNumber(raw, field);
          scalar(field, dv === null ? undefined : dv, advPath);
        }
        for (const field of ADVANCED_TEXT_FIELDS) scalar(field, d[field] === '' ? undefined : d[field], advPath);
        // tools / mcps replace the lower layer. Council roles cannot mount MCP
        // and the synthesizer ignores tools, so their lists are never written.
        if (roleId !== COUNCIL_ROLE_ID) scalar('tools', asList(d.tools), ovPath);
        // Council roles are blocked in the card (mcpViolation); every other role writes its list.
        if (!NO_MCP_ROLES.has(roleId)) scalar('mcps', d.mcps ?? [], ovPath, (a, b) => deepEqualJson(a ?? [], b ?? []));
        // sharedMcpTools: exact grants, never merged. The highest layer that
        // holds the field is edited in place (advanced > roles/presets). Absent
        // stays absent; removing the last grant of a stored list writes [].
        if (!NO_MCP_ROLES.has(roleId)) {
          const dv = asList(d.sharedMcpTools);
          const holders = [advPath, ovPath].filter((path) => getPath(user, [...path, 'sharedMcpTools']) !== undefined);
          const stored = holders.length > 0 ? getPath(user, [...holders[0], 'sharedMcpTools']) : undefined;
          if (dv === undefined) {
            for (const path of holders) ops.push({ op: 'unset', path: [...path, 'sharedMcpTools'] });
          } else if (!(dv.length === 0 && stored === undefined) && !deepEqualJson(dv, stored)) {
            ops.push({ op: 'set', path: [...(holders[0] ?? ovPath), 'sharedMcpTools'], value: dv });
          }
        }
        // deny is additive over the base: write only the extras.
        if (roleId !== COUNCIL_ROLE_ID && Array.isArray(d.deny)) {
          const extras = d.deny.filter((name) => !(baseRole.deny ?? []).includes(name));
          const current = uniq([...(ov.deny ?? []), ...(adv.deny ?? [])]).filter((name) => !(baseRole.deny ?? []).includes(name));
          if (!sameSet(extras, current)) {
            if (extras.length === 0) {
              for (const path of [advPath, ovPath]) if (getPath(user, [...path, 'deny']) !== undefined) ops.push({ op: 'unset', path: [...path, 'deny'] });
            } else {
              ops.push({ op: 'set', path: [...ovPath, 'deny'], value: extras });
              if (adv.deny !== undefined) ops.push({ op: 'unset', path: [...advPath, 'deny'] });
            }
          }
        }
      }
      // orchestrator.effort: write into the container that is active.
      {
        const dv = draft.orchestrator?.effort;
        const bv = basePreset.orchestrator?.effort;
        const active = activeOrchestratorPath(user, presetName) ?? ['presets', presetName, 'orchestrator'];
        const containers = [['roles', 'orchestrator'], ['presets', presetName, 'orchestrator'], ['orchestrator']];
        if (dv === undefined || dv === bv) {
          for (const path of containers) if (getPath(user, [...path, 'effort']) !== undefined) ops.push({ op: 'unset', path: [...path, 'effort'] });
        } else if (getPath(user, [...active, 'effort']) !== dv) {
          ops.push({ op: 'set', path: [...active, 'effort'], value: dv });
        }
      }
      // MCP server definitions: whole-entry replace, secrets stay as typed.
      const draftNames = Object.keys(draft.servers ?? {});
      for (const name of draftNames) {
        const form = draft.servers[name];
        const path = ['mcpServers', name];
        const storedUser = getPath(user, path);
        const storedBase = base?.mcpServers?.[name];
        // Untouched: the form equals what is already stored (compared through
        // the form, which is lossy for keys it does not edit), so nothing is
        // rewritten and no stored key is lost.
        if (storedUser !== undefined && deepEqualJson(form, serverToForm(storedUser))) continue;
        if (storedBase !== undefined && deepEqualJson(form, serverToForm(storedBase))) {
          if (storedUser !== undefined) ops.push({ op: 'unset', path });
          continue;
        }
        const { server, errors } = formToServer(form);
        if (errors.length > 0) continue;
        if (deepEqualJson(server, base?.mcpServers?.[name])) {
          if (getPath(user, path) !== undefined) ops.push({ op: 'unset', path });
        } else if (!deepEqualJson(getPath(user, path), server)) {
          ops.push({ op: 'set', path, value: server });
        }
      }
      for (const name of Object.keys(user?.mcpServers ?? {})) {
        if (!draftNames.includes(name)) ops.push({ op: 'unset', path: ['mcpServers', name] });
      }
      return ops;
    }

    // ----------------------------------------------------- profile helpers
    /** Extract a raw profile config document from a roster payload entry. */
    function profileConfig(value) {
      if (!value || typeof value !== 'object') return {};
      return cloneJson(value.config ?? value.value ?? value);
    }

    /** The roster shape before the host answers (bundled profile only). */
    function initialProfileRoster(base) {
      return {
        profiles: [{
          id: BUNDLED_PROFILE_ID,
          displayName: BUNDLED_PROFILE_NAME,
          kind: 'bundled',
          isDefaultForNewSessions: true,
          revision: undefined,
          config: undefined,
        }],
        defaultProfileId: BUNDLED_PROFILE_ID,
      };
    }

    /**
     * Normalize the roster payload from profile-list. Always keeps the
     * bundled profile first (it carries the bundled defaults and must remain
     * present even when the host lists nothing), then appends every custom
     * profile. The host is authoritative for names, defaults and revisions.
     */
    function normalizeProfileRoster(base, payload) {
      const initial = initialProfileRoster(base);
      const incoming = Array.isArray(payload) ? payload : payload?.profiles;
      if (!Array.isArray(incoming)) return initial;
      const profiles = [...initial.profiles];
      for (const item of incoming) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id === NEW_PROFILE_SENTINEL) continue;
        // Defense in depth: only ids this package owns can be edited here; the
        // host filters its roster too, but showing a foreign native preset that
        // the save RPC would refuse would be misleading.
        if (item.id !== BUNDLED_PROFILE_ID && !item.id.startsWith('profile-')) continue;
        const next = {
          id: item.id,
          displayName: item.id === BUNDLED_PROFILE_ID
            ? BUNDLED_PROFILE_NAME
            : typeof item.displayName === 'string' && item.displayName.trim() !== ''
              ? item.displayName.trim()
              : item.id,
          kind: item.id === BUNDLED_PROFILE_ID ? 'bundled' : 'custom',
          isDefaultForNewSessions: item.isDefaultForNewSessions === true,
          revision: item.revision,
          config: item.config === undefined ? undefined : profileConfig(item.config),
          // DSH 0.1.5 reads only the `prefix` persona key: a directory copied
          // from pre-0.1.5 content still carries `text` alone and would fail its
          // whole preset mount. The host flags such profiles so the card can
          // offer the one-click rewrite.
          needsMigration: item.needsMigration === true,
        };
        const index = profiles.findIndex((profile) => profile.id === next.id);
        if (index >= 0) {
          profiles[index] = {
            ...profiles[index],
            ...next,
            config: next.config !== undefined ? next.config : profiles[index].config,
          };
        } else {
          profiles.push(next);
        }
      }
      // The host's new-session default is a NATIVE agent preset id and may be
      // a preset this card does not own (dsh-base ships "standard"). Only an id
      // present in this roster can be marked; a foreign default is reported as
      // no default instead of silently pinning the bundled profile (which
      // would both select the wrong editor target and claim a default that is
      // not actually set).
      const requestedDefaultId = typeof payload?.defaultProfileId === 'string'
        ? payload.defaultProfileId
        : profiles.find((profile) => profile.isDefaultForNewSessions)?.id;
      const defaultProfileId = profiles.some((profile) => profile.id === requestedDefaultId)
        ? requestedDefaultId
        : undefined;
      return {
        profiles: profiles.map((profile) => ({
          ...profile,
          isDefaultForNewSessions: profile.id === defaultProfileId,
        })),
        defaultProfileId,
      };
    }

    /**
     * Resolve a profile config document against the bundled base, yielding the
     * effective configuration (same shape the settings snapshot has) that the
     * editor renders for a custom profile. Accepts both the legacy document
     * (overrides under `presets[<preset>]`) and the compact one (`roles`).
     */
    function mergeProfileConfig(base, doc) {
      const config = profileConfig(doc);
      const presetName = typeof config.preset === 'string'
        ? config.preset
        : typeof base?.preset === 'string'
          ? base.preset
          : 'my-dsh-slim-default';
      const basePreset = base?.presets?.[presetName] ?? {};
      // Backend precedence: a compact roles[role] entry replaces the whole
      // presets[preset][role] entry; the chosen entry then merges over the base
      // role. Mirroring that here keeps the editor's view equal to what runs.
      const inherited = config.presets?.[presetName] ?? {};
      const compact = config.roles ?? {};
      const mergedRoles = {};
      for (const roleId of ROLE_IDS) {
        mergedRoles[roleId] = { ...(basePreset[roleId] ?? {}), ...(compact[roleId] ?? inherited[roleId] ?? {}) };
      }
      const orchestrator = { ...(basePreset.orchestrator ?? {}), ...(compact.orchestrator ?? inherited.orchestrator ?? config.orchestrator ?? {}) };
      return {
        preset: presetName,
        mcpServers: { ...(base?.mcpServers ?? {}), ...(config.mcpServers ?? {}) },
        presets: {
          ...(base?.presets ?? {}),
          [presetName]: { ...basePreset, orchestrator, ...mergedRoles },
        },
        advanced: {
          ...(base?.advanced ?? {}),
          roles: {
            ...(base?.advanced?.roles ?? {}),
            ...Object.fromEntries(ROLE_IDS.map((roleId) => [roleId, {
              ...(base?.advanced?.roles?.[roleId] ?? {}),
              ...(config.advanced?.roles?.[roleId] ?? {}),
            }])),
          },
        },
      };
    }

    /** The draft profile object opened by the "new configuration" item. */
    function createNewProfileDraft(sourceEffective) {
      return {
        id: NEW_PROFILE_SENTINEL,
        displayName: '',
        kind: 'draft',
        isDefaultForNewSessions: false,
        revision: undefined,
        sourceConfig: cloneJson(sourceEffective ?? {}),
      };
    }

    /** Display-name validation shared with the host's own rules (≤64, unique). */
    function validateProfileName(raw, profiles = [], currentId) {
      const displayName = String(raw ?? '').trim();
      if (displayName.length === 0) return { valid: false, reason: 'required', value: displayName };
      if (displayName.length > 64) return { valid: false, reason: 'too-long', value: displayName };
      const duplicate = (profiles ?? []).some((profile) => profile.id !== currentId
        && String(profile.displayName ?? '').trim().toLocaleLowerCase() === displayName.toLocaleLowerCase());
      if (duplicate) return { valid: false, reason: 'conflict', value: displayName };
      return { valid: true, value: displayName };
    }

    /**
     * Whether a profile can be deleted. Only a PERSISTED custom profile
     * qualifies: the bundled preset is declared by this package's patch row
     * (there is no dict record to remove) and the in-place new-profile draft
     * has not been stored yet. The revision is the fence the delete RPC
     * requires, so a profile without one cannot be removed safely.
     */
    function canDeleteProfile(profile) {
      return Boolean(profile)
        && profile.kind === 'custom'
        && typeof profile.revision === 'string'
        && profile.revision !== '';
    }

    /**
     * Whether the "set as default for new sessions" action exists for a
     * profile: any non-default profile — bundled included, so the default can
     * always be switched back — but never the in-place new-profile draft.
     */
    function canSetDefault(profile) {
      return Boolean(profile)
        && profile.kind !== 'draft'
        && profile.isDefaultForNewSessions !== true;
    }

    /** Whether `id` names a profile the dropdown can select, or the draft. */
    function selectionInRoster(id, roster) {
      return id === NEW_PROFILE_SENTINEL
        || (Array.isArray(roster?.profiles) && roster.profiles.some((profile) => profile.id === id));
    }

    /**
     * The dropdown selection once the roster is known: the new-session
     * default, unless the user already picked a profile manually (anything
     * other than the still-untouched bundled initial value). Only ids present
     * in the roster are selectable: the host default may be a native preset
     * this card does not own, and a custom profile may disappear on reload.
     */
    function resolveInitialSelection(current, roster) {
      const known = new Set((roster?.profiles ?? []).map((profile) => profile.id));
      if (current === NEW_PROFILE_SENTINEL) return current;
      const wanted = roster?.defaultProfileId;
      if (current !== undefined && known.has(current)) {
        return current === BUNDLED_PROFILE_ID
          && wanted !== undefined
          && wanted !== BUNDLED_PROFILE_ID
          && known.has(wanted)
          ? wanted
          : current;
      }
      return wanted !== undefined && known.has(wanted) ? wanted : BUNDLED_PROFILE_ID;
    }

    /**
     * Which write path the Save action takes. The resolved profile must be the
     * selected id: a fallback profile rendered after a roster reload must never
     * be saved under another id (the 0.8.0 default-profile bug: selectedId was
     * the host's foreign "standard" id while selectedProfile fell back to the
     * bundled profile, so the bundled save never ran).
     * @returns 'bundled' | 'create' | 'custom' | 'invalid'
     */
    function profileSaveMode(selectedId, selectedProfile) {
      if (selectedId === NEW_PROFILE_SENTINEL) return 'create';
      if (!selectedProfile || selectedProfile.id !== selectedId) return 'invalid';
      if (selectedProfile.kind === 'bundled') return 'bundled';
      return typeof selectedProfile.revision === 'string' && selectedProfile.revision.length > 0
        ? 'custom'
        : 'invalid';
    }

    /**
     * Serialize one draft into the profile configuration document the host
     * persists as profile.json. Only fields differing from the referenced
     * baseline are written (unset = inherit the bundled defaults), so resetting
     * a profile to defaults saves an empty document.
     */
    function draftToConfig(draft, original, baseline) {
      const config = profileConfig(original);
      const preset = typeof draft?.preset === 'string' ? draft.preset : (config.preset ?? 'my-dsh-slim-default');
      const effective = baseline ?? config;
      // Compare against the editor's own view of the baseline: a draft built
      // from buildDraft(effective) yields exact equality for untouched fields,
      // so only genuine overrides are persisted (unset = inherit defaults).
      const baselineDraft = buildDraft(effective, effective?.advanced, baseline ?? config);
      const out = { preset, mcpServers: {}, presets: {}, advanced: { roles: {} } };
      // Root-only fields the editor does not own are carried through untouched.
      if (config.presetId !== undefined) out.presetId = config.presetId;
      if (config.verbose !== undefined) out.verbose = config.verbose;
      const put = (container, roleId, record) => {
        if (container === 'roles') out.roles = { ...(out.roles ?? {}), [roleId]: record };
        else out.presets[preset] = { ...(out.presets[preset] ?? {}), [roleId]: record };
      };
      for (const roleId of ROLE_IDS) {
        const role = draft?.roles?.[roleId] ?? {};
        const baseRole = baselineDraft.roles[roleId] ?? {};
        const record = {};
        for (const field of PRESET_FIELDS) {
          if (field === 'enabled' && DERIVED_ENABLED_ROLES.has(roleId)) continue;
          const value = role[field];
          if (value === undefined || deepEqualJson(value, baseRole[field])) continue;
          record[field] = value;
        }
        if (roleId !== COUNCIL_ROLE_ID && Array.isArray(role.tools) && !deepEqualJson(role.tools, baseRole.tools)) record.tools = role.tools;
        if (!NO_MCP_ROLES.has(roleId) && !deepEqualJson(role.mcps ?? [], baseRole.mcps ?? [])) record.mcps = role.mcps ?? [];
        let sharedInAdvanced;
        if (!NO_MCP_ROLES.has(roleId) && Array.isArray(role.sharedMcpTools)) {
          // A stored [] is kept as [] only while the document already had one;
          // an emptied draft of an absent field writes nothing.
          const keptEmpty = role.sharedMcpTools.length === 0 && storedSharedMcpTools(config, preset, roleId) !== undefined;
          if (keptEmpty || (role.sharedMcpTools.length > 0 && !deepEqualJson(role.sharedMcpTools, baseRole.sharedMcpTools))) {
            // advanced.roles outranks roles/presets, so a grant already stored
            // there is rewritten there; elsewhere it would be shadowed.
            if (asList(config.advanced?.roles?.[roleId]?.sharedMcpTools) !== undefined) sharedInAdvanced = role.sharedMcpTools;
            else record.sharedMcpTools = role.sharedMcpTools;
          }
        }
        if (roleId !== COUNCIL_ROLE_ID && Array.isArray(role.deny)) {
          const extras = role.deny.filter((name) => !(baseRole.deny ?? []).includes(name));
          if (extras.length > 0) record.deny = extras;
        }
        // A role already stored under compact `roles` stays there: moving it to
        // presets would let the old entry keep winning.
        if (Object.keys(record).length > 0) put(config.roles?.[roleId] !== undefined ? 'roles' : 'presets', roleId, record);
        const advanced = {};
        if (sharedInAdvanced !== undefined) advanced.sharedMcpTools = sharedInAdvanced;
        for (const field of ADVANCED_FIELDS) {
          const value = role[field];
          if (value === undefined || value === '' || deepEqualJson(value, baseRole[field])) continue;
          advanced[field] = parseAdvancedNumber(value, field);
        }
        for (const field of ADVANCED_TEXT_FIELDS) {
          const value = role[field];
          if (value === undefined || value === '' || deepEqualJson(value, baseRole[field])) continue;
          advanced[field] = value;
        }
        if (Object.keys(advanced).length > 0) out.advanced.roles[roleId] = advanced;
      }
      const orchEffort = draft?.orchestrator?.effort;
      if (orchEffort !== undefined && orchEffort !== baselineDraft.orchestrator?.effort) {
        const path = activeOrchestratorPath(config, preset) ?? ['presets', preset, 'orchestrator'];
        if (path[0] === 'roles') out.roles = { ...(out.roles ?? {}), orchestrator: { effort: orchEffort } };
        else if (path[0] === 'orchestrator') out.orchestrator = { effort: orchEffort };
        else out.presets[preset] = { ...(out.presets[preset] ?? {}), orchestrator: { effort: orchEffort } };
      }
      // MCP servers. This document REPLACES the stored one, so a definition the
      // draft still holds must never fall out of it: an untouched form maps back
      // to the stored object verbatim (the form is lossy for keys it does not
      // edit, and envFiles/env must not be re-typed), an edited valid form is
      // written, and an invalid form keeps the stored definition. Only a server
      // the user removed from the draft is left out.
      const baseServers = baseline?.mcpServers ?? {};
      for (const [name, form] of Object.entries(draft?.servers ?? {})) {
        const stored = config.mcpServers?.[name] ?? baseServers[name];
        const { server, errors } = formToServer(form);
        const resolved = stored !== undefined && deepEqualJson(form, serverToForm(stored))
          ? stored
          : errors.length === 0 ? server : stored;
        if (resolved !== undefined && !deepEqualJson(resolved, baseServers[name])) out.mcpServers[name] = cloneJson(resolved);
      }
      return out;
    }

    function createProfileRequest(displayName, draft, original, baseline) {
      return { displayName: String(displayName).trim(), config: draftToConfig(draft, original, baseline) };
    }

    function unwrapProfileRpc(response) {
      if (response?.ok === true) return response.value;
      if (response?.result?.ok === true) return response.result.value;
      if (response && response.profiles) return response;
      return undefined;
    }

    /** Thin adapter over the loopback RPC; undefined when the host has none. */
    function createProfileAdapter(connection) {
      const rpc = connection?.rpc;
      if (!rpc || typeof rpc.call !== 'function') return undefined;
      const call = (method, payload) => rpc.call(PROFILE_RPC_PATH, method, payload).then((response) => {
        const value = unwrapProfileRpc(response);
        if (value === undefined) {
          const error = new Error(response?.error?.message ?? `profile API ${method} failed`);
          error.code = response?.error?.code;
          throw error;
        }
        return value;
      });
      return {
        list: () => call(PROFILE_RPC_METHODS.list, {}),
        create: (payload) => call(PROFILE_RPC_METHODS.create, payload),
        save: (payload) => call(PROFILE_RPC_METHODS.save, payload),
        setDefault: (profileId) => call(PROFILE_RPC_METHODS.setDefault, { profileId }),
        migrate: (profileId) => call(PROFILE_RPC_METHODS.migrate, { profileId }),
        delete: (payload) => call(PROFILE_RPC_METHODS.delete, payload),
      };
    }

    function profileErrorKey(error) {
      const code = String(error?.code ?? error?.status ?? '').toLowerCase();
      const message = String(error?.message ?? '').toLowerCase();
      if (code.includes('conflict') || code === '409' || message.includes('conflict') || message.includes('already exists')) return 'conflict';
      return 'save';
    }

    /**
     * Classify a profile-delete failure into the copy the dialog shows. The RPC
     * returns distinct codes for each refusal; folding them into one generic
     * "failed" would hide the only actionable one (IS_DEFAULT tells the user to
     * pick another default first).
     * @returns {'conflict'|'not-found'|'is-default'|'failed'}
     */
    function deleteErrorKey(error) {
      const code = String(error?.code ?? error?.status ?? '').toUpperCase();
      if (code === 'PROFILE_IS_DEFAULT') return 'is-default';
      if (code === 'PROFILE_NOT_FOUND') return 'not-found';
      if (code === 'PROFILE_CONFLICT') return 'conflict';
      const message = String(error?.message ?? '').toLowerCase();
      if (message.includes('conflict') || message.includes('changed since')) return 'conflict';
      if (message.includes('does not exist')) return 'not-found';
      if (message.includes('default for new sessions')) return 'is-default';
      return 'failed';
    }

    /**
     * One settings-namespace write. DSH 0.2.x resolves false when the host
     * refuses a write (revision conflict or validation); 0.1.5 resolved
     * undefined on success, so only an explicit false is a rejection. A thrown
     * transport error is also a failure. Exported for unit tests.
     * @returns {Promise<{ok: true} | {ok: false, reason: 'conflict'|'error', error?: unknown}>}
     */
    async function writeSettings(scope, writeOps, revision) {
      try {
        const result = await scope.mutate(writeOps, revision);
        return result === false ? { ok: false, reason: 'conflict' } : { ok: true };
      } catch (error) {
        return { ok: false, reason: 'error', error };
      }
    }

    // ------------------------------------------------------------ components
    const color = {
      text: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      border: 'var(--dsw-alias-border-l3)',
      menuBg: 'var(--dsw-specific-menu)',
      warn: 'var(--dsw-alias-state-warn-label)',
      warnBg: 'var(--dsw-alias-bg-module-platform)',
    };

    function Switch({ checked, disabled, onChange, label }) {
      const track = {
        // The host sets `corner-shape: superellipse(1.5)` on every element, which
        // turns these radii into squircles; its own switch opts out with `round`.
        width: 34, height: 20, borderRadius: 10, cornerShape: 'round', cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${color.border}`, background: checked ? 'var(--dsw-alias-label-primary)' : color.hover,
        opacity: disabled ? 0.4 : 1, position: 'relative', flex: 'none', transition: 'background .12s',
      };
      const knob = {
        position: 'absolute', top: 3, left: checked ? 17 : 3, width: 14, height: 14, borderRadius: 7, cornerShape: 'round',
        background: checked ? 'var(--dsw-specific-menu)' : color.tertiary, transition: 'left .12s',
      };
      return React.createElement('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
        disabled, onClick: disabled ? undefined : onChange, style: { ...track, border: 'none', padding: 0 },
      }, React.createElement('span', { style: knob }));
    }

    function Field({ label, children, hint, grow = true }) {
      // `grow` is the horizontal layout's default (controls share one row).
      // In a COLUMN container the same `1 1 160px` becomes a 160px-tall floor,
      // which is what left a band of empty space under the seat-prompt box.
      return React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: grow ? '1 1 160px' : '0 0 auto' } },
        React.createElement('span', { style: { fontSize: 12, lineHeight: '18px', color: color.secondary } }, label),
        children,
        hint ? React.createElement('span', { style: { fontSize: 11, lineHeight: '16px', color: color.tertiary } }, hint) : null,
      );
    }

    function ModelSelect({ groups, status, provider, model, onChange, disabled, t }) {
      // A route is BOTH halves or neither (issue #11). A provider without a
      // model cannot describe a reachable target, and filling the missing half
      // from the session would pair one provider id with another provider's
      // model id; such a value renders — and saves — as "inherit".
      const routed = typeof provider === 'string' && provider !== ''
        && typeof model === 'string' && model !== '';
      const known = routed && groups.some((g) => g.id === provider && g.models.some((m) => m.id === model));
      // Select values are the synthetic "<provider>/<modelId>" — the current
      // value must use the SAME form or the browser falls back to the first
      // option (found in GUI acceptance: oracle showed Flash instead of Pro).
      const synthetic = routed ? `${provider}/${model}` : '';
      const options = [
        // Inherit is a first-class choice, not an empty state: it is what each
        // role runs on until the user pins a model, and the only way BACK after
        // pinning one. It stays available while the catalog loads, because
        // following the session model needs no catalog at all.
        React.createElement('option', { key: 'inherit', value: '' }, t('modelInherit')),
      ];
      if (routed && !known) {
        options.push(React.createElement('option', { key: 'current', value: synthetic }, `${t('currentValueTag')}: ${synthetic}`));
      }
      for (const group of groups) {
        options.push(React.createElement('optgroup', { key: group.id, label: group.name },
          group.models.map((m) => React.createElement('option', { key: m.id, value: `${group.id}/${m.id}` }, m.name || m.id))));
      }
      // Catalog state is a NOTICE, not the selected value. The old placeholder
      // doubled as both, so an inheriting role (or any role on a host that
      // exposes no catalog) looked like an installation with no providers.
      const notice = status === 'loading' ? t('modelsLoading')
        : status === 'error' ? t('modelsError')
          : groups.length === 0 ? t('modelsEmpty') : undefined;
      if (notice !== undefined) {
        options.push(React.createElement('option', { key: 'catalog', value: '__catalog__', disabled: true }, notice));
      }
      return React.createElement('select', {
        value: synthetic, disabled, 'aria-label': t('model'),
        onChange: (e) => {
          const next = e.target.value;
          // Clearing BOTH halves is what "inherit" persists as: the bundled
          // profile writes two `unset` ops, a custom profile omits both fields,
          // and the host then resolves the session's own model.
          if (next === '') { onChange(undefined, undefined); return; }
          if (!known && next === synthetic) return;
          const slash = next.indexOf('/');
          if (slash < 0) return;
          onChange(next.slice(0, slash), next.slice(slash + 1));
        }, className: 'omds-select',
      }, options);
    }

    /** The roster dropdown: existing profiles (default marker on the selected
     * one) then the always-present "new configuration" sentinel. */
    function ProfileSelect({ profiles, selectedId, onChange, disabled, t }) {
      return React.createElement('select', {
        value: selectedId,
        disabled,
        'aria-label': t('profile'),
        onChange: (event) => onChange(event.target.value),
        className: 'omds-select', style: { width: 'min(100%, 320px)', flex: '1 1 220px', fontWeight: 600 },
      },
        profiles.map((profile) => React.createElement('option', { key: profile.id, value: profile.id },
          `${profile.displayName}${profile.isDefaultForNewSessions ? ` · ${t('newSessionDefault')}` : ''}`)),
        React.createElement('option', { key: '__sep__', value: '__sep__', disabled: true }, '────────────'),
        React.createElement('option', { key: NEW_PROFILE_SENTINEL, value: NEW_PROFILE_SENTINEL }, `+ ${t('newProfile')} (${t('newProfileHint')})`),
      );
    }

    function RoleRow({ roleId, draft, groups, modelsStatus, advOpen, onAdvancedToggle, onChange, t, showSwitch = true, statusText, baseDeny = [], baseTools, serverNames = [] }) {
      const role = draft.roles[roleId];
      const locked = roleId === 'observer';
      const effortOptions = effortOptionsFor(groups, role.provider, role.model);
      // A switched-off role is never dispatched, so a stale effort its model
      // cannot take is not an error: observer ships disabled, and letting it
      // fail this check would lock the whole card on any model without "high".
      const effortBad = effortGatesSave(role, groups);
      const hintKey = effortHintKey(role);
      const routed = roleRouted(role);
      const descKey = COUNCIL_DESC_KEYS[roleId] ?? `role${roleId[0].toUpperCase()}${roleId.slice(1)}`;
      const invalid = {
        maxTokens: role.maxTokens !== undefined && role.maxTokens !== '' && parseAdvancedNumber(role.maxTokens, 'maxTokens') === null,
        temperature: role.temperature !== undefined && role.temperature !== '' && parseAdvancedNumber(role.temperature, 'temperature') === null,
        personaAppend: personaAppendInvalid(role.personaAppend),
      };
      // Two-line layout (GUI acceptance): line 1 = switch + name + description;
      // line 2 = model select (grows, full model names visible) + effort +
      // advanced toggle — controls align across roles regardless of name length.
      return React.createElement('div', { style: { border: `1px solid ${color.border}`, borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
          showSwitch
            ? React.createElement(Switch, {
              checked: role.enabled !== false, disabled: locked,
              onChange: () => onChange(roleId, { enabled: !(role.enabled !== false) }), label: `${roleId} ${t('enabled')}`,
            })
            : React.createElement('span', {
              style: { fontSize: 11, lineHeight: '16px', padding: '2px 8px', borderRadius: 999, border: `1px solid ${color.border}`, color: color.secondary, flex: 'none' },
            }, statusText),
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: color.text, flex: 'none' } }, roleId),
          React.createElement('span', {
            style: { fontSize: 11, color: color.tertiary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, t(descKey)),
        ),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' } },
          React.createElement('div', { style: { flex: '1 1 200px', minWidth: 0 } },
            React.createElement(ModelSelect, {
              groups, status: modelsStatus, provider: role.provider, model: role.model, disabled: locked,
              onChange: (provider, model) => onChange(roleId, roleModelPatch(provider, model)), t,
            }),
          ),
          React.createElement('select', {
            // The select must never display a level the configuration does not
            // hold. With `value` absent from the options the browser falls back
            // to the FIRST option, which is exactly how the card showed "none"
            // while the stored value was still "max": the error line and the
            // control disagreed, and re-picking "none" did not fire a change.
            // A mismatched value now renders the placeholder instead, and the
            // error line names the level the configuration still holds. The
            // placeholder exists only for that mismatch: with no mismatch an
            // unset role selects the follow-session option, so the placeholder
            // is neither shown nor selectable.
            value: effortSelectValue(role, effortBad), disabled: locked, 'aria-label': t('effort'),
            onChange: (e) => onChange(roleId, { effort: e.target.value === '' ? undefined : e.target.value }),
            className: 'omds-select', style: { width: 150, flex: 'none' },
          },
            effortBad ? React.createElement('option', { value: '', disabled: true }, t('effortPlaceholder')) : null,
            effortOptions.map((option) => React.createElement('option', { key: option.value, value: option.value }, effortLabel(option, t))),
          ),
          React.createElement('button', {
            // The label is text, not just a glyph: an icon-only control
            // disappeared outright whenever the host renamed the icon set
            // (0.2.1 → `OutlineMedium`), which made the advanced fields — the
            // only place to set maxTokens or temperature — unreachable.
            type: 'button', 'aria-label': t('advanced'), 'aria-expanded': advOpen, 'aria-controls': `omds-adv-${roleId}`, title: t('advancedSummary'),
            onClick: onAdvancedToggle,
            style: {
              background: 'none', border: 'none', cursor: 'pointer', color: color.tertiary,
              padding: '2px 4px', flex: 'none', display: 'flex', alignItems: 'center', gap: 2,
              fontSize: 11, lineHeight: '16px', fontFamily: 'inherit',
            },
          },
            t('advanced'),
            renderIcon(ui, ICON_CHEVRON, { size: 14, style: { transform: advOpen ? 'rotate(180deg)' : 'none', transition: 'transform .12s' } }),
          ),
        ),
        hintKey ? React.createElement('div', { style: { fontSize: 11, lineHeight: '16px', color: color.tertiary } }, t(hintKey)) : null,
        // Primary MCP assignment: a role that can mount servers (and a stale
        // blocked assignment that stops Save) is visible without Advanced.
        mcpIsPrimary(roleId, role, serverNames)
          ? React.createElement(McpField, { roleId, role, serverNames, onChange, locked, t })
          : null,
        effortBad ? React.createElement('div', { style: { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary)' } },
          t('effortMismatch').replace('{effort}', String(role.effort))) : null,
        locked ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, color: color.warn, fontSize: 12 } },
          renderIcon(ui, ICON_WARNING, { size: 14 }), t('observerLocked'), React.createElement('span', { style: { color: color.tertiary } }, t('observerRestriction'))) : null,
        advOpen ? React.createElement('div', { id: `omds-adv-${roleId}`, role: 'group', 'aria-label': `${roleId} ${t('advanced')}`, style: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${color.border}`, paddingTop: 8 } },
          React.createElement('div', { className: 'omds-row omds-row-wrap' },
            React.createElement(Field, { label: t('maxTokens') },
              React.createElement(ui.Input, {
                value: role.maxTokens ?? '', placeholder: ' ', inputMode: 'numeric', disabled: locked || !routed,
                onChange: (e) => onChange(roleId, { maxTokens: e.target.value }),
              })),
            React.createElement(Field, { label: t('temperature') },
              React.createElement(ui.Input, {
                value: role.temperature ?? '', placeholder: ' ', inputMode: 'decimal', disabled: locked,
                onChange: (e) => onChange(roleId, { temperature: e.target.value }),
              })),
          ),
          !routed
            ? React.createElement('span', { style: { fontSize: 11, lineHeight: '16px', color: color.tertiary } }, t('maxTokensFollowHint'))
            : (role.maxTokens === undefined || role.maxTokens === '')
              ? React.createElement('span', { style: { fontSize: 11, lineHeight: '16px', color: color.tertiary } }, t('maxTokensEmptyHint'))
              : null,
          COUNCIL_ROLE_IDS.includes(roleId) ? React.createElement(Field, {
            label: t(roleId === COUNCIL_ROLE_ID ? 'councilPrompt' : 'personaAppend'),
            grow: false,
          },
            React.createElement('textarea', {
              value: role.personaAppend ?? '', rows: 3,
              placeholder: t(roleId === COUNCIL_ROLE_ID ? 'councilPromptHint' : 'personaAppendHint'), disabled: locked,
              onChange: (e) => onChange(roleId, { personaAppend: e.target.value === '' ? undefined : e.target.value }),
              // Styled by `.omds-textarea` (border-box, multi-line height).
              className: 'omds-textarea',
            })) : null,
          (invalid.maxTokens || invalid.temperature || invalid.personaAppend) ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
            invalid.personaAppend ? t('personaAppendInvalid') : invalid.maxTokens ? t('invalidMaxTokens') : t('invalidTemperature')) : null,
          React.createElement(PolicySection, { roleId, role, baseDeny, baseTools, serverNames, onChange, locked, t }),
          roleId === COUNCIL_ROLE_ID ? React.createElement('span', { style: smallText }, t('councilRestriction')) : null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, color: color.warn, fontSize: 12, background: color.warnBg, borderRadius: 8, padding: '6px 8px' } },
            renderIcon(ui, ICON_WARNING, { size: 14 }), t('advancedWarn')),
        ) : null,
      );
    }

    // ------------------------------------------------- policy & config panels
    const errorColor = 'var(--dsw-alias-state-error-primary)';
    const smallText = { fontSize: 11, lineHeight: '16px', color: color.tertiary };

    function Panel({ title, children, hint, ...rest }) {
      return React.createElement('div', { ...rest, style: { border: `1px solid ${color.border}`, borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
        React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: color.text } }, title),
        hint ? React.createElement('span', { style: smallText }, hint) : null,
        children);
    }

    /** Toggle chips for a name list. `locked` entries are shown on and cannot be turned off. */
    function ChipPicker({ label, options, selected, locked = [], disabled, onChange, lockedTag, removeOnly = false }) {
      const names = [...new Set([...options, ...selected, ...locked])];
      return React.createElement('div', { role: 'group', 'aria-label': label, style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        names.map((name) => {
          const isLocked = locked.includes(name);
          const on = isLocked || selected.includes(name);
          return React.createElement('button', {
            key: name, type: 'button', 'aria-pressed': on, 'data-chip': name,
            disabled: disabled || isLocked || (removeOnly && !on),
            title: isLocked ? lockedTag : undefined,
            onClick: () => onChange(on ? selected.filter((item) => item !== name) : [...selected, name]),
            style: {
              fontSize: 11, lineHeight: '16px', padding: '2px 8px', borderRadius: 999, cursor: disabled || isLocked ? 'default' : 'pointer',
              // Disabled chips stay readable in both themes (0.6 measured 2.5:1
              // light / 4.0:1 dark); a locked entry is told apart by its dashed
              // border and the "shipped" tooltip instead of by fading.
              border: `1px ${isLocked ? 'dashed' : 'solid'} ${color.border}`, fontFamily: 'inherit',
              // On-chip text sits on the solid label colour, so it needs an OPAQUE
              // token: --dsw-specific-menu is translucent (2.26:1 in dark).
              background: on ? color.text : 'transparent', color: on ? 'var(--dsw-alias-bg-layer-1)' : color.secondary,
              opacity: isLocked ? 0.9 : disabled ? 0.75 : 1,
            },
          }, name);
        }));
    }

    /** Free-text entry for an exact MCP tool name (mcp__<server>__<tool>). */
    function McpToolNameAdder({ label, existing, onAdd, disabled, t, addLabel }) {
      const [name, setName] = React.useState('');
      const valid = isMcpToolNameUi(name) && !existing.includes(name);
      return React.createElement('div', { className: 'omds-row' },
        React.createElement('div', { className: 'omds-grow' }, React.createElement(ui.Input, {
          value: name, placeholder: 'mcp__server__tool', 'aria-label': label, disabled,
          onChange: (e) => setName(e.target.value),
        })),
        React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: disabled || !valid, onClick: () => { onAdd(name); setName(''); } }, addLabel ?? t('mcpToolAdd')),
        name !== '' && !valid && !existing.includes(name) ? React.createElement('span', { style: { fontSize: 11, color: errorColor, flex: 'none' } }, t('mcpToolNameInvalid')) : null);
    }

    /**
     * MCP server assignment for one role. It is a primary field of the role row
     * whenever the role can use a server (or still holds a stale one that blocks
     * Save); otherwise it stays inside Advanced next to its explanation.
     */
    function McpField({ roleId, role, serverNames, onChange, locked, t }) {
      const reason = mcpBlockReason(roleId);
      const noMcp = reason !== undefined;
      return React.createElement(React.Fragment, null,
        React.createElement(Field, {
          label: t('mcps'), grow: false,
          hint: reason === 'council' ? t('mcpsCouncilLocked') : serverNames.length === 0 ? t('mcpsNone') : undefined,
        },
          // A blocked role can only REMOVE stale entries: picking is disabled,
          // already-selected chips stay clickable so the user can clear them.
          React.createElement(ChipPicker, {
            label: t('mcps'), options: noMcp ? [] : serverNames, selected: role.mcps ?? [], disabled: locked,
            removeOnly: noMcp, onChange: (next) => onChange(roleId, { mcps: next }),
          })),
        mcpViolation(roleId, role) ? React.createElement('span', { role: 'alert', 'data-mcp-violation': roleId, style: { fontSize: 12, color: errorColor } }, t('mcpsViolation')) : null);
    }
    /** Whether the MCP field belongs to the role's primary line instead of Advanced. */
    const mcpIsPrimary = (roleId, role, serverNames) => (mcpBlockReason(roleId) === undefined && serverNames.length > 0) || mcpViolation(roleId, role);

    /**
     * Shared existing tools for one role: exact names the role may call although
     * its own `mcps` does not include their server. This does not connect or
     * start anything and there is no inventory to check names against, so the
     * list is manual and says nothing about availability. Granting never edits
     * the allowed-tools list; a grant the list or deny would block is flagged.
     */
    function SharedMcpField({ roleId, role, onChange, locked, t }) {
      const grants = role.sharedMcpTools ?? [];
      const invalid = sharedMcpInvalid(role);
      const warnings = sharedMcpWarnings(roleId, role);
      return React.createElement('div', { 'data-shared-mcp': roleId, style: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px dashed ${color.border}`, paddingTop: 8 } },
        // Not a <Field>: its <label> wrapper would hand the group's name to the
        // first chip button. A heading plus a labelled group keeps names exact.
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
          React.createElement('span', { style: { fontSize: 12, lineHeight: '18px', color: color.secondary } }, t('sharedMcp')),
          React.createElement('span', { style: smallText }, t('sharedMcpNote')),
          grants.length === 0
            ? React.createElement('span', { 'data-shared-empty': '', style: smallText }, t('sharedMcpNone'))
            : React.createElement(ChipPicker, {
              label: t('sharedMcp'), options: [], selected: grants, disabled: locked,
              // Chips are existing grants only: a click removes that exact name.
              onChange: (next) => onChange(roleId, { sharedMcpTools: next }),
            }),
          grants.length > 0 ? React.createElement('span', { style: smallText }, t('sharedMcpRemoveHint')) : null,
          React.createElement(McpToolNameAdder, {
            label: t('sharedMcp') + ' ' + t('mcpToolName'), existing: grants, disabled: locked, t, addLabel: t('sharedMcpAdd'),
            onAdd: (name) => onChange(roleId, { sharedMcpTools: [...grants, name] }),
          })),
        invalid.length > 0 ? React.createElement('span', { role: 'alert', 'data-shared-invalid': roleId, style: { fontSize: 12, color: errorColor } }, t('sharedMcpInvalid').replace('{names}', invalid.join(', '))) : null,
        ...warnings.map((item) => React.createElement('span', { key: item.kind + item.detail, 'data-shared-warning': item.kind, style: { fontSize: 12, lineHeight: '16px', color: color.warn } }, t('sharedWarn_' + item.kind).replace('{name}', item.detail))));
    }

    /** Per-role tools / deny policy (+ MCP when it is not a primary field). Restrictions are explained, never faked. */
    function PolicySection({ roleId, role, baseDeny, baseTools, serverNames, onChange, locked, t }) {
      const isCouncil = roleId === COUNCIL_ROLE_ID;
      const isSeat = COUNCILLOR_ROLE_IDS.includes(roleId);
      const reason = mcpBlockReason(roleId);
      const noMcp = reason !== undefined;
      const toolOptions = isSeat ? FIXED_ALLOW : TOOL_NAMES;
      const explicit = Array.isArray(role.tools);
      // Seats always carry a shipped read-only ceiling, so there is no "inherit"
      // state to switch back to; every other role chooses explicitly.
      const canToggle = !isSeat && !isCouncil;
      const badNames = [...(role.tools ?? []), ...(role.deny ?? [])].filter((name) => !isKnownToolName(name));
      return React.createElement(Panel, { title: t('policyTitle') },
        canToggle ? React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: color.secondary } },
          React.createElement(Switch, {
            checked: explicit, disabled: locked, label: t('toolsExplicit'),
            // On: start from an EMPTY exhaustive list (nothing allowed) so the
            // user adds exactly what the role may use. Off: back to defaults.
            onChange: () => onChange(roleId, { tools: explicit ? baseTools : [] }),
          }),
          t('toolsExplicit')) : null,
        React.createElement(Field, { label: t('tools'), grow: false, hint: isCouncil ? t('toolsSynthLocked') : isSeat ? t('toolsSeatCeiling') : explicit ? (role.tools.length === 0 ? t('toolsEmptyExplicit') : t('toolsExplicitHint')) : t('toolsInheritHint') },
          React.createElement(ChipPicker, {
            label: t('tools'), options: toolOptions, selected: role.tools ?? [], disabled: locked || isCouncil || (canToggle && !explicit),
            // Keep [] as [] — it is an exhaustive empty allow, not "unset".
            onChange: (next) => onChange(roleId, { tools: next }),
          }),
          // Seats and the synthesizer cannot mount MCP, so exact names only apply elsewhere.
          !noMcp ? React.createElement(McpToolNameAdder, {
            label: t('tools') + ' ' + t('mcpToolName'), existing: role.tools ?? [], disabled: locked || (canToggle && !explicit), t,
            onAdd: (name) => onChange(roleId, { tools: [...(role.tools ?? []), name] }),
          }) : null),
        React.createElement(Field, { label: t('deny'), grow: false, hint: isCouncil ? t('toolsSynthLocked') : t('denyHint') },
          React.createElement(ChipPicker, {
            label: t('deny'), options: TOOL_NAMES, selected: role.deny ?? [], locked: baseDeny, lockedTag: t('denyLocked'),
            disabled: locked || isCouncil, onChange: (next) => onChange(roleId, { deny: next }),
          }),
          !noMcp ? React.createElement(McpToolNameAdder, {
            label: t('deny') + ' ' + t('mcpToolName'), existing: role.deny ?? [], disabled: locked, t,
            onAdd: (name) => onChange(roleId, { deny: [...(role.deny ?? []), name] }),
          }) : null),
        mcpIsPrimary(roleId, role, serverNames) ? null : React.createElement(McpField, { roleId, role, serverNames, onChange, locked, t }),
        !noMcp ? React.createElement('span', { style: smallText }, t('mcpsSemantics')) : null,
        !noMcp ? React.createElement(SharedMcpField, { roleId, role, onChange, locked, t }) : null,
        badNames.length > 0 ? React.createElement('span', { role: 'alert', 'data-tool-unknown': roleId, style: { fontSize: 12, color: errorColor } }, t('toolUnknown').replace('{names}', badNames.join(', '))) : null,
        ...mcpPolicyWarnings(roleId, role).map((item) => React.createElement('span', { key: item.kind + item.detail, 'data-mcp-warning': item.kind, style: { fontSize: 12, lineHeight: '16px', color: color.warn } }, t('mcpWarn_' + item.kind).replace('{name}', item.detail))));
    }

    function OrchestratorPanel({ draft, onChange, t }) {
      const effort = draft.orchestrator?.effort;
      const bad = effort !== undefined && !EFFORT_RE.test(effort);
      // The orchestrator is the session's main model, so no model catalog applies:
      // offer the fixed list, and keep a stored level outside it (an older config
      // or a host-specific level) as its own option rather than dropping it.
      const options = effortOptionsFor(undefined).map((option) => ({ ...option }));
      if (effort !== undefined && effort !== '' && !options.some((option) => option.value === effort)) {
        options.push({ value: effort, label: effort });
      }
      return React.createElement(Panel, { title: t('orchestratorTitle') },
        React.createElement(Field, { label: t('orchestratorEffort'), grow: false },
          React.createElement('select', {
            value: effort ?? '', 'aria-label': t('orchestratorEffort'), className: 'omds-select',
            onChange: (e) => onChange({ effort: e.target.value === '' ? undefined : e.target.value }),
          },
            effort === undefined || effort === '' ? React.createElement('option', { value: '' }, t('effortUnset')) : null,
            options.map((option) => React.createElement('option', { key: option.value, value: option.value }, effortLabel(option, t))))),
        bad ? React.createElement('span', { style: { fontSize: 12, color: errorColor } }, t('invalidEffort')) : null,
        React.createElement(Field, { label: t('orchestratorMcps'), grow: false, hint: t('orchestratorMcpsLocked') },
          React.createElement(ChipPicker, { label: t('orchestratorMcps'), options: [], selected: [], disabled: true, onChange: () => {} })));
    }

    function PairRows({ rows, field, labels, onChange, disabled, t }) {
      const set = (index, patch) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        rows.map((row, index) => React.createElement('div', { key: index, className: 'omds-row' },
          React.createElement('div', { className: 'omds-grow' }, React.createElement(ui.Input, { value: row.key, placeholder: labels[0], 'aria-label': `${field} ${labels[0]} ${index + 1}`, disabled, onChange: (e) => set(index, { key: e.target.value }) })),
          React.createElement('div', { className: 'omds-grow' }, React.createElement(ui.Input, { value: row.value, placeholder: labels[1], 'aria-label': `${field} ${labels[1]} ${index + 1}`, disabled, onChange: (e) => set(index, { value: e.target.value }) })),
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled, onClick: () => onChange(rows.filter((_, i) => i !== index)) }, '×'))),
        React.createElement('div', null,
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled, onClick: () => onChange([...rows, { key: '', value: '' }]) }, t('serverRowAdd'))));
    }

    function ServerEditor({ name, form, usedBy, onChange, onRemove, disabled, t }) {
      const { errors } = formToServer(form);
      const http = form.transport === 'streamable-http';
      const set = (patch) => onChange(name, { ...form, ...patch });
      return React.createElement('div', { 'data-server': name, style: { border: `1px solid ${color.border}`, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: color.text, flex: 1 } }, name),
          React.createElement('select', {
            value: form.transport, disabled, 'aria-label': `${name} ${t('serverTransport')}`,
            onChange: (e) => set({ transport: e.target.value }), className: 'omds-select', style: { width: 170, flex: 'none' },
          }, React.createElement('option', { value: 'stdio' }, 'stdio'), React.createElement('option', { value: 'streamable-http' }, 'streamable-http')),
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: disabled || usedBy.length > 0, onClick: () => onRemove(name) }, t('serverRemove'))),
        usedBy.length > 0 ? React.createElement('span', { style: smallText }, t('serverInUse').replace('{roles}', usedBy.join(', '))) : null,
        http
          ? React.createElement(Field, { label: t('serverUrl'), grow: false },
            React.createElement(ui.Input, { value: form.url, placeholder: 'https://', disabled, onChange: (e) => set({ url: e.target.value }) }))
          : React.createElement(React.Fragment, null,
            React.createElement(Field, { label: t('serverCommand'), grow: false },
              React.createElement(ui.Input, { value: form.command, placeholder: ' ', disabled, onChange: (e) => set({ command: e.target.value }) })),
            React.createElement(Field, { label: t('serverArgs'), grow: false },
              React.createElement('textarea', {
                value: form.argsText, rows: 2, disabled, onChange: (e) => set({ argsText: e.target.value }),
                className: 'omds-textarea',
              }))),
        React.createElement(Field, { label: t('serverEnv'), grow: false, hint: t('serverEnvWarn') },
          React.createElement(PairRows, { rows: form.env, field: 'env', labels: [t('serverKey'), t('serverValue')], disabled, t, onChange: (rows) => set({ env: rows }) })),
        React.createElement(Field, { label: t('serverEnvFiles'), grow: false, hint: http ? t('serverEnvFilesHttp') : t('serverEnvFilesHint') },
          React.createElement(PairRows, { rows: form.envFiles, field: 'envFiles', labels: [t('serverKey'), t('serverPath')], disabled: disabled || http, t, onChange: (rows) => set({ envFiles: rows }) })),
        React.createElement(Field, { label: t('serverTimeout'), grow: false, hint: t('serverTimeoutHint') },
          React.createElement(ui.Input, { value: form.toolCallTimeoutMs, placeholder: '60000', inputMode: 'numeric', disabled, onChange: (e) => set({ toolCallTimeoutMs: e.target.value }) })),
        !serverNameUsable(name) ? React.createElement('span', { role: 'alert', 'data-server-name-bad': name, style: { fontSize: 12, color: errorColor } }, t('serverNameInvalid')) : null,
        errors.length > 0 ? React.createElement('span', { style: { fontSize: 12, color: errorColor } }, t('serverInvalid').replace('{fields}', [...new Set(errors)].join(', '))) : null);
    }

    function ServersPanel({ draft, onChange, onAdd, onRemove, disabled, t }) {
      const [newName, setNewName] = React.useState('');
      const names = Object.keys(draft.servers ?? {});
      const nameOk = serverNameUsable(newName) && !names.includes(newName);
      const usedBy = (name) => ROLE_IDS.filter((roleId) => (draft.roles[roleId]?.mcps ?? []).includes(name));
      return React.createElement(Panel, { title: t('serversTitle'), hint: t('serversHint') },
        names.map((name) => React.createElement(ServerEditor, { key: name, name, form: draft.servers[name], usedBy: usedBy(name), onChange, onRemove, disabled, t })),
        React.createElement('div', { className: 'omds-row' },
          React.createElement('div', { className: 'omds-grow' }, React.createElement(ui.Input, { value: newName, placeholder: t('serverName'), 'aria-label': t('serverName'), disabled, onChange: (e) => setNewName(e.target.value) })),
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: disabled || !nameOk, onClick: () => { onAdd(newName); setNewName(''); } }, t('serverAdd'))),
        newName !== '' && !nameOk ? React.createElement('span', { style: { fontSize: 12, color: errorColor } }, t('serverNameInvalid')) : null);
    }

    function OverridesPanel({ overrides, t }) {
      return React.createElement(Panel, { title: t('overridesTitle'), hint: t('overridesHint') },
        overrides.length === 0
          ? React.createElement('span', { style: smallText }, t('overridesNone'))
          : overrides.map((item) => React.createElement('span', { key: item.roleId, 'data-override': item.roleId, style: { fontSize: 12, color: item.shadowsPreset ? color.warn : color.secondary } },
            t(item.shadowsPreset ? 'overridesShadow' : 'overridesPlain').replace('{role}', item.roleId).replace('{fields}', item.fields.join(', ') || '\u2014'))));
    }

    function IdentityPanel({ presetName, presetNames, presetId, verbose, onPreset, disabled, t }) {
      const show = (value) => (value === undefined ? t('notSet') : String(value));
      return React.createElement(Panel, { title: t('identityTitle'), hint: t('identityReadOnly'), 'data-boot-readonly': true },
        React.createElement(Field, { label: t('presetName'), grow: false, hint: t('presetNameHint') },
          React.createElement('select', {
            value: presetName, disabled, 'aria-label': t('presetName'),
            onChange: (e) => onPreset(e.target.value), className: 'omds-select',
          }, presetNames.map((name) => React.createElement('option', { key: name, value: name }, name)))),
        React.createElement('div', { className: 'omds-row omds-row-wrap' },
          React.createElement(Field, { label: t('presetId') },
            React.createElement(ui.Input, { value: show(presetId), readOnly: true, disabled: true, 'aria-label': t('presetId') })),
          React.createElement(Field, { label: t('verbose') },
            React.createElement(ui.Input, { value: show(verbose), readOnly: true, disabled: true, 'aria-label': t('verbose') }))));
    }

    // -------------------------------------------------------------- card
    /**
     * The revision fence to send with a write.
     *
     * React state lags the host: `mutate` bumps the revision, and the row
     * restart that follows can bump it again before the next render. Reading
     * the live snapshot keeps a second save possible without a manual reload.
     */
    function liveRevision(scope, fallback) {
      try {
        const current = scope?.getSnapshot?.();
        return current?.revision ?? fallback;
      } catch {
        return fallback;
      }
    }

    // Narrowest card width that keeps a role row readable (switch, model, effort).
    const CARD_MIN_WIDTH = 340;

    /**
     * ONE editing session per settings scope, shared by every surface that
     * mounts the editor (the Settings section and the Agents page). Only the
     * state that must not diverge lives here: the staged draft, the selected
     * profile, the unsaved new-profile draft and the saving flag. Display-only
     * state (open Advanced panels, modals, toasts) stays local to the surface
     * the user is working in. Because the store outlives a mount, leaving the
     * Agents page keeps an unsaved draft instead of silently dropping it.
     */
    const editorStores = new WeakMap();
    function editorStoreFor(scope) {
      let store = editorStores.get(scope);
      if (store === undefined) {
        store = { state: {}, listeners: new Set() };
        editorStores.set(scope, store);
      }
      return store;
    }
    function useSharedEditorState(scope, key, initial) {
      const store = editorStoreFor(scope);
      const [, rerender] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        store.listeners.add(rerender);
        return () => { store.listeners.delete(rerender); };
      }, [store]);
      if (!(key in store.state)) store.state[key] = typeof initial === 'function' ? initial() : initial;
      const setValue = React.useCallback((next) => {
        const previous = store.state[key];
        const value = typeof next === 'function' ? next(previous) : next;
        if (Object.is(value, previous)) return;
        store.state[key] = value;
        for (const listener of [...store.listeners]) listener();
      }, [store, key]);
      return [store.state[key], setValue];
    }

    function SettingsCard({ scope, connection, remote, t, variant = 'section' }) {
      const [snap, setSnap] = React.useState(scope.getSnapshot());
      React.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
      // draft === undefined → clean (mirror the snapshot / profile config);
      // object → staged edits. Shared across surfaces (see useSharedEditorState).
      const [draft, setDraft] = useSharedEditorState(scope, 'draft', undefined);
      const [roster, setRoster] = React.useState(() => initialProfileRoster({}));
      const [selectedId, setSelectedId] = useSharedEditorState(scope, 'selectedId', BUNDLED_PROFILE_ID);
      // The in-place draft profile opened by the "new configuration" item.
      const [newDraft, setNewDraft] = useSharedEditorState(scope, 'newDraft', undefined);
      // Pending selection while the user decides the dirty-guard prompt.
      const [pendingSwitch, setPendingSwitch] = React.useState(undefined);
      // Naming dialog: {open, input, error}.
      const [nameModal, setNameModal] = React.useState({ open: false, input: '', error: undefined });
      const [profileError, setProfileError] = React.useState(undefined);
      const profileAdapter = React.useMemo(() => createProfileAdapter(connection), [connection]);
      // advOpen per role id: the advanced sub-section visibility.
      const [expanded, setExpanded] = React.useState(() => Object.fromEntries(ROLE_IDS.map((id) => [id, false])));
      const [saving, setSaving] = useSharedEditorState(scope, 'saving', false);
      const [confirmReset, setConfirmReset] = React.useState(false);
      // Keyboard focus: the action buttons swap or disable themselves, which
      // would drop focus to <body>. `actionsRef` lets the handlers put it back.
      const actionsRef = React.useRef(null);
      const focusAction = (index) => {
        const buttons = actionsRef.current?.querySelectorAll('button:not(:disabled)');
        const target = buttons?.[index] ?? buttons?.[0];
        if (target && typeof target.focus === 'function') target.focus();
      };
      const resetConfirmWasOpen = React.useRef(false);
      React.useEffect(() => {
        // Opening the confirmation puts focus on its safe "×" (not on the
        // destructive confirm); closing it returns focus to the first action.
        if (confirmReset) focusAction(1);
        else if (resetConfirmWasOpen.current) focusAction(0);
        resetConfirmWasOpen.current = confirmReset;
      }, [confirmReset]);
      const focusInActions = React.useRef(false);
      // Delete confirmation: an independent modal because the removal is final
      // and the profile name is the only proof of what is about to disappear.
      const [deleteModal, setDeleteModal] = React.useState({ open: false, profileId: undefined, displayName: '', revision: undefined, error: undefined });
      const [toast, setToast] = React.useState(null);
      const [models, setModels] = React.useState({ status: 'loading', groups: [] });
      const loadModels = React.useCallback(() => {
        // DSH 0.1.2: the model catalog moved behind the host remote face
        // (ctx.remote.session.modelCatalog()); 0.1.1's connection.api.llm is
        // gone. Degrade to the error notice when the face is unavailable so
        // the card still renders with configured values intact.
        if (remote?.session?.modelCatalog === undefined) {
          setModels({ status: 'error', groups: [] });
          return;
        }
        Promise.resolve(remote.session.modelCatalog()).then((response) => {
          if (response?.ok !== true || response.value === undefined) {
            setModels({ status: 'error', groups: [] });
            return;
          }
          const groups = (response.value.groups ?? []).map((group) => ({
            id: group.id,
            name: group.name,
            models: group.models.map((model) => ({
              id: model.id,
              name: model.name,
              // reasoning.efforts are the per-model supported effort levels;
              // the effort dropdown and its mismatch check read them here.
              ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
            })),
          }));
          setModels({ status: 'ready', groups });
        }).catch(() => setModels({ status: 'error', groups: [] }));
      }, [remote]);
      React.useEffect(() => { loadModels(); }, [loadModels]);

      const writable = snap.writable === true;
      const effective = snap.value ?? EMPTY_EFFECTIVE;
      const base = snap.base ?? EMPTY_BASE;
      const user = snap.user ?? EMPTY_USER;
      // Profiles persist a delta against the BUNDLED defaults (not against
      // the profile's own saved snapshot): with the wrong baseline a second
      // save rewrites profile.json and silently drops fields that matched
      // the previous save (e.g. explorer=A saved first, designer=B saved
      // second would lose explorer).
      const defaultsBaseline = mergeProfileConfig(base, {});

      const refreshRoster = React.useCallback(() => {
        if (!profileAdapter) return Promise.resolve();
        return profileAdapter.list().then((payload) => {
          setRoster(normalizeProfileRoster(base, payload));
          setProfileError(undefined);
        }).catch(() => {
          setRoster(initialProfileRoster(base));
          setProfileError(t('profileListFailed'));
        });
      }, [profileAdapter, base]);
      React.useEffect(() => {
        if (!profileAdapter) return undefined;
        let alive = true;
        profileAdapter.list().then((payload) => {
          if (!alive) return;
          const next = normalizeProfileRoster(base, payload);
          setRoster(next);
          // Open the card on the NEW-SESSION DEFAULT (not hard-coded on the
          // bundled profile). Only while the user has not picked anything yet
          // (still on the bundled initial value); a later manual selection is
          // never overridden.
          setSelectedId((current) => resolveInitialSelection(current, next));
        }).catch(() => {
          if (!alive) return;
          setRoster(initialProfileRoster(base));
          setProfileError(t('profileListFailed'));
        });
        return () => { alive = false; };
      }, [profileAdapter, base]);

      // A roster reload can drop the selected custom profile (or leave a stale
      // id from a host default this card does not own). Never edit a fallback
      // profile under a stale id: reset to a valid selection and drop the old
      // edits, which belonged to the profile that disappeared.
      React.useEffect(() => {
        if (selectionInRoster(selectedId, roster)) return;
        setDraft(undefined);
        setProfileError(undefined);
        setPendingSwitch(undefined);
        setSelectedId(resolveInitialSelection(selectedId, roster));
      }, [roster, selectedId]);

      // The profile object currently edited: roster entry, or the sentinel draft.
      const selectedProfile = selectedId === NEW_PROFILE_SENTINEL
        ? newDraft
        : roster.profiles.find((profile) => profile.id === selectedId) ?? roster.profiles[0];
      // Writes are gated by an invariant: the resolved profile must be the
      // selected id. Display may fall back to the first roster entry while a
      // reconciliation is pending, but that fallback is never saved under a
      // different id.
      const saveMode = profileSaveMode(selectedId, selectedProfile);
      const isBundledProfile = selectedProfile?.kind === 'bundled';
      // The RESOLVED configuration the editor renders: settings snapshot for
      // the bundled profile, base ⊕ profile.json for custom profiles, and the
      // frozen copy-of-current for the new-profile draft.
      const editEffective = isBundledProfile
        ? effective
        : selectedId === NEW_PROFILE_SENTINEL
          ? (newDraft?.sourceConfig ?? base)
          : mergeProfileConfig(base, selectedProfile?.config ?? {});
      const makeDraft = (source) => (isBundledProfile ? buildDraft(source, source?.advanced, base, user) : buildDraft(source, source?.advanced, base));
      const current = draft ?? makeDraft(editEffective);
      const baseline = makeDraft(editEffective);
      const ops = isBundledProfile && draft !== undefined ? planUserOps(base, user, draft) : [];
      const dirty = isBundledProfile
        ? ops.length > 0
        : draft !== undefined && !deepEqualJson(semanticDraft(draft), semanticDraft(baseline));
      const invalid = ROLE_IDS.some((roleId) => {
        const role = current.roles[roleId];
        return parseAdvancedNumber(role.maxTokens, 'maxTokens') === null
          || parseAdvancedNumber(role.temperature, 'temperature') === null
          || personaAppendInvalid(role.personaAppend)
          // A stored effort the selected model cannot take (e.g. flash+max)
          // blocks saving until it is reselected — but only for a role that
          // will be dispatched. A disabled role never sends its effort, so
          // failing here (observer ships disabled) would lock the whole card
          // on any model that does not offer that level.
          || effortGatesSave(role, models.groups);
      }) || (current.orchestrator?.effort !== undefined && !EFFORT_RE.test(current.orchestrator.effort))
        || Object.entries(current.servers ?? {}).some(([name, form]) => !serverNameUsable(name) || formToServer(form).errors.length > 0)
        || ROLE_IDS.some((roleId) => mcpViolation(roleId, current.roles[roleId])
          || sharedMcpInvalid(current.roles[roleId]).length > 0
          || [...(current.roles[roleId].tools ?? []), ...(current.roles[roleId].deny ?? [])].some((name) => !isKnownToolName(name)));

      // Browser fallback only: while edits are unsaved, reloading or closing the
      // tab asks first. The host exposes no leave-guard for settings sections,
      // so switching to another Settings page is NOT intercepted by this.
      React.useEffect(() => {
        if (!dirty || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onBeforeUnload = (event) => {
          event.preventDefault();
          event.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
      }, [dirty]);

      // A focused action that becomes disabled (Cancel once clean, Save while
      // saving) makes the browser drop focus to <body>; hand it back.
      React.useEffect(() => {
        if (!focusInActions.current || typeof document === 'undefined') return;
        const active = document.activeElement;
        if (active === null || active === document.body || active.disabled === true) focusAction(0);
      }, [dirty, saving]);

      const changeRole = (roleId, patch) => {
        setDraft((previous) => {
          const next = previous ?? makeDraft(editEffective);
          return { ...next, roles: { ...next.roles, [roleId]: { ...next.roles[roleId], ...patch } } };
        });
      };
      const patchDraft = (patch) => setDraft((previous) => ({ ...(previous ?? makeDraft(editEffective)), ...patch(previous ?? makeDraft(editEffective)) }));
      const changeOrchestrator = (patch) => patchDraft((d) => ({ orchestrator: { ...d.orchestrator, ...patch } }));
      const changeServer = (name, form) => patchDraft((d) => ({ servers: { ...d.servers, [name]: form } }));
      const addServer = (name) => patchDraft((d) => ({ servers: { ...d.servers, [name]: serverToForm({ transport: 'stdio', command: '', args: [] }) } }));
      const removeServer = (name) => patchDraft((d) => {
        const servers = { ...d.servers };
        delete servers[name];
        return { servers };
      });
      // Switching preset re-reads every role from the chosen preset; pending
      // role edits belong to the previous one and are dropped.
      const changePreset = (name) => {
        const doc = { ...editEffective, preset: name };
        setDraft(buildDraft(doc, doc.advanced, base, isBundledProfile ? { ...user, preset: name } : undefined));
      };
      const toggleAdvanced = (roleId) => {
        setExpanded((previous) => ({ ...previous, [roleId]: !previous[roleId] }));
      };
      const run = async (writeOps, doneText) => {
        setSaving(true);
        setProfileError(undefined);
        try {
          // DSH 0.1.2 settings scope: set/unset are top-level fields only;
          // multi-level paths (presets.<preset>.<role>.<field>) go through
          // one atomic mutate(ops) — the documented replacement for the
          // 0.1.1 per-op scope.write (which is gone).
          //
          // The fence comes from the LIVE snapshot, not from React state: an
          // accepted mutation bumps the revision, and the settings row is
          // restarted right after it, which can bump it again. The state copy
          // is then one generation behind, and the next save is rejected as
          // "changed in another window" although the user is the only writer —
          // and stays rejected on every retry because nothing refreshes it.
          let result = await writeSettings(scope, writeOps, liveRevision(scope, snap.revision));
          if (!result.ok && result.reason === 'conflict') {
            result = await writeSettings(scope, writeOps, liveRevision(scope, snap.revision));
          }
          if (!result.ok) {
            // Resync either way so a manual retry starts from what the host
            // actually holds now instead of repeating the same stale fence.
            setSnap(scope.getSnapshot());
            setProfileError(t(result.reason === 'conflict' ? 'profileConflict' : 'profileSaveFailed'));
            return false;
          }
          setSnap(scope.getSnapshot());
          setDraft(undefined);
          setToast({ text: doneText, icon: renderIcon(ui, ICON_CHECK, { size: 14 }) });
          return true;
        } finally {
          setSaving(false);
        }
      };

      // Persist a CUSTOM profile: an atomic whole-document snapshot write with
      // a revision fence (the host refuses stale writers).
      const saveCustom = async (profile, config) => {
        if (!profileAdapter) {
          setProfileError(t('profileUnavailable'));
          return false;
        }
        setSaving(true);
        setProfileError(undefined);
        try {
          const response = await profileAdapter.save({
            id: profile.id,
            config,
            expectedRevision: profile.revision,
          });
          const saved = response?.profile ?? response;
          const revision = typeof saved?.revision === 'string' ? saved.revision : profile.revision;
          setRoster((previous) => ({
            ...previous,
            profiles: previous.profiles.map((entry) => (
              entry.id === profile.id
                // Backfill the just-persisted snapshot so the editor keeps
                // showing the saved values (the save response carries only
                // id/displayName/revision; without the config backfill the
                // card re-renders from the previous profile.json and looks
                // like a reset to defaults).
                ? { ...entry, ...saved, revision, config: profileConfig(config) }
                : entry
            )),
          }));
          setDraft(undefined);
          setToast({ text: t('saved'), icon: renderIcon(ui, ICON_CHECK, { size: 14 }) });
          return true;
        } catch (error) {
          setProfileError(profileErrorKey(error) === 'conflict' ? t('profileConflict') : t('profileSaveFailed'));
          if (profileErrorKey(error) === 'conflict') void refreshRoster();
          return false;
        } finally {
          setSaving(false);
        }
      };

      // The bundled profile saves through the settings namespace (hot, fenced
      // by the host per op). Saving a new-profile draft opens the naming
      // dialog; the create RPC itself is confirmed from the dialog.
      const save = () => {
        if (!dirty || invalid || saving) return;
        if (saveMode === 'bundled') { void run(ops, t('saved')); return; }
        if (saveMode === 'create') {
          setNameModal({ open: true, input: '', error: undefined });
          return;
        }
        if (saveMode !== 'custom' || !selectedProfile) {
          setProfileError(t('profileSaveFailed'));
          return;
        }
        void saveCustom(selectedProfile, draftToConfig(draft, selectedProfile.config, defaultsBaseline));
      };

      const confirmCreate = async () => {
        const validation = validateProfileName(nameModal.input, roster.profiles);
        if (!validation.valid) {
          setNameModal({
            open: true,
            input: nameModal.input,
            error: t(validation.reason === 'conflict' ? 'nameConflict' : validation.reason === 'too-long' ? 'nameTooLong' : 'nameRequired'),
          });
          return;
        }
        if (!profileAdapter) {
          setNameModal({ open: false, input: '', error: undefined });
          setProfileError(t('profileUnavailable'));
          return;
        }
        setSaving(true);
        setProfileError(undefined);
        try {
          // The new profile stores a SNAPSHOT of the draft against the
          // bundled defaults — the merge baseline a fresh profile resolves
          // against. Comparing against the source profile's effective values
          // instead would drop every field inherited from it (a profile
          // created from the GPT series would silently become the defaults
          // plus the one edited field): the draft's differences vs the
          // source are NOT the draft's differences vs the new profile's own
          // base.
          const defaultsEffective = mergeProfileConfig(base, {});
          const snapshot = draftToConfig(draft, newDraft?.sourceConfig, defaultsEffective);
          const response = await profileAdapter.create(createProfileRequest(validation.value, draft, newDraft?.sourceConfig, defaultsEffective));
          const saved = response?.profile ?? response;
          const profile = {
            id: saved?.id,
            displayName: saved?.displayName ?? validation.value,
            kind: 'custom',
            isDefaultForNewSessions: false,
            revision: saved?.revision,
            config: snapshot,
          };
          setRoster((previous) => normalizeProfileRoster(base, {
            defaultProfileId: previous.defaultProfileId,
            profiles: [...previous.profiles.filter((entry) => entry.id !== profile.id), profile],
          }));
          setNewDraft(undefined);
          setSelectedId(profile.id);
          setDraft(undefined);
          setNameModal({ open: false, input: '', error: undefined });
          setToast({ text: t('saved'), icon: renderIcon(ui, ICON_CHECK, { size: 14 }) });
          if (pendingSwitch) {
            commitSelect(pendingSwitch);
            setPendingSwitch(undefined);
          }
        } catch (error) {
          setProfileError(profileErrorKey(error) === 'conflict' ? t('profileConflict') : t('profileSaveFailed'));
        } finally {
          setSaving(false);
        }
      };

      const makeDefault = async (profileId) => {
        if (!profileAdapter) {
          setProfileError(t('profileUnavailable'));
          return;
        }
        setSaving(true);
        setProfileError(undefined);
        try {
          await profileAdapter.setDefault(profileId);
          await refreshRoster();
          setToast({ text: t('defaultSet'), icon: renderIcon(ui, ICON_CHECK, { size: 14 }) });
        } catch {
          setProfileError(t('profileDefaultFailed'));
        } finally {
          setSaving(false);
        }
      };

      const closeDeleteModal = () => setDeleteModal({ open: false, profileId: undefined, displayName: '', revision: undefined, error: undefined });
      const openDeleteModal = (profile) => {
        if (!profileAdapter) {
          setProfileError(t('profileUnavailable'));
          return;
        }
        if (!canDeleteProfile(profile)) return;
        // The server enforces this too; failing here explains the rule before
        // a round trip and keeps the user out of a dialog that cannot succeed.
        if (profile.isDefaultForNewSessions === true) {
          setProfileError(t('deleteProfileIsDefault'));
          return;
        }
        setProfileError(undefined);
        setDeleteModal({ open: true, profileId: profile.id, displayName: profile.displayName, revision: profile.revision, error: undefined });
      };
      const confirmDelete = async () => {
        const target = deleteModal;
        if (!profileAdapter || !target.profileId) return;
        setSaving(true);
        setProfileError(undefined);
        try {
          await profileAdapter.delete({ id: target.profileId, expectedRevision: target.revision });
          closeDeleteModal();
          // Deleted the profile being edited: point the card at the bundled
          // preset immediately instead of rendering an id that is gone. The
          // roster reload below keeps the dropdown in sync.
          if (selectedId === target.profileId) {
            setDraft(undefined);
            setNewDraft(undefined);
            setPendingSwitch(undefined);
            setSelectedId(BUNDLED_PROFILE_ID);
          }
          setToast({ text: t('deleteProfileDone'), icon: renderIcon(ui, ICON_CHECK, { size: 14 }) });
          await refreshRoster();
        } catch (error) {
          const key = deleteErrorKey(error);
          if (key === 'not-found') {
            // Another window already deleted it: the end state the user asked
            // for holds, so close the dialog and resync instead of retrying.
            closeDeleteModal();
            setProfileError(t('deleteProfileNotFound'));
            await refreshRoster();
          } else {
            setDeleteModal((previous) => ({
              ...previous,
              error: t(key === 'conflict'
                ? 'profileConflict'
                : key === 'is-default' ? 'deleteProfileIsDefault' : 'deleteProfileFailed'),
            }));
          }
        } finally {
          setSaving(false);
        }
      };

      // Rewrite one legacy profile directory into the dual-key persona form so
      // it mounts on DSH 0.1.5 (the host backs the file up first and is
      // idempotent, so a double click is harmless).
      const migrateProfile = async (profileId) => {
        if (!profileAdapter) {
          setProfileError(t('profileUnavailable'));
          return;
        }
        setSaving(true);
        setProfileError(undefined);
        try {
          await profileAdapter.migrate(profileId);
          await refreshRoster();
          setToast({ text: t('profileMigrated'), icon: renderIcon(ui, ICON_CHECK, { size: 14 }) });
        } catch {
          setProfileError(t('profileMigrateFailed'));
        } finally {
          setSaving(false);
        }
      };

      const commitSelect = (nextId) => {
        setDraft(undefined);
        setProfileError(undefined);
        if (nextId === NEW_PROFILE_SENTINEL) {
          setNewDraft(createNewProfileDraft(editEffective));
          setSelectedId(NEW_PROFILE_SENTINEL);
        } else {
          setNewDraft(undefined);
          setSelectedId(nextId);
        }
      };
      const requestSelect = (nextId) => {
        if (nextId === selectedId || saving) return;
        if (dirty) {
          setPendingSwitch(nextId);
          return;
        }
        commitSelect(nextId);
      };
      // Dirty-guard dialog decision: save-and-switch, discard, or cancel.
      // While the naming dialog is open (sentinel save-and-switch), the guard
      // hides — both would stack on screen otherwise.
      const guard = pendingSwitch !== undefined && !nameModal.open;
      const confirmGuardSave = async () => {
        if (saveMode === 'bundled') {
          if (!(await run(ops, t('saved')))) return;
        } else if (saveMode === 'create') {
          setNameModal({ open: true, input: '', error: undefined });
          return; // confirmCreate performs the switch
        } else if (saveMode === 'custom' && selectedProfile) {
          const ok = await saveCustom(selectedProfile, draftToConfig(draft, selectedProfile.config, defaultsBaseline));
          if (!ok) return;
        } else {
          setProfileError(t('profileSaveFailed'));
          return;
        }
        const next = pendingSwitch;
        setPendingSwitch(undefined);
        commitSelect(next);
      };
      const confirmGuardDiscard = () => {
        const next = pendingSwitch;
        setPendingSwitch(undefined);
        commitSelect(next);
      };

      // Cancel: drop the staged edits and show the last loaded/saved values.
      // Purely local — no write, no reload; distinct from Reset to defaults,
      // which rewrites the configuration.
      const cancelEdits = () => {
        if (saving) return;
        setConfirmReset(false);
        setProfileError(undefined);
        setDraft(undefined);
      };

      const reset = async () => {
        setConfirmReset(false);
        if (isBundledProfile) {
          // Reset restores role settings only. Server definitions are the
          // user's connection data: the reset draft keeps the PERSISTED ones, so
          // planUserOps sees them unchanged instead of unsetting each one.
          const resetDraft = { ...buildDraft(base, base?.advanced, base), servers: baseline.servers };
          const resetOps = planUserOps(base, user, resetDraft);
          if (resetOps.length === 0) { setDraft(undefined); return; }
          await run(resetOps, t('resetDone'));
          return;
        }
        // Custom profiles: restore the LOCAL edit to the bundled defaults;
        // nothing is persisted until the user saves (spec: reset only touches
        // what is being edited).
        // Servers stay as they currently are in the editor (a removal the user
        // staged is still theirs to save or discard; nothing disappears by itself).
        const defaultsDraft = { ...buildDraft(base, base?.advanced, base), servers: current.servers };
        if (!deepEqualJson(defaultsDraft, baseline)) setDraft(defaultsDraft);
      };
      // Expanded by default: on DSH 0.2 the card is a settings page (the
      // `settings.section` slot), so the content should be visible on entry
      // instead of hiding behind an extra click. The header stays a toggle.
      const [cardOpenState, setCardOpen] = React.useState(true);
      // The Agents page is the editor itself, not a collapsible card in a list.
      const isPage = variant === 'page';
      const cardOpen = isPage ? true : cardOpenState;

      const headerButton = isPage ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 0 4px' } },
        React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: '28px', color: color.text } }, t('agentsTitle')),
          React.createElement('span', { style: { fontSize: 11, lineHeight: '16px', padding: '1px 6px', borderRadius: 999, border: `1px solid ${color.border}`, color: color.tertiary, flex: 'none' } }, `${BUNDLED_PROFILE_NAME} v${VERSION}`)),
        React.createElement('span', { style: { fontSize: 13, lineHeight: '1.5', color: color.tertiary } }, t('desc')),
      ) : React.createElement('button', {
        type: 'button',
        onClick: () => setCardOpen((o) => !o),
        'aria-expanded': cardOpen,
        // Match the host built-in cards' header chrome (dsh-client-ui-settings-plugins):
        // one flex row — text block (title + description stacked, flex:1) then chevron.
        style: {
          appearance: 'none', width: '100%', textAlign: 'left', cursor: 'pointer',
          background: 'none', border: 'none', color: color.text,
          display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12,
        },
      },
        React.createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 } },
          React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            React.createElement('span', { style: { fontSize: 15, fontWeight: 600, lineHeight: '1.4', color: color.text } }, BUNDLED_PROFILE_NAME),
            React.createElement('span', {
              style: {
                fontSize: 11, lineHeight: '16px', padding: '1px 6px', borderRadius: 999,
                border: `1px solid ${color.border}`, color: color.tertiary, flex: 'none',
              },
            }, `v${VERSION}`),
            !cardOpen && dirty ? renderIcon(ui, ICON_WARNING, { size: 14 }) : null,
          ),
          React.createElement('span', { style: { fontSize: 13, lineHeight: '1.5', color: color.tertiary } }, t('desc')),
        ),
        renderIcon(ui, ICON_CHEVRON, {
          size: 14,
          style: { transform: cardOpen ? 'rotate(180deg)' : 'none', transition: 'transform .12s', color: color.tertiary, flex: 'none' },
        }),
      );

      const serverNames = Object.keys(current.servers ?? {});
      const baseToolsFor = (roleId) => base?.presets?.[current.preset]?.[roleId]?.tools;
      const baseDenyFor = (roleId) => base?.presets?.[current.preset]?.[roleId]?.deny ?? [];
      const presetNames = [...new Set([...Object.keys(base?.presets ?? {}), ...Object.keys(editEffective?.presets ?? {}), current.preset])];
      const rootDoc = isBundledProfile ? user : (selectedProfile?.config ?? {});
      const overrides = rootOverrides(rootDoc, current.preset);
      const enabledSeats = COUNCILLOR_ROLE_IDS.filter((roleId) => {
        const role = current.roles[roleId];
        return role !== undefined && role.enabled !== false;
      });
      const councilOn = enabledSeats.length >= MIN_COUNCIL_SEATS;
      const councilStatusText = councilOn
        ? t('councilOn').replace('{seats}', enabledSeats.map((roleId) => roleId.replace('councillor-', '')).join(', '))
        : t('councilOff');
      const councilWarnings = councilWarningKeys(current).map((key) => t(key));
      // observer is force-disabled (no attachment forwarding yet) and parked
      // last; the Council group takes its previous position above it.
      const upstreamRows = UPSTREAM_ROLE_IDS.filter((roleId) => roleId !== 'observer').map((roleId) => React.createElement(RoleRow, {
        key: roleId, roleId, draft: current, groups: models.groups, modelsStatus: models.status,
        advOpen: expanded[roleId] === true,
        onAdvancedToggle: () => toggleAdvanced(roleId), onChange: changeRole, t, baseDeny: baseDenyFor(roleId), baseTools: baseToolsFor(roleId), serverNames,
      }));
      const observerRow = React.createElement(RoleRow, {
        key: 'observer', roleId: 'observer', draft: current, groups: models.groups, modelsStatus: models.status,
        advOpen: expanded.observer === true,
        onAdvancedToggle: () => toggleAdvanced('observer'), onChange: changeRole, t, baseDeny: baseDenyFor('observer'), baseTools: baseToolsFor('observer'), serverNames,
      });
      const councilRows = COUNCIL_ROLE_IDS.map((roleId) => React.createElement(RoleRow, {
        key: roleId, roleId, draft: current, groups: models.groups, modelsStatus: models.status,
        advOpen: expanded[roleId] === true,
        onAdvancedToggle: () => toggleAdvanced(roleId), onChange: changeRole, t, baseDeny: baseDenyFor(roleId), baseTools: baseToolsFor(roleId), serverNames,
        // The synthesizer has no switch: it follows the seats. The row only
        // configures its model/effort/prompt and shows the derived state.
        showSwitch: roleId !== COUNCIL_ROLE_ID,
        statusText: councilOn ? t('councilAutoOn') : t('councilAutoOff'),
      }));
      const councilGroup = React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: color.text, flex: 'none' } }, t('councilGroup')),
          React.createElement('span', { style: { fontSize: 11, color: councilOn ? color.secondary : color.tertiary, minWidth: 0 } }, councilStatusText),
        ),
        ...councilWarnings.map((text, index) => React.createElement('div', { key: 'warn-' + index, style: { fontSize: 11, lineHeight: '16px', color: color.warn } }, text)),
        ...councilRows,
      );
      const roleRows = [...upstreamRows, councilGroup, observerRow];

      // The profile strip lives at the top of the expanded card: choosing a
      // profile only changes WHAT is edited; the session is untouched.
      const profileStrip = React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: color.text, flex: 'none' } }, t('profile')),
          React.createElement('div', { style: { flex: '1 1 260px', minWidth: 0 } },
            React.createElement(ProfileSelect, {
              profiles: roster.profiles, selectedId,
              onChange: requestSelect, disabled: saving, t,
            }),
          ),
          // The dropdown already shows the selected profile's name, so no
          // badge repeats it on the right. The "set as default" action is
          // available for EVERY non-default profile — including the bundled
          // one, so the default can always be switched back — but never for
          // the in-place new-profile draft (nothing exists to point at yet).
          canSetDefault(selectedProfile)
            ? React.createElement(ui.Button, {
              variant: 'outline', size: 'sm', disabled: saving || !writable,
              onClick: () => void makeDefault(selectedProfile.id),
            }, t('setNewSessionDefault'))
            : null,
          // Deleting is final, so the action only exists for a persisted custom
          // profile and always confirms in its own dialog.
          canDeleteProfile(selectedProfile)
            ? React.createElement(ui.Button, {
              variant: 'outline', size: 'sm', disabled: saving || !writable,
              onClick: () => openDeleteModal(selectedProfile),
            }, t('deleteProfile'))
            : null,
        ),
        React.createElement('span', { style: { fontSize: 11, color: color.tertiary, lineHeight: '16px' } }, t('selectionHint')),
        selectedProfile?.needsMigration === true
          ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: color.warn, lineHeight: '16px' } },
            renderIcon(ui, ICON_WARNING, { size: 14 }),
            React.createElement('span', null, t('profileMigrationNeeded')),
            React.createElement(ui.Button, {
              variant: 'outline', size: 'sm', disabled: saving || !writable,
              onClick: () => void migrateProfile(selectedProfile.id),
            }, t('profileMigrate')),
          )
          : null,
        selectedId === NEW_PROFILE_SENTINEL
          ? React.createElement('span', { style: { fontSize: 11, color: color.warn, lineHeight: '16px' } }, t('draftNote'))
          : null,
        profileError
          ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '16px' } },
            renderIcon(ui, ICON_WARNING, { size: 14 }), profileError)
          : null,
      );

      // reachable without scrolling; dirty only switches the "unsaved" note
      // and the save button's availability.
      const actions = React.createElement('div', {
        ref: actionsRef,
        onFocus: () => { focusInActions.current = true; },
        // Only a move to another element ends "focus is in the actions"; a
        // button turning disabled reports no target and keeps it.
        onBlur: (event) => { if (event.relatedTarget && !actionsRef.current?.contains(event.relatedTarget)) focusInActions.current = false; },
        style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' },
      },
        // Always mounted so assistive tech announces the change of state.
        React.createElement('span', { role: 'status', 'data-dirty': dirty ? 'true' : 'false', style: { fontSize: 12, color: color.warn, marginRight: 'auto' } }, dirty ? t('dirty') : ''),
        confirmReset
          ? React.createElement(React.Fragment, null,
            React.createElement('span', { 'data-reset-keeps-servers': true, style: { fontSize: 12, color: color.warn } }, t('resetConfirm') + ' ' + t('resetKeepsServers') + (dirty ? ' ' + t('resetDiscards') : '')),
            React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: () => void reset() }, t('reset')),
            React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: () => setConfirmReset(false) }, '×'),
          )
          : React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving || !writable, onClick: () => setConfirmReset(true) }, t('reset')),
        React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving || !dirty, onClick: cancelEdits }, t('cancel')),
        React.createElement(ui.Button, {
          variant: 'outline', size: 'sm', disabled: saving || !writable || !dirty || invalid, onClick: save,
        }, saving ? t('saving') : t('save')),
      );

      const nameModalNode = nameModal.open ? React.createElement(ui.Modal, {
        open: true,
        onClose: () => {
          setNameModal({ open: false, input: '', error: undefined });
          // Cancel the naming dialog ends a pending guard switch too: the user
          // stays on the current (still dirty) edit.
          if (pendingSwitch !== undefined) setPendingSwitch(undefined);
        },
        closeLabel: t('cancel'),
        title: t('nameTitle'),
        description: t('nameDescription'),
        footer: React.createElement(React.Fragment, null,
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: () => {
            setNameModal({ open: false, input: '', error: undefined });
            if (pendingSwitch !== undefined) setPendingSwitch(undefined);
          } }, t('cancel')),
          React.createElement(ui.Button, { variant: 'primary', size: 'sm', disabled: saving, onClick: () => void confirmCreate() }, t('create')),
        ),
      },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          // Same column-container trap as the seat prompt: without this the
          // new-profile dialog reserves a 160px-tall field for one text input.
          React.createElement(Field, { label: t('displayName'), grow: false },
            React.createElement(ui.Input, {
              value: nameModal.input,
              disabled: saving,
              placeholder: ' ',
              onChange: (e) => setNameModal((previous) => ({ ...previous, input: e.target.value, error: undefined })),
            })),
          nameModal.error
            ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: '16px' } }, nameModal.error)
            : null,
        ),
      ) : null;

      const guardModalNode = guard ? React.createElement(ui.Modal, {
        open: true,
        onClose: () => setPendingSwitch(undefined),
        closeLabel: t('cancel'),
        title: t('switchTitle'),
        description: t('switchDescription'),
        footer: React.createElement(React.Fragment, null,
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: () => setPendingSwitch(undefined) }, t('cancel')),
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: confirmGuardDiscard }, t('discard')),
          React.createElement(ui.Button, { variant: 'primary', size: 'sm', disabled: saving, onClick: () => void confirmGuardSave() }, t('saveAndSwitch')),
        ),
      }, null) : null;

      const deleteModalNode = deleteModal.open ? React.createElement(ui.Modal, {
        open: true,
        onClose: closeDeleteModal,
        closeLabel: t('cancel'),
        title: t('deleteProfileTitle'),
        description: t('deleteProfileDescription'),
        footer: React.createElement(React.Fragment, null,
          React.createElement(ui.Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: closeDeleteModal }, t('cancel')),
          React.createElement(ui.Button, { variant: 'primary', size: 'sm', disabled: saving, onClick: () => void confirmDelete() }, t('deleteProfileConfirm')),
        ),
      },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: color.text, lineHeight: '18px' } }, deleteModal.displayName),
          selectedId === deleteModal.profileId && dirty
            ? React.createElement('span', { style: { fontSize: 12, color: color.warn, lineHeight: '16px' } }, t('deleteProfileDirty'))
            : null,
          deleteModal.error
            ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: '16px' } }, deleteModal.error)
            : null,
        ),
      ) : null;

      // Collapsed cards render only the header row; every editable surface
      // (profile strip, roles, actions, hints, toast mount point) lives
      // behind cardOpen.
      const body = cardOpen ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { borderTop: isPage ? 'none' : '1px solid var(--dsw-alias-border-l2)', padding: isPage ? 0 : '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10, color: color.text, minWidth: 0 } },
        profileStrip,
        actions,
        React.createElement('div', { style: { display: 'flex', gap: 6, fontSize: 12, color: color.secondary, background: color.hover, borderRadius: 8, padding: '6px 8px' } },
          t('orchestratorNote')),
        roleRows,
        React.createElement(OrchestratorPanel, { draft: current, onChange: changeOrchestrator, t }),
        React.createElement(ServersPanel, { draft: current, onChange: changeServer, onAdd: addServer, onRemove: removeServer, disabled: !writable, t }),
        React.createElement(OverridesPanel, { overrides, t }),
        React.createElement(IdentityPanel, {
          presetName: current.preset, presetNames, onPreset: changePreset, disabled: !writable || saving, t,
          presetId: (isBundledProfile ? (effective.presetId ?? user.presetId) : rootDoc.presetId),
          verbose: (isBundledProfile ? (effective.verbose ?? user.verbose) : rootDoc.verbose),
        }),
        !writable ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, color: color.warn, fontSize: 12 } },
          renderIcon(ui, ICON_WARNING, { size: 14 }), t('readOnly')) : null,
        React.createElement('span', { style: { fontSize: 11, color: color.tertiary } }, t(isBundledProfile ? 'effectiveHint' : 'effectiveHintProfile')),
        toast ? React.createElement(ui.Toast, { text: toast.text, icon: toast.icon, onDone: () => setToast(null) }) : null,
        ),
      ) : null;

      // Agents page: the page owns the full width, so no card chrome and no
      // minimum width — rows reflow instead of scrolling sideways.
      if (isPage) {
        return React.createElement('div', { className: 'omds-page', 'data-omds-page': '' },
          React.createElement('div', { className: 'omds-page-wrap' }, headerButton,
            body,
            nameModalNode, guardModalNode, deleteModalNode));
      }
      return React.createElement('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-3)',
          // Below CARD_MIN_WIDTH the host column would squeeze the rows to ~100px.
          // Keep a readable width instead: the host's own settings scroller
          // (overflow-x: auto) then scrolls the card sideways.
          display: 'flex', flexDirection: 'column', minWidth: CARD_MIN_WIDTH, flex: 'none', boxSizing: 'border-box', overflow: 'hidden',
          width: '100%',
        },
        'data-omds-card': '',
      }, headerButton, body, nameModalNode, guardModalNode, deleteModalNode);
    }

    // ----------------------------------------------------------------- apply
    const name = NS;
    // `remote` / `remote.session` exist on DSH 0.2 — the host's own Subagent
    // settings page injects the same pair and calls
    // `ctx.remote.session.modelCatalog()` for its model picker. Inject them so
    // the card's dropdown gets the full provider/model catalog.
    const inject = ['slots', 'locale', 'layout', 'connection', 'remote', 'remote.session', 'configForms'];
    // Keyed `main` panel + `sidebar.panellist` entry share this id (the sidebar
    // selects the main entry with the same key, as the MCP panel does).
    const AGENTS_PANEL_ID = 'oh-my-dsh-slim-agents';

    // Native controls (select, textarea) have no host primitive. This sheet
    // gives them the same box as `ui.Input`'s wrapper (32px + border = 34px,
    // `--dsw-radius-md`, layer-1 fill) using only host tokens, so light/dark
    // themes follow the host. `ui.Input` itself is left unstyled: its wrapper
    // already draws the border.
    const CONTROL_CSS = `
.omds-select, .omds-textarea {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; outline: none;
}
.omds-select {
  height: 34px; padding: 0 32px 0 10px; line-height: 22px; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; text-overflow: ellipsis;
}
.omds-textarea { display: block; width: 100%; padding: 6px 10px; line-height: 20px; resize: vertical; }
.omds-select:focus, .omds-textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
.omds-select:focus-visible, .omds-textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.omds-select:disabled, .omds-textarea:disabled { opacity: .6; cursor: not-allowed; }
.omds-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.omds-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.omds-row-wrap { align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.omds-grow { flex: 1 1 0; min-width: 0; display: flex; }
.omds-grow > * { flex: 1 1 auto; min-width: 0; }
/* ui.Input's wrapper is 32px + its border (34px); keep row buttons the same height. */
.omds-row > button { height: 34px; flex: none; }
/* Agents page: the page itself scrolls and reflows; no minimum width. */
.omds-page { container-type: inline-size; box-sizing: border-box; height: 100%; overflow-x: hidden; overflow-y: auto; padding: 28px 32px 40px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; }
.omds-page-wrap { max-width: 880px; min-width: 0; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
@container (max-width: 520px) { .omds-page { padding: 18px 12px 28px; } }
`;

    /** Own glyph (currentColor): host icon names differ per generation. */
    function AgentsIcon({ size }) {
      const px = typeof size === 'number' ? size : 20;
      return React.createElement('svg', { width: px, height: px, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('circle', { cx: 10, cy: 6.5, r: 2.75 }),
        React.createElement('path', { d: 'M4 16.5c0-3 2.7-4.75 6-4.75s6 1.75 6 4.75' }),
        React.createElement('path', { d: 'M15.5 4.5v3M14 6h3' }));
    }

    function installControlCss() {
      if (typeof document === 'undefined' || !document.head) return () => {};
      let node = document.head.querySelector('style[data-omds-css]');
      if (!node) {
        node = document.createElement('style');
        node.setAttribute('data-omds-css', '');
        node.textContent = CONTROL_CSS;
        document.head.appendChild(node);
      }
      return () => { node.remove(); };
    }

    function apply(ctx) {
      const gaps = missingPrimitives(uiPrimitives);
      if (gaps.length > 0) {
        console.warn('[oh-my-dsh-slim] host ui-primitives missing ' + gaps.join(', ') + ' — settings card disabled');
        return;
      }
      ctx.effect(installControlCss, 'oh-my-dsh-slim: control styles');
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'oh-my-dsh-slim: dictionaries');
      const t = ctx.locale.bind(NS);
      // DSH 0.2 desktop renders plugin configuration as a settings page: the
      // settings shell draws the active `settings.section` entry (its own
      // General/Models pages and third-party cards such as dsh-better-sidebar
      // all register there). The older `plugins.item` slot is not rendered by
      // that UI, so a card registered only there stays invisible.
      const scope = ctx.configForms.get(NS);
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 100,
        label: () => BUNDLED_PROFILE_NAME,
        locale: NS,
        inject: () => ({ t }),
      }, () => React.createElement(SettingsCard, { t, scope, connection: ctx.connection, remote: ctx.remote })))), 'oh-my-dsh-slim: settings page');
      // Agents: a sidebar entry plus a full-page `main` panel, registered the way
      // the MCP panel does. It mounts the SAME SettingsCard over the SAME scope
      // and the shared editor store, so the Settings section and this page edit
      // one draft — there is no second editor and no second config.
      ctx.effect(() => ctx.configForms.whileServed([NS], () => {
        const offMain = ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: AGENTS_PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, () => React.createElement(SettingsCard, { t, scope, connection: ctx.connection, remote: ctx.remote, variant: 'page' })));
        const offNav = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: AGENTS_PANEL_ID,
          order: 2,
          label: () => t('agentsPanel'),
          locale: NS,
        }, AgentsIcon));
        return () => { offNav?.(); offMain?.(); };
      }), 'oh-my-dsh-slim: agents page');
    }

    exports.name = name;
    exports.VERSION = VERSION;
    exports.inject = inject;
    exports.apply = apply;
    exports.REQUIRED_PRIMITIVES = REQUIRED_PRIMITIVES;
    exports.missingPrimitives = missingPrimitives;
    exports.planUserOps = planUserOps;
    exports.serverToForm = serverToForm;
    exports.formToServer = formToServer;
    exports.rootOverrides = rootOverrides;
    exports.mcpBlockReason = mcpBlockReason;
    exports.mcpPolicyWarnings = mcpPolicyWarnings;
    exports.isMcpToolNameUi = isMcpToolNameUi;
    exports.serverNameUsable = serverNameUsable;
    exports.mcpViolation = mcpViolation;
    exports.sharedMcpWarnings = sharedMcpWarnings;
    exports.sharedMcpInvalid = sharedMcpInvalid;
    exports.activeRoleOverride = activeRoleOverride;
    exports.activeOrchestratorPath = activeOrchestratorPath;
    exports.PolicySection = PolicySection;
    exports.OrchestratorPanel = OrchestratorPanel;
    exports.ServersPanel = ServersPanel;
    exports.OverridesPanel = OverridesPanel;
    exports.IdentityPanel = IdentityPanel;
    exports.SettingsCard = SettingsCard;
    exports.RoleRow = RoleRow;
    exports.TOOL_NAMES = TOOL_NAMES;
    exports.buildDraft = buildDraft;
    exports.effortOptionsFor = effortOptionsFor;
    exports.effortLabel = effortLabel;
    exports.effortSelectValue = effortSelectValue;
    exports.effortHintKey = effortHintKey;
    exports.roleModelPatch = roleModelPatch;
    exports.effortMismatch = effortMismatch;
    exports.effortGatesSave = effortGatesSave;
    exports.initialProfileRoster = initialProfileRoster;
    exports.normalizeProfileRoster = normalizeProfileRoster;
    exports.mergeProfileConfig = mergeProfileConfig;
    exports.councilWarningKeys = councilWarningKeys;
    exports.validateProfileName = validateProfileName;
    exports.draftToConfig = draftToConfig;
    exports.createProfileAdapter = createProfileAdapter;
    exports.unwrapProfileRpc = unwrapProfileRpc;
    exports.ProfileSelect = ProfileSelect;
    exports.ModelSelect = ModelSelect;
    exports.canSetDefault = canSetDefault;
    exports.canDeleteProfile = canDeleteProfile;
    exports.deleteErrorKey = deleteErrorKey;
    exports.resolveInitialSelection = resolveInitialSelection;
    exports.selectionInRoster = selectionInRoster;
    exports.profileSaveMode = profileSaveMode;
    exports.writeSettings = writeSettings;
    exports.liveRevision = liveRevision;
    // Icon resolution is exported for the regression test: the card's advanced
    // toggle became invisible on hosts that renamed every glyph to
    // `OutlineMedium`, and an icon-only control has no other trace to assert.
    exports.ICON_CHEVRON = ICON_CHEVRON;
    exports.ICON_CHECK = ICON_CHECK;
    exports.ICON_WARNING = ICON_WARNING;
    exports.resolveIcon = (names) => icon(ui, names);
    return module.exports;
  },
});
