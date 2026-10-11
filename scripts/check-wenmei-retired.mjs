#!/usr/bin/env node
// ============================================================================
//  check-wenmei-retired.mjs — the Flow room's dependence direction is retired, and it stays
//  one-way.
// ----------------------------------------------------------------------------
//  The room was extracted OUT of the Wenmei playground (`app_design`) into `apps/flow-room` and
//  pinned at one commit. Extracting is not the same as retiring: the playground still holds a
//  full copy of the room (FlowRoom, FlowCards, FlowEdges, FlowInspector, FlowSteeringDock,
//  LoopCanvas, reached through StageLayer), and a copy that nobody calls retired is a second
//  source of truth waiting to happen.
//
//  This gate holds the direction down on four points:
//    1. NO REACH-BACK — nothing the room ships reaches into the Wenmei tree. Comments that
//       mention Wenmei are fine and stay: they are provenance ("copied, not depended on"). This
//       looks for DEPENDENCY shapes only — imports, requires, path escapes, package deps.
//    2. THE PIN IS TRUTHFUL — PROVENANCE.json still records where the copy came from, at a real
//       commit, in a checkout that still exists. A pin that names a directory which is gone
//       cannot be re-verified, and reads as provenance without being any.
//    3. THE PLAYGROUND SAYS SO — `app_design/TOMBSTONE.md` names the new home and the pinned
//       commit, so the next person to open the playground learns the room moved before they
//       edit the copy. When the Wenmei checkout is not present this SKIPS, loudly and visibly:
//       an unreachable source must never read as a pass (same rule as the provenance gate).
//    4. THE DIRECTION IS WRITTEN DOWN HERE TOO — `docs/flow-room-retirement.md` records the
//       one-way rule in this repo, where the room's maintainers are.
//
//  Usage: node scripts/check-wenmei-retired.mjs [--json]
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'flow-room');
const PROVENANCE = join(APP, 'PROVENANCE.json');
const RECORD = join(ROOT, 'docs', 'flow-room-retirement.md');
const SOURCE_REPO = process.env.PB_FLOW_SOURCE || 'D:\\HermesProjects\\Wenmei\\wenmei';
const TOMBSTONE = join(SOURCE_REPO, 'app_design', 'TOMBSTONE.md');
const PIN_RE = /^[0-9a-f]{40}$/;

