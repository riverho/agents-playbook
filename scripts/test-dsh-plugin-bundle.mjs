#!/usr/bin/env node
// scripts/test-dsh-plugin-bundle.mjs
// ----------------------------------------------------------------------------
// The bundled-engine build: a deployment should be ONE install, not an engine
// install plus a plugin install that can drift apart.
//
// Two risks this suite exists for, both of which are silent when wrong:
//   1. the bundle is incomplete or carries this repository's own state (a leaked
//      backlog/journal would ship this repo's work into every deployment);
//   2. discovery "finds" the plugin's OWN vendored playbook and operates on that
//      instead of the user's project — because the plugin now contains a
//      playbook-shaped tree, this is the natural failure of a naive ancestor walk.
// It also proves the payoff: a workspace with NO engine gets a working playbook via
// the bundled engine.
//
// Skips honestly when the bundle has not been built (`node scripts/pack-dsh-plugin.mjs`).
// ----------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempDir } from './lib/test-temp.mjs';

const core = await import('../dsh-plugin/core.mjs');
const { bundledEngine, engineVersion, resolveEngine, findPlaybookRoot, readMasterVersion, scaffoldFromBundle, PLUGIN_DIR } = core;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const bundle = bundledEngine();
if (!bundle) {
  console.log('  SKIP  no bundled engine — build it with `node scripts/pack-dsh-plugin.mjs`');
  console.log('\ntest-dsh-plugin-bundle: skipped (0 pass, 0 fail)');
  process.exit(0);
}

// --- 1. the bundle is complete and clean -------------------------------------
{
  ok('the bundle carries the engine entry point', existsSync(join(bundle.root, 'scripts', 'pb.mjs')));
  ok('the bundle carries the master it operates with', existsSync(join(bundle.root, 'playbook.yaml')));
  ok('the bundle carries process + skill indices (scaffold needs them)',
    existsSync(join(bundle.root, 'processes', 'index.yaml')) && existsSync(join(bundle.root, 'skills', 'index.yaml')));
  ok('the bundle carries the memory template, not a memory record',
    existsSync(join(bundle.root, 'memory', 'project-memory.md')));
  // The bundle is hydrated by `pb init`, so it has a PLACEHOLDER backlog — never this
  // repository's work. That distinction is the leak check.
  const bundledBacklog = join(bundle.root, 'memory', 'backlog.yaml');
  ok('the bundle carries only the engine placeholder backlog, not real work',
    existsSync(bundledBacklog) && /First task/.test(readFileSync(bundledBacklog, 'utf8')),
    existsSync(bundledBacklog) ? readFileSync(bundledBacklog, 'utf8').slice(0, 200) : '(missing)');
  for (const leak of ['memory/backlog-state.json', 'memory/backlog-state.json.lock', '.git', 'dsh-plugin']) {
    ok(`the bundle does NOT carry this repository's ${leak}`, !existsSync(join(bundle.root, leak)));
  }
  ok('the bundle excludes engine test suites (dev material, not runtime)',
    !existsSync(join(bundle.root, 'scripts', 'test-concurrency-state.mjs')));
  ok('the bundle declares its own version', typeof engineVersion(bundle.pb) === 'string' && engineVersion(bundle.pb).length > 0,
    String(engineVersion(bundle.pb)));
  ok('the bundled engine version equals the engine repo version (no drift on publish)',
    engineVersion(bundle.pb) === JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version,
    `bundle=${engineVersion(bundle.pb)} repo=${JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version}`);
}

