// ============================================================================
//  scripts/test-gate-tiers.mjs
// ----------------------------------------------------------------------------
// The gate had ONE speed, and it was the expensive one.
//
// Measured on this repository before the split: `npm test` 327s across 77 commands, of which
// seven timeout/kill suites alone are 188s (58%). The stop condition ran that, and
// `pb status --json` feeds the harness's PER-STEP context injection — so the check deciding
// "may the loop continue?" cost minutes per step. The verdict was cached on the journal seq
// to make the harness usable at all, but a cache is a mitigation: the underlying command was
// still wrong for the caller.
//
// The fix splits the question in two:
//   fast (default)  "may the loop continue?"  — structural guards + the terminal-state
//                   contract, declared in `playbook.yaml` under `loop.gate_tiers.fast`.
//   --full          "is this repo sound?"     — the version's own stop_checks (the suite).
//
// WHAT MUST BE TRUE:
//   1. The fast tier runs and exits 0 on a healthy repo.
//   2. It is FAST — under the budget the master declares, and far under the full tier.
//   3. It says which question it answered: a fast green must NOT imply the suite passes.
//      This is the hollow-gate guard — a cheap gate that reads as a full one is worse than
//      an expensive one.
//   4. `--full` still runs the version's declared stop checks.
//   5. The tier contents come from the MASTER, not from the script: a project edits its own
//      gates without editing the dispatcher.
//   6. An empty fast tier is a FAILURE, not a silent green.
// ============================================================================

import { spawnSync } from 'node:child_process';
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

function run(cwd, args, timeout = 600_000) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// 1 & 2 & 3. The real repository: fast tier is fast, green, and honest about scope.
// ---------------------------------------------------------------------------
let fastMs = 0;
let budgetMs = null;
{
  const master = readFileSync(join(ROOT, 'playbook.yaml'), 'utf8');
  budgetMs = Number(/budget_ms:\s*(\d+)/.exec(master)?.[1] ?? NaN);
  ok('the master declares a fast-tier latency budget', Number.isFinite(budgetMs), `budget_ms=${budgetMs}`);
  ok('the master declares fast-tier commands',
    /fast:[\s\S]*?commands:/.test(master) && /test-stop-when\.mjs/.test(master));

  const fast = run(ROOT, ['scripts/check-phase-stop.mjs'], 300_000);
  fastMs = fast.ms;
  ok('the fast tier exits 0 on a healthy repo', fast.code === 0, fast.out.slice(0, 400));
  ok('the fast tier runs in seconds, not minutes',
    fastMs < 60_000, `took ${(fastMs / 1000).toFixed(1)}s`);
  if (Number.isFinite(budgetMs)) {
    ok(`the fast tier fits its declared budget (${budgetMs}ms)`,
      fastMs < budgetMs, `took ${fastMs}ms > budget ${budgetMs}ms — raise the budget or shrink the tier`);
  }
  // THE HOLLOW-GATE GUARD: a cheap green must not read as a full one.
  ok('the fast tier says it is the FAST tier', /\[fast tier\]/.test(fast.out), fast.out.slice(0, 300));
  ok('the fast tier explicitly does NOT claim the repo is sound',
    /does not claim|did NOT run|NOT "is the repo sound"/i.test(fast.out), fast.out.slice(0, 600));
  ok('the fast tier points at the phase-boundary command',
    /--full/.test(fast.out), fast.out.slice(0, 600));
}

