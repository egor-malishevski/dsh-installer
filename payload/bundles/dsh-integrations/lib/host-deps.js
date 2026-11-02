import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

// Resolve as ESM from the exact packaged rc.5 client, not this local bundle.
const entry = (process.argv[1] ?? '').replaceAll('\\', '/');
const marker = '/resources/app.asar/';
const index = entry.toLowerCase().indexOf(marker);
const asar = index < 0 ? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar' : entry.slice(0, index + marker.length - 1);
const parent = pathToFileURL(asar + '/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js').href;
const metadata = JSON.parse(readFileSync(asar + '/dsh/node_modules/@deepseek-ai/dsh-mcp-client/package.json', 'utf8'));
if (metadata.version !== '0.2.1-rc.5') throw new Error('Unsupported packaged MCP client version');
const loader = createRequire(import.meta.url)('internal/modules/esm/loader').getOrInitializeCascadedLoader();
export const hostImport = specifier => import(loader.resolveSync(parent, { specifier, attributes: {} }).url);
