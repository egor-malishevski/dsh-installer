// Observation only: this module never starts or probes a connection.
const instances = new Map();
const states = new Set(['connecting', 'connected', 'disconnected', 'retrying', 'error']);
const reasons = new Set(['connection_lost', 'connection_failed', 'reconnect_disabled', 'retry_exhausted', 'close_unconfirmed']);
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value);

// The opaque token belongs to one supervisor. Replacing it revokes old callbacks.
export function begin(id, serverName) {
  if (typeof id !== 'string' || !safeName(serverName)) return undefined;
  const token = {};
  instances.set(id, { token, generation: undefined, serverName, state: 'connecting', changedAt: Date.now() });
  return token;
}

// Only the supervisor starts a generation; callbacks can only transition it.
export function beginGeneration(id, token) {
  try {
    const entry = instances.get(id);
    if (!entry || entry.token !== token) return undefined;
    const generation = {};
    entry.generation = generation;
    transition(id, token, generation, 'connecting');
    return generation;
  } catch { return undefined; }
}

export function transition(id, token, generation, state, details = {}) {
  try {
    const entry = instances.get(id);
    if (!entry || entry.token !== token || !states.has(state)) return false;
    if (!generation || entry.generation !== generation) return false;
    entry.state = state;
    entry.changedAt = Date.now();
    delete entry.attempt; delete entry.retryAt; delete entry.reasonCode;
    if (Number.isSafeInteger(details.attempt) && details.attempt > 0) entry.attempt = details.attempt;
    if (Number.isSafeInteger(details.retryAt) && details.retryAt >= 0) entry.retryAt = details.retryAt;
    if (reasons.has(details.reasonCode)) entry.reasonCode = details.reasonCode;
    return true;
  } catch { return false; }
}

export function dispose(id, token) {
  try { if (instances.get(id)?.token === token && token !== undefined) instances.delete(id); } catch {}
}

export function snapshot(rows) {
  const observedAt = Date.now();
  return { ok: true, observedAt, entries: rows.map(({ id, serverName }) => {
    const entry = instances.get(id);
    if (!entry || entry.serverName !== serverName) return { id, serverName, state: 'unknown', changedAt: observedAt };
    const { state, changedAt, attempt, retryAt, reasonCode } = entry;
    return { id, serverName, state, changedAt, ...(attempt === undefined ? {} : { attempt }), ...(retryAt === undefined ? {} : { retryAt }), ...(reasonCode === undefined ? {} : { reasonCode }) };
  }) };
}
