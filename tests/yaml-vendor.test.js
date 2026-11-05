import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const YAML = require('../lib/vendor/yaml/dist/index.js');
const metadata = require('../lib/vendor/yaml/package.json');

test('vendored yaml is pinned and includes its ISC license', async () => {
  assert.equal(metadata.version, '2.8.3');
  assert.equal(metadata.license, 'ISC');
  assert.equal(metadata.dependencies, undefined);
  const license = await readFile(new URL('../lib/vendor/yaml/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright Eemeli Aro/);
  assert.match(license, /Permission to use, copy, modify, and\/or distribute this software/);
});

test('unknown JavaScript tag warns and preserves scalar without executing it', () => {
  const doc = YAML.parseDocument('value: !!js/function "() => { throw new Error(\'executed\') }"\n', { keepSourceTokens: true });
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.warnings.length, 1);
  assert.match(doc.warnings[0].message, /Unresolved tag/);
  assert.equal(doc.toJS().value, "() => { throw new Error('executed') }");
});
