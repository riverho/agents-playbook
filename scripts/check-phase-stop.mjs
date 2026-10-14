// ============================================================================
//  scripts/check-phase-stop.mjs
// ----------------------------------------------------------------------------
// The executable form of the active phase's stop condition. `playbook.yaml` declares
//   loop.stop_when: "node scripts/check-phase-stop.mjs"
// and exit 0 here means THE PHASE IS OVER — not "healthy, keep going".
//
// WHY THIS EXISTS. The debrief (artifacts/debrief-pb-optimization-2026-10-13.md, Part 0)
// found the loop had no terminal state: `pb checkpoint` reports DRIFT, which is a request
// for MORE work, so a finished phase looked exactly like a busy one and the injected banner
// kept asking. This script is the negative signal — one command whose exit 0 says "stop".
//
// TWO TIERS, BECAUSE ONE SPEED CANNOT SERVE BOTH CALLERS.
// The first version ran the whole suite here. Measured on this repo: 327s across 77
// commands, of which seven timeout/kill suites alone are 188s (58%). That is a fair price
// at a phase boundary and impossible on the per-turn path — `pb status --json` feeds the
// harness's per-STEP injection, so the check deciding "may the loop continue?" cost minutes
// per step. Caching the verdict on the journal seq kept the harness usable; this is the
// design fix that makes the fast path fast by construction.
//
//   (default)  --fast   "may the loop continue?"  pb validate + the terminal-state contract.
//                       Seconds. What the banner and per-turn path run.
//   --full              "is this repo sound?"     the version's declared stop_checks (the
//                       whole suite). Phase boundaries only.
//
// The tier CONTENTS are declared in `playbook.yaml` under `loop.gate_tiers`, not hard-coded
// here: which gates are cheap is a property of the project, not of this dispatcher.
//
// A version's OWN `stop_checks` ARE the full tier — closing a version is a boundary, so it
// must answer the expensive question.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PB = join(ROOT, 'scripts', 'pb.mjs');

const FULL = process.argv.includes('--full');
const tier = FULL ? 'full' : 'fast';

const clauses = [];

