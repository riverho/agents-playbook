// ============================================================================
//  scripts/test-dsh-no-progress-backstop.mjs
// ----------------------------------------------------------------------------
// The LAST line of defence from the debrief (artifacts/debrief-pb-optimization-2026-10-13.md,
// design rule 4): `max_turns_without_progress`.
//
// The other two fixes remove the CAUSE of the endless loop — the banner is inert when it wants
// nothing, and `loop.stop_when` gives the loop a terminal state. This one is the BACKSTOP:
// even with both in place, a loop that is only talking to itself must self-limit rather than
// rely on the agent's manners.
//
// PROGRESS IS MEASURED ON THE JOURNAL SEQ, not on turn count. That choice is the whole
// design: turns always advance (that is the failure being bounded), so counting them measures
// nothing. The journal is the record of what actually happened — a turn that recorded nothing
// advanced it by zero.
//
// The test drives the REAL plugin against a REAL scaffolded playbook and a REAL agent double,
// so it observes the injection path the harness actually uses, not a reimplementation.
// ============================================================================

import { execFileSync } from 'node:child_process';
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
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).slice(0, 600)}` : ''}`); }
}

const plugin = await import('../dsh-plugin/index.js');

// ---------------------------------------------------------------------------
// A real playbook with ONE live todo, so the pre-step handler does not take the
// `quietWhenIdle` early return and the backstop is actually reachable.
// ---------------------------------------------------------------------------
const playbookRoot = mkdtempSync(join(tmpdir(), 'pb-noprogress-'));
try {
  mkdirSync(join(playbookRoot, 'scripts'), { recursive: true });
  execFileSync(process.execPath, [PB, 'scaffold', '--target', playbookRoot], { cwd: ROOT, encoding: 'utf8' });
  // The scaffolded engine imports js-yaml; give it the real dependency (a targeted copy, not
  // a junction and not the whole tree — see the node_modules lesson in project-memory rule 26).
  const dep = join(ROOT, 'node_modules', 'js-yaml');
  if (existsSync(dep)) {
    mkdirSync(join(playbookRoot, 'node_modules'), { recursive: true });
    cpSync(dep, join(playbookRoot, 'node_modules', 'js-yaml'), { recursive: true });
  }
  execFileSync(process.execPath, [join(playbookRoot, 'scripts', 'pb.mjs'), 'init'], { cwd: playbookRoot, encoding: 'utf8' });
  execFileSync(process.execPath, [join(playbookRoot, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: playbookRoot, encoding: 'utf8' });

  // Answer the cycle brief's Q5 and open a loop, so `pb` commands here behave like a live
  // workspace rather than a half-initialized one.
  const cyclePath = join(playbookRoot, 'memory', 'cycle.md');
  if (existsSync(cyclePath)) {
    writeFileSync(cyclePath, readFileSync(cyclePath, 'utf8').replace(/\(Your host memory is the PAST[\s\S]*?memory\.\)/, 'NONE — scratch playbook for a test.'), 'utf8');
  }
  // One live todo keeps the handler past `quietWhenIdle`.
  const backlogPath = join(playbookRoot, 'memory', 'backlog.yaml');
  writeFileSync(backlogPath, [
    'tasks:',
    '  - id: plan-np-001',
    "    title: 'a task that never advances'",
    '    status: todo',
    '    skill: run-task',
    '    priority: 1',
    "    acceptance_checks: ['node -e \"process.exit(0)\"']",
    '',
  ].join('\n'), 'utf8');

  // -------------------------------------------------------------------------
  // Drive the plugin's REAL pre-step handler, with a real agent double.
  // -------------------------------------------------------------------------
  const ctx = {
    __hooks: {},
    on(event, handler) { this.__hooks[event] = handler; },
    inject(names, cb) { if (typeof cb === 'function') cb({ provide: () => {}, inject: () => {} }); },
    provide() {},
    tools: { register() {} },
    logger: { warn() {}, info() {}, debug() {} },
  };
  plugin.apply(ctx, { playbookPath: playbookRoot, maxTurnsWithoutProgress: 3 });

  const injected = [];
  const agent = {
    id: 'agent-np',
    session: { id: 'sess-np', cwd: playbookRoot },
    inject: (m) => injected.push(m),
    inbox: { append: (slot, m) => injected.push(m) },
    steer: () => {},
  };

  const preStep = ctx.__hooks['agent/pre-step'];
  ok('the plugin registers an agent/pre-step handler', typeof preStep === 'function');

  // The handler stages context for the NEXT step; `next()` is the pass-through decision.
  const driveStep = () => preStep({ agent, signal: { aborted: false } }, async () => ({ kind: 'accept' }));

  const textOf = (m) => (m?.content?.[0]?.text) || '';

  // -------------------------------------------------------------------------
  // Turns 1..3 with NO journal writes: the record never advances.
  // -------------------------------------------------------------------------
  await driveStep();
  const afterFirst = injected.length;
  ok('the first turn injects the normal context block', afterFirst >= 1, `injected=${afterFirst}`);

  for (let i = 0; i < 4; i += 1) await driveStep();

  const staleRows = injected.map(textOf).filter((t) => /NO PROGRESS/i.test(t));
  ok('the backstop fires once the journal seq stops advancing', staleRows.length >= 1, injected.map(textOf).join('\n---\n').slice(0, 800));
  ok('the stall message says it is status, not a request', /STATUS, not a request|not a request/i.test(staleRows[0] || ''), staleRows[0] || '(none)');
  ok('the stall message names the journal seq as the evidence', /seq/i.test(staleRows[0] || ''), staleRows[0] || '(none)');
  ok('the stall message does NOT carry a "next up"/imperative instruction',
    !/next up:/i.test(staleRows[0] || ''), staleRows[0] || '(none)');

  // The key property: the stall is said ONCE, then injection stops entirely. Repeating the
  // same static status every turn is what added no information and cost the turns.
  const injectedAtStall = injected.length;
  for (let i = 0; i < 4; i += 1) await driveStep();
  const extraStallRows = injected.map(textOf).filter((t) => /NO PROGRESS/i.test(t)).length;
  ok('the stall is reported ONCE, not every turn', extraStallRows === 1, `stall rows=${extraStallRows}`);
  ok('injection STOPS once stalled (the loop cannot keep itself alive)',
    injected.length === injectedAtStall, `before=${injectedAtStall} after=${injected.length}`);

  // -------------------------------------------------------------------------
  // And the opposite: real progress un-stalls it. A backstop that latches
  // permanently would silence a workspace that resumes, which is a worse bug
  // than the one it fixes.
  // -------------------------------------------------------------------------
  {
    // Advance the journal for real, through the engine's own writer.
    execFileSync(process.execPath, [join(playbookRoot, 'scripts', 'pb.mjs'), 'comment', '--task', 'plan-np-001', '--text', 'progress'], {
      cwd: playbookRoot, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'test-runner' },
    });
    const before = injected.length;
    await driveStep();
    const newRows = injected.slice(before).map(textOf);
    ok('a real journal advance resumes normal injection (the backstop is not a latch)',
      newRows.length >= 1 && !/NO PROGRESS/i.test(newRows.join('\n')), JSON.stringify(newRows).slice(0, 400));
  }

  // -------------------------------------------------------------------------
  // The cap is configurable, and 0 disables the backstop (so a deployment can
  // opt out without patching the plugin).
  // -------------------------------------------------------------------------
  {
    const ctx2 = {
      __hooks: {},
      on(event, handler) { this.__hooks[event] = handler; },
      inject(names, cb) { if (typeof cb === 'function') cb({ provide: () => {}, inject: () => {} }); },
      provide() {},
      tools: { register() {} },
      logger: { warn() {}, info() {}, debug() {} },
    };
    plugin.apply(ctx2, { playbookPath: playbookRoot, maxTurnsWithoutProgress: 0 });
    const injected2 = [];
    const agent2 = {
      id: 'agent-np2',
      session: { id: 'sess-np2', cwd: playbookRoot },
      inject: (m) => injected2.push(m),
      inbox: { append: (slot, m) => injected2.push(m) },
      steer: () => {},
    };
    const handler2 = ctx2.__hooks['agent/pre-step'];
    for (let i = 0; i < 8; i += 1) await handler2({ agent: agent2, signal: { aborted: false } }, async () => ({ kind: 'accept' }));
    ok('maxTurnsWithoutProgress: 0 disables the backstop',
      !injected2.map(textOf).some((t) => /NO PROGRESS/i.test(t)), injected2.map(textOf).join('\n---\n').slice(0, 400));
  }

  // -------------------------------------------------------------------------
  // A TERMINAL STATE also stops injection: when the engine reports a green
  // `stop`, the plugin must not inject work-shaped context at all.
  // -------------------------------------------------------------------------
  {
    const ctx3 = {
      __hooks: {},
      on(event, handler) { this.__hooks[event] = handler; },
      inject(names, cb) { if (typeof cb === 'function') cb({ provide: () => {}, inject: () => {} }); },
      provide() {},
      tools: { register() {} },
      logger: { warn() {}, info() {}, debug() {} },
    };
    plugin.apply(ctx3, { playbookPath: playbookRoot });
    const injected3 = [];
    const agent3 = {
      id: 'agent-np3',
      session: { id: 'sess-np3', cwd: playbookRoot },
      inject: (m) => injected3.push(m),
      inbox: { append: (slot, m) => injected3.push(m) },
      steer: () => {},
    };
    const handler3 = ctx3.__hooks['agent/pre-step'];
    await handler3({ agent: agent3, signal: { aborted: false } }, async () => ({ kind: 'accept' }));
    const block3 = injected3.map(textOf).join('\n');
    ok('the live workspace block does not false-report COMPLETE (its stop check is unmet)',
      !/phase: COMPLETE/.test(block3), block3.slice(0, 400));
  }

  console.log(`\ntest-dsh-no-progress-backstop: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
} finally {
  try { rmSync(playbookRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}
