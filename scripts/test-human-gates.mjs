// scripts/test-human-gates.mjs
// ----------------------------------------------------------------------------
// Human-gated branches. A layer gate whose author declared `human: true` fails until
// a PERSON acts (buy the domain, provision the database) — no agent retry turns it
// green. Two problems follow, and this suite pins both:
//
//   1. THE LIE OF SILENCE. `pb loop run --auto` used to print "Autonomous run
//      complete." when the only remaining work sat above a red gate, because a failing
//      gate filters work out of `claimable`. An engine that is confidently wrong about
//      being finished is worse than one that fails: the human is told there is nothing
//      left when there is a whole layer left.
//   2. NO BATCH. A red human gate is a QUESTION, not a retry. Every such question must
//      be collectable in ONE hand-off instead of the run stopping at the first one.
//
// Also pinned: branch scoping. A failing L0 gate must block only the work ABOVE L0 —
// tasks AT L0 and in unrelated branches stay claimable, and an UNMARKED gate keeps
// exactly the semantics it had before `human` existed.
// ----------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// The gate is red until the marker exists — mechanically the same shape as "the
// domain is not registered yet". `human:` is what classifies it.
const GATE = "node -e process.exit(require('fs').existsSync('memory/infra.ok')?0:1)";

function makePlaybook({ layers, tasks }) {
  const root = mkdtempSync(join(tmpdir(), 'pbhuman-'));
  for (const d of ['scripts', 'memory', 'modes']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  try { symlinkSync(resolve('node_modules'), join(root, 'node_modules')); } catch {}
  writeFileSync(join(root, 'playbook.yaml'),
    'name: human-gates-test\nversion: 0.6.3\nentry: SKILL.md\n' +
    'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
    'index:\n  cli: scripts/pb.mjs\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
    'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
    'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
    'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n' +
    'layers:\n' + layers);
  writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(root, 'memory/loops.yaml'), 'active: loop-human-001\nloops:\n  - id: loop-human-001\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(root, 'memory/cycle.md'),
    '# Cycle\n## 1. What is this cycle\'s goal?\ntest\n## 2. What challenges do I foresee?\nnone\n' +
    '## 3. What were the previous challenges?\nnone\n## 4. Where do I stop?\ndone\n## 5. Do I have any conflicting memory?\nNone\n');
  writeFileSync(join(root, 'memory/backlog.yaml'), tasks);
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  return {
    root,
    pb: (args) => spawnSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], { cwd: root, encoding: 'utf8' }),
    // A fixture that fails to produce a plan must say SO and what the CLI printed; a
    // bare JSON.parse throw here would blame the assertion instead of the fixture.
    planJson: () => {
      const r = spawnSync(process.execPath, [join(root, 'scripts/pb.mjs'), 'plan', '--layers', '--check-gates', '--json'], { cwd: root, encoding: 'utf8' });
      try { return JSON.parse(r.stdout); }
      catch (e) {
        throw new Error(`fixture produced no parseable plan (exit ${r.status}): ${e.message}\nstdout: ${r.stdout.slice(0, 300)}\nstderr: ${r.stderr.slice(0, 500)}`);
      }
    },
  };
}

const TWO_LAYERS_HUMAN = `  - {id: L0, name: infra, human: true, gate: "${GATE}"}\n  - {id: L1, name: data}\n`;
const TWO_LAYERS_AGENT = `  - {id: L0, name: substrate, gate: "${GATE}"}\n  - {id: L1, name: data}\n`;

// Tasks are built in BLOCK style, never by opening a flow mapping and continuing it on
// a following line. `- {id: x, ...` closed on the next line is invalid YAML, and a
// malformed fixture makes every assertion about behavior pass vacuously.
function task({ id, title, layer = null, priority = 1, status = 'todo', check = null }) {
  const lines = [`  - id: ${id}`, `    title: ${title}`, `    status: ${status}`, `    priority: ${priority}`];
  if (layer) lines.push(`    layer: ${layer}`);
  if (check) lines.push('    acceptance_checks:', `      - "${check}"`);
  return lines.join('\n');
}
const backlogOf = (...tasks) => `tasks:\n${tasks.join('\n')}\n`;

// --- 1. `human` is classified, and the batch is collected ----------------------
{
  const p = makePlaybook({
    layers: TWO_LAYERS_HUMAN,
    tasks: backlogOf(
      task({ id: 'schema', title: 'write the schema', layer: 'L1', priority: 1, check: 'node -e process.exit(0)' }),
      task({ id: 'api', title: 'build the api', layer: 'L1', priority: 2, check: 'node -e process.exit(0)' }),
    ),
  });
  // Prove the fixture parsed before asserting anything about behavior.
  const plan = p.planJson();
  ok('the fixture parses into the two gated tasks',
    plan.tasks.length === 2 && plan.problems.length === 0,
    `tasks=${plan.tasks.length} problems=${JSON.stringify(plan.problems)}`);
  ok('a human gate is declared on the layer', plan.layers[0].human === true, JSON.stringify(plan.layers[0]));
  ok('a failed human gate lands in the waiting-on-human batch',
    plan.waiting_on_human.length === 1 && plan.waiting_on_human[0].layer === 'L0',
    JSON.stringify(plan.waiting_on_human));
  ok('the batch names EVERY task it blocks, not just the first',
    plan.waiting_on_human[0].blocked_tasks.join() === 'schema,api',
    JSON.stringify(plan.waiting_on_human[0].blocked_tasks));
  ok('the batch names the layers it holds up', plan.waiting_on_human[0].blocked_layers.join() === 'L1',
    JSON.stringify(plan.waiting_on_human[0].blocked_layers));
  ok('the batch carries the command the human must satisfy',
    /infra\.ok/.test(plan.waiting_on_human[0].gate), plan.waiting_on_human[0].gate);
  ok('nothing is reported as waiting on agent work in the same batch',
    plan.waiting_on_agent.length === 0, JSON.stringify(plan.waiting_on_agent));

  const text = p.pb(['plan', '--layers', '--check-gates']).stdout;
  ok('the text report renders a WAITING ON A HUMAN section',
    /WAITING ON A HUMAN \(1\)/.test(text), text);
  ok('the text report says an agent retry cannot clear it',
    /no agent retry turns these green/.test(text), text);
  ok('the layer line is marked human, not a plain FAIL',
    /gate BLOCKED \(human\)/.test(text) && !/gate FAIL/.test(text), text);
}

