// ============================================================================
//  scripts/test-stop-when.mjs
// ----------------------------------------------------------------------------
// The debrief (artifacts/debrief-pb-optimization-2026-10-13.md, Part 0) found the loop
// had NO terminal state: `playbook.yaml` declared `loop.steps` and an `orchestrator:`
// block, but nothing anywhere said "the loop ends when X". The phase's stop condition
// lived in `memory/cycle.md` as PROSE — printed by `pb anchor`, never evaluated.
//
// The repo's own rule is "exit codes, not prose". This suite holds the loop contract to
// it: a declared stop condition must be a RUNNABLE COMMAND with a readable verdict, and
// `pb stop-check` must report it as one.
//
// What this pins:
//   1. `loop.stop_when` is accepted by `pb validate` only when it is a command that runs.
//   2. A PROSE stop condition is refused (not merely warned about) — this is the defect.
//   3. `pb stop-check` exits 0 when green, non-zero when red, and says which.
//   4. Green is reported as PHASE COMPLETE — the negative signal the loop lacked.
//   5. `stop_action` is honored: an unknown action is refused, never silently ignored.
//
// Every assertion below was written to FAIL against the engine as it stood before this
// task (there was no `stop_when` key and no `stop-check` command at all), so the RED run
// is the proof the check has teeth. See the task's journal row for the RED evidence.
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PB = join(ROOT, 'scripts', 'pb.mjs');

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).replace(/\n/g, '\n       ').slice(0, 600)}` : ''}`); }
}

/**
 * Run pb INSIDE a fixture; never throws — returns the verdict as data.
 *
 * It must be the FIXTURE's copy of pb.mjs, not the repo's: the engine resolves its master
 * from its own location, so calling the repo's copy with `cwd: fixture` reads the REPO's
 * playbook.yaml — including its real `stop_when`. The first version of this suite did
 * exactly that, so every fixture silently ran the repo's full phase-stop check (the whole
 * test suite) instead of the stop condition under test, and the run never finished.
 */
function pb(cwd, args) {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ---------------------------------------------------------------------------
// A scratch playbook, copied from the real engine so the fixture IS the engine
// under test (not a hand-rolled stub that could drift from it).
// ---------------------------------------------------------------------------
function makeFixture({ stop_when = null, stop_action = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-stop-when-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  // The engine files the CLI resolves from its own folder.
  for (const f of ['scripts/pb.mjs', 'AGENTS.md', 'SKILL.md', 'README.md', 'INSTALL.md', 'package.json']) {
    const src = join(ROOT, f);
    if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true });
  }
  // Copy ONLY the engine's real dependency (js-yaml) instead of the whole node_modules:
  // the full tree is tens of thousands of files and made this suite take minutes.
  const dep = join(ROOT, 'node_modules', 'js-yaml');
  if (existsSync(dep)) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    cpSync(dep, join(dir, 'node_modules', 'js-yaml'), { recursive: true });
  }

  const master = readFileSync(join(ROOT, 'playbook.yaml'), 'utf8');
  // The real master declares a real stop_when. Left in place, EVERY fixture would actually
  // run the repo's phase-stop check (which runs the whole test suite) — the fixture would
  // measure the repo instead of the engine. Strip it, then add the case under test.
  let out = master.replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, '');
  if (stop_when !== null) {
    const block = [
      '  # test fixture',
      `  stop_when: ${JSON.stringify(stop_when)}`,
      stop_action ? `  stop_action: ${stop_action}` : null,
    ].filter(Boolean).join('\n');
    // Insert immediately after the `loop:` line — the map's first key follows it, and
    // matching on that specific key was brittle (`description:` is on the next line).
    out = out.replace(/^loop:[ \t]*\r?\n/m, (m) => `${m}${block}\n`);
  }
  // Fail loudly rather than silently measuring the repo. The master's own COMMENTS mention
  // `stop_when`, so this must look for a declared KEY, not the bare word.
  if (stop_when === null && /^[ \t]*stop_when[ \t]*:/m.test(out)) {
    throw new Error('fixture setup failed: the real stop_when survived the strip');
  }
  writeFileSync(join(dir, 'playbook.yaml'), out, 'utf8');
  writeFileSync(join(dir, 'memory', 'backlog.yaml'), 'tasks: []\n', 'utf8');
  writeFileSync(join(dir, 'memory', 'journal.ndjson'), '', 'utf8');
  writeFileSync(join(dir, 'memory', 'cycle.md'), '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered.\n', 'utf8');
  // `init` hydrates the runtime files; `bootstrap` writes the minimal process/skill stubs.
  // Both are needed for `pb validate` to be a fair test of THIS change: without the indices
  // the fixture fails the engine's structural guardrails for reasons unrelated to stop_when,
  // and a "validate went red" assertion would pass for the wrong reason.
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

