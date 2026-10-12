#!/usr/bin/env node
// Build and install distributable mode packs (.pbpack).
//
// build <mode-id> [--out <dir>]
//   Validate via check-pack-manifest, then archive the pack dir CONTENTS plus
//   `mode.yaml` (a copy of modes/<id>.yaml — the descriptor lives OUTSIDE the
//   pack dir, but a sellable unit must carry it) with pack.yaml at the root.
//   Writes dist/<id>-<version>.pbpack + a .sha256 sidecar.
//
// install <file.pbpack> [--root <playbook-root>] [--force]
//   Verify the sha256 sidecar and engine_range, unpack into modes/<id>/,
//   write mode.yaml out to modes/<id>.yaml, and register the mode in BOTH
//   playbook.yaml's modes: map and modes/index.yaml (textual inserts — both
//   files are comment-rich; a parse→dump would destroy them). Idempotent on
//   the same version; upgrades allowed; downgrades refused without --force.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = resolve(ROOT, 'scripts/check-pack-manifest.mjs');
const PACK_ROOT = resolve(process.env.PB_PACK_ROOT || resolve(ROOT, 'modes'));

function fail(message) {
  console.error(`pb pack: ${message}`);
  process.exit(1);
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function satisfiesRange(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  const r = String(range || '').trim();
  const ge = /^>=\s*(\d+\.\d+\.\d+)$/.exec(r);
  if (ge) return cmpSemver(v, parseSemver(ge[1])) >= 0;
  const exact = parseSemver(r);
  return exact ? cmpSemver(v, exact) === 0 : false;
}

function cmdBuild(modeId, args) {
  let outDir = resolve(ROOT, 'dist');
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--out' || !args[i + 1] || i + 2 !== args.length) {
      fail('usage: node scripts/pb-pack.mjs build <mode-id> [--out <dir>]');
    }
    outDir = resolve(args[++i]);
  }

  const validation = spawnSync(process.execPath, [CHECKER, modeId], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PB_PACK_ROOT: PACK_ROOT },
  });
  if (validation.error) fail(`manifest validation could not run: ${validation.error.message}`);
  if (validation.status !== 0) {
    process.stderr.write(validation.stdout || '');
    process.stderr.write(validation.stderr || '');
    fail(`manifest validation failed for ${modeId}`);
  }

  const packDir = resolve(PACK_ROOT, modeId);
  const descriptor = resolve(PACK_ROOT, `${modeId}.yaml`);
  if (!existsSync(descriptor)) {
    fail(`mode descriptor missing: ${descriptor} — a pack without its mode.yaml is not installable`);
  }
  let manifest;
  try {
    manifest = yaml.load(readFileSync(resolve(packDir, 'pack.yaml'), 'utf8'));
  } catch (error) {
    fail(`could not read validated manifest: ${error.message}`);
  }

  // Stage: pack contents + mode.yaml (descriptor copy) so the archive is the
  // complete unit while the manifest walk of modes/<id>/ stays descriptor-free.
  const staging = mkdtempSync(resolve(tmpdir(), 'pb-pack-stage-'));
  // fail() exits the process, and a `finally` does not run on process.exit: every refused
  // run used to leave this staging dir in the temp folder. Remove it on exit too.
  const dropStaging = () => rmSync(staging, { recursive: true, force: true });
  process.on('exit', dropStaging);
  try {
    cpSync(packDir, staging, { recursive: true });
    copyFileSync(descriptor, resolve(staging, 'mode.yaml'));

    mkdirSync(outDir, { recursive: true });
    const filename = `${modeId}-${manifest.version}.pbpack`;
    const artifact = resolve(outDir, filename);
    const entries = readdirSync(staging).sort();
    const tar = spawnSync('tar', ['-czf', artifact, ...entries], { cwd: staging, encoding: 'utf8' });
    if (tar.error) fail(`tar could not run: ${tar.error.message}`);
    if (tar.status !== 0) fail(`tar failed: ${(tar.stderr || tar.stdout || '').trim()}`);

    const hash = sha256Of(artifact);
    writeFileSync(`${artifact}.sha256`, `${hash}  ${filename}\n`, 'utf8');
    console.log(`${artifact}  ${hash}`);
  } finally {
    dropStaging();
  }
}

function registerInPlaybook(playbookPath, modeId) {
  const src = readFileSync(playbookPath, 'utf8');
  const line = `  ${modeId}: modes/${modeId}.yaml`;
  if (new RegExp(`^\\s{2}${modeId}:\\s`, 'm').test(src)) return false; // already registered
  const updated = src.replace(/^modes:\s*$/m, (m) => `${m}\n${line}`);
  if (updated === src) fail(`could not find a top-level \`modes:\` map in ${playbookPath}`);
  writeFileSync(playbookPath, updated, 'utf8');
  return true;
}

