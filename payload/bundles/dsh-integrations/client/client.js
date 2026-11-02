// dsh-integrations — "MCP" sidebar panel (browser half of the bundle).
//
// A hand-written ModuleLoader bundle, same shape as oh-my-dsh-slim/client: no
// build step, no JSX, React and the UI primitives are host-provided.
//
// WHAT IT READS (and nothing else):
//   * `ctx.remote.pluginManager.listPlugins()` — loader entries; the panel keeps
//     those whose moduleName is `@deepseek-ai/dsh-mcp-client`. The result has
//     entryId / enabled / fiberPhase only. It carries NO row config, so env,
//     headers, `!!js` values and URLs never reach this file.
//   * `ctx.remote.pluginManager.listBundles()` — only to map an entry to the
//     bundle that declares it (for "Open settings"). Failure is tolerated.
//   * `ctx.configForms.get('oh-my-dsh-slim')` — the role store: name, transport
//     and role usage of each server. env / envFiles / args / url / command are
//     never read.
// WHAT IT DOES: navigation (`pluginNavigation.openBundle`) plus ONE explicit,
// user-triggered write: `remote.pluginManager.setPluginEnabled(entryId, enabled)`,
// the same call the host's own Plugins page makes. It flips only that entry's
// `disabled` flag, never row config, so `!!js` secret references are untouched.
// Disable asks for confirmation first. Nothing is called on load.
// STATUS IS HONEST: the phase pill is the PLUGIN lifecycle, not a connection. The Connection pill
// is separate and comes ONLY from the owner RPC `/integrations-editor` `status` (read-only: it
// starts no connection, probes nothing and writes nothing). It is fetched on mount and then every
// STATUS_POLL_MS while the page is mounted. No answer, a failed answer, a disabled row, a row the
// payload does not name exactly, or any invalid entry => Unknown. Connected means the handshake and
// initial sync were observed, not that the remote server is healthy now. Backend text is never shown.
// CONFIG EDITOR: an explicit Edit on a row opens an inline editor for exactly four
// fields (command, args, cwd, toolCallTimeoutMs) through the optional backend channel
// `/integrations-editor` (`describe` on Edit, `mutate` on Save). Nothing is called on load.
// Env, headers, URLs and transport are never read or written here: see `limitation`.
window.__ModuleLoader__.load({
  id: 'dsh-integrations',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-integrations-mcp';
    const PANEL_ID = 'mcp-servers';
    const MCP_MODULE = '@deepseek-ai/dsh-mcp-client';
    // Module names whose rows are LISTED: the native module (unmigrated rows) and the adapter name. Exact
    // names only. Listing a row says nothing about the adapter's runtime: status comes only from the backend.
    const MCP_MODULES = [MCP_MODULE, 'dsh-integrations/mcp-client'];
    const STATUS_POLL_MS = 3000;
    const STATUS_TIMEOUT_MS = 6000;
    // The backend's complete reason allowlist (lib/mcp-status.js). Anything else shows the generic line.
    const REASON_CODES = { connection_lost: 1, connection_failed: 1, reconnect_disabled: 1, retry_exhausted: 1, close_unconfirmed: 1 };
    const CONN_STATES = ['unknown', 'connecting', 'connected', 'disconnected', 'retrying', 'error'];
    const ROLE_STORE = 'oh-my-dsh-slim';
    const ENTRY_PREFIX = 'mcp-';
    const INCLUDE_PREFIX = 'include:';
    const PHASES = ['failed', 'pending', 'active', 'loading', 'unloading'];

    const en = {
      panel: 'MCP',
      title: 'MCP servers',
      intro: 'Servers declared in your plugin bundles and in the role store.',
      refresh: 'Refresh',
      globalTitle: 'Global servers',
      globalHint: 'Started with the MCP client plugin for every session. "Plugin" is whether the plugin is loaded. "Connection" comes from the integrations backend: Connected means the handshake and first sync were observed, not that the server is healthy right now. Unknown means no status is available.',
      roleTitle: 'Role servers (Oh My DSH Slim)',
      roleHint: 'A separate store. These servers are configured only: they start inside a role\'s own session, so nothing here is connected.',
      loading: 'Loading…',
      errorList: 'Could not read the plugin list.',
      retry: 'Try again',
      emptyGlobal: 'No global MCP servers are declared.',
      emptyRole: 'No role servers yet. Add them in Settings → Oh My DSH Slim.',
      roleUnavailable: 'The role store is not available in this profile.',
      roleNotUsed: 'Not assigned to any role',
      usedBy: 'Roles',
      transport: 'Transport',
      bundle: 'Bundle',
      openSettings: 'Open plugin',
      lifecycle: 'Plugin lifecycle (not a connection)',
      connection: 'Connection',
      connectionUnknown: 'Unknown',
      connConnecting: 'Connecting',
      connConnected: 'Connected',
      connDisconnected: 'Disconnected',
      connRetrying: 'Retrying',
      connError: 'Error',
      connConnectedNote: 'Handshake and first sync were observed. This does not guarantee the remote server is healthy now.',
      connObserved: 'Observed {time}',
      connChanged: 'Changed {time}',
      connLastObserved: 'Last observed {time}',
      connAttempt: 'Attempt {n}',
      connRetryAt: 'Next retry {time}',
      connReason: 'A reason was reported; details are not shown.',
      connReason_connection_lost: 'Reason: the connection was lost.',
      connReason_connection_failed: 'Reason: the connection could not be made.',
      connReason_reconnect_disabled: 'Reason: automatic reconnect is off.',
      connReason_retry_exhausted: 'Reason: retries ran out.',
      connReason_close_unconfirmed: 'Reason: closing was not confirmed.',
      localeTag: 'en-US',
      phaseNone: 'Plugin not loaded',
      phaseFailed: 'Plugin failed',
      phasePending: 'Plugin starting',
      phaseActive: 'Plugin loaded',
      phaseLoading: 'Plugin loading',
      phaseUnloading: 'Plugin unloading',
      disabled: 'Disabled',
      limitation: 'Edit changes only four fields of an existing stdio server: command, arguments, working directory and tool call timeout. Environment variables, headers, URLs, transport, adding and removing servers are never shown or changed here, and saving does not check that the server connects. Open plugin only shows the declaring bundle in Plugins.',
      edit: 'Edit',
      editNamed: 'Edit {name}',
      editorTitle: 'Edit settings',
      editorLoading: 'Reading the current settings…',
      editorUnavailable: 'The settings editor is not available: the integrations backend did not respond. This list still works.',
      editorMissing: 'This server cannot be edited here. Only existing stdio servers with safely readable fields can be edited.',
      editorScope: 'Only these four fields can be edited. Environment variables, headers, URLs and transport are never shown or changed here.',
      fieldCommand: 'Command',
      fieldArgs: 'Arguments (JSON array of strings)',
      fieldCwd: 'Working directory',
      fieldTimeout: 'Tool call timeout (ms)',
      argsHint: 'One JSON array. Each item is one argument; nothing is split or interpreted by a shell, and empty strings are kept.',
      lockedField: 'Read-only: managed outside this editor. Its value is not shown.',
      gateInactive: 'Saving is off for this server: it is not active in this session, or DSH needs a restart before a change can apply.',
      save: 'Save',
      saving: 'Saving…',
      reload: 'Reload',
      discardPrompt: 'Discard your unsaved changes to {name}? Nothing has been written.',
      keepEditing: 'Keep editing',
      discardChanges: 'Discard changes',
      reloadLatest: 'Reload latest (discards my edits)',
      noChanges: 'No changes to save.',
      errCommandEmpty: 'The command cannot be empty.',
      errArgsJson: 'Arguments must be valid JSON.',
      errArgsShape: 'Arguments must be a JSON array of strings.',
      errArgsCount: 'At most 128 arguments.',
      errTextLength: 'At most 4096 characters per value.',
      errTimeout: 'Enter a finite number of milliseconds, for example 30000.',
      saveApplied: 'Saved to the configuration and applied by the host. This does not mean the server is connected or healthy.',
      saveNoChange: 'Nothing to change: the saved configuration already has these values.',
      saveFailed: 'Not saved.',
      editErr_INVALID_REQUEST: 'The backend rejected these values. Values that look like secrets or tokens cannot be saved here.',
      editErr_RESTART_REQUIRED: 'This change needs a DSH restart to apply, so it was not saved.',
      editErr_CONFLICT: 'The configuration changed since you opened the editor. Nothing was saved. Your edits are kept until you reload.',
      editErr_UNKNOWN_SERVER: 'This server is no longer in the editable configuration. Reload to see the current state.',
      editErr_PROTECTED_FIELD: 'One of these fields is protected and cannot be changed here.',
      editErr_INVALID_DOCUMENT: 'The configuration could not be changed safely. Nothing was saved.',
      editErr_AMBIGUOUS_ID: 'The configuration has duplicate server ids, so it cannot be edited here.',
      editErr_UNSUPPORTED_DOCUMENT: 'This configuration layout is not supported by the editor.',
      editErr_UNSAFE_PATH: 'The configuration file location failed a safety check. Nothing was changed.',
      editErr_UNAVAILABLE: 'The backend could not complete the request, so the save may not have finished. Reload to check the current values.',
      editErr_FORBIDDEN: 'This connection is not allowed to edit these settings.',
      editErr_ACTIVATION_ROLLED_BACK: 'The host could not apply the change and tried to restore the previous settings. The server may be running either version, so check it before relying on it. Your edits are kept.',
      editErr_RECOVERY_UNCERTAIN: 'Warning: the change could not be applied and the previous settings could not be confirmed as restored. The configuration may be in an unknown state. Saving is turned off: reload the current state or fix it by hand.',
      enable: 'Enable',
      disable: 'Disable',
      cancel: 'Cancel',
      working: 'Working…',
      readOnly: 'Managed outside the plugin list',
      confirmDisable: 'Disable {name}? It is turned off for every session that uses this profile.',
      disableNamed: 'Disable {name}',
      enableNamed: 'Enable {name}',
      doneApplied: '{name}: saved and applied by the host. Connection is shown separately.',
      doneRestart: '{name}: saved. Restart DSH to apply it. {reason}',
      doneOverridden: '{name}: saved, but a higher-priority configuration overrides it, so it is not in effect.',
      doneNoChange: '{name}: already in that state.',
      failedToggle: '{name}: could not change it ({code}).',
      reasonNoHmr: 'This profile applies changes only at startup.',
      reasonPackageMoved: 'The package now resolves to another directory.',
      reasonHostModule: 'The change reaches modules DSH itself loaded.',
      reasonUnmanagedPlugin: 'The change reaches a plugin outside the plugin list.',
      reasonModuleComparison: 'DSH could not compare the loaded plugins with their files.',
    };
    const zh = {
      panel: 'MCP',
      title: 'MCP 服务器',
      intro: '插件包与角色配置中声明的服务器。',
      refresh: '刷新',
      globalTitle: '全局服务器',
      globalHint: '随 MCP 客户端插件为所有会话启动。“插件”表示插件是否已加载。“连接”来自 integrations 后端：“已连接”表示已观察到握手和首次同步，不代表服务器此刻运行正常。“未知”表示没有可用状态。',
      roleTitle: '角色服务器（Oh My DSH Slim）',
      roleHint: '独立的配置。这些服务器仅为已配置：它们在角色自己的会话中启动，因此此处不代表已连接。',
      loading: '加载中…',
      errorList: '无法读取插件列表。',
      retry: '重试',
      emptyGlobal: '尚未声明全局 MCP 服务器。',
      emptyRole: '暂无角色服务器。请在 设置 → Oh My DSH Slim 中添加。',
      roleUnavailable: '当前配置中没有角色配置。',
      roleNotUsed: '未分配给任何角色',
      usedBy: '角色',
      transport: '传输方式',
      bundle: '插件包',
      openSettings: '打开插件',
      lifecycle: '插件生命周期（不是连接状态）',
      connection: '连接',
      connectionUnknown: '未知',
      connConnecting: '连接中',
      connConnected: '已连接',
      connDisconnected: '已断开',
      connRetrying: '重试中',
      connError: '出错',
      connConnectedNote: '已观察到握手和首次同步。这不保证远端服务器此刻运行正常。',
      connObserved: '观测于 {time}',
      connChanged: '变更于 {time}',
      connLastObserved: '上次观测于 {time}',
      connAttempt: '第 {n} 次尝试',
      connRetryAt: '下次重试 {time}',
      connReason: '后端报告了原因；此处不显示详情。',
      connReason_connection_lost: '原因：连接已丢失。',
      connReason_connection_failed: '原因：无法建立连接。',
      connReason_reconnect_disabled: '原因：自动重连已关闭。',
      connReason_retry_exhausted: '原因：重试次数已用完。',
      connReason_close_unconfirmed: '原因：未确认已关闭。',
      localeTag: 'zh-CN',
      phaseNone: '插件未加载',
      phaseFailed: '插件失败',
      phasePending: '插件启动中',
      phaseActive: '插件已加载',
      phaseLoading: '插件加载中',
      phaseUnloading: '插件卸载中',
      disabled: '已停用',
      limitation: '“编辑”只能修改现有 stdio 服务器的四个字段：命令、参数、工作目录和工具调用超时。环境变量、请求头、URL、传输方式以及新增或删除服务器在此处不会显示也不能更改，保存也不会检查服务器能否连接。“打开插件”只会在插件页显示声明它们的插件包。',
      edit: '编辑',
      editNamed: '编辑 {name}',
      editorTitle: '编辑设置',
      editorLoading: '正在读取当前设置…',
      editorUnavailable: '设置编辑器不可用：integrations 后端没有响应。此列表仍可使用。',
      editorMissing: '此服务器无法在这里编辑。只有可安全读取字段的现有 stdio 服务器才能编辑。',
      editorScope: '只能编辑这四个字段。环境变量、请求头、URL 和传输方式在此处不会显示也不能更改。',
      fieldCommand: '命令',
      fieldArgs: '参数（字符串 JSON 数组）',
      fieldCwd: '工作目录',
      fieldTimeout: '工具调用超时（毫秒）',
      argsHint: '一个 JSON 数组。每一项就是一个参数；不会按空格拆分，也不会经过 shell 解析，空字符串会保留。',
      lockedField: '只读：由此编辑器之外管理，不显示其值。',
      gateInactive: '此服务器暂不能保存：它在当前会话中未启用，或需要先重启 DSH 才能生效。',
      save: '保存',
      saving: '保存中…',
      reload: '重新加载',
      discardPrompt: '放弃对 {name} 尚未保存的修改？目前没有写入任何内容。',
      keepEditing: '继续编辑',
      discardChanges: '放弃修改',
      reloadLatest: '重新加载最新内容（放弃我的修改）',
      noChanges: '没有可保存的更改。',
      errCommandEmpty: '命令不能为空。',
      errArgsJson: '参数必须是有效的 JSON。',
      errArgsShape: '参数必须是字符串组成的 JSON 数组。',
      errArgsCount: '参数最多 128 个。',
      errTextLength: '每个值最多 4096 个字符。',
      errTimeout: '请输入有限的毫秒数，例如 30000。',
      saveApplied: '已保存到配置并由宿主应用。这并不表示服务器已连接或运行正常。',
      saveNoChange: '无需更改：已保存的配置已是这些值。',
      saveFailed: '未保存。',
      editErr_INVALID_REQUEST: '后端拒绝了这些值。此处无法保存看起来像密钥或令牌的值。',
      editErr_RESTART_REQUIRED: '此更改需要重启 DSH 才能生效，因此没有保存。',
      editErr_CONFLICT: '自你打开编辑器后配置已变化，未保存任何内容。重新加载之前会保留你的修改。',
      editErr_UNKNOWN_SERVER: '此服务器已不在可编辑的配置中。请重新加载查看当前状态。',
      editErr_PROTECTED_FIELD: '其中一个字段受保护，无法在此更改。',
      editErr_INVALID_DOCUMENT: '无法安全地修改配置，未保存任何内容。',
      editErr_AMBIGUOUS_ID: '配置中存在重复的服务器 ID，因此无法在此编辑。',
      editErr_UNSUPPORTED_DOCUMENT: '编辑器不支持此配置的结构。',
      editErr_UNSAFE_PATH: '配置文件位置未通过安全检查，未做任何更改。',
      editErr_UNAVAILABLE: '后端无法完成请求，保存可能未完成。请重新加载确认当前值。',
      editErr_FORBIDDEN: '此连接无权编辑这些设置。',
      editErr_ACTIVATION_ROLLED_BACK: '宿主无法应用此更改，并尝试恢复了之前的设置。服务器可能运行的是任一版本，请在依赖它之前先检查。你的修改已保留。',
      editErr_RECOVERY_UNCERTAIN: '警告：更改无法应用，且无法确认已恢复之前的设置。配置可能处于未知状态。已关闭保存：请重新加载当前状态或手动处理。',
      enable: '启用',
      disable: '停用',
      cancel: '取消',
      working: '处理中…',
      readOnly: '不受插件列表管理',
      confirmDisable: '停用 {name}？使用此 profile 的所有会话都会关闭它。',
      disableNamed: '停用 {name}',
      enableNamed: '启用 {name}',
      doneApplied: '{name}：已保存，宿主已应用。连接状态单独显示。',
      doneRestart: '{name}：已保存。请重启 DSH 使其生效。{reason}',
      doneOverridden: '{name}：已保存，但被更高优先级的配置覆盖，当前未生效。',
      doneNoChange: '{name}：已经是该状态。',
      failedToggle: '{name}：无法更改（{code}）。',
      reasonNoHmr: '这个 profile 只在启动时应用更改。',
      reasonPackageMoved: '该插件包现在解析到了另一个目录。',
      reasonHostModule: '更改涉及 DSH 自身已加载的模块。',
      reasonUnmanagedPlugin: '更改涉及一个不受插件列表管理的插件。',
      reasonModuleComparison: 'DSH 无法将已加载的插件与磁盘上的文件进行比较。',
    };

    // ---------------------------------------------------------------- data

    /**
     * `include:mcp-playwright` -> `playwright`. The loader reports rows mounted
     * through a bundle as `include:<rowId>`; other ids are shown as-is.
     */
    function displayName(entryId) {
      const rowId = entryId.startsWith(INCLUDE_PREFIX) && entryId.length > INCLUDE_PREFIX.length
        ? entryId.slice(INCLUDE_PREFIX.length)
        : entryId;
      return rowId.startsWith(ENTRY_PREFIX) && rowId.length > ENTRY_PREFIX.length
        ? rowId.slice(ENTRY_PREFIX.length)
        : rowId;
    }

    /**
     * Global rows: keep only MCP-client entries and copy the four safe fields.
     * Everything else on the host object is dropped on purpose.
     */
    function globalRows(plugins, bundles) {
      const bundleOf = new Map();
      for (const bundle of Array.isArray(bundles) ? bundles : []) {
        for (const row of Array.isArray(bundle?.rows) ? bundle.rows : []) {
          if (typeof row?.entryId === 'string' && typeof bundle.name === 'string') bundleOf.set(row.entryId, bundle.name);
        }
      }
      return (Array.isArray(plugins) ? plugins : [])
        .filter((p) => p && MCP_MODULES.includes(p.moduleName) && typeof p.entryId === 'string')
        .map((p) => ({
          id: p.entryId,
          name: displayName(p.entryId),
          enabled: p.enabled !== false,
          phase: PHASES.includes(p.fiberPhase) ? p.fiberPhase : null,
          bundle: bundleOf.get(p.entryId) ?? null,
          // Rows the host cannot address (management-required / unaddressable) cannot be toggled.
          readOnly: typeof p.readOnlyReason === 'string',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    /**
     * Role store: name + transport + the roles that list the server. The whole
     * server object is never copied — only `transport` is read from it.
     * Orchestrator mounts are unsupported by the role schema, so it is skipped.
     */
    function roleRows(doc, base) {
      if (!isObject(doc)) return [];
      const servers = isObject(doc.mcpServers) ? doc.mcpServers : {};
      // Mirrors oh-my-dsh-slim preset/config.js (loadConfig -> selectUserRoles -> mergeRole).
      // The backend reads the settings value as the user document and the BASE layer
      // (shipped defaults) as the default preset:
      //   userRoles = { ...presets[preset], ...roles }   // roles[r] replaces presets[preset][r] whole
      //   mcps = advanced.roles[r].mcps ?? userRoles[r].mcps ?? defaultPreset[r].mcps ?? []
      // so roles[r] = {} does NOT fall back to the user's presets[preset][r].mcps; it falls
      // back to the shipped default preset's list.
      const preset = doc.preset ?? base?.preset;
      const userPreset = isObject(doc.presets?.[preset]) ? doc.presets[preset] : {};
      const basePresets = isObject(base?.presets) ? base.presets : {};
      const defaultPreset = isObject(basePresets[preset]) ? basePresets[preset] : isObject(basePresets[base?.preset]) ? basePresets[base.preset] : {};
      const userRoles = { ...userPreset, ...(isObject(doc.roles) ? doc.roles : {}) };
      const advancedRoles = isObject(doc.advanced?.roles) ? doc.advanced.roles : {};
      const roleIds = new Set([...Object.keys(defaultPreset), ...Object.keys(userRoles), ...Object.keys(advancedRoles)]);
      const usedBy = new Map();
      for (const roleId of roleIds) {
        if (roleId === 'orchestrator') continue;
        const pick = [advancedRoles[roleId]?.mcps, userRoles[roleId]?.mcps, defaultPreset[roleId]?.mcps].find((v) => v !== undefined);
        const list = Array.isArray(pick) ? pick : [];
        for (const name of list) {
          if (typeof name !== 'string') continue;
          usedBy.set(name, [...(usedBy.get(name) ?? []), roleId]);
        }
      }
      return Object.keys(servers).sort().map((name) => ({
        name,
        transport: typeof servers[name]?.transport === 'string' ? servers[name].transport : null,
        roles: (usedBy.get(name) ?? []).sort(),
      }));
    }

    // ---------------------------------------------------------------- connection status helpers (pure)

    /** Epoch milliseconds from a finite positive number or an ISO-like string; anything else is null. */
    function toMs(value) {
      const ms = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 64 ? Date.parse(value) : NaN;
      return Number.isFinite(ms) && ms > 0 && Number.isFinite(new Date(ms).getTime()) ? ms : null;
    }

    /**
     * Strictly validates the owner `status` answer. Returns `{ ok: false }` for anything that is not
     * `{ ok: true, observedAt, entries: [...] }`. Entries are kept by exact local id; an invalid entry
     * (unknown state, bad time, wrong types, `disposed`, duplicate id) is dropped, so its row reads
     * Unknown. Only bounded fields are copied: server names, messages and details are never kept.
     */
    function parseStatus(response) {
      const outcome = unwrapEditor(response);
      if (!outcome.ok || outcome.value.ok !== true) return { ok: false };
      const observedAt = toMs(outcome.value.observedAt);
      if (observedAt === null || !Array.isArray(outcome.value.entries)) return { ok: false };
      const seen = new Set();
      const dropped = new Set();
      const entries = new Map();
      for (const e of outcome.value.entries) {
        if (!isObject(e) || typeof e.id !== 'string' || e.id.length === 0) continue;
        if (seen.has(e.id)) { dropped.add(e.id); continue; }
        seen.add(e.id);
        const changedAt = toMs(e.changedAt);
        const retryAt = e.retryAt === undefined ? undefined : toMs(e.retryAt);
        const attemptOk = e.attempt === undefined || (Number.isInteger(e.attempt) && e.attempt >= 0 && e.attempt <= 1e6);
        if (typeof e.serverName !== 'string' || !CONN_STATES.includes(e.state) || changedAt === null || retryAt === null || !attemptOk) { dropped.add(e.id); continue; }
        if (e.reasonCode !== undefined && typeof e.reasonCode !== 'string') { dropped.add(e.id); continue; }
        // Only the backend's fixed code list maps to its own message; any other string is a generic "reason reported".
        const reason = typeof e.reasonCode === 'string' && e.reasonCode.length > 0 ? (Object.hasOwn(REASON_CODES, e.reasonCode) ? e.reasonCode : 'other') : undefined;
        entries.set(e.id, { state: e.state, changedAt, attempt: e.attempt, retryAt, reason });
      }
      for (const id of dropped) entries.delete(id);
      return { ok: true, observedAt, entries };
    }

    /**
     * What one row shows. `status` is `{ entries: Map | null, observedAt: number | null }`:
     * `entries === null` means the last request failed (or none succeeded yet), and `observedAt` is
     * then the last time a valid answer WAS observed. A disabled row, or an id the backend did not
     * name exactly (after the `include:` strip), is Unknown: nothing is inferred from the plugin phase.
     */
    function connectionOf(row, status) {
      if (!row.enabled) return { state: 'unknown' };
      if (status.entries === null) return status.observedAt === null ? { state: 'unknown' } : { state: 'unknown', lastObservedAt: status.observedAt };
      const entry = status.entries.get(localId(row.id));
      // The backend reports a missing/disposed record as `unknown` with changedAt = the snapshot time:
      // that is not a real change, so an Unknown row carries no change time, attempt, retry or reason.
      if (entry === undefined || entry.state === 'unknown') return { state: 'unknown', observedAt: status.observedAt };
      return { ...entry, observedAt: status.observedAt };
    }

    function formatTime(ms, tag) {
      try { return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(ms)); } catch (_error) { return new Date(ms).toISOString(); }
    }

    // ---------------------------------------------------------------- editor helpers (pure)

    const EDIT_FIELDS = ['command', 'args', 'cwd', 'toolCallTimeoutMs'];
    const EDIT_CHANNEL = '/integrations-editor';
    const EDIT_CODES = ['INVALID_REQUEST', 'RESTART_REQUIRED', 'CONFLICT', 'UNKNOWN_SERVER', 'PROTECTED_FIELD', 'INVALID_DOCUMENT', 'AMBIGUOUS_ID', 'UNSUPPORTED_DOCUMENT', 'UNSAFE_PATH', 'UNAVAILABLE', 'ACTIVATION_ROLLED_BACK', 'RECOVERY_UNCERTAIN', 'FORBIDDEN'];
    const MAX_ARGS = 128;
    const MAX_TEXT = 4096;
    const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

    /** The global list id is `include:mcp-x`; the backend knows `mcp-x`. Exact prefix strip, nothing else. */
    function localId(rowId) {
      return typeof rowId === 'string' && rowId.startsWith(INCLUDE_PREFIX) ? rowId.slice(INCLUDE_PREFIX.length) : rowId;
    }

    /**
     * Reduces a host RPC answer to `{ ok: true, value }` or `{ ok: false, code, effects? }`.
     * Only whitelisted codes survive: backend messages and details are never copied.
     */
    function unwrapEditor(response) {
      const outer = response?.ok === true ? response : response?.result?.ok === true ? response.result : null;
      if (outer === null) {
        const code = response?.error?.code ?? response?.result?.error?.code;
        return { ok: false, code: code === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAVAILABLE' };
      }
      const value = outer.value;
      if (!isObject(value)) return { ok: false, code: 'UNAVAILABLE' };
      if (value.ok !== true) {
        const code = EDIT_CODES.includes(value.code) ? value.code : 'UNAVAILABLE';
        return value.effects === 'uncertain' ? { ok: false, code, effects: 'uncertain' } : { ok: false, code };
      }
      return { ok: true, value };
    }

    /** Draft text for each field the backend provided (and only those). */
    function draftFrom(entry) {
      const draft = {};
      const f = entry.fields;
      if (typeof f.command === 'string') draft.command = f.command;
      if (Array.isArray(f.args)) draft.args = JSON.stringify(f.args, null, 2);
      if (typeof f.cwd === 'string') draft.cwd = f.cwd;
      if (typeof f.toolCallTimeoutMs === 'number') draft.toolCallTimeoutMs = String(f.toolCallTimeoutMs);
      return draft;
    }

    /** Exact JSON array of strings: no shell parsing, no trimming, empty strings kept. */
    function parseArgs(text) {
      let parsed;
      try { parsed = JSON.parse(text); } catch (_error) { return { error: 'errArgsJson' }; }
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return { error: 'errArgsShape' };
      if (parsed.length > MAX_ARGS) return { error: 'errArgsCount' };
      if (parsed.some((item) => item.length > MAX_TEXT)) return { error: 'errTextLength' };
      return { value: parsed };
    }

    /** `errors` maps field -> message key; `patch` holds ONLY fields whose value differs from the loaded one. */
    function checkDraft(entry, draft) {
      const errors = {};
      const patch = {};
      for (const key of EDIT_FIELDS) {
        if (!(key in entry.fields) || !(key in draft)) continue;
        const text = draft[key];
        let next;
        if (key === 'args') {
          const r = parseArgs(text);
          if (r.error) { errors[key] = r.error; continue; }
          next = r.value;
        } else if (key === 'toolCallTimeoutMs') {
          // Native schema and backend both accept any finite number: no invented minimum or integer rule.
          const n = Number(text.trim());
          if (!JSON_NUMBER.test(text.trim()) || !Number.isFinite(n)) { errors[key] = 'errTimeout'; continue; }
          next = n;
        } else {
          if (text.length > MAX_TEXT) { errors[key] = 'errTextLength'; continue; }
          if (key === 'command' && text.length === 0) { errors[key] = 'errCommandEmpty'; continue; }
          next = text;
        }
        if (JSON.stringify(next) !== JSON.stringify(entry.fields[key])) patch[key] = next;
      }
      return { errors, patch };
    }

    // ---------------------------------------------------------------- view

    const CSS = `
.dlm-page { container-type: inline-size; box-sizing: border-box; height: 100%; overflow: auto; padding: 28px 32px 40px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; }
.dlm-wrap { max-width: 760px; margin: 0 auto; }
.dlm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dlm-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -.01em; }
.dlm-dim { color: var(--dsw-alias-label-secondary); }
.dlm-intro { margin: 4px 0 0; }
.dlm-section { margin-top: 28px; }
.dlm-section-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-secondary); }
.dlm-count { font-variant-numeric: tabular-nums; padding: 0 7px; border-radius: 999px; border: .5px solid var(--dsw-alias-border-l4); font-size: 12px; letter-spacing: 0; text-transform: none; }
.dlm-hint { margin: 6px 0 12px; font-size: 13px; }
.dlm-list { list-style: none; margin: 0; padding: 0; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dlm-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; min-width: 0; transition: background-color .15s ease; }
.dlm-item + .dlm-item { border-top: .5px solid var(--dsw-alias-border-l4); }
.dlm-item:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.dlm-main { flex: 1 1 auto; min-width: 0; }
.dlm-name { font-weight: 600; overflow-wrap: anywhere; }
.dlm-meta { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 2px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.dlm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dlm-pill { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 12px; border: .5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dlm-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .7; }
.dlm-pill[data-phase='active']::before { opacity: 1; }
.dlm-pill[data-phase='failed'] { color: #d4483b; border-color: color-mix(in srgb, #d4483b 45%, transparent); background: color-mix(in srgb, #d4483b 10%, transparent); }
.dlm-conn { height: 20px; padding: 0 8px; margin-inline-start: 2px; vertical-align: baseline; }
.dlm-conn[data-conn='connected'] { color: #23844f; border-color: color-mix(in srgb, #23844f 45%, transparent); background: color-mix(in srgb, #23844f 10%, transparent); }
.dlm-conn[data-conn='connected']::before, .dlm-conn[data-conn='retrying']::before, .dlm-conn[data-conn='error']::before, .dlm-conn[data-conn='connecting']::before { opacity: 1; }
.dlm-conn[data-conn='retrying'] { color: #a8630a; border-color: color-mix(in srgb, #a8630a 45%, transparent); background: color-mix(in srgb, #a8630a 10%, transparent); }
.dlm-conn[data-conn='error'] { color: #d4483b; border-color: color-mix(in srgb, #d4483b 45%, transparent); background: color-mix(in srgb, #d4483b 10%, transparent); }
.dlm-btn { flex: none; height: 30px; padding: 0 12px; border-radius: var(--dsw-radius-md, 8px); border: .5px solid var(--dsw-alias-border-l4); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; transition: border-color .15s ease, background-color .15s ease; }
.dlm-btn:hover { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); }
.dlm-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dlm-btn:disabled, .dlm-btn[aria-disabled='true'] { opacity: .5; cursor: not-allowed; }
.dlm-btn[aria-disabled='true']:hover { border-color: var(--dsw-alias-border-l4); background: transparent; }
.dlm-item-global { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 16px; }
.dlm-side { display: flex; align-items: center; gap: 12px; }
.dlm-side .dlm-pill { min-width: 124px; justify-content: center; }
.dlm-actions { display: flex; align-items: center; gap: 8px; }
.dlm-toggle { min-width: 84px; }
.dlm-btn[data-danger] { border-color: color-mix(in srgb, #d4483b 55%, transparent); color: #d4483b; }
.dlm-btn[data-danger]:hover { background: color-mix(in srgb, #d4483b 10%, transparent); border-color: #d4483b; }
.dlm-confirm { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 10px; font-size: 13px; }
.dlm-editor { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 12px; margin-top: 12px; padding: 14px; min-width: 0; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px); background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); font-size: 13px; }
.dlm-editor-title { font-weight: 600; }
.dlm-fieldnote { margin: 0; font-size: 12.5px; }
.dlm-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dlm-label { font-size: 12.5px; font-weight: 600; }
.dlm-input { box-sizing: border-box; width: 100%; min-width: 0; padding: 6px 9px; border-radius: var(--dsw-radius-md, 8px); border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 18px; }
.dlm-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dlm-input[readonly] { opacity: .7; }
.dlm-input[aria-invalid='true'] { border-color: #d4483b; }
.dlm-textarea { resize: vertical; white-space: pre; overflow: auto; }
.dlm-fielderr { color: #d4483b; }
.dlm-locked { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dlm-locked li { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; }
.dlm-callout { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; margin: 0; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px); border: .5px solid var(--dsw-alias-border-l4); }
.dlm-callout[data-kind='error'] { border-color: color-mix(in srgb, #d4483b 55%, transparent); background: color-mix(in srgb, #d4483b 8%, transparent); }
.dlm-callout[data-code='RECOVERY_UNCERTAIN'] { border-width: 1px; border-color: #d4483b; font-weight: 600; }
.dlm-editor-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dlm-primary { border-color: var(--dsw-alias-state-business-primary); }
.dlm-notice { margin: 12px 0; padding: 9px 12px; border-radius: var(--dsw-radius-md, 8px); border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); font-size: 13px; }
.dlm-notice[data-kind='error'] { border-color: color-mix(in srgb, #d4483b 55%, transparent); }
.dlm-state { padding: 18px 14px; border: .5px dashed var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dlm-note { margin-top: 24px; font-size: 12.5px; }
@media (max-width: 560px) {
  .dlm-page { padding: 20px 14px 32px; }
  .dlm-item { flex-wrap: wrap; }
  .dlm-main { flex-basis: 100%; }
}
/* Global rows: below this width the whole pill + actions block drops under the text in EVERY row. */
@container (max-width: 640px) {
  .dlm-item-global { grid-template-columns: minmax(0, 1fr); row-gap: 10px; }
  .dlm-side { justify-content: flex-start; flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) { .dlm-item, .dlm-btn { transition: none; } }
`;

    function installCss() {
      if (typeof document === 'undefined' || !document.head) return () => {};
      let node = document.head.querySelector('style[data-dlm-css]');
      if (!node) {
        node = document.createElement('style');
        node.setAttribute('data-dlm-css', '');
        node.textContent = CSS;
        document.head.appendChild(node);
      }
      return () => { node.remove(); };
    }

    /** Own glyph (currentColor): host icon names differ per generation. */
    function PanelIcon({ size }) {
      const px = typeof size === 'number' ? size : 20;
      return h('svg', { width: px, height: px, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 3.5, width: 14, height: 5, rx: 1.5 }),
        h('rect', { x: 3, y: 11.5, width: 14, height: 5, rx: 1.5 }),
        h('path', { d: 'M6 6h.01M6 14h.01' }));
    }

    const CONN_KEY = { unknown: 'connectionUnknown', connecting: 'connConnecting', connected: 'connConnected', disconnected: 'connDisconnected', retrying: 'connRetrying', error: 'connError' };
    const PHASE_KEY = { failed: 'phaseFailed', pending: 'phasePending', active: 'phaseActive', loading: 'phaseLoading', unloading: 'phaseUnloading' };

    function Section({ title, count, hint, children }) {
      return h('section', { className: 'dlm-section' },
        h('h2', { className: 'dlm-section-title' }, title, count === undefined ? null : h('span', { className: 'dlm-count' }, String(count))),
        h('p', { className: 'dlm-hint dlm-dim' }, hint),
        children);
    }

    const REASON_KEY = {
      'no-hmr': 'reasonNoHmr', 'package-moved': 'reasonPackageMoved', 'host-module': 'reasonHostModule',
      'unmanaged-plugin': 'reasonUnmanagedPlugin', 'module-comparison': 'reasonModuleComparison',
    };

    /**
     * One global server. Status is two separate facts: the PLUGIN lifecycle (known) and the
     * CONNECTION (always Unknown: the host reports no MCP reachability). Disabling is
     * disruptive, so it needs an inline confirmation; enabling does not.
     */
    function GlobalItem({ row, t, onOpen, busy, confirming, onAsk, onCancel, onToggle, editor, editing, onEdit, onCloseEdit, dirtyRef, discarding, onKeep, onDiscard, conn }) {
      const phaseLabel = row.enabled ? t(row.phase === null ? 'phaseNone' : PHASE_KEY[row.phase]) : t('disabled');
      // Times use the UI language; the same strings are what a screen reader gets.
      const tag = t('localeTag');
      const at = (ms) => formatTime(ms, tag);
      const detailBits = [];
      if (conn.state === 'connected') detailBits.push(t('connConnectedNote'));
      if (conn.observedAt !== undefined) detailBits.push(t('connObserved', { time: at(conn.observedAt) }));
      if (conn.lastObservedAt !== undefined) detailBits.push(t('connLastObserved', { time: at(conn.lastObservedAt) }));
      if (conn.changedAt !== undefined) detailBits.push(t('connChanged', { time: at(conn.changedAt) }));
      if (conn.attempt !== undefined && conn.state !== 'connected') detailBits.push(t('connAttempt', { n: conn.attempt }));
      if (conn.retryAt !== undefined && conn.state === 'retrying') detailBits.push(t('connRetryAt', { time: at(conn.retryAt) }));
      if (conn.reason !== undefined && conn.state !== 'connected' && conn.state !== 'unknown') detailBits.push(t(conn.reason === 'other' ? 'connReason' : 'connReason_' + conn.reason));
      const toggleRef = React.useRef(null);
      const cancelRef = React.useRef(null);
      const wasConfirming = React.useRef(false);
      const editRef = React.useRef(null);
      const wasEditing = React.useRef(false);
      React.useEffect(() => {
        if (wasEditing.current && !editing && (document.activeElement === document.body || document.activeElement === null)) editRef.current?.focus();
        wasEditing.current = editing;
      }, [editing]);
      const messageId = 'dlm-confirm-' + row.id;
      // Inline, NON-modal confirmation (the rest of the page stays usable, so no aria-modal and
      // no Tab trap). Focus: opening lands on the safe Cancel; closing returns to the row's own
      // action button, but only when focus would otherwise be lost to <body>.
      React.useEffect(() => {
        if (confirming) cancelRef.current?.focus();
        else if (wasConfirming.current && (document.activeElement === document.body || document.activeElement === null)) toggleRef.current?.focus();
        wasConfirming.current = confirming;
      }, [confirming]);
      // While busy the buttons stay focusable (aria-disabled, not disabled) so focus is not dropped.
      const busyProps = busy ? { 'aria-disabled': 'true' } : {};
      const guard = (fn) => () => { if (!busy) fn(); };
      const toggle = row.readOnly
        ? h('span', { className: 'dlm-meta' }, t('readOnly'))
        : row.enabled
          ? h('button', { ref: toggleRef, type: 'button', className: 'dlm-btn dlm-toggle', 'data-danger': '', 'aria-label': t('disableNamed', { name: row.name }), 'aria-expanded': confirming ? 'true' : 'false', 'aria-controls': confirming ? messageId + '-box' : undefined, ...busyProps, onClick: guard(() => onAsk(row.id)) }, t('disable'))
          : h('button', { ref: toggleRef, type: 'button', className: 'dlm-btn dlm-toggle', 'aria-label': t('enableNamed', { name: row.name }), ...busyProps, onClick: guard(() => onToggle(row, true)) }, busy ? t('working') : t('enable'));
      // Escape dismisses from anywhere in the row while the confirmation is open (Cancel, the
      // confirm button, or the row's own trigger after Shift+Tab). Ignored while busy.
      const onRowKey = confirming ? (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onCancel(); } } : undefined;
      return h('li', { className: 'dlm-item dlm-item-global', 'data-testid': 'global-' + row.id, onKeyDown: onRowKey },
        h('div', { className: 'dlm-main' },
          h('div', { className: 'dlm-name' }, row.name),
          h('div', { className: 'dlm-meta' },
            h('span', { className: 'dlm-mono' }, row.id),
            row.bundle === null ? null : h('span', null, t('bundle') + ': ' + row.bundle),
            h('span', { 'data-testid': 'connection-' + row.id }, t('connection') + ': ',
              h('span', { className: 'dlm-pill dlm-conn', 'data-conn': conn.state, 'data-testid': 'connstate-' + row.id }, t(CONN_KEY[conn.state])))),
          detailBits.length === 0 ? null : h('div', { className: 'dlm-meta', 'data-testid': 'conndetail-' + row.id },
            detailBits.map((bit, i) => h('span', { key: i }, bit)))),
        h('div', { className: 'dlm-side' },
          h('span', { className: 'dlm-pill', 'data-phase': row.enabled ? (row.phase ?? 'none') : 'disabled', title: t('lifecycle') }, phaseLabel),
          h('div', { className: 'dlm-actions' },
            row.readOnly ? null : h('button', {
              ref: editRef, type: 'button', className: 'dlm-btn', 'data-testid': 'edit-' + row.id, 'aria-label': t('editNamed', { name: row.name }),
              'aria-expanded': editing ? 'true' : 'false', 'aria-controls': editing ? 'dlm-edit-' + localId(row.id) : undefined,
              ...(busy || !editor ? { 'aria-disabled': 'true' } : {}), title: editor ? undefined : t('editorUnavailable'),
              onClick: () => { if (!busy && editor) (editing ? onCloseEdit : onEdit)(row.id); },
            }, t('edit')),
            toggle,
            row.bundle === null ? null : h('button', { type: 'button', className: 'dlm-btn', onClick: () => onOpen(row.bundle) }, t('openSettings')))),
        confirming
          ? h('div', {
            id: messageId + '-box', className: 'dlm-confirm', role: 'alertdialog', 'aria-labelledby': messageId, 'aria-busy': busy ? 'true' : undefined,
          },
            h('span', { id: messageId }, t('confirmDisable', { name: row.name })),
            h('button', { type: 'button', className: 'dlm-btn', 'data-danger': '', ...busyProps, onClick: guard(() => onToggle(row, false)) }, busy ? t('working') : t('disable')),
            h('button', { ref: cancelRef, type: 'button', className: 'dlm-btn', ...busyProps, onClick: guard(onCancel) }, t('cancel')))
          : null,
        editing ? h(EditorPanel, { row, t, editor, onClose: onCloseEdit, dirtyRef, discarding, onKeep, onDiscard }) : null);
    }

    const FIELD_LABEL = { command: 'fieldCommand', args: 'fieldArgs', cwd: 'fieldCwd', toolCallTimeoutMs: 'fieldTimeout' };
    const RELOAD_CODES = ['CONFLICT', 'UNKNOWN_SERVER', 'UNAVAILABLE', 'RECOVERY_UNCERTAIN', 'ACTIVATION_ROLLED_BACK'];

    /**
     * Inline editor for ONE server. Mounted only after an explicit Edit click, so nothing is read
     * on page load; unmounting (Cancel, Escape, another row) discards the draft. The draft lives
     * only here. Save sends the changed fields plus the revision that describe returned.
     */
    function EditorPanel({ row, t, editor, onClose, dirtyRef, discarding, onKeep, onDiscard }) {
      const serverId = localId(row.id);
      const base = 'dlm-edit-' + serverId;
      const [view, setView] = React.useState({ status: 'loading' }); // loading | unavailable | missing | ready
      const [snap, setSnap] = React.useState(null); // { revision, entry }
      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [result, setResult] = React.useState(null); // { kind, key, code?, reload }
      const [locked, setLocked] = React.useState(false); // RECOVERY_UNCERTAIN: no more saves until a fresh describe
      const firstRef = React.useRef(null);
      const generation = React.useRef(0);

      const describe = React.useCallback(async (keep) => {
        const mine = ++generation.current;
        if (!keep) setView({ status: 'loading' });
        let outcome;
        try { outcome = editor ? unwrapEditor(await editor.describe()) : { ok: false, code: 'UNAVAILABLE' }; } catch (_error) { outcome = { ok: false, code: 'UNAVAILABLE' }; }
        if (mine !== generation.current) return;
        if (!outcome.ok) { setView({ status: 'unavailable', code: outcome.code }); return; }
        const entries = Array.isArray(outcome.value.entries) ? outcome.value.entries : [];
        const entry = entries.find((e) => isObject(e) && e.id === serverId && isObject(e.fields) && Array.isArray(e.protectedFields));
        if (typeof outcome.value.revision !== 'string' || entry === undefined) { setView({ status: 'missing' }); return; }
        setSnap({ revision: outcome.value.revision, entry });
        setDraft(draftFrom(entry));
        setLocked(false);
        setView({ status: 'ready' });
      }, [editor, serverId]);

      React.useEffect(() => { describe(false); return () => { generation.current += 1; }; }, [describe]);
      React.useEffect(() => { if (view.status === 'ready') firstRef.current?.focus(); }, [view.status]);

      const entry = snap?.entry;
      const checked = entry ? checkDraft(entry, draft) : { errors: {}, patch: {} };
      const dirty = Object.keys(checked.patch).length > 0;
      const invalid = Object.keys(checked.errors).length > 0;
      const editable = !!entry && entry.canSave === true && !locked;
      const canSubmit = editable && dirty && !invalid && !saving;
      dirtyRef.current = dirty;
      const keepRef = React.useRef(null);
      React.useEffect(() => { if (discarding) keepRef.current?.focus(); }, [discarding]);
      React.useEffect(() => () => { dirtyRef.current = false; }, [dirtyRef]);

      const reload = () => { setResult(null); describe(false); };

      const save = async () => {
        if (!canSubmit) return;
        setSaving(true);
        setResult(null);
        let outcome;
        try { outcome = unwrapEditor(await editor.mutate({ serverId, expectedRevision: snap.revision, patch: checked.patch })); } catch (_error) { outcome = { ok: false, code: 'UNAVAILABLE' }; }
        setSaving(false);
        if (outcome.ok) {
          const changed = outcome.value.changed === true;
          setResult({ kind: 'info', key: changed ? 'saveApplied' : 'saveNoChange', reload: false });
          // Re-read so the next save is fenced by the revision that is now on disk.
          await describe(true);
          return;
        }
        if (outcome.code === 'RECOVERY_UNCERTAIN') setLocked(true);
        setResult({ kind: 'error', key: 'editErr_' + outcome.code, code: outcome.code, reload: RELOAD_CODES.includes(outcome.code) });
      };

      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (saving) return; if (discarding) onKeep(); else onClose(); } };
      const set = (key) => (e) => { setDraft((d) => ({ ...d, [key]: e.target.value })); setResult(null); };

      const field = (key, index) => {
        const id = base + '-' + key;
        const err = checked.errors[key];
        const common = {
          id, value: draft[key], onChange: set(key), readOnly: !editable, 'aria-invalid': err ? 'true' : undefined,
          'aria-describedby': err ? id + '-err' : key === 'args' ? id + '-hint' : undefined, className: 'dlm-input', ref: index === 0 ? firstRef : undefined, spellCheck: false, autoComplete: 'off',
        };
        const control = key === 'args'
          ? h('textarea', { ...common, rows: Math.min(10, Math.max(3, (draft.args ?? '').split('\n').length)), className: 'dlm-input dlm-textarea', wrap: 'off' })
          : h('input', { ...common, type: 'text', inputMode: key === 'toolCallTimeoutMs' ? 'numeric' : undefined });
        return h('div', { className: 'dlm-field', key },
          h('label', { htmlFor: id, className: 'dlm-label' }, t(FIELD_LABEL[key])),
          control,
          key === 'args' ? h('p', { id: id + '-hint', className: 'dlm-fieldnote dlm-dim' }, t('argsHint')) : null,
          err ? h('p', { id: id + '-err', className: 'dlm-fieldnote dlm-fielderr' }, t(err)) : null);
      };

      let body;
      if (view.status === 'loading') body = h('p', { className: 'dlm-dim', role: 'status' }, t('editorLoading'));
      else if (view.status === 'unavailable') body = h('p', { className: 'dlm-dim', role: 'status', 'data-testid': 'editor-unavailable' }, t(view.code === 'FORBIDDEN' ? 'editErr_FORBIDDEN' : 'editorUnavailable'));
      else if (view.status === 'missing') body = h('p', { className: 'dlm-dim', role: 'status', 'data-testid': 'editor-missing' }, t('editorMissing'));
      else {
        const shown = EDIT_FIELDS.filter((k) => k in entry.fields);
        const hidden = EDIT_FIELDS.filter((k) => !(k in entry.fields));
        body = h(React.Fragment, null,
          entry.canSave === true ? null : h('p', { className: 'dlm-callout', 'data-testid': 'editor-gate', role: 'status' }, t('gateInactive')),
          shown.map((k, i) => field(k, i)),
          hidden.length === 0 ? null : h('ul', { className: 'dlm-locked', 'data-testid': 'editor-locked' },
            hidden.map((k) => h('li', { key: k }, h('span', { className: 'dlm-label' }, t(FIELD_LABEL[k])), h('span', { className: 'dlm-dim' }, t('lockedField'))))),
          result === null ? null : h('div', {
            className: 'dlm-callout', 'data-kind': result.kind, 'data-code': result.code, role: result.kind === 'error' ? 'alert' : 'status', 'data-testid': 'editor-result',
          },
          h('span', null, t(result.key)),
          result.reload ? h('button', { type: 'button', className: 'dlm-btn', onClick: reload }, t(result.code === 'CONFLICT' ? 'reloadLatest' : 'reload')) : null),
          discarding ? h('div', { className: 'dlm-callout', role: 'alertdialog', 'aria-labelledby': base + '-discard', 'data-testid': 'editor-discard' },
            h('span', { id: base + '-discard' }, t('discardPrompt', { name: row.name })),
            h('span', { className: 'dlm-editor-actions' },
              h('button', { ref: keepRef, type: 'button', className: 'dlm-btn', onClick: onKeep }, t('keepEditing')),
              h('button', { type: 'button', className: 'dlm-btn', 'data-danger': '', 'data-testid': 'editor-discard-confirm', onClick: onDiscard }, t('discardChanges')))) : null,
          h('div', { className: 'dlm-editor-actions' },
            h('button', { type: 'button', className: 'dlm-btn dlm-primary', 'data-testid': 'editor-save', ...(canSubmit ? {} : { 'aria-disabled': 'true' }), onClick: save }, saving ? t('saving') : t('save')),
            h('button', { type: 'button', className: 'dlm-btn', 'data-testid': 'editor-cancel', ...(saving ? { 'aria-disabled': 'true' } : {}), onClick: () => { if (!saving) onClose(); } }, t('cancel')),
            !dirty && editable && !invalid ? h('span', { className: 'dlm-dim dlm-fieldnote' }, t('noChanges')) : null));
      }
      if (view.status !== 'ready') body = h(React.Fragment, null, body, h('div', { className: 'dlm-editor-actions' },
        h('button', { type: 'button', className: 'dlm-btn', 'data-testid': 'editor-cancel', onClick: onClose }, t('cancel')),
        view.status === 'loading' ? null : h('button', { type: 'button', className: 'dlm-btn', onClick: reload }, t('reload'))));

      return h('div', { id: base, className: 'dlm-editor', role: 'group', 'aria-labelledby': base + '-title', 'aria-busy': saving ? 'true' : undefined, 'data-testid': 'editor-' + serverId, onKeyDown: onKey },
        h('div', { id: base + '-title', className: 'dlm-editor-title' }, t('editorTitle') + ' · ' + row.name),
        h('p', { className: 'dlm-fieldnote dlm-dim' }, t('editorScope')),
        body);
    }

    function RoleItem({ row, t }) {
      return h('li', { className: 'dlm-item', 'data-testid': 'role-' + row.name },
        h('div', { className: 'dlm-main' },
          h('div', { className: 'dlm-name' }, row.name),
          h('div', { className: 'dlm-meta' },
            row.transport === null ? null : h('span', null, t('transport') + ': ' + row.transport),
            h('span', null, row.roles.length === 0 ? t('roleNotUsed') : t('usedBy') + ': ' + row.roles.join(', ')))));
    }

    function StateBox({ text, action }) {
      return h('div', { className: 'dlm-state dlm-dim' }, h('span', null, text), action ?? null);
    }

    /**
     * The page. `deps` is everything it may touch; on mount it performs the two
     * read-only list calls and nothing else.
     */
    function McpPage({ t, deps }) {
      const [globalState, setGlobalState] = React.useState({ status: 'loading', rows: [] });
      const [roleSnap, setRoleSnap] = React.useState(() => deps.roleSnapshot());
      const generation = React.useRef(0);
      const [confirmId, setConfirmId] = React.useState(null);
      const [editId, setEditId] = React.useState(null);
      const [pending, setPending] = React.useState(null); // action waiting for a discard decision
      const dirtyRef = React.useRef(false);
      // Anything that would close or replace the open editor goes through here: a dirty draft asks first.
      const guarded = (next) => { if (editId !== null && dirtyRef.current) setPending({ next }); else next(); };
      const [busyId, setBusyId] = React.useState(null);
      const [notice, setNotice] = React.useState(null);

      const load = React.useCallback(async () => {
        const mine = ++generation.current;
        setGlobalState((prev) => ({ status: 'loading', rows: prev.rows }));
        try {
          // The bundle map is optional (it only enables "Open settings"): a rejected or
          // synchronously throwing listBundles must not fail the global list.
          const optionalBundles = async () => { try { return await deps.listBundles(); } catch (_error) { return null; } };
          const [plugins, bundles] = await Promise.all([deps.listPlugins(), optionalBundles()]);
          if (mine !== generation.current) return;
          if (!plugins || plugins.ok !== true) { setGlobalState({ status: 'error', rows: [] }); return; }
          setGlobalState({ status: 'ready', rows: globalRows(plugins.value, bundles && bundles.ok === true ? bundles.value : []) });
        } catch (_error) {
          if (mine === generation.current) setGlobalState({ status: 'error', rows: [] });
        }
      }, [deps]);

      React.useEffect(() => {
        load();
        const off = deps.onChanged(load);
        return () => { generation.current += 1; off(); };
      }, [deps, load]);

      React.useEffect(() => deps.subscribeRoles(() => setRoleSnap(deps.roleSnapshot())), [deps]);

      // Connection status: read-only owner RPC, once on mount and every STATUS_POLL_MS while mounted.
      // One request at a time (a tick is skipped while one is pending) and a sequence number, so a
      // slow older answer can never replace a newer one, and nothing lands after unmount. A missing
      // or failed answer drops every row to Unknown but keeps the last honest observation time.
      const [status, setStatus] = React.useState({ entries: null, observedAt: null });
      const statusSeq = React.useRef(0);
      const statusBusy = React.useRef(false);
      const refreshStatus = React.useCallback(async () => {
        if (typeof deps.status !== 'function' || statusBusy.current) return;
        const mine = ++statusSeq.current;
        statusBusy.current = true;
        let parsed;
        let timer;
        // A request that never answers must not keep an old green pill: it counts as a failure.
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), STATUS_TIMEOUT_MS); });
        try { parsed = parseStatus(await Promise.race([Promise.resolve().then(() => deps.status()), timeout])); } catch (_error) { parsed = { ok: false }; }
        clearTimeout(timer);
        if (mine !== statusSeq.current) return; // unmounted or superseded: discard
        statusBusy.current = false;
        setStatus((prev) => (parsed.ok
          ? (prev.observedAt !== null && parsed.observedAt < prev.observedAt ? prev : { entries: parsed.entries, observedAt: parsed.observedAt })
          : { entries: null, observedAt: prev.observedAt }));
      }, [deps]);
      React.useEffect(() => {
        statusBusy.current = false;
        if (typeof deps.status !== 'function') return undefined; // no owner channel: nothing to poll
        refreshStatus();
        const timer = setInterval(refreshStatus, STATUS_POLL_MS);
        return () => { clearInterval(timer); statusSeq.current += 1; statusBusy.current = false; };
      }, [refreshStatus]);

      const roles = roleSnap.status === 'ready' ? roleRows(roleSnap.value, roleSnap.base) : [];

      // Explicit user action only. The host's own Plugins page calls the same method; it flips
      // `disabled` for this one entry and answers how it took effect. Nothing here claims a
      // connection: "applied" means the host recomposed, not that the server is reachable.
      const toggle = async (row, enabled) => {
        if (busyId !== null) return;
        setBusyId(row.id);
        let message;
        try {
          const result = await deps.setEnabled(row.id, enabled);
          const value = result && result.ok === true ? result.value : null;
          if (value === null || value.application === 'failed' || value.application === 'cancelled') {
            message = { kind: 'error', text: t('failedToggle', { name: row.name, code: String(value?.error?.code ?? 'request') }) };
          } else if (value.application === 'restart-required') {
            const key = REASON_KEY[value.restartReason];
            message = { kind: 'info', text: t('doneRestart', { name: row.name, reason: key === undefined ? '' : t(key) }).trim() };
          } else if (value.application === 'overridden') {
            message = { kind: 'info', text: t('doneOverridden', { name: row.name }) };
          } else {
            message = { kind: 'info', text: t(value.changed === false ? 'doneNoChange' : 'doneApplied', { name: row.name }) };
          }
        } catch (_error) {
          message = { kind: 'error', text: t('failedToggle', { name: row.name, code: 'request' }) };
        }
        setBusyId(null);
        setConfirmId(null);
        setNotice(message);
        // A toggle changes the connection under us: drop whatever was shown (the backend disposes or
        // restarts it) and ask again, instead of keeping a green pill from before the change.
        statusSeq.current += 1;
        statusBusy.current = false;
        setStatus((prev) => ({ entries: null, observedAt: prev.observedAt }));
        refreshStatus();
        load();
      };

      let globalBody;
      if (globalState.status === 'loading' && globalState.rows.length === 0) globalBody = h(StateBox, { text: t('loading') });
      else if (globalState.status === 'error') {
        globalBody = h(StateBox, { text: t('errorList'), action: h('button', { type: 'button', className: 'dlm-btn', onClick: load }, t('retry')) });
      } else if (globalState.rows.length === 0) globalBody = h(StateBox, { text: t('emptyGlobal') });
      else globalBody = h('ul', { className: 'dlm-list' }, globalState.rows.map((row) => h(GlobalItem, {
        key: row.id, row, t, conn: connectionOf(row, status), onOpen: deps.openBundle, busy: busyId === row.id,
        confirming: confirmId === row.id, onAsk: (id) => guarded(() => { setNotice(null); setEditId(null); setPending(null); setConfirmId(id); }), onCancel: () => setConfirmId(null), onToggle: toggle,
        editor: deps.editor, editing: editId === row.id, onEdit: (id) => guarded(() => { setNotice(null); setConfirmId(null); setPending(null); setEditId(id); }), onCloseEdit: () => guarded(() => { setPending(null); setEditId(null); }),
        dirtyRef, discarding: editId === row.id && pending !== null, onKeep: () => setPending(null), onDiscard: () => { const n = pending.next; setPending(null); dirtyRef.current = false; n(); },
      })));

      let roleBody;
      if (roleSnap.status === 'loading') roleBody = h(StateBox, { text: t('loading') });
      else if (roleSnap.status !== 'ready') roleBody = h(StateBox, { text: t('roleUnavailable') });
      else if (roles.length === 0) roleBody = h(StateBox, { text: t('emptyRole') });
      else roleBody = h('ul', { className: 'dlm-list' }, roles.map((row) => h(RoleItem, { key: row.name, row, t })));

      return h('div', { className: 'dlm-page', 'data-testid': 'mcp-page' },
        h('div', { className: 'dlm-wrap' },
          h('div', { className: 'dlm-head' },
            h('div', null,
              h('h1', { className: 'dlm-title' }, t('title')),
              h('p', { className: 'dlm-intro dlm-dim' }, t('intro'))),
            h('button', { type: 'button', className: 'dlm-btn', onClick: load, disabled: globalState.status === 'loading' }, t('refresh'))),
          notice === null ? null : h('p', { className: 'dlm-notice', role: 'status', 'data-kind': notice.kind, 'data-testid': 'notice' }, notice.text),
          h(Section, { title: t('globalTitle'), count: globalState.status === 'ready' ? globalState.rows.length : undefined, hint: t('globalHint') }, globalBody),
          h(Section, { title: t('roleTitle'), count: roleSnap.status === 'ready' ? roles.length : undefined, hint: t('roleHint') }, roleBody),
          h('p', { className: 'dlm-note dlm-dim' }, t('limitation'))));
    }

    // ---------------------------------------------------------------- host wiring

    const name = 'dsh-integrations';
    const inject = ['slots', 'locale', 'layout', 'connection', 'remote', 'remote.pluginManager', 'configForms', 'pluginNavigation'];

    function apply(ctx) {
      ctx.effect(installCss, 'dsh-integrations: styles');
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-integrations: dictionaries');
      const t = ctx.locale.bind(NS);
      const roleForm = ctx.configForms.get(ROLE_STORE);

      // Optional authenticated backend channel. Absent rpc => Edit shows as unavailable; the list is unaffected.
      const rpc = ctx.connection?.rpc;
      const editor = rpc && typeof rpc.call === 'function'
        ? {
          describe: () => rpc.call(EDIT_CHANNEL, 'describe', {}),
          mutate: (payload) => rpc.call(EDIT_CHANNEL, 'mutate', payload),
        }
        : undefined;

      const deps = {
        editor,
        // Same owner channel, read-only `status` endpoint. Absent rpc => no status => every row Unknown.
        status: rpc && typeof rpc.call === 'function' ? () => rpc.call(EDIT_CHANNEL, 'status', {}) : undefined,
        listPlugins: () => ctx.remote.pluginManager.listPlugins(),
        listBundles: () => ctx.remote.pluginManager.listBundles(),
        onChanged: (cb) => ctx.remote.$on('plugin-manager/changed', cb),
        openBundle: (packageName) => ctx.pluginNavigation.openBundle(packageName),
        setEnabled: (entryId, enabled) => ctx.remote.pluginManager.setPluginEnabled(entryId, enabled),
        roleSnapshot: () => {
          const snap = roleForm.getSnapshot();
          return { status: snap.status, value: snap.value, base: snap.base };
        },
        subscribeRoles: (cb) => roleForm.subscribe(cb),
      };
      // useSyncExternalStore-free: the page re-reads the snapshot on each notification.
      const page = () => h(McpPage, { t, deps });

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t }),
      }, page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 1,
        label: () => t('panel'),
        locale: NS,
      }, PanelIcon));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.PANEL_ID = PANEL_ID;
    exports.MCP_MODULE = MCP_MODULE;
    exports.localId = localId;
    exports.parseStatus = parseStatus;
    exports.connectionOf = connectionOf;
    exports.MCP_MODULES = MCP_MODULES;
    exports.STATUS_POLL_MS = STATUS_POLL_MS;
    exports.unwrapEditor = unwrapEditor;
    exports.checkDraft = checkDraft;
    exports.parseArgs = parseArgs;
    exports.displayName = displayName;
    exports.globalRows = globalRows;
    exports.roleRows = roleRows;
    exports.McpPage = McpPage;
    exports.PanelIcon = PanelIcon;
    exports.en = en;
    exports.zh = zh;
    return module.exports;
  },
});