const fixtures = [];
function fixture(opts) {
  const d = makeFixture(opts);
  fixtures.push(d);
  return d;
}

try {
  // -------------------------------------------------------------------------
  // 1. A GREEN stop condition is a command, and `pb stop-check` reads exit 0.
  // -------------------------------------------------------------------------
  const green = fixture({ stop_when: 'node -e "process.exit(0)"', stop_action: 'idle' });
  {
    const r = pb(green, ['stop-check', '--json']);
    ok('pb stop-check exists and answers --json for a declared stop_when', r.code === 0 && /"schema"/.test(r.out), `code=${r.code}\n${r.out.slice(0, 300)}`);
    let payload = null;
    try { payload = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* asserted below */ }
    ok('the stop-check verdict is machine-readable and says met', payload?.met === true, JSON.stringify(payload)?.slice(0, 300));
    ok('the verdict names the command it ran', typeof payload?.command === 'string' && payload.command.includes('process.exit(0)'), JSON.stringify(payload)?.slice(0, 300));
  }

  // -------------------------------------------------------------------------
  // 2. A RED stop condition is exit non-zero and a distinct verdict.
  // -------------------------------------------------------------------------
  const red = fixture({ stop_when: 'node -e "process.exit(3)"', stop_action: 'report' });
  {
    const r = pb(red, ['stop-check', '--json']);
    ok('a red stop condition exits non-zero', r.code !== 0, `code=${r.code}`);
    let payload = null;
    try { payload = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* asserted below */ }
    ok('the verdict says not met and carries the real exit code', payload?.met === false && payload?.exit_code === 3, JSON.stringify(payload)?.slice(0, 300));
  }

  // -------------------------------------------------------------------------
  // 3. THE DEFECT: a PROSE stop condition must be refused, not printed.
  //    This is the debrief's rule 2 — "an unenforceable condition is the same as
  //    no condition". The old engine happily carried prose in `cycle.md` stop:.
  // -------------------------------------------------------------------------
  const prose = fixture({ stop_when: 'All the cards are done and the suite passes', stop_action: 'idle' });
  {
    const r = pb(prose, ['stop-check', '--json']);
    ok('a PROSE stop condition is refused, not treated as satisfied', r.code !== 0, `code=${r.code}\n${r.out.slice(0, 300)}`);
    let payload = null;
    try { payload = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* asserted below */ }
    ok('the refusal says the stop condition is not executable',
      payload?.met === false && payload?.error === 'not-executable', JSON.stringify(payload)?.slice(0, 300));
    ok('the refusal is fatal to `pb validate`, because an unenforceable stop is a broken contract',
      pb(prose, ['validate']).code !== 0, 'validate stayed green over a prose stop_when');
  }

  // -------------------------------------------------------------------------
  // 4. No stop_when at all is NOT an error — the key is opt-in, so a playbook
  //    that has not adopted it keeps working exactly as before.
  // -------------------------------------------------------------------------
  const none = fixture({});
  {
    const r = pb(none, ['stop-check', '--json']);
    let payload = null;
    try { payload = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* asserted below */ }
    ok('an absent stop_when reports "not declared" rather than failing', payload?.declared === false, `code=${r.code}\n${r.out.slice(0, 200)}`);
    ok('an absent stop_when keeps `pb validate` green (opt-in, no forced migration)', pb(none, ['validate']).code === 0, 'validate went red on a playbook that never adopted stop_when');
  }

  // -------------------------------------------------------------------------
  // 5. stop_action is a closed vocabulary — silently ignoring a typo would
  //    recreate the same class of unenforceable declaration.
  // -------------------------------------------------------------------------
  const badAction = fixture({ stop_when: 'node -e "process.exit(0)"', stop_action: 'explode' });
  {
    const r = pb(badAction, ['validate']);
    ok('an unknown stop_action is a guardrail failure', r.code !== 0, `code=${r.code}\n${r.out.slice(0, 400)}`);
  }

  // -------------------------------------------------------------------------
  // 6. The banner changes SHAPE when the stop check is green — the negative
  //    signal. `pb anchor --brief` must say "no action required" and must not
  //    end on an imperative, because an instruction-shaped banner is what the
  //    agent answered as a prompt (debrief mechanisms 1 and 2).
  // -------------------------------------------------------------------------
  {
    const r = pb(green, ['anchor', '--brief']);
    ok('a green stop check makes the brief announce PHASE COMPLETE', r.code === 0 && /PHASE COMPLETE/.test(r.out), `code=${r.code}\n${r.out.slice(0, 400)}`);
    ok('the complete banner is explicitly inert — it says no action is required',
      /no action required/i.test(r.out), r.out.slice(0, 400));
    ok('the complete banner tells the agent NOT to reply',
      /do not reply/i.test(r.out), r.out.slice(0, 400));
    ok('the complete banner drops the imperative footer that caused the endless loop',
      !/Drive the loop|re-anchor any time/i.test(r.out), r.out.slice(0, 400));
  }

  // -------------------------------------------------------------------------
  // 7. With NO stop condition and NO claimable work the brief must ALSO be inert.
  //    This is the assertion that would have ended the debrief session: the task
  //    was done, the backlog had nothing claimable, yet the banner asked again.
  // -------------------------------------------------------------------------
  {
    const r = pb(none, ['anchor', '--brief']);
    ok('an idle backlog with no stop_when still yields an inert banner (nothing claimable)',
      /no action required/i.test(r.out), r.out.slice(0, 400));
    ok('the idle banner does not end on an imperative',
      !/Drive the loop|re-anchor any time/i.test(r.out), r.out.slice(0, 400));
  }

  // -------------------------------------------------------------------------
  // 8. And the opposite: with work actually claimable, the brief MUST NOT be
  //    inert. An inert banner over live work is the mirror-image defect — it
  //    would let a real task go unclaimed.
  // -------------------------------------------------------------------------
  {
    const busy = fixture({});
    writeFileSync(join(busy, 'memory', 'backlog.yaml'), [
      'tasks:',
      '  - id: plan-test-001',
      "    title: 'a real task'",
      '    status: todo',
      '    skill: run-task',
      '    priority: 1',
      "    acceptance_checks: ['node -e \"process.exit(0)\"']",
      '',
    ].join('\n'), 'utf8');
    const r = pb(busy, ['anchor', '--brief']);
    ok('a claimable task keeps the banner ACTIVE (no false "no action required")',
      !/no action required/i.test(r.out), r.out.slice(0, 400));
  }

  // -------------------------------------------------------------------------
  // 9. THE CACHE. A stop condition is usually a real gate (this repo's runs the whole
  //    suite), and `pb status --json` feeds the harness's PER-STEP injection — running a
  //    multi-minute gate on every step would make the harness unusable. The verdict is
  //    therefore cached, keyed on the journal seq: reused while the record has not moved,
  //    recomputed the moment a row is appended.
  // -------------------------------------------------------------------------
  {
    const c = fixture({ stop_when: 'node -e "process.exit(0)"', stop_action: 'idle' });

    // First call populates the cache (and reports itself as uncached).
    const first = pb(c, ['stop-check', '--json', '--cached']);
    let p1 = null; try { p1 = JSON.parse(first.out.slice(first.out.indexOf('{'))); } catch { /* asserted */ }
    ok('the first cached call evaluates for real (no cache yet)', p1?.met === true && !p1?.cached, JSON.stringify(p1)?.slice(0, 250));

    // A second call with no journal movement is served from the cache.
    const second = pb(c, ['stop-check', '--json', '--cached']);
    let p2 = null; try { p2 = JSON.parse(second.out.slice(second.out.indexOf('{'))); } catch { /* asserted */ }
    ok('a second call with an unmoved journal is served from the cache', p2?.cached === true, JSON.stringify(p2)?.slice(0, 250));
    ok('the cached verdict agrees with the fresh one', p2?.met === p1?.met, JSON.stringify(p2)?.slice(0, 250));

    // `status --json` — the PER-TURN caller — must use the cache too.
    const st = pb(c, ['status', '--json']);
    let sp = null; try { sp = JSON.parse(st.out.slice(st.out.indexOf('{'))); } catch { /* asserted */ }
    ok('status --json carries the stop verdict for the harness', sp?.stop?.declared === true && sp?.stop?.met === true, JSON.stringify(sp?.stop));

    // And the cache INVALIDATES on record: appending a journal row must force a re-evaluation.
    // A cache that outlives the record would report a stale "complete" over new work.
    writeFileSync(join(c, 'memory', 'journal.ndjson'), `${JSON.stringify({ seq: 9, ts: new Date().toISOString(), task: 'x', action: 'test', status: 'event' })}\n`, 'utf8');
    const third = pb(c, ['stop-check', '--json', '--cached']);
    let p3 = null; try { p3 = JSON.parse(third.out.slice(third.out.indexOf('{'))); } catch { /* asserted */ }
    ok('a new journal row INVALIDATES the cache (it cannot outlive the record)', p3?.cached !== true, JSON.stringify(p3)?.slice(0, 250));

    // `pb stop-check` WITHOUT --cached always tells the truth now, even with a warm cache.
    const fresh = pb(c, ['stop-check', '--json']);
    let pf = null; try { pf = JSON.parse(fresh.out.slice(fresh.out.indexOf('{'))); } catch { /* asserted */ }
    ok('plain `pb stop-check` bypasses the cache (a human asking wants the truth now)', pf?.cached !== true, JSON.stringify(pf)?.slice(0, 250));
  }

  console.log(`\ntest-stop-when: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
} finally {
  for (const d of fixtures) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
