// ============================================================================
//  scripts/test-dsh-inert-banner.mjs
// ----------------------------------------------------------------------------
// The HARNESS half of the debrief's finding (artifacts/debrief-pb-optimization-2026-10-13.md).
//
// The endless loop had three compounding mechanisms, and two of them are the plugin's:
//
//   1. per-turn re-injection — the block is staged on every step;
//   2. THE BLOCK IS SHAPED LIKE A PROMPT — it ended on an imperative ("Drive the loop with
//      the `playbook` tool"), so an instruction-following agent answered a STATUS LINE as
//      an INSTRUCTION. Answering it created the next turn.
//   3. no stop condition was evaluated anywhere.
//
// The engine now evaluates (3) via `loop.stop_when`. This suite pins (1) and (2): the block
// must become INERT — carrying no imperative, saying it asks for nothing — exactly when
// there is nothing to ask for.
//
// This is the assertion the debrief calls "the one that would have ended this session":
// a correct answer, an empty backlog, and a banner that still asked for more.
// ============================================================================

import { buildContextBlock } from '../dsh-plugin/core.mjs';

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).slice(0, 500)}` : ''}`); }
}

// The imperatives that made the banner read as a prompt. An inert block must contain NONE.
const IMPERATIVES = [/Drive the loop/i, /re-anchor any time/i, /next up:/i, /Record with `pb record`/i];

const baseStatus = (over = {}) => ({
  schema: 'agent-playbook.status.v1',
  name: 'agents-playbook',
  version: '0.8.0',
  backlog: { counts: { todo: 0, in_progress: 0, blocked: 0, done: 5 }, total: 5, next: null, in_progress: [] },
  loop: { id: 'loop-1', status: 'active', goal: 'do a thing', mode: 'coding' },
  ...over,
});

const meets = (block) => IMPERATIVES.filter((re) => re.test(block));
const isInert = (block) => /no action required/i.test(block) && /do not reply/i.test(block);

// ---------------------------------------------------------------------------
// 1. THE SESSION-ENDING CASE: a green stop condition. The phase is over.
// ---------------------------------------------------------------------------
{
  const block = buildContextBlock({
    status: baseStatus({ stop: { declared: true, executable: true, met: true, command: 'node scripts/check-phase-stop.mjs', action: 'idle' } }),
  });
  ok('a green stop condition makes the block announce COMPLETE', /COMPLETE/.test(block), block);
  ok('the complete block is inert (says no action required, says do not reply)', isInert(block), block);
  ok('the complete block carries NO imperative', meets(block).length === 0, `found ${meets(block).map(String).join(', ')}\n${block}`);
  ok('the complete block names the command that proved it', /check-phase-stop/.test(block), block);
}

// ---------------------------------------------------------------------------
// 2. The debrief's actual session: nothing claimable, nothing in hand, no
//    stop condition declared. It must STILL be inert — this is the exact state
//    that repeated "Holding." dozens of times.
// ---------------------------------------------------------------------------
{
  const block = buildContextBlock({ status: baseStatus() });
  ok('an idle backlog with nothing in hand is inert', isInert(block), block);
  ok('the idle block carries NO imperative (this is what ended the endless loop)', meets(block).length === 0, `found ${meets(block).map(String).join(', ')}\n${block}`);
  ok('the idle block still reports the real state (it is status, not silence)', /backlog: 0 todo/.test(block), block);
}

// ---------------------------------------------------------------------------
// 3. THE MIRROR-IMAGE DEFECT: an inert banner over LIVE work would let a real
//    task go unclaimed. Work in hand must keep the block actionable.
// ---------------------------------------------------------------------------
{
  const task = { id: 'plan-x', title: 'wire the gate', acceptance_checks: ['npm test'] };
  const block = buildContextBlock({ status: baseStatus({ backlog: { counts: { todo: 1, in_progress: 1, blocked: 0, done: 5 }, total: 6, next: null, in_progress: [{ id: 'plan-x', claimed_by: 'me' }] } }), task });
  ok('a task in hand keeps the block ACTIVE (not inert)', !isInert(block), block);
  ok('a task in hand still shows what done means', /done means these exit 0/.test(block) && /npm test/.test(block), block);
  ok('a task in hand keeps the record imperative', /pb record/.test(block), block);
}