// --- 2. an UNMARKED gate keeps exactly its old semantics -----------------------
{
  const p = makePlaybook({
    layers: TWO_LAYERS_AGENT,
    tasks: backlogOf(task({ id: 'schema', title: 's', layer: 'L1' })),
  });
  const plan = p.planJson();
  ok('an unmarked failing gate is NOT reported as waiting on a human',
    plan.waiting_on_human.length === 0, JSON.stringify(plan.waiting_on_human));
  ok('an unmarked failing gate is reported as blocked on agent work',
    plan.waiting_on_agent.length === 1 && plan.waiting_on_agent[0].layer === 'L0',
    JSON.stringify(plan.waiting_on_agent));
  const text = p.pb(['plan', '--layers', '--check-gates']).stdout;
  ok('an unmarked failing gate still renders as gate FAIL',
    /gate FAIL/.test(text) && !/gate BLOCKED \(human\)/.test(text), text);
  ok('the human batch is absent from the report when no gate is marked human',
    !/WAITING ON A HUMAN/.test(text), text);
}

// --- 3. branch scoping: a failing gate blocks only what is ABOVE it -------------
{
  const p = makePlaybook({
    layers: TWO_LAYERS_HUMAN,
    tasks: backlogOf(
      // Same layer as the red gate: must stay claimable.
      task({ id: 'at-l0', title: 'work in the gated layer', layer: 'L0', priority: 1 }),
      // Above it: blocked.
      task({ id: 'above', title: 'work above', layer: 'L1', priority: 2 }),
      // No layer at all: unconstrained in both directions.
      task({ id: 'free', title: 'unrelated work', priority: 3 }),
    ),
  });
  const plan = p.planJson();
  ok('the failing gate does NOT freeze the whole tree',
    plan.ready.includes('at-l0') && plan.ready.includes('free'),
    JSON.stringify(plan.ready));
  ok('work above the failing gate is excluded from the ready set',
    !plan.ready.includes('above'), JSON.stringify(plan.ready));
  const next = p.pb(['next']).stdout;
  ok('the selection path offers the unblocked branch, not nothing',
    /Next task: \[at-l0\]/.test(next), next);
}

// --- 4. the auto run names the blockers instead of claiming completion ----------
{
  const p = makePlaybook({
    layers: TWO_LAYERS_HUMAN,
    tasks: backlogOf(
      task({ id: 'schema', title: 'write the schema', layer: 'L1', priority: 1, check: 'node -e process.exit(0)' }),
      task({ id: 'api', title: 'build the api', layer: 'L1', priority: 2, check: 'node -e process.exit(0)' }),
    ),
  });
  const run = p.pb(['loop', 'run', '--auto']);
  const out = run.stdout + run.stderr;
  ok('the auto run does NOT claim the run is complete while a layer is gated',
    !/Autonomous run complete/.test(out), out);
  ok('the auto run names the blocked tasks', /\[schema\]/.test(out) && /\[api\]/.test(out), out);
  ok('the auto run collects the human question as a batch, not one stop',
    /WAITING ON A HUMAN \(1\)/.test(out) && /does not need to stop for each one/.test(out), out);
  ok('the auto run reports a stalled terminal status, not done',
    /Status: stalled/.test(out), out);
  // An ABSENT projection is the healthy outcome: it means the run claimed nothing, so
  // it wrote no state at all. Only a present projection can be inspected for claims.
  const stateFile = join(p.root, 'memory/backlog-state.json');
  const stateText = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '';
  ok('the auto run left the gated work untouched (nothing claimed)',
    !/in_progress/.test(stateText), stateText || '(no projection written — nothing was claimed)');

  // The human answers the whole batch at once, then the run proceeds.
  writeFileSync(join(p.root, 'memory/infra.ok'), 'provisioned\n');
  const after = p.pb(['plan', '--layers', '--check-gates']);
  ok('answering the human gate clears the batch', !/WAITING ON A HUMAN/.test(after.stdout), after.stdout);
  const claim = p.pb(['next', '--claim', '--force']);
  ok('the formerly gated work becomes claimable after the human acts',
    /Claimed \[schema\]/.test(claim.stdout), claim.stdout + claim.stderr);
}

// --- 5. a genuinely empty backlog still reports completion ---------------------
{
  const p = makePlaybook({
    layers: TWO_LAYERS_HUMAN,
    tasks: backlogOf(task({ id: 'done-already', title: 'd', layer: 'L0', status: 'done' })),
  });
  const run = p.pb(['loop', 'run', '--auto']);
  const out = run.stdout + run.stderr;
  ok('with no open work at all, the run still reports completion',
    /No actionable tasks\. Autonomous run complete\./.test(out), out);
  ok('an empty backlog is not misreported as stalled', !/Status: stalled/.test(out), out);
}

console.log(`\ntest-human-gates: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
