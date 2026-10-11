#!/usr/bin/env node
// ============================================================================
//  check-wenmei-retired.mjs — the Flow room's dependence direction is retired, and it stays
//  one-way.
// ----------------------------------------------------------------------------
//  The room was extracted OUT of the Wenmei playground (`app_design`) into `apps/flow-room` and
//  pinned at one commit. Extracting is not retiring: the playground still holds a full copy of
//  the room, and a copy nobody calls retired is a second source of truth waiting to happen.
//
//  FOUR ASSERTIONS
//    1. NO RESOLUTION — nothing the app ships resolves a Wenmei path: imports, requires, dynamic
//       imports, path-shaped strings, `file:` values, dependency names AND values. Comments are
//       documentation and fixture DATA is history; both are allowed, and both are reported.
//    2. THE PIN IS TRUTHFUL — PROVENANCE.json pins a full sha that git agrees is a real commit
//       in a real checkout, an ancestor of that repo's HEAD, in a directory that is not a
//       worktree, with file hashes recorded. Shape alone is not truth.
//    3. THE PLAYGROUND SAYS SO — `app_design/TOMBSTONE.md` names the new home, this repo, the
//       pinned commit and the direction.
//    4. THE DIRECTION IS WRITTEN DOWN HERE TOO — docs/flow-room-retirement.md, and it must be
//       TRACKED, not merely present on this disk.
//
//  WHAT THE FIRST VERSION OF THIS GATE GOT WRONG, kept here because it is the useful part of its
//  history. An independent checker took it apart AFTER it had been mutation-tested six ways:
//    · its comment stripper was a regex (`/*…*/`), not a scanner, so prose containing `/*` —
//      `// … a thin /api/* that …` in server.mjs — opened a match that closed 95 lines later and
//      silently deleted every real import in between. Testing the ASSERTIONS is not testing the
//      SCANNER; the input path is part of the check.
//    · it walked only `src/`, `server.mjs` and `package.json`, so root configs and `index.html`
//      were never read.
//    · it pruned dot-directories and skipped `.cjs`/`.mts`.
//    · it matched only forward-slash relative paths, so a Windows backslash escape or a path
//      split across `join("..","..","Wenmei")` walked straight through.
//    · it read dependency NAMES from two of the four dependency-bearing fields.
//    · it checked the pin's shape and not its truth — a forty-zero commit passed.
//    · it claimed an unreachable source is never a pass while exiting 0 when the source was
//      absent, which is exactly what a `&&`-chained gate must not do silently.
//  Every escape above is now a case in `scripts/test-wenmei-retired-teeth.mjs`.
//
//  Usage: node scripts/check-wenmei-retired.mjs [--root <dir>] [--require-source] [--json]
//         PB_FLOW_SOURCE=<checkout>          PB_FLOW_REQUIRE_SOURCE=1
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ROOT = resolve(valueOf('--root', resolve(dirname(fileURLToPath(import.meta.url)), '..')));
const APP = join(ROOT, 'apps', 'flow-room');
const PROVENANCE = join(APP, 'PROVENANCE.json');
const RECORD_REL = 'docs/flow-room-retirement.md';
const RECORD = join(ROOT, RECORD_REL);
const SOURCE_REPO = process.env.PB_FLOW_SOURCE || 'D:\\HermesProjects\\Wenmei\\wenmei';
const TOMBSTONE = join(SOURCE_REPO, 'app_design', 'TOMBSTONE.md');
const REQUIRE_SOURCE = flag('--require-source') || process.env.PB_FLOW_REQUIRE_SOURCE === '1';
const PIN_RE = /^[0-9a-f]{40}$/;

const problems = [];
const notes = [];
const check = (ok, message) => { if (!ok) problems.push(message); };
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const isTracked = (rel) => { try { git(ROOT, ['ls-files', '--error-unmatch', rel]); return true; } catch { return false; } };

// ── the scanner ────────────────────────────────────────────────────────────
//  A character walk, not a regex. It blanks comments to spaces (preserving line count) and
//  collects string-literal values, so a `/*` inside prose or a quote inside a comment cannot
//  swallow the file, and a path split across `join("..","..","Wenmei")` is still visible as its
//  own segments.
const SCAN_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|json|css|html|htm|yaml|yml|toml)$/;
function scanText(text) {
  let out = '';
  const strings = [];
  let i = 0;
  const n = text.length;
  let state = 'code'; // code | line | block
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        let value = '';
        out += c;
        i += 1;
        while (i < n) {
          const d = text[i];
          // Keep the RAW text. Un-escaping (`\t` → a tab, and worse, `\W` → `W`) destroys
          // Windows path separators, which is exactly what a path rule looks for — an html
          // `src="D:\…\app_design\…"` became `D:…app_design…` and walked through.
          if (d === '\\') { value += d + (text[i + 1] ?? ''); out += d + (text[i + 1] ?? ''); i += 2; continue; }
          if (d === quote) { out += d; i += 1; break; }
          value += d; out += d; i += 1;
        }
        strings.push(value);
        continue;
      }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    // block comment
    if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }
  return { code: out, strings };
}

