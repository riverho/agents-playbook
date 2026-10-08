#!/usr/bin/env node
// scripts/test-dsh-plugin-published.mjs
// ----------------------------------------------------------------------------
// Verifies the SHIPPED artifact, not the source tree: pack the real tarball, extract
// it exactly as npm would install it, and bootstrap a workspace using only what is
// inside the package.
//
// This is the closest thing to "a deployment installs this and it works" that can be
// checked without a live harness session. It catches packaging mistakes the source-tree
// suites structurally cannot: a path that only exists because we are in the repo root,
// a file excluded by `files`, a build script that forgot to run.
//
// Requires the bundle to be built (`npm run build:plugin`); skips honestly otherwise.
// ----------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { firstPackedEntry } from './lib/npm-pack.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const PLUGIN = resolve('dsh-plugin');
const pluginPkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
if (!existsSync(join(PLUGIN, 'engine', 'scripts', 'pb.mjs'))) {
  console.log('  SKIP  plugin bundle not built — run `npm run build:plugin` first');
  console.log('\ntest-dsh-plugin-published: skipped (0 pass, 0 fail)');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'pbpub-'));
const npmCli = process.env.npm_execpath || join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npm = [process.env.npm_execpath ? process.execPath : 'node', process.env.npm_execpath ? npmCli : npmCli];

// --- 1. pack the real tarball ------------------------------------------------
let tarball = null;
{
  const r = spawnSync(npm[0], [npm[1], 'pack', '--json', '--pack-destination', work], { cwd: PLUGIN, encoding: 'utf8' });
  let info = null;
  try { info = JSON.parse(r.stdout); } catch { /* reported below */ }
  // npm 11 answers with an array, npm 12 with an object keyed by package name.
  const packed = firstPackedEntry(info);
  tarball = packed?.filename ? join(work, packed.filename) : null;
  ok('the plugin tarball builds', r.status === 0 && !!tarball, `exit=${r.status}\n${r.stdout}${r.stderr}`.slice(0, 500));
  if (!tarball) { console.log('\ntest-dsh-plugin-published: aborted'); process.exit(1); }
}

