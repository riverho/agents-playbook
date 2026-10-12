#!/usr/bin/env node
// Sandboxed coverage for building distributable mode packs.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { tempDir } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = resolve(ROOT, 'scripts/pb-pack.mjs');
const SOURCE = resolve(ROOT, 'modes/blogwatch');
const tempRoot = tempDir('pb-pack-build-');
let pass = 0;

function fixture(name) {
  const modes = resolve(tempRoot, name, 'modes');
  const pack = resolve(modes, 'blogwatch');
  const out = resolve(tempRoot, name, 'dist');
  cpSync(SOURCE, pack, { recursive: true });
  // The build also embeds the mode descriptor (modes/<id>.yaml) as mode.yaml.
  cpSync(`${SOURCE}.yaml`, resolve(modes, 'blogwatch.yaml'));
  return { modes, pack, out };
}

function run({ modes, out }) {
  return spawnSync(process.execPath, [BUILDER, 'build', 'blogwatch', '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PB_PACK_ROOT: modes },
  });
}

function assert(name, condition, result) {
  if (!condition) {
    console.error(`  FAIL  ${name}`);
    console.error(`${result?.stdout || ''}${result?.stderr || ''}`.trim());
    process.exitCode = 1;
    return;
  }
  console.log(`  PASS  ${name}`);
  pass++;
}

try {
  const happy = fixture('happy');
  let result = run(happy);
  const archive = resolve(happy.out, 'blogwatch-0.1.0.pbpack');
  const sidecar = `${archive}.sha256`;
  const hash = existsSync(archive)
    ? createHash('sha256').update(readFileSync(archive)).digest('hex')
    : '';
  const listing = existsSync(archive)
    ? spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    : { status: 1, stdout: '' };
  // bsdtar on Windows emits CRLF entry lines, which would leave a trailing "\r" on
  // every name and make the membership test fail on an archive that is in fact
  // correct. Normalize line endings before splitting (portable, no behavior change
  // on LF platforms).
  const entries = String(listing.stdout || '').split(/\r?\n/);
  assert('happy path builds a valid archive and checksum',
    result.status === 0 && existsSync(sidecar)
      && readFileSync(sidecar, 'utf8') === `${hash}  blogwatch-0.1.0.pbpack\n`
      && listing.status === 0 && entries.includes('pack.yaml')
      && entries.includes('mode.yaml'), result);

  const stray = fixture('stray');
  writeFileSync(resolve(stray.pack, 'stray.txt'), 'unlisted\n', 'utf8');
  result = run(stray);
  assert('unlisted stray file refuses build', result.status !== 0, result);

  const invalid = fixture('bad-manifest');
  const manifestPath = resolve(invalid.pack, 'pack.yaml');
  const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
  manifest.engine_range = 'invalid';
  writeFileSync(manifestPath, yaml.dump(manifest), 'utf8');
  result = run(invalid);
  assert('bad manifest refuses build', result.status !== 0, result);

  const noDescriptor = fixture('no-descriptor');
  rmSync(resolve(noDescriptor.modes, 'blogwatch.yaml'));
  result = run(noDescriptor);
  assert('missing mode descriptor refuses build', result.status !== 0, result);

  const fail = 4 - pass;
  console.log(`test-pack-build: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