//  What counts as a dependence, precisely. NAMING the other checkout is not the same as being
//  able to RESOLVE it: this repo legitimately carries the string "Paint the Wenmei backlog-graph
//  (React Flow) design" as a goal, and comments explain the origin. So a path-shaped rule needs a
//  SEPARATOR adjacency — `wenmei` as a path SEGMENT (`…/wenmei/…`, `..\Wenmei\`, a bare
//  `"Wenmei"` segment in a `join(...)`) — while an IMPORT specifier is resolution whatever its
//  shape, because the module system will act on it.
const MENTIONS = /wenmei|app_design/i;
const SEGMENT = /(?:^|[\\/])(?:wenmei|app_design)(?:[\\/]|$)/i;
const SPECIFIER = /(?:from|require\(|import\()\s*["'`]([^"'`]*)["'`]/gi;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    // Only these three are pruned. Dot-directories are NOT: `src/.reach/` was a proven escape.
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

// ── 1. no resolution ───────────────────────────────────────────────────────
const shipped = existsSync(APP) ? walk(APP).filter((f) => statSync(f).isFile()) : [];
const reachBacks = [];
const fixtureHits = new Set();
for (const file of shipped) {
  // These two are *about* the origin; recording it is their purpose.
  if (file === PROVENANCE || /README\.md$/i.test(file)) continue;
  const rel = file.slice(APP.length + 1).replace(/\\/g, '/');
  const isFixture = /(^|\/)mocks\//.test(rel);
  const text = readFileSync(file, 'utf8');
  const fatal = (about) => { if (isFixture) fixtureHits.add(rel); else reachBacks.push(`${rel} — ${about}`); };

  if (/\.json$/i.test(file)) {
    // Dependency NAMES and VALUES, in every dependency-bearing field — not two of four.
    let pkg;
    try { pkg = JSON.parse(text); } catch { continue; }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions']) {
      const block = pkg[field];
      if (!block || typeof block !== 'object') continue;
      for (const [name, val] of Object.entries(block)) {
        if (MENTIONS.test(name)) fatal(`${field}["${name}"] names the Wenmei tree`);
        const asText = typeof val === 'string' ? val : JSON.stringify(val ?? '');
        if (SEGMENT.test(asText)) fatal(`${field}["${name}"] = ${asText.slice(0, 60)} resolves into the Wenmei tree`);
      }
    }
    continue;
  }

  const { code, strings } = scanText(text);
  // An import specifier is resolution whatever it looks like.
  for (const m of code.matchAll(SPECIFIER)) {
    if (MENTIONS.test(m[1])) fatal(`an import/require names the Wenmei tree: "${m[1].slice(0, 48)}"`);
  }
  // A path-SHAPED literal is resolution: `…/wenmei/…`, `..\Wenmei\`, a bare "Wenmei" segment.
  for (const s of strings) if (SEGMENT.test(s)) fatal(`a path-shaped literal reaches into Wenmei: "${s.slice(0, 48)}"`);
}
if (fixtureHits.size) {
  notes.push(
    `${fixtureHits.size} fixture file(s) under src/room/mocks record historical Wenmei paths as DATA ` +
    `(${[...fixtureHits].join(', ')}). They resolve nothing and are reported, not hidden.`
  );
}
check(reachBacks.length === 0,
  `the app resolves into Wenmei (${reachBacks.length}):\n      ${[...new Set(reachBacks)].join('\n      ')}`);

// ── 2. the pin is truthful ─────────────────────────────────────────────────
let pin = null;
if (!existsSync(PROVENANCE)) {
  problems.push('apps/flow-room/PROVENANCE.json is missing — the copy has no recorded origin');
} else {
  pin = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  const commit = pin?.source?.commit;
  const repo = pin?.source?.repo;
  check(typeof commit === 'string' && PIN_RE.test(commit),
    `PROVENANCE.json does not pin a full commit sha (got ${JSON.stringify(commit)})`);
  check(typeof repo === 'string' && repo.length > 0, 'PROVENANCE.json does not record the source repo');
  if (typeof repo === 'string' && repo.length > 0) {
    check(existsSync(repo), `PROVENANCE.json records the source repo as ${repo}, which does not exist`);
    // A worktree is de-registered the moment its branch merges, so a pin must never name one —
    // and no trailing separator is needed for `.worktrees` to be the wrong thing.
    check(!/[\\/]\.worktrees(?:[\\/]|$)/i.test(repo),
      `PROVENANCE.json points at a worktree (${repo}) rather than a durable checkout — worktrees are de-registered`);
    check((pin?.files && Object.keys(pin.files).length > 0) === true,
      'PROVENANCE.json records no file hashes, so "faithful copy" is unverifiable');
    // TRUTH, not shape: git must agree the commit is real and reachable from that repo's HEAD.
    if (PIN_RE.test(commit) && existsSync(repo)) {
      let kind = null;
      try { kind = git(repo, ['cat-file', '-t', commit]).trim(); } catch { kind = null; }
      check(kind === 'commit',
        `git does not know ${commit.slice(0, 12)} in ${repo} (cat-file -t returned ${JSON.stringify(kind)}) — the pin names something that is not a commit there`);
      if (kind === 'commit') {
        let ancestor = false;
        try { git(repo, ['merge-base', '--is-ancestor', commit, 'HEAD']); ancestor = true; } catch { ancestor = false; }
        check(ancestor,
          `${commit.slice(0, 12)} is not an ancestor of ${repo}'s HEAD — the pinned revision is not part of the checkout it claims to come from`);
      }
    }
  }
}

