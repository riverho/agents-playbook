#!/usr/bin/env node
// ============================================================================
//  test-lifecycle-first-run.mjs — a first run must not dead-end, and the guidance
//  scaffold prints must be TRUE.
// ----------------------------------------------------------------------------
//  Why this exists: `pb plan` refuses without an active loop, and then refuses AGAIN until
//  the cycle brief's Q5 placeholder is answered — and no command answers Q5, so the brief
//  has to be edited by hand. Scaffold's printed "Next" block said `init && validate` and
//  stopped, so a human (or an agent following it literally) hit two dead ends with no hint.
//  The guidance is now the real sequence; this test executes it and asserts the guidance
//  names every step that is actually required.
//
//  HONEST LIMIT: step 1 is `npm install` (js-yaml). This machine refuses remote fetches
//  (EALLOWREMOTE), so the dependency is placed by REAL COPY instead (project rule 27) — the
//  step itself is asserted by the guidance, not by fetching.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

function pb(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

const work = mkdtempSync(join(tmpdir(), 'pb-first-run-'));
const repo = join(work, 'myrepo');
const pbRoot = join(repo, '.agents-playbook');
mkdirSync(repo, { recursive: true });

try {
  // ── the scaffold, and the guidance it prints ─────────────────────────────────
  let guidance = '';
  try {
    guidance = execFileSync(process.execPath, [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', pbRoot], {
      cwd: repo, encoding: 'utf8',
    });
  } catch (err) {
    problems.push(`scaffold failed: ${String(err.message).split('\n')[0]}`);
  }

  for (const [needle, why] of [
    ['loop new', 'the active-loop step — without it `pb plan` refuses'],
    ['cycle --new', 'the goal step'],
    ['cycle.md', 'where the five questions (Q5 gates planning) get answered'],
    ['plan --goal', 'how a real task is seeded'],
    ['pb ui', 'how the room is seen'],
  ]) {
    check(guidance.includes(needle), `scaffold's Next guidance never mentions "${needle}" (${why})`);
  }
  check(!/pb\.mjs init\b/.test(guidance),
    "scaffold's guidance still tells the reader to run `pb init`, which scaffold has already done");

  // step 1, done the only way this machine allows
  mkdirSync(join(pbRoot, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    cpSync(join(ROOT, 'node_modules', dep), join(pbRoot, 'node_modules', dep), { recursive: true });
  }

  // ── the two dead ends, pinned so the guidance cannot regress silently ────────
  const beforeLoop = pb(pbRoot, ['plan', '--goal', 'premature', '--check', 'node -v']);
  check(beforeLoop.code !== 0, '`plan` ACCEPTED a task with no active loop — the loop gate is gone');
  check(/loop/i.test(beforeLoop.stderr + beforeLoop.stdout),
    `the no-loop refusal does not name the loop: ${(beforeLoop.stderr || beforeLoop.stdout).trim().split('\n')[0]}`);

  const loop = pb(pbRoot, ['loop', 'new']);
  check(loop.code === 0, `step 2 (\`pb loop new\`) exited ${loop.code}: ${(loop.stderr || loop.stdout).trim().split('\n')[0]}`);

  const cycle = pb(pbRoot, ['cycle', '--new', '--goal', 'ship the thing', '--stop', 'the thing is shipped']);
  check(cycle.code === 0, `step 3 (\`pb cycle --new\`) exited ${cycle.code}`);

  const beforeQ5 = pb(pbRoot, ['plan', '--goal', 'premature', '--check', 'node -v']);
  check(beforeQ5.code !== 0, '`plan` ACCEPTED a task with an unanswered cycle brief — the Q5 gate is gone');
  check(/Q5|memory-conflict/i.test(beforeQ5.stderr + beforeQ5.stdout),
    `the Q5 refusal does not name Q5: ${(beforeQ5.stderr || beforeQ5.stdout).trim().split('\n')[0]}`);

  // ── the documented answer to the brief, then a real task ────────────────────
  const cycleFile = join(pbRoot, 'memory', 'cycle.md');
  const answered = readFileSync(cycleFile, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?memory\.\)/,
    'None: the playbook folder is the truth for this project.'
  );
  check(answered !== readFileSync(cycleFile, 'utf8'), 'the Q5 placeholder was not found in the brief');
  writeFileSync(cycleFile, answered, 'utf8');

  const planned = pb(pbRoot, ['plan', '--goal', 'the first real task', '--check', 'node -v']);
  check(planned.code === 0, `step 4 (\`pb plan\`) exited ${planned.code}: ${(planned.stderr || planned.stdout).trim().split('\n')[0]}`);
  const id = /Planned \[([^\]]+)\]/.exec(planned.stdout)?.[1] ?? null;
  check(Boolean(id), '`pb plan` printed no task id');

  if (id) {
    const backlog = readFileSync(join(pbRoot, 'memory', 'backlog.yaml'), 'utf8');
    check(backlog.includes(id), `the planned task ${id} is not in the workspace backlog`);
    const show = pb(pbRoot, ['task', 'show', id]);
    check(show.code === 0, `\`pb task show ${id}\` exited ${show.code}`);
    // `task show` is a summary; the acceptance check lives in the backlog, which is where a
    // reader and `pb validate --task` both find it.
    const taskBlock = backlog.split(/\n  - id: /).find((block) => block.startsWith(id)) ?? '';
    check(taskBlock.includes('node -v'), 'the planned task lost its acceptance check');
  }

  const validate = pb(pbRoot, ['validate']);
  check(validate.code === 0, `step 5 (\`pb validate\`) exited ${validate.code}: ${(validate.stderr || validate.stdout).trim().split('\n')[0]}`);

  // ── step 6: the room. A plain scaffold has no app, and `pb ui` must say so ──
  const ui = pb(pbRoot, ['ui']);
  check(ui.code === 1, `step 6: \`pb ui\` in a plain scaffold exited ${ui.code}, expected 1 with guidance`);
  check(/no Flow room app found/i.test(ui.stderr + ui.stdout),
    'step 6: `pb ui` did not explain that a plain scaffold carries no app');
} catch (err) {
  problems.push(`harness error: ${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('First run — scaffold → loop → brief → plan → validate → ui');
console.log('  guidance   : names loop new, cycle --new, the Q5 edit, plan --goal, pb ui');
console.log('  dead ends  : no active loop and unanswered Q5 both REFUSE, and both name the reason');
console.log('  sequence   : every documented step exits 0 and the task lands in the backlog');

if (problems.length) {
  console.error(`\nFIRST RUN FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nA first run completes, and the instructions it follows are true.');