// --- 2. the bundled engine actually runs -------------------------------------
{
  const r = spawnSync(process.execPath, [bundle.pb, 'validate'], { cwd: bundle.root, encoding: 'utf8' });
  ok('the bundled engine validates its own tree (it is a runnable playbook)',
    r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`.slice(0, 500));
}

// --- 3. discovery must never target the plugin's own vendored playbook --------
{
  // The plugin now CONTAINS a playbook-shaped tree, so a naive ancestor walk could
  // "discover" the vendored copy. Probe from a standalone workspace with no playbook:
  // discovery must find nothing, and the engine must still be offered for execution.
  const bare = tempDir('pbbare-');
  mkdirSync(join(bare, 'src'), { recursive: true });
  const found = findPlaybookRoot({ workspace: join(bare, 'src'), exclude: PLUGIN_DIR });
  ok('a workspace with no playbook discovers none', found === null, `found=${found}`);

  const engine = resolveEngine({ workspace: join(bare, 'src') });
  ok('resolveEngine selects no workspace to operate on', engine.cwd === null, JSON.stringify(engine));
  ok('resolveEngine still offers the bundled engine to execute',
    engine.pbPath === bundle.pb && engine.source === 'bundled-engine', JSON.stringify(engine));

  // And the bundled tree itself is excluded even when it is an ancestor candidate.
  ok('the bundled engine path is never treated as a workspace playbook',
    findPlaybookRoot({ workspace: join(PLUGIN_DIR, 'engine', 'scripts'), exclude: PLUGIN_DIR }) === null
    || !findPlaybookRoot({ workspace: join(PLUGIN_DIR, 'engine', 'scripts'), exclude: PLUGIN_DIR }).startsWith(PLUGIN_DIR));

  // An EXPLICIT path into the bundle is still an explicit choice, but every implicit
  // route must stay clear of it: the deployed plugin sits inside the user's project,
  // and a workspace playbook must never resolve to the plugin's own copy.
  const explicitBundle = resolveEngine({ workspace: join(bare, 'src'), explicit: join(PLUGIN_DIR, 'engine') });
  ok('pointing explicitly at the bundle does not make the bundle a workspace',
    explicitBundle.cwd === null, JSON.stringify(explicitBundle));
  rmSync(bare, { recursive: true, force: true });
}

// --- 4. a workspace playbook wins over the bundle -----------------------------
{
  const ws = tempDir('pbws-');
  mkdirSync(join(ws, 'scripts'), { recursive: true });
  writeFileSync(join(ws, 'playbook.yaml'), 'name: user-project\nversion: 1.2.3\n');
  // Give the workspace its OWN engine file so the resolver has to choose.
  cpSync(resolve('scripts/pb.mjs'), join(ws, 'scripts', 'pb.mjs'));

  const engine = resolveEngine({ workspace: ws });
  ok('a workspace playbook is preferred over the bundled engine',
    engine.cwd === ws && engine.pbPath === join(ws, 'scripts', 'pb.mjs') && engine.source === 'workspace',
    JSON.stringify(engine));
  ok('the workspace master version is reported', engine.workspace_version === '1.2.3', JSON.stringify(engine));
  ok('readMasterVersion parses a YAML master without a YAML dependency',
    readMasterVersion(ws) === '1.2.3', String(readMasterVersion(ws)));

  // A workspace with a playbook but NO engine of its own: the bundled engine runs it.
  rmSync(join(ws, 'scripts'), { recursive: true, force: true });
  const borrowed = resolveEngine({ workspace: ws });
  ok('a playbook without its own engine borrows the bundled one',
    borrowed.cwd === ws && borrowed.pbPath === bundle.pb && borrowed.source === 'bundled-engine-for-workspace',
    JSON.stringify(borrowed));
  rmSync(ws, { recursive: true, force: true });
}

// --- 5. the payoff: bootstrap a workspace from the bundle --------------------
{
  const ws = tempDir('pbinit-');
  // Mirror the real deployment topology: the plugin (with its js-yaml dependency)
  // lives in the project's node_modules, so a playbook scaffolded INTO that project
  // resolves the engine's single dependency by walking up to it.
  mkdirSync(join(ws, 'node_modules'), { recursive: true });
  try { cpSync(resolve('node_modules/js-yaml'), join(ws, 'node_modules', 'js-yaml'), { recursive: true }); } catch { /* asserted below */ }

  const target = join(ws, '.agents-playbook');
  const r = scaffoldFromBundle(target);
  ok('scaffoldFromBundle exits 0 and reports successful hydration', r.ok && r.initialized, `exit=${r.code}\n${r.stdout}${r.stderr}`.slice(0, 700));
  ok('the scaffolded workspace has a master', existsSync(join(target, 'playbook.yaml')));
  ok('the scaffolded workspace has a runnable engine', existsSync(join(target, 'scripts', 'pb.mjs')));
  ok('the scaffolded workspace was hydrated (journal + backlog)',
    existsSync(join(target, 'memory', 'journal.ndjson')) && existsSync(join(target, 'memory', 'backlog.yaml')));

  // The real gate: a freshly scaffolded playbook must validate with no manual fixups.
  const v = spawnSync(process.execPath, [join(target, 'scripts', 'pb.mjs'), 'validate'], { cwd: target, encoding: 'utf8' });
  ok('the scaffolded playbook validates with no manual fixups', v.status === 0,
    `exit=${v.status}\n${v.stdout}${v.stderr}`.slice(0, 600));

  const discovered = findPlaybookRoot({ workspace: ws, exclude: PLUGIN_DIR });
  ok('the plugin finds a playbook scaffolded into the engine\'s NESTED install location',
    discovered === target, `discovered=${discovered}`);
  const engine = resolveEngine({ workspace: ws });
  ok('after init, the plugin operates on the workspace playbook, not the bundle',
    engine.cwd === target && engine.pbPath === join(target, 'scripts', 'pb.mjs') && engine.source === 'workspace',
    JSON.stringify(engine));
  ok('the workspace playbook\'s version is reported for drift checks',
    typeof engine.workspace_version === 'string' && engine.workspace_version.length > 0, JSON.stringify(engine));

  // And the workspace copy is a full engine: a second scaffold from it must work too,
  // which is what makes the playbook self-hosting rather than plugin-dependent.
  const nested = join(ws, 'nested');
  const r2 = spawnSync(process.execPath, [join(target, 'scripts', 'pb.mjs'), 'scaffold', '--target', nested], { cwd: target, encoding: 'utf8' });
  ok('the workspace engine can itself scaffold another playbook (self-hosting)',
    r2.status === 0 && existsSync(join(nested, 'playbook.yaml')), `exit=${r2.status}\n${r2.stdout}${r2.stderr}`.slice(0, 400));
  rmSync(ws, { recursive: true, force: true });
}

console.log(`\ntest-dsh-plugin-bundle: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
