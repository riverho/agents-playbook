#!/usr/bin/env node
// scripts/test-dsh-plugin-profile.mjs
// ----------------------------------------------------------------------------
// Mounts the plugin ON TOP OF A REAL DSH PROFILE through the documented `--patch`
// overlay and reads the composed tree back. Nothing on disk is modified.
//
// What this proves that the unit suites cannot:
//   - the loader ACCEPTS this patch shape. A rejected patch is a silent no-op, so
//     "my cordis.patch.yml looks right" is not evidence; a composed tree containing the
//     row is.
//   - the composed config agrees with what the plugin declares as its defaults, so a
//     deployment that copy-pastes the patch is not silently configuring something else.
//
// What it explicitly does NOT prove, and says so: that a live session loads the module.
// `--dump-config` composes the tree without importing it, and the harness packages are
// resolved by the launcher's module fallback rather than from the profile directory — so
// package resolution needs a boot, and a boot needs a live app. That remains the human
// step in RELEASE.md.
//
// Skips honestly when no dsh CLI is discoverable, or when the discoverable CLI's own
// harness packages are incomplete (see the guard below — a suite that FAILS because a
// peer dependency is absent is a red the repo cannot fix, and project-memory rule 11
// says such a suite must SKIP instead).
// ----------------------------------------------------------------------------

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// --- locate a dsh CLI and a profile to mount onto ----------------------------
const DSH_CANDIDATES = [
  process.env.DSH_BIN,
  join(process.env.DSH_HOME || '', '..', 'dsh.cmd'),
  'C:/Users/RH/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/.bin/dsh.cmd',
].filter(Boolean);
const dshBin = DSH_CANDIDATES.find((p) => existsSync(p));
// On Windows the discovered `dsh` is a `.cmd` shim, which node cannot execute directly
// and which needs a shell to launch. Wrap it with cmd.exe explicitly (the project's
// established shim convention) rather than passing `shell: true`, which is deprecated
// and loses argument escaping.
const runDsh = (args) => (process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/c', dshBin, ...args], { encoding: 'utf8', timeout: 180_000 })
  : spawnSync(dshBin, args, { encoding: 'utf8', timeout: 180_000 }));
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
const profile = process.env.DSH_TEST_PROFILE || 'web';
const profileDir = join(dshHome, 'profiles', profile);
if (!dshBin || !existsSync(profileDir)) {
  console.log('  SKIP  no dsh CLI / profile discoverable — set DSH_BIN and DSH_TEST_PROFILE to run this suite');
  console.log('\ntest-dsh-plugin-profile: skipped (0 pass, 0 fail)');
  process.exit(0);
}

// The discovered `dsh` shim is only usable when the harness packages it resolves against are
// actually installed. On this box the npx cache holds a directory that HAS `dsh-tools` but is
// MISSING `cordis` and its siblings — so `dsh --dump-config` cannot run and the probe imports
// fail, which used to surface as 10 FAILs for an absent dependency rather than a skip. Detect
// completeness explicitly: every package this suite needs must be present, or the suite skips.
const HARNESS_REQUIRED = ['dsh-tools', 'dsh-skill', 'dsh-llm', 'cordis', 'schemastery'];
function harnessCandidates() {
  return [
    process.env.DSH_PACKAGES,
    'C:/Users/RH/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai',
  ].filter(Boolean);
}
function harnessDir() {
  return harnessCandidates().find((d) => existsSync(join(d, 'dsh-tools', 'package.json'))) || null;
}
function completeHarnessDir() {
  return harnessCandidates().find((d) =>
    HARNESS_REQUIRED.every((p) => existsSync(join(d, p, 'package.json')))) || null;
}
{
  const harness = harnessDir();
  const complete = completeHarnessDir();
  if (!complete) {
    const missing = harness
      ? HARNESS_REQUIRED.filter((p) => !existsSync(join(harness, p, 'package.json')))
      : HARNESS_REQUIRED;
    console.log(`  SKIP  the discoverable dsh CLI's harness packages are incomplete (missing: ${missing.join(', ')})`);
    console.log('        a failure here would be a red this repo cannot fix — set DSH_PACKAGES to a complete');
    console.log('        @deepseek-ai directory to run this suite against real packages (rule 11: skip, never fail)');
    console.log('\ntest-dsh-plugin-profile: skipped (0 pass, 0 fail)');
    process.exit(0);
  }
}

const pluginPkg = JSON.parse(readFileSync(resolve('dsh-plugin/package.json'), 'utf8'));
const patchPath = resolve('scripts/fixtures/dsh-plugin-probe.patch.yml');
ok('the probe overlay exists', existsSync(patchPath), patchPath);

// Harness packages are resolved by `harnessDir()` / `completeHarnessDir()` above; the
// completeness guard has already run, so section 3 can rely on a complete directory.

