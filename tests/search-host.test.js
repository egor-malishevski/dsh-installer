import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const electron = process.env.DSH_ELECTRON;
const anchor = process.env.DSH_PACKAGED_ANCHOR;
// Plain Node cannot inspect paths inside Electron's app.asar.
const available = electron && anchor && existsSync(electron);

test('packaged Electron loader imports and registers the fixed search provider', { skip: available ? false : 'DSH_ELECTRON and DSH_PACKAGED_ANCHOR must point to packaged host files' }, () => {
  const plugin = fileURLToPath(new URL('../payload/plugins/dsh-web-search-exa-parallel/lib/index.js', import.meta.url));
  const patch = readFileSync(fileURLToPath(new URL('../payload/plugins/dsh-web-search-exa-parallel/cordis.patch.yml', import.meta.url)), 'utf8');
  assert.match(patch, /searchProvider:\s*exa-parallel/);
  assert.match(patch, /fetchProvider:\s*http/);
  const program = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import assert from 'node:assert/strict';
    const [anchor, plugin] = process.argv.slice(1);
    const loader = createRequire(anchor)('@deepseek-ai/cordis-plugin-loader').ModuleLoader.fromInternal();
    const search = await loader.import(pathToFileURL(plugin).href, import.meta.url, {});
    assert.equal(search.name, 'dsh-web-search-exa-parallel');
    assert.deepEqual(search.inject, ['web']);
    assert.equal(search.Config, undefined);
    let registered;
    search.apply({ web: { registerSearchProvider(provider) { registered = provider; } } });
    assert.equal(registered.id, 'exa-parallel');
    assert.equal(registered.available(), true);
  `;
  const result = spawnSync(electron, ['--input-type=module', '-e', program, path.resolve(anchor), plugin], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
});
