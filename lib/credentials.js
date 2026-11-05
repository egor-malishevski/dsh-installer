// The current DSH credential editor parses this file as YAML and rejects a save when the
// version is read as a BigInt. JSON.stringify emits such a number, so the store must be YAML.
const forbidden = /\u0000/;

export function credentialDocument(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey || forbidden.test(apiKey)) throw new Error('Invalid credential.');
  return `version: 1\nrefs:\n  CLIPROXY_API_KEY: ${JSON.stringify(apiKey)}\n`;
}

function credentialRef(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function credentialValue(value) {
  return typeof value === 'string' && value.length > 0 && !forbidden.test(value);
}

function yamlRefs(refs) {
  const entries = Object.entries(refs);
  if (!entries.length || entries.some(([name, value]) => !credentialRef(name) || !credentialValue(value))) return null;
  return `version: 1\nrefs:\n${entries.map(([name, value]) => `  ${name}: ${JSON.stringify(value)}`).join('\n')}\n`;
}

// Convert only a JSON credential document current DSH can read but cannot save. YAML, comments,
// records, unknown fields, and every other document stay untouched.
export function yamlCredentialMigration(text) {
  if (typeof text !== 'string' || forbidden.test(text) || !text.trimStart().startsWith('{')) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) return null;
  const keys = Object.keys(parsed);
  if (keys.length === 2 && keys.includes('version') && parsed.refs && typeof parsed.refs === 'object' && !Array.isArray(parsed.refs)) return yamlRefs(parsed.refs);
  if (keys.length !== 3 || !keys.includes('version') || !keys.includes('refs') || !keys.includes('records')) return null;
  if (!parsed.refs || typeof parsed.refs !== 'object' || Array.isArray(parsed.refs)) return null;
  const records = parsed.records;
  if (!records || typeof records !== 'object' || Array.isArray(records) || Object.keys(records).length !== 0) return null;
  return yamlRefs(parsed.refs);
}
