import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const script = readFileSync(new URL('../scripts/package.sh', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package uses root version and includes the recovery guide explicitly', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.match(script, /require\("\.\/package\.json"\)\.version/);
  assert.match(script, /cp docs\/update-recovery\.md "\$STAGE\/\$NAME\/docs\/"/);
  assert.match(script, /s\/\^VERSION=\.\*\/VERSION='\$VERSION'\//);
});

test('archive preserves vendored parser while excluding generated and secret files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-package-test-'));
  try {
    const root = new URL('../', import.meta.url);
    for (const path of ['scripts/package.sh', 'package.json', 'Install.command', 'server.js', 'README.md', 'lib', 'payload', 'docs/update-recovery.md', 'ui']) {
      const dest = join(temp, path);
      mkdirSync(join(dest, '..'), { recursive: true });
      cpSync(new URL(path, root), dest, { recursive: true });
    }
    writeFileSync(join(temp, 'install.sh'), "VERSION='old'\nSHA256='old'\n");
    mkdirSync(join(temp, 'lib/node_modules'), { recursive: true });
    writeFileSync(join(temp, 'lib/node_modules/secret.js'), 'excluded');
    writeFileSync(join(temp, 'lib/.env'), 'excluded');
    execFileSync('bash', ['scripts/package.sh'], { cwd: temp });
    const name = `dsh-installer-${pkg.version}`;
    const archive = join(temp, 'dist', `${name}.tar.gz`);
    const extract = join(temp, 'extract');
    mkdirSync(extract);
    execFileSync('tar', ['-xzf', archive, '-C', extract]);
    const vendor = join(extract, name, 'lib/vendor/yaml');
    assert.match(readFileSync(join(vendor, 'LICENSE'), 'utf8'), /Copyright Eemeli Aro/);
    assert.match(readFileSync(join(vendor, 'PROVENANCE.md'), 'utf8'), /yaml@2\.8\.3/);
    const require = createRequire(import.meta.url);
    assert.equal(require(join(vendor, 'dist/index.js')).parse('value: 42').value, 42);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.doesNotMatch(entries, /\/node_modules(?:\/|$)|\/\.env(?:\/|$)/m);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('archive excludes common generated and secret files', () => {
  assert.ok(script.includes('--exclude="$NAME/dist"'));
  for (const pattern of ['*/node_modules', '*/tmp', '*/.env', '*/.env.*', '*.pem', '*.key']) {
    assert.ok(script.includes(`--exclude='${pattern}'`), pattern);
  }
});
