import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const script = resolve(import.meta.dirname, '../install.sh');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-install-sh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = (await readFile(script, 'utf8')).replace(/^VERSION=.*/m, "VERSION='9.9.9'");
  const pkg = join(dir, 'src/dsh-installer-9.9.9');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'Install.command'), '#!/bin/bash\necho "ran $*"\n');
  const tarball = join(dir, 'setup.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', join(dir, 'src'), 'dsh-installer-9.9.9']).status, 0);
  const sha = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const run = async (sha256, args = [], env = {}) => {
    const file = join(dir, 'install.sh');
    await writeFile(file, source.replace(/^SHA256=.*/m, `SHA256='${sha256}'`));
    return spawnSync('bash', [file, ...args], { encoding: 'utf8', env: { ...process.env, DSH_INSTALLER_URL: 'file://' + tarball, TMPDIR: dir + '/', ...env } });
  };
  return { dir, sha, run };
}

test('install.sh runs the verified archive and forwards --check', async t => {
  const { sha, run } = await fixture(t);
  const result = await run(sha, ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ran --check/);
});

test('install.sh aborts on checksum mismatch without running the payload', async t => {
  const { run } = await fixture(t);
  const result = await run('0'.repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Контрольная сумма/);
  assert.doesNotMatch(result.stdout, /ran/);
});

test('install.sh refuses non-macOS systems and unknown arguments', async t => {
  const { dir, sha, run } = await fixture(t);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'uname'), '#!/bin/sh\necho Linux\n');
  await chmod(join(bin, 'uname'), 0o755);
  const linux = await run(sha, [], { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(linux.status, 0);
  assert.match(linux.stderr, /только macOS/);
  const bad = await run(sha, ['--force']);
  assert.notEqual(bad.status, 0);
  assert.doesNotMatch(bad.stdout, /ran/);
});

test('install.sh removes its temporary directory after the run', async t => {
  const { dir, sha, run } = await fixture(t);
  await run(sha);
  const left = spawnSync('find', [dir, '-maxdepth', '1', '-name', 'dsh-setup.*'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '');
});
