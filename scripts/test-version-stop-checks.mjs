// ============================================================================
//  scripts/test-version-stop-checks.mjs
// ----------------------------------------------------------------------------
// A version's `stop_checks` were WRITE-ONCE. `pb version retitle` could correct a version's
// title, goal and stop — but not the commands that actually decide whether the phase is
// over. A version opened with a wrong check therefore had no way to declare its real gates
// short of closing and reopening it, and a version that cannot state what "done" means is
// the same defect as a stop condition written in prose.
//
// This was not hypothetical: v0.8.1 was created with
//     --stop-check "node scripts/check-phase-stop.mjs"
// which is the DISPATCHER that runs a version's checks. It invoked itself, exited 0 on the
// recursion, and reported PHASE COMPLETE having evaluated nothing — a hollow green, which
// this project treats as worse than a red. There was no command to fix it.
//
// WHAT MUST BE TRUE:
//   1. `version retitle --stop-check` REPLACES the list on an open version.
//   2. It is repeatable (several gates in one declaration).
//   3. The previous list is recorded in `retitles[]` — append-only history, not a rewrite.
//   4. A CIRCULAR check (the dispatcher itself) is refused before anything is written.
//   5. An empty list is refused: a version must declare what "done" means.
//   6. --reason is still required, and a no-op change is refused.
//   7. A closed version's checks cannot be moved (its stop_result is the evidence for it).
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PB_SRC = readFileSync(join(ROOT, 'scripts', 'pb.mjs'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).replace(/\n/g, '\n       ').slice(0, 700)}` : ''}`); }
}

function pb(cwd, args) {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
/** The open version, straight from the version store. */
function openVersion(cwd) {
  const r = pb(cwd, ['version', 'list', '--json']);
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))).versions.find((v) => v.state === 'open') || null; } catch { return null; }
}
function versionByName(cwd, name) {
  const r = pb(cwd, ['version', 'list', '--json']);
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))).versions.find((v) => v.version === name) || null; } catch { return null; }
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pb-version-checks-'));
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
  writeFileSync(join(dir, 'playbook.yaml'), readFileSync(join(ROOT, 'playbook.yaml'), 'utf8')
    .replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, ''), 'utf8');
  writeFileSync(join(dir, 'memory', 'backlog.yaml'), 'tasks: []\n', 'utf8');
  writeFileSync(join(dir, 'memory', 'journal.ndjson'), '', 'utf8');
  writeFileSync(join(dir, 'memory', 'cycle.md'),
    '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered — no conflict with my memory.\n', 'utf8');
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });
  // A version opened with the WRONG (circular) check — the real situation being fixed.
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'version', 'new',
    '--name', 'v1', '--goal', 'g', '--stop-check', 'node scripts/check-phase-stop.mjs'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' } });
  return dir;
}