// ── 3. the playground says so ──────────────────────────────────────────────
const sourceReachable = existsSync(join(SOURCE_REPO, 'app_design'));
let tombstoneState = 'not reachable';
if (!sourceReachable) {
  tombstoneState = 'NOT EVALUATED (no checkout)';
  if (REQUIRE_SOURCE) {
    problems.push(`no Wenmei checkout at ${SOURCE_REPO} and --require-source was given: the tombstone assertion was NOT evaluated`);
  } else {
    notes.push(
      `NOT EVALUATED: no Wenmei checkout at ${SOURCE_REPO}, so assertion 3 (the playground tombstone) did not run. ` +
      'Point PB_FLOW_SOURCE at a checkout, or pass --require-source to make its absence fatal.'
    );
  }
} else if (!existsSync(TOMBSTONE)) {
  tombstoneState = 'MISSING';
  problems.push('the Wenmei playground has no app_design/TOMBSTONE.md — the retired copy is still described as nothing in particular');
} else {
  tombstoneState = 'present';
  const tomb = readFileSync(TOMBSTONE, 'utf8');
  check(/apps[\\/]flow-room/.test(tomb), "TOMBSTONE.md does not name apps/flow-room as the room's home");
  check(/Agents-Playbook/i.test(tomb), 'TOMBSTONE.md does not name the repo that now owns the room');
  if (pin?.source?.commit) {
    check(new RegExp(pin.source.commit.slice(0, 7), 'i').test(tomb),
      `TOMBSTONE.md does not name the pinned commit (${pin.source.commit.slice(0, 7)})`);
  }
  check(/one[- ]way|direction/i.test(tomb), 'TOMBSTONE.md does not state the dependence DIRECTION');
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
  // A record that exists only on this disk is not a record: `docs/*` is gitignored here with
  // published contracts whitelisted, so "the file is there" passed while it was untracked.
  check(isTracked(RECORD_REL),
    'docs/flow-room-retirement.md exists but is NOT tracked by git (docs/* needs whitelisting) — the record would not survive a clone');
}

// ── report ─────────────────────────────────────────────────────────────────
const summary = {
  schema: 'agent-playbook.wenmei-retired.v1',
  root: ROOT,
  scanned_files: shipped.length,
  reach_backs: [...new Set(reachBacks)],
  fixture_data_files: [...fixtureHits],
  pin: pin?.source?.commit ?? null,
  source_repo: SOURCE_REPO,
  source_reachable: sourceReachable,
  tombstone: tombstoneState,
  record_tracked: existsSync(RECORD) ? isTracked(RECORD_REL) : false,
  problems,
  notes,
};
if (flag('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('Flow room × Wenmei — dependence direction retired');
  console.log(`  scanned for resolution : ${shipped.length} file(s) — the whole app tree (configs, html, .cjs/.mts, dot-dirs included)`);
  console.log(`  pinned source          : ${summary.pin ? `${summary.pin.slice(0, 12)} (git-verified: real commit, ancestor of HEAD)` : '—'}`);
  console.log(`  playground tombstone   : ${tombstoneState}`);
  console.log(`  repo-side record       : ${existsSync(RECORD) ? (summary.record_tracked ? 'present and tracked' : 'present but UNTRACKED') : 'MISSING'}`);
  for (const n of notes) console.log(`  note: ${n}`);
}

if (problems.length) {
  console.error(`\nWENMEI RETIREMENT FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe room lives in apps/flow-room, the playground copy is retired, and the direction is written down.');