// ---------------------------------------------------------------------------
// 4. Next-up work (unclaimed) must also stay actionable.
// ---------------------------------------------------------------------------
{
  const block = buildContextBlock({
    status: baseStatus({ backlog: { counts: { todo: 1, in_progress: 0, blocked: 0, done: 5 }, total: 6, next: { id: 'plan-y', title: 'next thing' }, in_progress: [] } }),
    next: { task: { id: 'plan-y', title: 'next thing' }, skill: 'run-task', skill_file: 'skills/run-task/SKILL.md' },
  });
  ok('a claimable next-up keeps the block ACTIVE', !isInert(block) && /next up:/.test(block), block);
}

// ---------------------------------------------------------------------------
// 5. A DECLARED BUT UNEVALUABLE stop condition is a broken contract, and the
//    agent is who can fix it — so unlike "complete", this one DOES ask. The
//    distinction is the point: inert means "nothing to do", not "we could not tell".
// ---------------------------------------------------------------------------
{
  const block = buildContextBlock({
    status: baseStatus({ stop: { declared: true, executable: false, met: false, command: 'All the cards are done', action: 'idle' } }),
  });
  ok('a non-executable stop condition is NOT silently treated as complete', !/COMPLETE/.test(block), block);
  ok('it says the contract is broken and names the fix', /not executable/.test(block) && /loop\.stop_when/.test(block), block);
}

// ---------------------------------------------------------------------------
// 6. A red stop condition with live work stays active (nothing regressed).
// ---------------------------------------------------------------------------
{
  const block = buildContextBlock({
    status: baseStatus({
      backlog: { counts: { todo: 1, in_progress: 0, blocked: 0, done: 5 }, total: 6, next: { id: 'plan-z', title: 'more' }, in_progress: [] },
      stop: { declared: true, executable: true, met: false, command: 'node scripts/check-phase-stop.mjs', action: 'idle' },
    }),
    next: { task: { id: 'plan-z', title: 'more' } },
  });
  ok('a RED stop condition with work left stays active', !isInert(block), block);
}

// ---------------------------------------------------------------------------
// 7. Backwards compatibility: a status payload with no `stop` field at all
//    (an older engine) must still behave sensibly — inert when idle, active
//    with work. The plugin must not require the new field.
// ---------------------------------------------------------------------------
{
  const idleOld = buildContextBlock({ status: baseStatus() });
  const workOld = buildContextBlock({ status: baseStatus({ backlog: { counts: { todo: 1, in_progress: 0, blocked: 0, done: 0 }, total: 1, next: { id: 'a', title: 'b' }, in_progress: [] } }), next: { task: { id: 'a', title: 'b' } } });
  ok('an engine with no stop field still yields an inert idle block', isInert(idleOld), idleOld);
  ok('an engine with no stop field still yields an active working block', !isInert(workOld), workOld);
}

// ---------------------------------------------------------------------------
// 8. The maxChars cap holds for an ACTIVE block, and truncation never strips the
//    inert marker. These two pull against each other on a tiny cap, and the
//    resolution is stated here rather than left implicit: the marker outranks
//    the cap. A banner that reads like a task and never says it is inert is the
//    original defect; one that is a few bytes over budget is not.
// ---------------------------------------------------------------------------
{
  const active = buildContextBlock({
    status: baseStatus({ backlog: { counts: { todo: 1, in_progress: 0, blocked: 0, done: 0 }, total: 1, next: { id: 'a', title: 'x'.repeat(50) }, in_progress: [] } }),
    next: { task: { id: 'a', title: 'x'.repeat(50) } },
    maxChars: 200,
  });
  ok('an ACTIVE block respects maxChars', active.length <= 200, `len=${active.length}`);

  const idle = buildContextBlock({ status: baseStatus(), maxChars: 120 });
  ok('a truncated inert block still carries the inert marker (safety outranks the cap)', isInert(idle), idle);
  ok('a truncated inert block still carries NO imperative', meets(idle).length === 0, `found ${meets(idle).map(String).join(', ')}\n${idle}`);
}

console.log(`\ntest-dsh-inert-banner: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
