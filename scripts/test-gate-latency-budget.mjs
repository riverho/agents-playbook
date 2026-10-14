// ============================================================================
//  scripts/test-gate-latency-budget.mjs
// ----------------------------------------------------------------------------
// A budget that is only DECLARED is not a budget.
//
// `loop.stop_timeout_ms` bounds a HANG — a check that never returns. That is a different
// question from "is this check cheap enough to run on the per-turn path?". A stop condition
// that takes four minutes and returns the right answer is not hung; it is wrong for the
// caller, and the engine used to report it as a plain healthy green while the harness paid
// four minutes on every agent step. That is how the original problem arose: the stop
// condition ran the whole 327s suite, and nothing in the engine objected.
//
// So an over-budget green is a THREE-VALUED outcome, not a failure:
//   met: true, over_budget: true  — the work passed, the gate placement is wrong.
// Reporting it as red would be a lie (the check passed); staying silent is the bug.
//
// WHAT MUST BE TRUE:
//   1. A green that fits the budget carries no diagnosis — no noise on the common path.
//   2. A green that EXCEEDS the budget is reported as over_budget, with a diagnosis that
//      says it is NOT failing.
//   3. It does NOT flip `met` to false: the check passed, and a budget is not a verdict.
//   4. The budget comes from the MASTER (`loop.gate_tiers.fast.budget_ms`), so a project
//      sets its own — no number baked into the engine.
//   5. No declared budget means no budget check (opt-in, like every other tier key).
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).replace(/\n/g, '\n       ').slice(0, 700)}` : ''}`); }
}

/** A fixture whose `loop.stop_when` is a command that always exits 0, after `sleepMs`. */
function makeFixture({ sleepMs = 0, budgetMs = null, declareBudget = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-budget-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  for (const f of ['scripts/pb.mjs', 'AGENTS.md', 'SKILL.md', 'README.md', 'INSTALL.md', 'package.json']) {
    const src = join(ROOT, f);
    if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true });
  }
  const dep = join(ROOT, 'node_modules', 'js-yaml');
  if (existsSync(dep)) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    cpSync(dep, join(dir, 'node_modules', 'js-yaml'), { recursive: true });
  }
  // A stop_when that sleeps then exits 0 — green, but slow. Written as a script so the
  // quoting is unambiguous on Windows and the timing is the script's, not the shell's.
  writeFileSync(join(dir, 'scripts', 'slow-stop.mjs'), `setTimeout(() => process.exit(0), ${sleepMs});\n`, 'utf8');

  const master = readFileSync(join(ROOT, 'playbook.yaml'), 'utf8')
    .replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, '')
    .replace(/^[ \t]*budget_ms:.*\r?\n?/gm, '');
  let out = master.replace(/^loop:[ \t]*\r?\n/m, (m) => `${m}  stop_when: "node scripts/slow-stop.mjs"\n  stop_action: idle\n`);
  if (declareBudget && budgetMs !== null) {
    out = out.replace(/^(\s*)fast:[ \t]*\r?\n/m, (m, indent) => `${m}${indent}  budget_ms: ${budgetMs}\n`);
  }
  writeFileSync(join(dir, 'playbook.yaml'), out, 'utf8');
  writeFileSync(join(dir, 'memory', 'backlog.yaml'), 'tasks: []\n', 'utf8');
  writeFileSync(join(dir, 'memory', 'journal.ndjson'), '', 'utf8');
  writeFileSync(join(dir, 'memory', 'cycle.md'),
    '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered — no conflict with my memory.\n', 'utf8');
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

function stopCheckJson(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'stop-check', '--json'],
    { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  let payload = null;
  try { payload = JSON.parse((r.stdout || '').slice((r.stdout || '').indexOf('{'))); } catch { /* asserted */ }
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, payload };
}