// --- 2. extract it exactly as an install would -------------------------------
const installed = join(work, 'node_modules', pluginPkg.name);
{
  mkdirSync(installed, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'], { encoding: 'utf8' });
  ok('the tarball extracts', r.status === 0 && existsSync(join(installed, 'package.json')),
    `exit=${r.status}\n${r.stderr}`);
  ok('the installed package carries the engine (the point of bundling)',
    existsSync(join(installed, 'engine', 'scripts', 'pb.mjs')));
  ok('the installed package carries its entry points and patch',
    ['index.js', 'core.mjs', 'cordis.patch.yml', 'README.md'].every((f) => existsSync(join(installed, f))),
    readdirSync(installed).join(', '));
  // This repository's own work must never reach a deployment.
  ok('the installed package does NOT carry this repository\'s git history',
    !existsSync(join(installed, '.git')) && !existsSync(join(installed, 'engine', '.git')));
  ok('the installed package does NOT carry this repository\'s state',
    !existsSync(join(installed, 'engine', 'memory', 'backlog-state.json')));
}

// --- 3. the installed package bootstraps a workspace on its own ---------------
{
  // The plugin runs from the workspace, where a real install would have placed it.
  // Its declared `js-yaml` dependency is resolved by walking up from the plugin's
  // own location, which is exactly how the engine it copies into the workspace
  // later finds it too.
  const hostRoot = mkdtempSync(join(tmpdir(), 'pbpubhost-'));
  const hostPlugin = join(hostRoot, 'node_modules', pluginPkg.name);
  mkdirSync(dirname(hostPlugin), { recursive: true });
  cpSync(installed, hostPlugin, { recursive: true });
  cpSync(resolve('node_modules', 'js-yaml'), join(hostRoot, 'node_modules', 'js-yaml'), { recursive: true });
  // The plugin is installed INTO the project it operates on (and, while developing the
  // engine, the project root is the engine repo). That placement is what lets the
  // engine the plugin copies into `.agents-playbook/` resolve its one dependency by
  // walking up — so the topology is part of the behavior under test, not incidental.
  const ws = hostRoot;

  // Resolve through the plugin's OWN resolver, from the installed location.
  const driver = `
    const core = await import(${JSON.stringify(`file:///${join(hostPlugin, 'core.mjs').replace(/\\/g, '/')}`)});
    const out = {};
    out.bundled = !!core.bundledEngine();
    out.version = core.engineVersion(core.bundledEngine().pb);
    out.before = core.resolveEngine({ workspace: ${JSON.stringify(ws)} });
    const r = core.scaffoldFromBundle(${JSON.stringify(join(ws, '.agents-playbook'))});
    out.scaffold = { ok: r.ok, initialized: r.initialized, code: r.code, err: (r.stderr || '').slice(0, 300), out: (r.stdout || '').slice(0, 200) };
    out.after = core.resolveEngine({ workspace: ${JSON.stringify(ws)} });
    console.log('__R__' + JSON.stringify(out));
  `;
  const driverPath = join(hostRoot, 'driver.mjs');
  writeFileSync(driverPath, driver);
  const r = spawnSync(process.execPath, [driverPath], { cwd: hostRoot, encoding: 'utf8', timeout: 180_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__R__'));
  let out = {};
  try { out = JSON.parse(line.slice('__R__'.length)); } catch { /* reported below */ }
  ok('the installed plugin finds its bundled engine', out.bundled === true, `${r.stdout}\n${r.stderr}`.slice(0, 400));
  ok('the bundled engine reports a version', typeof out.version === 'string' && out.version.length > 0, String(out.version));
  ok('before scaffolding, no workspace playbook is selected', out.before?.cwd === null, JSON.stringify(out.before));
  ok('the installed plugin scaffolds AND hydrates a playbook',
    out.scaffold?.ok === true && out.scaffold?.initialized === true,
    JSON.stringify(out.scaffold) + `\n${r.stderr}`.slice(0, 500));
  ok('after scaffolding, the workspace playbook is selected (not the bundle)',
    out.after?.cwd === join(ws, '.agents-playbook') && out.after?.source === 'workspace', JSON.stringify(out.after));

  // The scaffolded playbook must run with only the dependency the plugin declares.
  const target = join(ws, '.agents-playbook');
  ok('the scaffolded playbook has a master and an engine',
    existsSync(join(target, 'playbook.yaml')) && existsSync(join(target, 'scripts', 'pb.mjs')));
  // js-yaml reaches the workspace engine the same way it reached the plugin: by the
  // project root's node_modules. Give the workspace that copy, as npm would.
  mkdirSync(join(ws, 'node_modules'), { recursive: true });
  cpSync(resolve('node_modules', 'js-yaml'), join(ws, 'node_modules', 'js-yaml'), { recursive: true });
  const v = spawnSync(process.execPath, [join(target, 'scripts', 'pb.mjs'), 'validate'], { cwd: target, encoding: 'utf8' });
  ok('the scaffolded playbook validates and runs', v.status === 0, `exit=${v.status}\n${v.stdout}${v.stderr}`.slice(0, 500));
  const st = spawnSync(process.execPath, [join(target, 'scripts', 'pb.mjs'), 'status', '--json'], { cwd: target, encoding: 'utf8' });
  let status = null;
  try { status = JSON.parse(st.stdout); } catch { /* reported below */ }
  ok('the scaffolded playbook orients (status --json is machine-readable)',
    status?.schema === 'agent-playbook.status.v1', `exit=${st.status}\n${st.stdout}`.slice(0, 300));

  rmSync(hostRoot, { recursive: true, force: true });
}

rmSync(work, { recursive: true, force: true });
console.log(`\ntest-dsh-plugin-published: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

