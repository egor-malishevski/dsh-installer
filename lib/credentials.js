// The current DSH credential editor parses this file as YAML and rejects a save when the
// version is read as a BigInt. JSON.stringify emits such a number, so the store must be YAML.
export function credentialDocument(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey || /[\0\r\n]/.test(apiKey)) throw new Error('Invalid credential.');
  return `version: 1\nrefs:\n  CLIPROXY_API_KEY: ${JSON.stringify(apiKey)}\n`;
}

// Convert only the exact JSON document this installer used to write. Every other store stays untouched.
export function yamlCredentialMigration(text) {
  if (typeof text !== 'string' || text.includes('\0')) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const refs = parsed.refs;
  if (parsed.version !== 1 || Object.keys(parsed).length !== 2 || !refs || typeof refs !== 'object' || Array.isArray(refs)) return null;
  const entries = Object.entries(refs);
  if (!entries.length || entries.some(([name, value]) => !/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string' || !value || /[\0\r\n]/.test(value))) return null;
  return `version: 1\nrefs:\n${entries.map(([name, value]) => `  ${name}: ${JSON.stringify(value)}`).join('\n')}\n`;
}