/** Run a command, read its OWN exit code, never let a pipeline hide it (rule 28). */
function run(file, args, { timeout = 900_000 } = {}) {
  const r = spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', timeout });
  return { code: r.status === null ? 124 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`, timedOut: r.status === null };
}

/** `loop.gate_tiers.<name>` from the master — the declared budget and commands. */
function readTier(name) {
  try {
    // js-yaml is the engine's one dependency; read the master through a tiny child so this
    // script needs no import of its own and stays runnable wherever the engine is copied.
    const script = 'const yaml=require("js-yaml"),fs=require("fs");'
      + `const m=yaml.load(fs.readFileSync(${JSON.stringify(join(ROOT, 'playbook.yaml'))},"utf8"));`
      + `process.stdout.write(JSON.stringify((m&&m.loop&&m.loop.gate_tiers&&m.loop.gate_tiers[${JSON.stringify(name)}])||null));`;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) return null;
    return JSON.parse((r.stdout || '').trim() || 'null');
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// The open version and its declared stop checks — the source of truth for this phase.
// ---------------------------------------------------------------------------
let open = null;
let versionStopChecks = [];
{
  const r = run(process.execPath, [PB, 'version', 'list', '--json']);
  if (r.code === 0) {
    try {
      const payload = JSON.parse(r.out.slice(r.out.indexOf('{')));
      open = (payload.versions || []).find((v) => v.state === 'open') || null;
    } catch { /* handled below */ }
  }
  if (!open) {
    // No open version is NOT a failure: a playbook that never adopted versions has no phase
    // to close, and refusing here would make `stop_when` red forever.
    clauses.push({ id: 'open-version', met: true, detail: 'no open version (versions unused or all closed) — nothing to close' });
  } else {
    const tasks = Array.isArray(open.task_snapshot) ? open.task_snapshot : [];
    const unfinished = tasks.filter((t) => t.status !== 'done' && t.disposition !== 'dropped');
    clauses.push({
      id: 'no-unfinished-cards',
      met: unfinished.length === 0,
      detail: unfinished.length
        ? `${unfinished.length} card(s) still open in ${open.version}: ${unfinished.map((t) => `${t.id} (${t.status})`).join(', ')}`
        : `every card in ${open.version} is done or dropped`,
    });
    versionStopChecks = Array.isArray(open.stop_checks) ? open.stop_checks.filter(Boolean) : [];
    if (!versionStopChecks.length) {
      clauses.push({ id: 'stop-checks-declared', met: false, detail: `${open.version} declares no stop checks — its end condition is unanswerable` });
    }
  }
}

// ---------------------------------------------------------------------------
// Which commands this tier runs.
// ---------------------------------------------------------------------------
const declared = readTier(tier);
let commands = [];
if (tier === 'full') {
  // A version's own stop checks ARE the full tier; the declared list is the fallback for a
  // playbook with no open version.
  commands = versionStopChecks.length ? versionStopChecks : (declared?.commands || []);
} else {
  commands = declared?.commands || [];
  if (!commands.length) {
    clauses.push({
      id: `gate-tier-${tier}`,
      met: false,
      detail: `playbook.yaml declares no loop.gate_tiers.${tier}.commands — an empty fast gate reads as green while checking nothing`,
    });
  }
}

// ---------------------------------------------------------------------------
// Run them.
// ---------------------------------------------------------------------------
for (const cmd of commands) {
  // REFUSE TO RUN OURSELVES. A version whose stop check names this dispatcher is circular:
  // it would invoke itself, exit 0 on the recursion, and report the phase COMPLETE without
  // evaluating anything — a green gate with no work behind it.
  if (/check-phase-stop\.mjs/.test(cmd)) {
    clauses.push({
      id: cmd,
      met: false,
      detail: `${cmd} is THIS dispatcher — a stop check cannot be the thing that evaluates it. `
        + 'Declare the real gates (e.g. `npm test`) on the version instead.',
    });
    continue;
  }
  // Shell so `node scripts/x.mjs` and `npm test` both work unchanged.
  const res = spawnSync(cmd, { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 900_000 });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === null) {
    clauses.push({ id: cmd, met: false, detail: `${cmd} TIMED OUT — no verdict, so not a pass` });
    continue;
  }
  if (res.status !== 0) {
    const tail = out.trim().split('\n').slice(-6).join('\n         ');
    clauses.push({ id: cmd, met: false, detail: `${cmd} exited ${res.status}\n         ${tail}` });
    continue;
  }
  const counts = out.match(/\d+\s+(?:pass|passed|fail|failed)/gi);
  clauses.push({
    id: cmd,
    met: true,
    detail: `${cmd} exit 0${counts?.length ? ` (${[...new Set(counts.map((c) => c.replace(/\s+/g, ' ')))].join(', ')})` : ''}`,
  });
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const budget = declared?.budget_ms;
console.log(`phase stop condition [${tier} tier] — every clause must hold for this command to exit 0`);
console.log(`  version: ${open ? `${open.version} (${open.title || open.goal || ''})`.slice(0, 110) : '(none open)'}`);
if (tier === 'fast') {
  console.log('  tier:    FAST — answers "may the loop continue?", NOT "is the repo sound?"');
  console.log('           phase boundary: `node scripts/check-phase-stop.mjs --full`');
}
for (const c of clauses) {
  console.log(`  ${c.met ? 'MET    ' : 'NOT MET'} ${String(c.id).padEnd(34)} ${c.detail}`);
}

const unmet = clauses.filter((c) => !c.met);
if (unmet.length) {
  console.log(`\nPHASE NOT COMPLETE — ${unmet.length} clause(s) unmet. Keep working the loop (or hand back).`);
  process.exit(1);
}
if (tier === 'fast') {
  // A fast verdict is NOT a claim that the suite passes. Saying so explicitly is the
  // difference between a cheap gate and a hollow one.
  console.log(`\nPHASE COMPLETE (fast tier${budget ? `, budget ${budget}ms` : ''}) — the loop may continue.`);
  console.log('The full suite did NOT run: this tier does not claim the repo is sound, only that no card is unfinished.');
} else {
  console.log('\nPHASE COMPLETE (full tier) — the stop condition for this phase is met. Nothing here asks for more work.');
}
process.exit(0);