const problems = [];
const notes = [];
const check = (ok, message) => { if (!ok) problems.push(message); };
const runGit = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ── 1. no reach-back ───────────────────────────────────────────────────────
//  RESOLUTION, not vocabulary. Three kinds of "wenmei" string exist in this tree and only one
//  of them is a dependence:
//    · a comment ("copied, not depended on") — documentation; deleting it would make the copy
//      LESS auditable, so it stays;
//    · DATA in a fixture — `mocks/flow-graph-live.ts` is the v1 snapshot, and its records embed
//      the historical worktree paths the extraction came from. That is recorded history. It does
//      not resolve anything, and rewriting history to satisfy a gate would be the gate lying;
//    · a RESOLUTION — an import, a require, a package dependency, a configured path. That is a
//      dependence, and it is what this section fails on, wherever it appears.
//  Path-shaped strings are therefore only fatal OUTSIDE the fixtures, and the fixtures are
//  counted and reported instead of ignored.
const IMPORT_PATTERNS = [
  { re: /(?:from|require\(|import\()\s*["'][^"']*(?:wenmei|app_design)[^"']*["']/i, about: 'an import/require pointing into the Wenmei tree' },
];
const PATH_PATTERNS = [
  { re: /["'][^"']*(?:\.\.\/){2,}[^"']*Wenmei[\\/]/i, about: 'a relative path escaping into a Wenmei checkout' },
  { re: /["'][A-Za-z]:[\\/][^"']*Wenmei[\\/]/i, about: 'an absolute path into a Wenmei checkout' },
  { re: /["'](?:\.\.\/)+app_design\//i, about: 'a relative path into app_design' },
];
const isFixtureData = (file) => /[\\/]mocks[\\/]/.test(file);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:ts|tsx|mjs|js|jsx|css|json|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const shipped = [
  ...walk(join(APP, 'src')),
  join(APP, 'server.mjs'),
  join(APP, 'package.json'),
].filter((f) => existsSync(f) && statSync(f).isFile());

const reachBacks = [];
let fixturePathMentions = 0;
for (const file of shipped) {
  // PROVENANCE.json and the app README are *about* the origin; they are allowed to name it.
  if (file === PROVENANCE || /README\.md$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const { re, about } of IMPORT_PATTERNS) {
    if (re.test(stripped)) reachBacks.push(`${file.slice(ROOT.length + 1)} — ${about}`);
  }
  for (const { re, about } of PATH_PATTERNS) {
    if (!re.test(stripped)) continue;
    if (isFixtureData(file)) { fixturePathMentions += 1; continue; }
    reachBacks.push(`${file.slice(ROOT.length + 1)} — ${about}`);
  }
}
if (fixturePathMentions) {
  notes.push(
    `${fixturePathMentions} fixture file(s) under src/room/mocks record historical Wenmei paths as DATA ` +
    '(the v1 snapshot the room was extracted from). They resolve nothing and are reported, not hidden.'
  );
}
check(reachBacks.length === 0,
  `the room reaches back into Wenmei (${reachBacks.length}):\n      ${reachBacks.join('\n      ')}`);

// package.json dependencies must not name a wenmei package either
const appPkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
const depsNaming = Object.keys({ ...appPkg.dependencies, ...appPkg.devDependencies })
  .filter((d) => /wenmei/i.test(d));
check(depsNaming.length === 0, `apps/flow-room/package.json depends on ${depsNaming.join(', ')}`);

// ── 2. the pin is truthful ─────────────────────────────────────────────────
if (!existsSync(PROVENANCE)) {
  problems.push('apps/flow-room/PROVENANCE.json is missing — the copy has no recorded origin');
} else {
  const prov = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  const commit = prov?.source?.commit;
  const repo = prov?.source?.repo;
  check(typeof commit === 'string' && PIN_RE.test(commit),
    `PROVENANCE.json does not pin a full commit sha (got ${JSON.stringify(commit)})`);
  check(typeof repo === 'string' && repo.length > 0,
    'PROVENANCE.json does not record the source repo');
  if (typeof repo === 'string' && repo.length > 0) {
    // The recorded path must still exist. It named a de-registered worker worktree once: the
    // pin still "looked" auditable while pointing at a directory that no longer existed.
    check(existsSync(repo),
      `PROVENANCE.json records the source repo as ${repo}, which does not exist — the pin cannot be re-verified against it`);
    if (!existsSync(repo)) {
      notes.push(`point source.repo at the surviving checkout (${SOURCE_REPO}) so the pin stays checkable`);
    }
    check(!/[\\/]\.worktrees[\\/]/i.test(repo),
      `PROVENANCE.json points at a worktree (${repo}) rather than a durable checkout — worktrees are de-registered`);
  }
  check((prov?.files && Object.keys(prov.files).length > 0) === true,
    'PROVENANCE.json records no file hashes, so "faithful copy" is unverifiable');
}

// ── 3. the playground says so ──────────────────────────────────────────────
const sourceReachable = existsSync(join(SOURCE_REPO, 'app_design'));
if (!sourceReachable) {
  notes.push(`SKIPPED the playground tombstone check: no Wenmei checkout at ${SOURCE_REPO} (set PB_FLOW_SOURCE to check it)`);
} else if (!existsSync(TOMBSTONE)) {
  problems.push('the Wenmei playground has no app_design/TOMBSTONE.md — the retired copy is still described as nothing in particular');
} else {
  const tomb = readFileSync(TOMBSTONE, 'utf8');
  check(/apps[\\/]flow-room/.test(tomb),
    'TOMBSTONE.md does not name apps/flow-room as the room\'s home');
  check(/33fdcea/i.test(tomb),
    'TOMBSTONE.md does not name the commit the copy was taken from, so it cannot be tied to the pin');
  check(/one[- ]way|direction/i.test(tomb),
    'TOMBSTONE.md does not state the dependence DIRECTION');
  check(/Agents-Playbook/i.test(tomb),
    'TOMBSTONE.md does not name the repo that now owns the room');
}

// ── 4. the direction is written down here too ──────────────────────────────
if (!existsSync(RECORD)) {
  problems.push('docs/flow-room-retirement.md is missing — the direction is only asserted, never written down');
} else {
  const rec = readFileSync(RECORD, 'utf8');
  check(/apps[\\/]flow-room/.test(rec), 'the retirement record does not name apps/flow-room');
  check(/Wenmei/i.test(rec), 'the retirement record does not name Wenmei');
  check(/one[- ]way|does not (?:read|depend)|no (?:reach|dependence)/i.test(rec),
    'the retirement record does not state the one-way rule');
  // A record that exists only on this disk is not a record. `docs/*` is gitignored by default
  // in this repo with published contracts whitelisted, so "the file is there" passed while the
  // file was untracked — the gate would have been green here and unfalsifiable on a clone.
  const tracked = (() => {
    try {
      runGit(['ls-files', '--error-unmatch', 'docs/flow-room-retirement.md']);
      return true;
    } catch { return false; }
  })();
  check(tracked, 'docs/flow-room-retirement.md exists but is NOT tracked by git (docs/* needs whitelisting) — the record would not survive a clone');
}

// ── report ─────────────────────────────────────────────────────────────────
console.log('Flow room × Wenmei — dependence direction retired');
console.log(`  shipped files scanned for reach-back : ${shipped.length}`);
console.log(`  pinned source                        : ${JSON.parse(readFileSync(PROVENANCE, 'utf8'))?.source?.commit?.slice(0, 12) ?? '—'}`);
console.log(`  playground tombstone                  : ${sourceReachable ? (existsSync(TOMBSTONE) ? 'present' : 'MISSING') : 'not reachable'}`);
console.log(`  repo-side record                     : ${existsSync(RECORD) ? 'present' : 'MISSING'}`);
for (const n of notes) console.log(`  note: ${n}`);

if (problems.length) {
  console.error(`\nWENMEI RETIREMENT FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe room lives in apps/flow-room, the playground copy is retired, and the direction is written down.');
