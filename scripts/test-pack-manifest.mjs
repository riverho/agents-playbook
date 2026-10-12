#!/usr/bin/env node
// Red-fixture coverage for the mode pack manifest checker.

import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = resolve(ROOT, 'scripts/check-pack-manifest.mjs');
const SOURCE = resolve(ROOT, 'modes/blogwatch');
const tempRoot = tempDir('pb-pack-manifest-');
let pass = 0;

function fixture(name) {
  const modes = resolve(tempRoot, name);
  const pack = resolve(modes, 'blogwatch');
  cpSync(SOURCE, pack, { recursive: true });
  return { modes, pack };
}

function run(modes) {
  return spawnSync(process.execPath, [CHECKER, 'blogwatch'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PB_PACK_ROOT: modes },
  });
}

function assert(name, condition, result) {
  if (!condition) {
    console.error(`  FAIL  ${name}`);
    console.error(`${result.stdout || ''}${result.stderr || ''}`.trim());
    process.exitCode = 1;
    return;
  }
  console.log(`  PASS  ${name}`);
  pass++;
}

try {
  const pristine = fixture('pristine');
  let result = run(pristine.modes);
  assert('pristine copy passes', result.status === 0, result);

  const missing = fixture('missing');
  unlinkSync(resolve(missing.pack, 'config/daily-watches.yaml'));
  result = run(missing.modes);
  assert('missing listed file fails', result.status !== 0, result);

  const stray = fixture('stray');
  writeFileSync(resolve(stray.pack, 'stray.txt'), 'unlisted\n', 'utf8');
  result = run(stray.modes);
  assert('unlisted stray file fails', result.status !== 0, result);

  const incompatible = fixture('incompatible');
  const manifestPath = resolve(incompatible.pack, 'pack.yaml');
  const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
  manifest.engine_range = '>=99.0.0';
  writeFileSync(manifestPath, yaml.dump(manifest), 'utf8');
  result = run(incompatible.modes);
  assert('incompatible engine_range fails', result.status !== 0, result);

  const fail = 4 - pass;
  console.log(`test-pack-manifest: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
