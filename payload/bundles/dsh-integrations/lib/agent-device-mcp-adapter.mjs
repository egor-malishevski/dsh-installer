#!/usr/bin/env node
// Stdio adapter around `agent-device mcp` (0.17.1).
// Problem: the server returns tools/call result.structuredContent as the raw command
// result (array/string/null), but MCP requires structuredContent to be a JSON object.
// Fix: only for response messages, if result.structuredContent is defined and not a
// plain object, replace it with {result: <value>}. Everything else passes through verbatim.
// Usage: node adapter.mjs <agent-device.mjs> [args...]   (e.g. ... mcp)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [cli, ...rest] = process.argv.slice(2);
if (!cli) { process.stderr.write('usage: adapter <agent-device.mjs> [args...]\n'); process.exit(2); }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function fix(m) {
  if (isObj(m) && isObj(m.result) && 'structuredContent' in m.result
      && m.result.structuredContent !== undefined && !isObj(m.result.structuredContent)) {
    return { ...m, result: { ...m.result, structuredContent: { result: m.result.structuredContent } } };
  }
  return m;
}
function transformLine(line) {
  if (!line.trim()) return line;
  try {
    const m = JSON.parse(line);
    if (Array.isArray(m)) return JSON.stringify(m.map(fix));
    const f = fix(m);
    return f === m ? line : JSON.stringify(f);
  } catch { return line; }
}

const child = spawn(process.execPath, [cli, ...rest], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
createInterface({ input: child.stdout, crlfDelay: Infinity })
  .on('line', (l) => process.stdout.write(transformLine(l) + '\n'));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('error', (e) => { process.stderr.write(`adapter spawn error: ${e.message}\n`); process.exit(1); });
child.on('close', (code, sig) => { setImmediate(() => process.exit(code ?? (sig ? 1 : 0))); });