// ---------------------------------------------------------------------------
// 1. A green that FITS the budget: no diagnosis, no noise.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture({ sleepMs: 0, budgetMs: 20_000 });
  try {
    const { code, payload } = stopCheckJson(dir);
    ok('a fast green exits 0', code === 0, JSON.stringify(payload)?.slice(0, 300));
    ok('a fast green is `met`', payload?.met === true, JSON.stringify(payload)?.slice(0, 300));
    ok('a fast green carries NO over-budget diagnosis (no noise on the common path)',
      !payload?.over_budget, JSON.stringify(payload)?.slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 2 & 3. A green that EXCEEDS the budget is reported — and is NOT turned into a failure.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture({ sleepMs: 2_500, budgetMs: 500 });
  try {
    const { code, payload } = stopCheckJson(dir);
    ok('an over-budget green still exits 0 (the check PASSED — a budget is not a verdict)',
      code === 0, `exit ${code}\n${JSON.stringify(payload)?.slice(0, 300)}`);
    ok('…and `met` stays TRUE (the work is fine; the gate placement is what is wrong)',
      payload?.met === true, JSON.stringify(payload)?.slice(0, 300));
    ok('…and it IS reported as over budget', payload?.over_budget === true, JSON.stringify(payload)?.slice(0, 400));
    ok('…naming the budget it exceeded', payload?.budget_ms === 500, JSON.stringify(payload)?.slice(0, 300));
    ok('…and the elapsed time that exceeded it',
      typeof payload?.elapsed_ms === 'number' && payload.elapsed_ms > 500, JSON.stringify(payload)?.slice(0, 300));
    // The console output must say it is not a failure — a bare "over budget" reads as red.
    const consoleRun = spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'stop-check'],
      { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    const out = `${consoleRun.stdout || ''}${consoleRun.stderr || ''}`;
    ok('the console warning says the check is not failing',
      /not failing|too slow to run on the per-turn path/i.test(out), out.slice(0, 600));
    ok('the console warning says where to fix it (the full tier / the budget)',
      /full tier|budget/i.test(out), out.slice(0, 600));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 4. The budget comes from the MASTER — a different declared number changes the verdict.
//    (Same slow command, generous budget => no complaint.)
// ---------------------------------------------------------------------------
{
  const dir = makeFixture({ sleepMs: 1_200, budgetMs: 60_000 });
  try {
    const { payload } = stopCheckJson(dir);
    ok('a generous declared budget accepts the same slow-but-green check',
      payload?.met === true && !payload?.over_budget, JSON.stringify(payload)?.slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 5. No declared budget => no budget check. Opt-in, like every other tier key.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture({ sleepMs: 1_200, declareBudget: false });
  try {
    const { code, payload } = stopCheckJson(dir);
    ok('with no declared budget the check is unconstrained (opt-in)', code === 0 && payload?.met === true, JSON.stringify(payload)?.slice(0, 300));
    ok('…and it is not reported as over budget', !payload?.over_budget, JSON.stringify(payload)?.slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 6. The per-turn caller (`status --json`) carries the diagnosis too — that is where the
//    harness reads it, so a budget only visible to `stop-check` would help nobody.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture({ sleepMs: 2_500, budgetMs: 500 });
  try {
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'status', '--json'],
      { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    let payload = null;
    try { payload = JSON.parse((r.stdout || '').slice((r.stdout || '').indexOf('{'))); } catch { /* asserted */ }
    if (process.env.PB_DEBUG_FIXTURE) {
      console.log('       [debug] status stop:', JSON.stringify(payload?.stop));
      console.log('       [debug] stop-check first:', JSON.stringify(stopCheckJson(dir).payload));
      console.log('       [debug] cache:', existsSync(join(dir, 'memory', '.stop-check-cache.json'))
        ? readFileSync(join(dir, 'memory', '.stop-check-cache.json'), 'utf8').slice(0, 300) : '(none)');
    }
    ok('status --json surfaces the over-budget verdict for the harness',
      payload?.stop?.over_budget === true, JSON.stringify(payload?.stop)?.slice(0, 400));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\ntest-gate-latency-budget: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
