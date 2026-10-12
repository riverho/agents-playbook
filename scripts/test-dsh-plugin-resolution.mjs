#!/usr/bin/env node
// scripts/test-dsh-plugin-resolution.mjs
// ----------------------------------------------------------------------------
// Package RESOLUTION from a profile directory — the precondition for a boot.
//
// The composition suite proves the loader builds a tree containing the plugin row, but
// `--dump-config` composes WITHOUT importing, so it says nothing about whether the named
// package can actually be resolved. That is the next failure mode in line, and it is
// checkable: put the package where a profile would have it and ask node to resolve it from
// there, exactly as the loader's import would.
//
// It also pins the shim convention the plugin's engine copy depends on:
//   <project>/node_modules/dsh-agents-playbook/engine/scripts/pb.mjs
// resolves `js-yaml` by walking up to <project>/node_modules — which is why the engine the
// plugin scaffolds into a workspace can run at all, and why the plugin declares js-yaml.
//
// What this does NOT prove: that the plugin's `apply()` runs correctly inside a live
// profile. That needs a boot, and a boot either serves the Web UI or runs an LLM task —
// neither is something a test suite should do unasked. RELEASE.md states that gap.
// ----------------------------------------------------------------------------

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './lib/test-temp.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const pluginPkg = JSON.parse(readFileSync(resolve('dsh-plugin/package.json'), 'utf8'));
const pluginDir = resolve('dsh-plugin');

function harnessDir() {
  const candidates = [
    process.env.DSH_PACKAGES,
    'C:/Users/RH/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai',
  ].filter(Boolean);
  return candidates.find((d) => existsSync(join(d, 'dsh-tools', 'package.json'))) || null;
}

// --- build a profile-shaped directory ---------------------------------------
const work = tempDir('pbresolve-');
const dshHome = join(work, 'dsh');
const profile = join(dshHome, 'profiles', 'probe');
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'cordis.yml'), '[]\n');
writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-probe',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pluginPkg.name], patchReload: 'live' } },
}, null, 2) + '\n');

// The plugin, placed where an install would put it. Derived from the manifest's own name
// so a rename cannot silently relocate it: an npm install layout IS the package name.
const installedPluginDir = join(profile, 'node_modules', pluginPkg.name);
mkdirSync(dirname(installedPluginDir), { recursive: true });
try { symlinkSync(pluginDir, installedPluginDir, 'junction'); } catch { /* exists */ }