// --- 1. the loader accepts the plugin's patch shape --------------------------
let tree = '';
{
  const r = runDsh(['--profile', profile, '--patch', patchPath, '--dump-config']);
  tree = `${r.stdout || ''}${r.stderr || ''}`;
  ok('the profile composes with the plugin overlay applied', r.status === 0 && tree.length > 0,
    `exit=${r.status}\n${tree.slice(0, 400)}`);
  ok('the composed tree CONTAINS the plugin row (a rejected patch would be a silent no-op)',
    tree.includes(pluginPkg.name), tree.slice(-600));
  ok('the row is inserted with the id the patch asks for', /id:\s*agent-playbook-probe/.test(tree));
  ok('the overlay is attributed as a patch layer (so the origin is traceable)',
    /# == .*dsh-plugin-probe\.patch\.yml/.test(tree), tree.slice(-400));
}

// --- 2. the composed config matches the plugin's declared defaults -----------
// A deployment copies this patch; if the composed values drifted from the package's
// declared defaults, the documented config would be lying.
{
  const row = /- id:\s*agent-playbook-probe[\s\S]*?(?=\n- id:|\s*$)/.exec(tree)?.[0] || '';
  ok('playbookPath defaults to discovery (empty)', /playbookPath:\s*''/.test(row), row);
  ok('context injection is on by default', /injectContext:\s*true/.test(row), row);
  ok('idle quiet is on by default', /quietWhenIdle:\s*true/.test(row), row);
  ok('the context cap is declared', /maxContextChars:\s*4000/.test(row), row);
  ok('the command timeout is declared', /commandTimeoutMs:\s*120000/.test(row), row);
}

// --- 3. every service the plugin injects is actually provided ----------------
// Cordis leaves a plugin inactive when an injected service never appears, and an
// inactive plugin is SILENT: the tool is simply absent, with no error explaining why.
// The composed tree is the cheapest place to catch that.
{
  // Name-matching the composed tree for a service is guesswork (a package name and the
  // service it publishes need not share a word). Assert the API the plugin actually
  // calls instead — that is the thing that would break, and it is checkable here.
  const harness = harnessDir();
  if (!harness) {
    console.log('  SKIP  harness packages unavailable — API assertions skipped (set DSH_PACKAGES)');
  } else {
    const probe = `
      const out = {};
      try {
        const skill = await import('file:///${join(harness, 'dsh-skill', 'lib', 'index.js').replace(/\\/g, '/')}');
        const reg = skill.SkillRegistry ?? skill.default;
        out.skillRegistryPresent = typeof reg === 'function';
        out.registerProviderIsMethod = typeof reg?.prototype?.registerProvider === 'function';
      } catch (e) { out.skillError = String(e.message).slice(0, 160); }
      try {
        const tools = await import('file:///${join(harness, 'dsh-tools', 'lib', 'index.js').replace(/\\/g, '/')}');
        out.defineToolPresent = typeof tools.defineTool === 'function';
      } catch (e) { out.toolsError = String(e.message).slice(0, 160); }
      try {
        const llm = await import('file:///${join(harness, 'dsh-llm', 'lib', 'index.js').replace(/\\/g, '/')}');
        out.createUserMessagePresent = typeof llm.createUserMessage === 'function';
      } catch (e) { out.llmError = String(e.message).slice(0, 160); }
      console.log('__API__' + JSON.stringify(out));
    `;
    const probePath = join(mkdtempSync(join(tmpdir(), 'pbapi-')), 'probe.mjs');
    writeFileSync(probePath, probe);
    const r = spawnSync(process.execPath, [probePath], { encoding: 'utf8', timeout: 120_000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__API__'));
    let api = {};
    try { api = JSON.parse(line.slice('__API__'.length)); } catch { /* reported below */ }
    ok('the harness exposes the skill registry class', api.skillRegistryPresent === true,
      JSON.stringify(api) + (r.stderr || '').slice(0, 200));
    ok('the skill registry API the plugin registers into exists (registerProvider)',
      api.registerProviderIsMethod === true, JSON.stringify(api));
    ok('the harness exposes defineTool (the plugin\'s tool contract)', api.defineToolPresent === true, JSON.stringify(api));
    ok('the harness exposes createUserMessage (the plugin\'s context-injection contract)',
      api.createUserMessagePresent === true, JSON.stringify(api));
  }

  // Cordis does not activate a plugin AT ALL while any declared `inject` entry is missing,
  // and `inject` has no required/optional form (the object form maps a name to intercept
  // config). So the only safe hard dependency is the tool registry; the skill registry is
  // declared at runtime via ctx.inject, which keeps the tool working in a profile that
  // ships tools without skills — otherwise the plugin would vanish silently.
  {
    const indexSrc = readFileSync(resolve('dsh-plugin/index.js'), 'utf8');
    const injectLine = /^export const inject = (\[[^\]]*\]);/m.exec(indexSrc)?.[1];
    ok('the plugin declares exactly one HARD dependency (the tool registry)',
      injectLine === "['tools']", `declared: ${injectLine}`);
    ok('the skill registry is declared at RUNTIME instead (ctx.inject)',
      /ctx\.inject\(\['skills'\]/.test(indexSrc), 'no ctx.inject([\'skills\']) found');
  }
}

// --- 4. a patch that matches nothing must be visible, not silent -------------
// The probe inserts rather than targets, so this checks the loader still accepts an
// overlay whose row is disabled — i.e. that mounting the plugin is a deliberate row,
// not something that sneaks in.
{
  const offPath = join(mkdtempSync(join(tmpdir(), 'pbpatch-')), 'disabled.yml');
  writeFileSync(offPath, `- insert:\n    - id: agent-playbook-off\n      name: '${pluginPkg.name}'\n      disabled: true\n`);
  const r = runDsh(['--profile', profile, '--patch', offPath, '--dump-config']);
  const offTree = `${r.stdout || ''}${r.stderr || ''}`;
  ok('a plugin row can be composed as disabled (mounting is deliberate)',
    r.status === 0 && /id:\s*agent-playbook-off/.test(offTree) && /disabled:\s*true/.test(offTree),
    offTree.slice(-300));
  rmSync(offPath, { force: true, recursive: true });
}

console.log('\nNote: this proves COMPOSITION, not a live load. That stays the human boot step.');
console.log(`\ntest-dsh-plugin-profile: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);



