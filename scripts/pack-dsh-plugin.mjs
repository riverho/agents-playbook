#!/usr/bin/env node
// ============================================================================
//  pack-dsh-plugin.mjs — build the plugin's bundled engine, then verify the package.
// ----------------------------------------------------------------------------
//  Why bundle: without it a deployment does two installs and can drift from the engine
//  the plugin was tested against. With it the plugin carries a known-good engine, and
//  `playbook action=init` scaffolds a workspace playbook from it. A workspace copy
//  always wins at runtime — that is where the project's truth (backlog, journal) lives.
//
//  What is copied is the ENGINE, not this repository: no tests, no adapters for other
//  harnesses, no loop artifacts, no memory of this repo's own work, no nested plugin.
//
//  STDOUT DISCIPLINE: `prepack` runs this during `npm pack`, and `npm pack --json`
//  reserves stdout for its result. Every human line therefore goes to stderr — a build
//  log on stdout corrupts the caller's JSON (observed as a pack that succeeds whose
//  output will not parse).
//
//  Usage: node scripts/pack-dsh-plugin.mjs [--force] [--json] [--clean] [--pack [--dry-run]]
// ============================================================================

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstPackedEntry } from './lib/npm-pack.mjs';

const log = (...parts) => console.error(...parts);
const emitJson = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'dsh-plugin');
const ENGINE = join(PLUGIN, 'engine');

const INCLUDE_DIRS = ['scripts', 'processes', 'skills', 'modes'];
const INCLUDE_FILES = ['playbook.yaml', 'SKILL.md', 'AGENTS.md', 'README.md', 'INSTALL.md', 'LICENSE'];

// Excluded inside the included dirs: suites and fixtures are for DEVELOPING the engine,
// not for running it inside a plugin.
const EXCLUDE_PATTERNS = [
  /^scripts[/\\]test-.*\.mjs$/i,
  /^scripts[/\\]check-.*\.mjs$/i,
  /^scripts[/\\]concurrency-smoke\.mjs$/i,
  /^scripts[/\\]lib[/\\]/i,
  /^scripts[/\\]pb-daily-monitor\.mjs$/i,
  /^scripts[/\\]pb-flow\.mjs$/i,
  /^scripts[/\\]pb-pack\.mjs$/i,
  /^scripts[/\\]attention-research-daily\.mjs$/i,
  /^scripts[/\\]wiki-news-daily\.mjs$/i,
  /^scripts[/\\]verify-attention-research-output\.mjs$/i,
  /^scripts[/\\]pack-dsh-plugin\.mjs$/i,
  /^modes[/\\][^/\\]+[/\\]config[/\\]/i,
];
const shouldExclude = (rel) => EXCLUDE_PATTERNS.some((re) => re.test(rel));

// The stamp records WHAT was bundled, not merely which version. Keying the cache on the
// version alone was wrong in a way that actually shipped: engine files were edited without
// bumping (the README, twice), the version still matched, the build was skipped, and the
// tarball carried a stale copy while every check stayed green. A build has to depend on its
// inputs. The stamp lives OUTSIDE `engine/` so it is never published.
const STAMP = join(PLUGIN, '.bundle-stamp');

/**
 * The exact file set `build()` copies, in a stable order. Shared with the stamp, so the cache
 * can never disagree with what was actually bundled. Sorting matters: readdir order is not
 * guaranteed, and an unstable hash would rebuild on every run.
 */
function listSourceFiles() {
  const files = [];
  for (const f of INCLUDE_FILES) {
    if (existsSync(join(ROOT, f)) && !shouldExclude(f)) files.push(f);
  }
  for (const d of INCLUDE_DIRS) {
    const src = join(ROOT, d);
    if (!existsSync(src)) continue;
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!shouldExclude(rel)) walk(join(dir, entry.name), rel);
        } else if (!shouldExclude(rel)) files.push(rel);
      }
    };
    walk(src, d);
  }
  // `build()` copies this one file out of memory/ separately, so it counts as an input.
  const pm = 'memory/project-memory.md';
  if (existsSync(join(ROOT, pm))) files.push(pm);
  return files.sort();
}