function registerInCatalog(catalogPath, modeId, description) {
  const src = readFileSync(catalogPath, 'utf8');
  if (new RegExp(`^\\s*-\\s*id:\\s*${modeId}\\s*$`, 'm').test(src)) return false;
  const desc = String(description || modeId).replace(/\s+/g, ' ').trim();
  const entry = `\n  - id: ${modeId}\n    description: ${JSON.stringify(desc)}\n    abstract: >-\n      ${desc}\n`;
  writeFileSync(catalogPath, src.replace(/\s*$/, '\n') + entry, 'utf8');
  return true;
}

function cmdInstall(file, args) {
  let root = ROOT;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') { force = true; continue; }
    if (args[i] === '--root' && args[i + 1]) { root = resolve(args[++i]); continue; }
    fail('usage: node scripts/pb-pack.mjs install <file.pbpack> [--root <playbook-root>] [--force]');
  }
  const archive = resolve(file);
  if (!existsSync(archive)) fail(`no such archive: ${archive}`);

  // 1. Integrity — the sidecar is required, not optional.
  const sidecar = `${archive}.sha256`;
  if (!existsSync(sidecar)) fail(`missing checksum sidecar: ${sidecar}`);
  const expected = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
  const actual = sha256Of(archive);
  if (expected !== actual) fail(`sha256 mismatch: sidecar=${expected} actual=${actual}`);

  const playbookPath = resolve(root, 'playbook.yaml');
  if (!existsSync(playbookPath)) fail(`target is not a playbook root (no playbook.yaml): ${root}`);
  const engineVersion = yaml.load(readFileSync(playbookPath, 'utf8'))?.version;

  const staging = mkdtempSync(resolve(tmpdir(), 'pb-pack-install-'));
  // fail() exits the process, and a `finally` does not run on process.exit: every refused
  // run used to leave this staging dir in the temp folder. Remove it on exit too.
  const dropStaging = () => rmSync(staging, { recursive: true, force: true });
  process.on('exit', dropStaging);
  try {
    const untar = spawnSync('tar', ['-xzf', archive, '-C', staging], { encoding: 'utf8' });
    if (untar.status !== 0) fail(`could not extract: ${(untar.stderr || '').trim()}`);

    const manifestPath = resolve(staging, 'pack.yaml');
    const descriptorPath = resolve(staging, 'mode.yaml');
    if (!existsSync(manifestPath)) fail('archive has no pack.yaml at root');
    if (!existsSync(descriptorPath)) fail('archive has no mode.yaml at root (not a complete pack — rebuild with the current pb-pack)');
    const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
    const descriptor = yaml.load(readFileSync(descriptorPath, 'utf8'));
    const modeId = manifest?.id;
    const version = parseSemver(manifest?.version);
    if (!modeId || !version) fail('archive manifest is missing id or a valid semver version');

    // 2. Engine compatibility against the TARGET root's engine.
    if (!satisfiesRange(engineVersion, manifest.engine_range)) {
      fail(`engine_range ${manifest.engine_range} not satisfied by target engine ${engineVersion}`);
    }

    // 3. Semver gate against any existing install.
    const packDir = resolve(root, 'modes', modeId);
    const existingManifest = resolve(packDir, 'pack.yaml');
    if (existsSync(existingManifest)) {
      const existing = parseSemver(yaml.load(readFileSync(existingManifest, 'utf8'))?.version);
      if (existing && cmpSemver(version, existing) < 0 && !force) {
        fail(`downgrade refused: installed ${existing.join('.')} > incoming ${version.join('.')} (use --force)`);
      }
      rmSync(packDir, { recursive: true, force: true });
    }

    // 4. Lay down files: pack contents → modes/<id>/, descriptor → modes/<id>.yaml.
    const descriptorSrc = readFileSync(descriptorPath, 'utf8');
    rmSync(descriptorPath);
    cpSync(staging, packDir, { recursive: true });
    writeFileSync(resolve(root, 'modes', `${modeId}.yaml`), descriptorSrc, 'utf8');

    // 5. Register in both authorities (pb validate asserts they agree).
    const registeredMap = registerInPlaybook(playbookPath, modeId);
    const catalogPath = resolve(root, 'modes', 'index.yaml');
    const registeredCatalog = existsSync(catalogPath)
      ? registerInCatalog(catalogPath, modeId, descriptor?.description)
      : false;

    console.log(`installed ${modeId}@${manifest.version} → ${packDir}`);
    console.log(`registered: playbook.yaml ${registeredMap ? 'added' : 'already present'}, modes/index.yaml ${registeredCatalog ? 'added' : catalogPath && existsSync(catalogPath) ? 'already present' : 'absent'}`);
  } finally {
    dropStaging();
  }
}

const [command, target, ...rest] = process.argv.slice(2);
if (command === 'build' && target) cmdBuild(target, rest);
else if (command === 'install' && target) cmdInstall(target, rest);
else fail('usage: node scripts/pb-pack.mjs <build <mode-id> [--out <dir>] | install <file.pbpack> [--root <dir>] [--force]>');
