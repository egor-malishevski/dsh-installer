import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

// Match the installer's packaged rc.5 host dependency resolution.
const entry = (process.argv[1] ?? '').replaceAll('\\', '/');
const marker = '/resources/app.asar/';
const index = entry.toLowerCase().indexOf(marker);
const asar = index < 0 ? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar' : entry.slice(0, index + marker.length - 1);
const parent = pathToFileURL(asar + '/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js').href;
const metadata = JSON.parse(readFileSync(asar + '/dsh/node_modules/@deepseek-ai/dsh-mcp-client/package.json', 'utf8'));
if (metadata.version !== '0.2.1-rc.5') throw new Error('Unsupported packaged MCP client version');
const requireHost = createRequire(asar + '/dsh/package.json');
const loader = requireHost('@deepseek-ai/cordis-plugin-loader').ModuleLoader.fromInternal();
if (!loader) throw new Error('Packaged module loader unavailable');
export const hostImport = specifier => loader.import(specifier, parent, {});