const dir = makeFixture();
try {
  ok('the fixture opens a version with the circular check as its stop_checks',
    JSON.stringify(openVersion(dir)?.stop_checks) === JSON.stringify(['node scripts/check-phase-stop.mjs']),
    JSON.stringify(openVersion(dir)?.stop_checks));

  // -------------------------------------------------------------------------
  // 1. THE FIX: the list can be replaced.
  //    The replacement gates are TRIVIALLY GREEN on purpose (`node -e`), so this suite
  //    measures the stop_checks MACHINERY and not the repository's test suite — a fixture
  //    has no business running `npm test`, and a close that fails for that reason would
  //    make the test's subject ambiguous.
  // -------------------------------------------------------------------------
  {
    const r = pb(dir, ['version', 'retitle', 'v1', '--stop-check', 'node -e "process.exit(0)"', '--stop-check', 'node -e "process.exit(0)"', '--reason', 'declare the real gates']);
    ok('version retitle accepts --stop-check (the gap this closes)', r.code === 0, r.out.slice(0, 400));
    const v = openVersion(dir);
    ok('the stop_checks list was REPLACED, not appended to',
      JSON.stringify(v?.stop_checks) === JSON.stringify(['node -e "process.exit(0)"', 'node -e "process.exit(0)"']), JSON.stringify(v?.stop_checks));
    ok('…and it is repeatable, so several gates can be declared at once', (v?.stop_checks || []).length === 2, JSON.stringify(v?.stop_checks));
    ok('the previous list is recorded in retitles[] (append-only history)',
      (v?.retitles || []).some((t) => JSON.stringify(t.was?.stop_checks) === JSON.stringify(['node scripts/check-phase-stop.mjs'])),
      JSON.stringify(v?.retitles));
  }

  // -------------------------------------------------------------------------
  // 2. The CIRCULAR refusal — the defect that motivated the feature.
  // -------------------------------------------------------------------------
  {
    const before = JSON.stringify(openVersion(dir)?.stop_checks);
    const r = pb(dir, ['version', 'retitle', 'v1', '--stop-check', 'node scripts/check-phase-stop.mjs', '--reason', 'try the dispatcher']);
    ok('a CIRCULAR stop check (the dispatcher itself) is refused', r.code !== 0, r.out.slice(0, 300));
    ok('the refusal explains why it is circular', /circular/i.test(r.out), r.out.slice(0, 400));
    ok('…and nothing was written', JSON.stringify(openVersion(dir)?.stop_checks) === before, JSON.stringify(openVersion(dir)?.stop_checks));
  }

  // -------------------------------------------------------------------------
  // 3. An empty list is refused: a version must say what "done" means.
  // -------------------------------------------------------------------------
  {
    const before = JSON.stringify(openVersion(dir)?.stop_checks);
    const r = pb(dir, ['version', 'retitle', 'v1', '--stop-check', '', '--reason', 'empty it']);
    ok('an empty --stop-check list is refused', r.code !== 0, r.out.slice(0, 300));
    ok('…and nothing was written', JSON.stringify(openVersion(dir)?.stop_checks) === before);
  }

  // -------------------------------------------------------------------------
  // 4. --reason still required; a no-op change refused.
  // -------------------------------------------------------------------------
  {
    const noReason = pb(dir, ['version', 'retitle', 'v1', '--stop-check', 'node -e "process.exit(0)"']);
    ok('retitling still requires --reason', noReason.code !== 0 && /reason/i.test(noReason.out), noReason.out.slice(0, 300));

    const noop = pb(dir, ['version', 'retitle', 'v1', '--stop-check', 'node -e "process.exit(0)"', '--stop-check', 'node -e "process.exit(0)"', '--reason', 'same thing again']);
    ok('a no-op change is refused (it would write a row that changes nothing)', noop.code !== 0, noop.out.slice(0, 300));
  }

  // -------------------------------------------------------------------------
  // 5. A CLOSED version's checks are frozen: its stop_result is the evidence
  //    for what ran, so moving them afterwards would rewrite proof.
  // -------------------------------------------------------------------------
  {
    const closed = pb(dir, ['version', 'close']);
    if (process.env.PB_DEBUG_FIXTURE) console.log('       [debug] close:', closed.code, closed.out.slice(0, 300));
    ok('the version closed', versionByName(dir, 'v1')?.state === 'closed', `close said: ${closed.out.slice(0, 200)}`);
    const before = JSON.stringify(versionByName(dir, 'v1')?.stop_checks);
    const r = pb(dir, ['version', 'retitle', 'v1', '--stop-check', 'node -e "process.exit(1)"', '--reason', 'rewrite a closed version']);
    // A closed version's `stop_result` is the EVIDENCE for what ran when it closed. Moving the
    // stop_checks afterwards would silently re-point that evidence at gates that never ran, so
    // the list must stay as it was when the close recorded it.
    ok('a closed version\'s stop_checks are not silently rewritten',
      JSON.stringify(versionByName(dir, 'v1')?.stop_checks) === before,
      `code=${r.code} before=${before} now=${JSON.stringify(versionByName(dir, 'v1')?.stop_checks)}`);
  }

  console.log(`\ntest-version-stop-checks: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