/** Content hash over every bundled input: path + bytes, so a rename counts as a change too. */
function sourceSignature() {
  const hash = createHash('sha256');
  for (const rel of listSourceFiles()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(ROOT, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readStamp() {
  try { return readFileSync(STAMP, 'utf8').trim(); } catch { return null; }
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    total += e.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

function engineVersionOf(pbPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(pbPath, '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function validateBundle() {
  const r = spawnSync(process.execPath, [join(ENGINE, 'scripts', 'pb.mjs'), 'validate'], { cwd: ENGINE, encoding: 'utf8' });
  if (r.status !== 0) log(`${r.stdout || ''}${r.stderr || ''}`);
  return r.status === 0;
}

function build() {
  if (existsSync(ENGINE)) rmSync(ENGINE, { recursive: true, force: true });
  mkdirSync(ENGINE, { recursive: true });

  const copyIf = (rel) => {
    const from = join(ROOT, rel);
    if (!existsSync(from) || shouldExclude(rel)) return;
    const to = join(ENGINE, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  };

  for (const f of INCLUDE_FILES) copyIf(f);
  for (const d of INCLUDE_DIRS) {
    const src = join(ROOT, d);
    if (!existsSync(src)) continue;
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (shouldExclude(rel)) continue;
          walk(join(dir, entry.name), rel);
        } else if (!shouldExclude(rel)) {
          copyIf(rel);
        }
      }
    };
    walk(src, d);
  }

  // A `pb scaffold` copies the engine from the directory containing pb.mjs, so the
  // bundled tree must itself be a playbook root: keep the memory template, never this
  // repository's records.
  mkdirSync(join(ENGINE, 'memory'), { recursive: true });
  const pm = join(ROOT, 'memory', 'project-memory.md');
  if (existsSync(pm)) cpSync(pm, join(ENGINE, 'memory', 'project-memory.md'));

  const enginePkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  writeFileSync(join(ENGINE, 'package.json'), JSON.stringify({
    name: 'agent-playbook-engine',
    version: enginePkg.version,
    private: true,
    type: 'module',
    description: 'Agent-Playbook engine bundled with dsh-agents-playbook.',
    dependencies: { 'js-yaml': '^4.1.0' },
    engines: { node: '>=18' },
  }, null, 2) + '\n', 'utf8');

  // Give the bundled tree its runtime files. `pb init` is the engine's own
  // never-overwrites hydration step, so the bundle IS a runnable playbook rather than a
  // template that fails `validate` the first time it runs.
  const init = spawnSync(process.execPath, [join(ENGINE, 'scripts', 'pb.mjs'), 'init'], { cwd: ENGINE, encoding: 'utf8' });
  if (init.status !== 0) {
    log('  ERROR: the bundled engine could not initialize itself:');
    log(`${init.stdout || ''}${init.stderr || ''}`);
    process.exit(1);
  }

  const ok = existsSync(join(ENGINE, 'scripts', 'pb.mjs'));
  log(`bundled engine  → ${ENGINE}`);
  log(`  engine version: ${enginePkg.version}`);
  log(`  pb.mjs present: ${ok ? 'yes' : 'NO — the bundle is unusable'}`);
  log(`  self-validate:  ${validateBundle() ? 'green' : 'FAILED'}`);
  log(`  size:           ${(dirSize(ENGINE) / 1024).toFixed(0)} KiB`);
  if (!ok) process.exit(1);

  // A bundle that carries this repository's work would leak it into every deployment.
  for (const leak of ['memory/backlog-state.json', '.git', 'dsh-plugin', 'node_modules']) {
    if (existsSync(join(ENGINE, leak))) {
      log(`  ERROR: the bundle contains ${leak} — that is not engine material.`);
      process.exit(1);
    }
  }
  const bundledBacklog = join(ENGINE, 'memory', 'backlog.yaml');
  if (existsSync(bundledBacklog) && !/First task/.test(readFileSync(bundledBacklog, 'utf8'))) {
    log('  ERROR: the bundle carries a real backlog — that is this repository\'s work, not engine material.');
    process.exit(1);
  }
  // Record WHAT was bundled so the next run can tell whether anything changed. Written last,
  // so a failed build leaves the old stamp rather than claiming success.
  writeFileSync(STAMP, `${enginePkg.version} ${sourceSignature()}\n`, 'utf8');
  return { rebuilt: true, version: enginePkg.version, engine: ENGINE, size: dirSize(ENGINE) };
}

// The tarball can only contain what `files` lists, and `files` is easy to get wrong
// silently — an empty bundle ships a plugin that loads and then does nothing.
function checkManifest(builtVersion) {
  const pluginPkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  const problems = [];
  if (!Array.isArray(pluginPkg.files) || !pluginPkg.files.includes('engine/')) {
    problems.push('`files` does not include "engine/" — npm would ship a plugin with no engine');
  }
  if (pluginPkg.version !== builtVersion) {
    problems.push(`version drift: plugin ${pluginPkg.version} vs bundled engine ${builtVersion} — bump the plugin so the pair is identifiable`);
  }
  if (!pluginPkg.dependencies || !pluginPkg.dependencies['js-yaml']) {
    problems.push('js-yaml is not declared — the engine copied into a workspace cannot run without it');
  }
  if (!pluginPkg.scripts || pluginPkg.scripts.prepack !== 'node ../scripts/pack-dsh-plugin.mjs') {
    problems.push('no `prepack` hook — publishing would ship whatever bundle happened to be on disk');
  }
  // The Flow room's Harness panel is GENERATED, and this script generates it, so the
  // manifest must both carry it and declare it. (`files` is a whitelist: a bundle that is
  // built but unlisted ships nothing, which looks like the panel simply never appears.)
  if (!existsSync(join(PLUGIN, 'client.js'))) {
    problems.push('no client.js — the Harness panel bundle is missing; this script builds it at pack time');
  } else if (!Array.isArray(pluginPkg.files) || !pluginPkg.files.includes('client.js')) {
    problems.push('client.js exists but `files` does not include it — the panel would not ship');
  }
  if (pluginPkg.dsh?.client?.platform !== 'web') {
    problems.push('`dsh.client.platform` is not "web" — the Harness would not load the panel in the browser');
  }
  // A package that depends on itself. Nothing in the source tree looks wrong when this
  // happens, which is why it needs a gate rather than care: running `npm install <own-name>`
  // from inside the package folder adds it and rewrites the manifest. That shipped once —
  // 0.5.1 went out with `dsh-agents-playbook` in its own `dependencies` — and every
  // consumer would have resolved the plugin against itself.
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (Object.prototype.hasOwnProperty.call(pluginPkg[field] || {}, pluginPkg.name)) {
      problems.push(`${field} contains ${pluginPkg.name} — the plugin depends on ITSELF. Remove it; this is what running \`npm install ${pluginPkg.name}\` inside dsh-plugin/ leaves behind`);
    }
  }
  if (problems.length) {
    log('\nmanifest checks FAILED:');
    for (const p of problems) log(`  ! ${p}`);
    process.exit(1);
  }
  log('  manifest:       files/version/js-yaml/prepack OK');
}

function runPack(dry) {
  const npmCli = process.env.npm_execpath
    || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  // Invoke npm's CLI entry directly: passing args through a shell is deprecated and
  // loses argument escaping.
  const r = spawnSync(process.execPath, [npmCli, 'pack', ...(dry ? ['--dry-run'] : []), '--json'], {
    cwd: PLUGIN, encoding: 'utf8',
  });
  log(`\nnpm pack ${dry ? '(dry run) ' : ''}exit=${r.status}`);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* reported below */ }
  // npm 11 answers with an array, npm 12 with an object keyed by package name.
  const packed = firstPackedEntry(parsed);
  if (packed) {
    log(`  tarball:   ${packed.filename}`);
    log(`  unpacked:  ${(packed.unpackedSize / 1024).toFixed(0)} KiB across ${packed.entryCount} files`);
    const hasEngine = (packed.files || []).some((x) => /^engine\/scripts\/pb\.mjs$/.test(x.path));
    log(`  engine in tarball: ${hasEngine ? 'yes' : 'NO — the published plugin would not work'}`);
    if (!hasEngine) process.exit(1);
  } else {
    // NOT a soft landing. This branch used to print the raw output and exit 0, so the
    // moment npm changed its JSON shape the engine-in-tarball assertion stopped running
    // and the gate still reported success. An unreadable pack result is a failure.
    log('  ERROR: could not read `npm pack --json` output — the engine-in-tarball check cannot run.');
    log(`${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 2000));
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status || 1);
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.includes('--clean')) {
  rmSync(ENGINE, { recursive: true, force: true });
  log(`removed ${ENGINE}`);
  process.exit(0);
}

const repoVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const builtPb = join(ENGINE, 'scripts', 'pb.mjs');
// Currency is judged on the CONTENT that would be copied, not on the version alone: a source
// edit without a version bump must rebuild. See the STAMP note above for why.
const signature = sourceSignature();
const stamp = readStamp();
const stampMatches = stamp === `${repoVersion} ${signature}`;
const upToDate = !args.includes('--force') && existsSync(builtPb)
  && engineVersionOf(builtPb) === repoVersion && stampMatches;

let built;
if (upToDate) {
  log(`bundled engine  → ${ENGINE} (already at ${repoVersion}, sources unchanged; pass --force to rebuild)`);
  built = { rebuilt: false, version: repoVersion, engine: ENGINE };
} else {
  if (!args.includes('--force') && existsSync(builtPb)) {
    const why = engineVersionOf(builtPb) !== repoVersion
      ? `version moved to ${repoVersion}`
      : stamp === null ? 'no bundle stamp (built before staleness was tracked)' : 'bundled sources changed';
    log(`bundled engine  → rebuilding: ${why}`);
  }
  built = build();
}
// The Flow room's Harness panel bundle is generated exactly like the engine: at pack time,
// from the app source, staleness-aware. Doing it here (rather than in the package's own
// prepack) keeps the invariant checkManifest enforces — prepack IS this script — and gives
// one place that owns every artifact a consumer receives.
const clientBuild = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-dsh-client.mjs')], {
  encoding: 'utf8',
});
if (clientBuild.stdout) process.stderr.write(clientBuild.stdout);
if (clientBuild.stderr) process.stderr.write(clientBuild.stderr);
if (clientBuild.status !== 0) {
  log('the DSH client build failed — refusing to pack a plugin with a stale or missing panel');
  process.exit(1);
}

checkManifest(built.version);

if (args.includes('--pack')) runPack(args.includes('--dry-run'));
else if (args.includes('--json')) emitJson(built);
