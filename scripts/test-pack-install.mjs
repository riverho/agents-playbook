#!/usr/bin/env node
// Sandboxed coverage for installing .pbpack archives into a playbook root.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { tempDir } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = resolve(ROOT, 'scripts/pb-pack.mjs');
const CHECKER = resolve(ROOT, 'scripts/check-pack-manifest.mjs');
const SOURCE = resolve(ROOT, 'modes/blogwatch');
const tempRoot = tempDir('pb-pack-install-test-');
let pass = 0;
let total = 0;

function assert(name, condition, result) {
  total++;
  if (!condition) {
    console.error(`  FAIL  ${name}`);
    if (result) console.error(`${result.stdout || ''}${result.stderr || ''}`.trim());
    process.exitCode = 1;
    return;
  }
  console.log(`  PASS  ${name}`);
  pass++;
}

// A minimal target playbook root the installer can register into.
function makeSandboxRoot(name, engineVersion = '0.3.5') {
  const root = resolve(tempRoot, name);
  mkdirSync(resolve(root, 'modes'), { recursive: true });
  writeFileSync(resolve(root, 'playbook.yaml'),
    `name: sandbox\nversion: ${engineVersion}\ndefault_mode: coding\nmodes:\n  coding: modes/coding.yaml\n`, 'utf8');
  writeFileSync(resolve(root, 'modes/coding.yaml'), 'id: coding\ndescription: sandbox coding mode\n', 'utf8');
  writeFileSync(resolve(root, 'modes/index.yaml'),
    'name: mode-catalog\nmodes:\n  - id: coding\n    description: sandbox coding mode\n    abstract: sandbox\n', 'utf8');
  return root;
}

// Build a blogwatch archive at an arbitrary pack version.
function buildArchive(name, version) {
  const modes = resolve(tempRoot, name, 'modes');
  const out = resolve(tempRoot, name, 'dist');
  cpSync(SOURCE, resolve(modes, 'blogwatch'), { recursive: true });
  cpSync(`${SOURCE}.yaml`, resolve(modes, 'blogwatch.yaml'));
  if (version) {
    const mPath = resolve(modes, 'blogwatch/pack.yaml');
    const m = yaml.load(readFileSync(mPath, 'utf8'));
    m.version = version;
    writeFileSync(mPath, yaml.dump(m), 'utf8');
  }
  const r = spawnSync(process.execPath, [PACK, 'build', 'blogwatch', '--out', out],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PB_PACK_ROOT: modes } });
  if (r.status !== 0) throw new Error(`fixture build failed:\n${r.stdout}${r.stderr}`);
  return resolve(out, r.stdout.trim().split(/\s+/)[0].split('/').pop());
}

function install(archive, root, extra = []) {
  return spawnSync(process.execPath, [PACK, 'install', archive, '--root', root, ...extra],
    { cwd: ROOT, encoding: 'utf8' });
}

try {
  const archive = buildArchive('v010', null); // pack's own 0.1.0

  // 1. Fresh install: files + descriptor + dual registration.
  const fresh = makeSandboxRoot('fresh');
  let r = install(archive, fresh);
  const playbookSrc = readFileSync(resolve(fresh, 'playbook.yaml'), 'utf8');
  const catalogSrc = readFileSync(resolve(fresh, 'modes/index.yaml'), 'utf8');
  assert('fresh install exits 0 and lays down pack + descriptor',
    r.status === 0
      && existsSync(resolve(fresh, 'modes/blogwatch/pack.yaml'))
      && existsSync(resolve(fresh, 'modes/blogwatch/skills/index.yaml'))
      && existsSync(resolve(fresh, 'modes/blogwatch.yaml'))
      && !existsSync(resolve(fresh, 'modes/blogwatch/mode.yaml')), r);
  assert('fresh install registers in playbook.yaml modes map',
    /^\s{2}blogwatch:\s+modes\/blogwatch\.yaml$/m.test(playbookSrc), r);
  assert('fresh install registers in modes/index.yaml catalog',
    /-\s*id:\s*blogwatch/.test(catalogSrc), r);
  const checkInstalled = spawnSync(process.execPath, [CHECKER, 'blogwatch'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PB_PACK_ROOT: resolve(fresh, 'modes') } });
  assert('installed pack passes the manifest checker', checkInstalled.status === 0, checkInstalled);

  // 2. Idempotent reinstall: same version, exit 0, no duplicate registration.
  r = install(archive, fresh);
  const playbook2 = readFileSync(resolve(fresh, 'playbook.yaml'), 'utf8');
  assert('same-version reinstall is idempotent (exit 0, single registration)',
    r.status === 0 && playbook2.match(/blogwatch:/g).length === 1, r);

  // 3. Upgrade allowed, downgrade refused without --force.
  const v020 = buildArchive('v020', '0.2.0');
  r = install(v020, fresh);
  assert('semver upgrade installs', r.status === 0
    && yaml.load(readFileSync(resolve(fresh, 'modes/blogwatch/pack.yaml'), 'utf8')).version === '0.2.0', r);
  r = install(archive, fresh);
  assert('downgrade refused without --force', r.status !== 0, r);
  r = install(archive, fresh, ['--force']);
  assert('downgrade allowed with --force', r.status === 0
    && yaml.load(readFileSync(resolve(fresh, 'modes/blogwatch/pack.yaml'), 'utf8')).version === '0.1.0', r);

  // 4. Tampered archive refused (sha mismatch).
  const tampered = resolve(tempRoot, 'tampered.pbpack');
  cpSync(archive, tampered);
  cpSync(`${archive}.sha256`, `${tampered}.sha256`);
  // sidecar names the original file; rewrite the filename column so ONLY the hash mismatches
  writeFileSync(`${tampered}.sha256`,
    readFileSync(`${archive}.sha256`, 'utf8').replace(/\S+$/m, 'tampered.pbpack'), 'utf8');
  appendFileSync(tampered, 'x');
  r = install(tampered, makeSandboxRoot('tamper-target'));
  assert('tampered archive refused', r.status !== 0 && /sha256 mismatch/.test(r.stderr), r);

  // 5. engine_range unsatisfied by target engine refused.
  r = install(archive, makeSandboxRoot('old-engine', '0.0.1'));
  assert('engine_range unsatisfied refused', r.status !== 0 && /engine_range/.test(r.stderr), r);

  console.log(`test-pack-install: ${pass} pass, ${total - pass} fail`);
  if (pass !== total) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