const resolveFrom = (spec) => {
  try {
    return { ok: true, path: execFileSync(process.execPath, ['-e', `process.stdout.write(require.resolve(${JSON.stringify(spec)}))`],
      { cwd: profile, encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message).split('\n').slice(0, 3).join(' ') };
  }
};
const importFrom = (spec) => {
  try {
    execFileSync(process.execPath, ['-e', `import(${JSON.stringify(spec)}).then(()=>process.stdout.write('LOADED'))`],
      { cwd: profile, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message).split('\n').filter((l) => /Error|error/.test(l)).slice(0, 2).join(' ') };
  }
};

// --- 1. the profile declares the plugin as a bundle --------------------------
// The plugin ships `dsh.bundle.patch`, so listing the package IS the mount. This asserts
// the manifest side of that contract, without which the documented install would need a
// hand-written row.
{
  ok('the plugin manifest declares a bundle patch', !!pluginPkg.dsh?.bundle?.patch, JSON.stringify(pluginPkg.dsh));
  ok('the declared patch file is shipped in `files`',
    Array.isArray(pluginPkg.files) && pluginPkg.files.includes('cordis.patch.yml')
    && existsSync(join(pluginDir, 'cordis.patch.yml')));
  ok('the profile lists the plugin as a bundle', readFileSync(join(profile, 'package.json'), 'utf8').includes(pluginPkg.name));
}

// --- 2. the package resolves from the profile --------------------------------
{
  const r = resolveFrom(`${pluginPkg.name}/package.json`);
  ok('the plugin package resolves from the profile directory', r.ok, r.err);
  const entry = resolveFrom(pluginPkg.name);
  ok('the plugin ENTRY resolves (so a boot could import it)', entry.ok, entry.err);
  const core = resolveFrom(`${pluginPkg.name}/core`);
  ok('the plugin\'s core export resolves (the subpath an integrator may import)',
    core.ok && /core\.mjs$/.test(core.path || ''), `${core.err || ''} ${core.path || ''}`);
}

// --- 3. the harness peers resolve, or the plugin cannot load -----------------
{
  const harness = harnessDir();
  if (!harness) {
    console.log('  SKIP  harness packages unavailable — peer resolution not checked (set DSH_PACKAGES)');
  } else {
    // A profile resolves harness packages through the launcher's module fallback; model
    // that by placing them where the profile can see them, then assert the peers the
    // plugin DECLARES are actually resolvable. A missing peer is an import error at boot.
    mkdirSync(join(profile, 'node_modules', '@deepseek-ai'), { recursive: true });
    for (const peer of Object.keys(pluginPkg.peerDependencies || {})) {
      const name = peer.replace('@deepseek-ai/', '');
      const from = join(harness, name);
      if (!existsSync(from)) continue;
      try { symlinkSync(from, join(profile, 'node_modules', '@deepseek-ai', name), 'junction'); } catch { /* exists */ }
    }
    const missing = [];
    for (const peer of Object.keys(pluginPkg.peerDependencies || {})) {
      const r = resolveFrom(`${peer}/package.json`);
      if (!r.ok) missing.push(peer);
    }
    ok('every declared peer dependency resolves from the profile', missing.length === 0,
      `missing: ${missing.join(', ')}`);
    ok('the plugin package loads and imports its peers (the precondition for apply())',
      importFrom(pluginDir.replace(/\\/g, '/')).ok || importFrom(`file:///${join(installedPluginDir, 'index.js').replace(/\\/g, '/')}`).ok,
      'neither the bare nor the file path import succeeded');
  }
}

// --- 4. the bundled engine resolves its dependency the way a deploy relies on ---
// The engine copy the plugin scaffolds into a workspace lives under the project's
// node_modules, so it finds js-yaml by walking up. If that stopped being true, every
// scaffolded playbook would fail on its first command.
{
  const bundledPb = join(pluginDir, 'engine', 'scripts', 'pb.mjs');
  if (!existsSync(bundledPb)) {
    console.log('  SKIP  plugin bundle not built — run `npm run build:plugin`');
  } else {
    const projectRoot = join(work, 'project');
    const target = join(projectRoot, '.agents-playbook');
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    mkdirSync(target, { recursive: true });
    // A real install has the plugin (and its js-yaml) at the project root.
    const yaml = resolve('node_modules', 'js-yaml');
    try { symlinkSync(yaml, join(projectRoot, 'node_modules', 'js-yaml'), 'junction'); } catch { /* exists */ }
    const r = execFileSync(process.execPath, [bundledPb, 'scaffold', '--target', target],
      { cwd: pluginDir, encoding: 'utf8' });
    ok('the bundled engine scaffolds from its own location', /Scaffolded/i.test(r), r.slice(0, 200));
    const v = (() => {
      try {
        execFileSync(process.execPath, [join(target, 'scripts', 'pb.mjs'), 'validate'], { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true };
      } catch (e) { return { ok: false, err: `${e.stdout || ''}${e.stderr || ''}`.slice(0, 300) }; }
    })();
    ok('the scaffolded playbook runs (its engine found js-yaml by walking up to the project)',
      v.ok, v.err);
  }
}

rmSync(work, { recursive: true, force: true });
console.log('\nNote: this proves RESOLUTION, not a live apply(). A boot stays the human step in RELEASE.md.');
console.log(`\ntest-dsh-plugin-resolution: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