// ---------------------------------------------------------------------------
// 4. `--full` runs the version's declared stop checks. Cheap proof: point a fixture
//    version at a trivially green command and confirm the full tier executed it.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'pb-tiers-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'memory'), { recursive: true });
    for (const f of ['scripts/pb.mjs', 'scripts/check-phase-stop.mjs', 'AGENTS.md', 'SKILL.md', 'README.md', 'INSTALL.md', 'package.json']) {
      const src = join(ROOT, f);
      if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true });
    }
    const dep = join(ROOT, 'node_modules', 'js-yaml');
    if (existsSync(dep)) {
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      cpSync(dep, join(dir, 'node_modules', 'js-yaml'), { recursive: true });
    }
    // The fixture master DECLARES its own tiers — proof the dispatcher reads the master
    // rather than carrying this repository's gates baked in.
    const masterText = readFileSync(join(ROOT, 'playbook.yaml'), 'utf8')
      .replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, '');
    writeFileSync(join(dir, 'playbook.yaml'), masterText, 'utf8');
    writeFileSync(join(dir, 'memory', 'backlog.yaml'), 'tasks: []\n', 'utf8');
    writeFileSync(join(dir, 'memory', 'journal.ndjson'), '', 'utf8');
    writeFileSync(join(dir, 'memory', 'cycle.md'),
      '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered — no conflict with my memory.\n', 'utf8');
    spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
    spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });
    // A version whose stop_checks are unmistakably the full tier's business.
    spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'version', 'new',
      '--name', 'v1', '--goal', 'g', '--stop-check', 'node -e "console.log(\'FULL_TIER_MARKER\')"'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' } });

    const full = run(dir, ['scripts/check-phase-stop.mjs', '--full'], 120_000);
    ok('--full exits 0 when the version stop checks pass', full.code === 0, full.out.slice(0, 400));
    ok('--full actually RAN the version stop check',
      /FULL_TIER_MARKER/.test(full.out) || /node -e/.test(full.out), full.out.slice(0, 400));
    ok('--full labels itself the full tier', /\[full tier\]/.test(full.out), full.out.slice(0, 300));

    // And the fast tier uses the MASTER's declared fast commands, which here are this
    // repository's (the fixture copied the master verbatim) — so a fast run must not be
    // silent about being the cheap question.
    const fast = run(dir, ['scripts/check-phase-stop.mjs'], 300_000);
    ok('the fast tier does not run the version stop checks (they are the boundary question)',
      !/FULL_TIER_MARKER/.test(fast.out), fast.out.slice(0, 400));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 5 & 6. An EMPTY or missing fast tier is a FAILURE, never a silent green.
//    A gate with nothing in it that exits 0 is the hollow gate this project refuses.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'pb-tiers-empty-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'memory'), { recursive: true });
    for (const f of ['scripts/pb.mjs', 'scripts/check-phase-stop.mjs', 'AGENTS.md', 'SKILL.md', 'README.md', 'INSTALL.md', 'package.json']) {
      const src = join(ROOT, f);
      if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true });
    }
    const dep = join(ROOT, 'node_modules', 'js-yaml');
    if (existsSync(dep)) {
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      cpSync(dep, join(dir, 'node_modules', 'js-yaml'), { recursive: true });
    }
    // A master with NO gate_tiers at all.
    const bare = readFileSync(join(ROOT, 'playbook.yaml'), 'utf8')
      .replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, '')
      .replace(/^  gate_tiers:[\s\S]*?(?=^  steps:)/m, '');
    writeFileSync(join(dir, 'playbook.yaml'), bare, 'utf8');
    writeFileSync(join(dir, 'memory', 'backlog.yaml'), 'tasks: []\n', 'utf8');
    writeFileSync(join(dir, 'memory', 'journal.ndjson'), '', 'utf8');
    writeFileSync(join(dir, 'memory', 'cycle.md'),
      '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered — no conflict with my memory.\n', 'utf8');
    spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
    spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });

    const r = run(dir, ['scripts/check-phase-stop.mjs'], 120_000);
    ok('an undeclared fast tier FAILS rather than reporting a green over nothing',
      r.code !== 0, `exit ${r.code}\n${r.out.slice(0, 400)}`);
    ok('…and it names the missing declaration',
      /gate_tiers\.fast/.test(r.out), r.out.slice(0, 400));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\ntest-gate-tiers: ${pass} pass, ${fail} fail`);
console.log(`fast tier measured: ${(fastMs / 1000).toFixed(1)}s (budget ${budgetMs}ms)`);
if (fail) process.exit(1);
