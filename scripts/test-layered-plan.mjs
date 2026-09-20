// scripts/test-layered-plan.mjs
// ----------------------------------------------------------------------------
// The layered planner's contract. Layers exist so that a REPO can be planned in
// strata (substrate → data → domain → interface) and so that a layer's GATE is
// enforced rather than intended. These assertions pin the properties that make
// that true, and the ones that keep it from becoming a second source of truth:
//
//   1. DRY RUN — `pb plan --layers` writes NOTHING and runs NO acceptance check.
//      Gate commands are not executed unless --check-gates is asked for.
//   2. DERIVED LAYERS — a task's layer is derived from its dependencies; a declared
//      `layer:` that contradicts them is a failure, not a decoration.
//   3. GATES GATE CLAIMS — a task above a failing/unverified lower gate is not
//      claimable by `pb next --claim`, while `workers` reports the real blockers.
//   4. STRUCTURE IS A GUARDRAIL — a dependency cycle and an unknown layer fail
//      `pb validate`, because a plan that cannot be ordered is not a plan.
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

// The gate command is kept quote-free on purpose: shellSplit preserves inner quotes,
// but a YAML-escaped doubly-quoted command is its own readability trap, and what is
// under test here is the gate's EFFECT, not pb's argument parsing.
const LAYERS_WITH_GATE =
  'layers:\n' +
  '  - {id: L0, name: substrate, gate: "node -e process.exit(require(\'fs\').existsSync(\'memory/gate0.ok\')?0:1)"}\n' +
  '  - {id: L1, name: domain}\n';

// A playbook with two layers, a GATED lower layer, and a dependency that puts a
// task where its declaration says it belongs. `ready-now` deliberately sits in L0
// next to the gated work so "waiting on the gate" cannot be confused with
// "waiting on a sibling".
function makePlaybook({ layers = LAYERS_WITH_GATE, tasks, extraMaster = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pblayers-'));
  for (const d of ['scripts', 'memory', 'modes', 'skills/run-task', 'processes']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  try { symlinkSync(resolve('node_modules'), join(root, 'node_modules')); } catch {}
  // A minimal but REAL catalog, so `pb plan` (which defaults to skill `run-task`) can
  // resolve a skill the way a scaffolded playbook would. Without it, every `pb plan`
  // assertion below would fail on the fixture instead of on the behavior under test.
  writeFileSync(join(root, 'skills/index.yaml'),
    'skills:\n  - {id: run-task, file: skills/run-task/SKILL.md, process: run-task}\n');
  writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run-task\n');
  writeFileSync(join(root, 'processes/index.yaml'),
    'processes:\n  - {id: run-task, file: processes/run-task.yaml}\n');
  writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\nsteps: []\n');
  writeFileSync(join(root, 'playbook.yaml'),
    'name: layers-test\nversion: 0.6.3\nentry: SKILL.md\n' +
    'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
    'index:\n  cli: scripts/pb.mjs\n  skills_index: skills/index.yaml\n  processes_index: processes/index.yaml\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
    'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
    'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
    'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n' +
    layers + extraMaster);
  writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - id: L1\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(root, 'memory/cycle.md'), '# c\n## 1. Goal\nx\n## 2. Foresee\nx\n## 3. Prior\nx\n## 4. Stop\nx\n## 5. Conflicts\nNone\n');
  writeFileSync(join(root, 'memory/backlog.yaml'), tasks);
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  const rel = (r) => (r.startsWith(root) ? r : join(root, r));
  return {
    root,
    pb: (args, opts = {}) => spawnSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], { cwd: root, encoding: 'utf8', ...opts }),
    snap: () => ['memory/backlog.yaml', 'memory/journal.ndjson', 'memory/backlog-state.json', 'memory/cycle.md']
      .map((f) => { try { return f + ':' + readFileSync(join(root, f), 'utf8'); } catch { return f + ':absent'; } }).join('\u0000'),
  };
}

// --- 1. layers + a gate: the plan is derived, the gate is reported -------------
{
  const p = makePlaybook({
    tasks: 'tasks:\n' +
      '  - {id: ready-now, title: ungated sibling, status: todo, priority: 1, layer: L0}\n' +
      '  - {id: gated, title: other L0 work, status: todo, priority: 2, layer: L0}\n' +
      '  - {id: domain, title: needs L0 green, status: todo, priority: 3, layer: L1}\n',
  });

  const r = p.pb(['plan', '--layers']);
  ok('a declared layer plan renders instead of the flat-queue notice',
    /Layered plan/.test(r.stdout) && !/flat queue/.test(r.stdout), r.stdout + r.stderr);
  ok('every layer is listed with its status counts', /L0 \(substrate\)/.test(r.stdout) && /L1 \(domain\)/.test(r.stdout), r.stdout);
  ok('the gate is shown as NOT checked when --check-gates is absent',
    /gate unchecked/.test(r.stdout), r.stdout);
  ok('a task in a higher layer is reported as waiting on the layer below',
    /waiting on lower layer\(s\): L0/.test(r.stdout), r.stdout);
  ok('same-layer work is still claimable while the gate is unverified',
    /ready now \(claimable\): ready-now, gated/.test(r.stdout), r.stdout);
  ok('the dry run exits 0 on a sound plan with open work', r.status === 0, `exit=${r.status}\n${r.stdout}`);

  const j = p.pb(['plan', '--layers', '--json']);
  let plan = null;
  try { plan = JSON.parse(j.stdout); } catch (e) { ok('--json emits parseable JSON', false, `${e.message}\n${j.stdout}`); }
  if (plan) {
    ok('--json marks the plan structurally valid', plan.structurally_valid === true, JSON.stringify(plan.problems));
    ok('--json derives the same layers the text view shows',
      JSON.stringify(plan.layer_ids) === JSON.stringify(['L0', 'L1']), JSON.stringify(plan.layer_ids));
    ok('--json reports the higher-layer task as blocked by the lower gate',
      (plan.tasks.find((t) => t.id === 'domain')?.gate_blocked_by || []).map((b) => b.layer).join() === 'L0',
      JSON.stringify(plan.tasks.find((t) => t.id === 'domain')));
    ok('--json is explicit that gates were not executed', plan.gates_checked === false, JSON.stringify(plan.gates_checked));
    ok('--json output is byte-identical to itself (the dry run is deterministic)',
      p.pb(['plan', '--layers', '--json']).stdout === j.stdout, 'two runs differed');
  }
}

// --- 2. the dry run writes nothing --------------------------------------------
{
  const p = makePlaybook({
    tasks: 'tasks:\n' +
      '  - {id: a, title: A, status: todo, priority: 1, layer: L0}\n' +
      // A check that would leave evidence if a dry run ever executed it. The flow
      // mapping must be CLOSED before the nested key, or the scratch backlog is
      // invalid YAML and every "dry run wrote nothing" assertion passes vacuously.
      '  - {id: b, title: B, status: todo, priority: 2, layer: L1,\n' +
      '    acceptance_checks: ["node -e \\"require(\'fs\').writeFileSync(\'memory/ran-check\',\'x\')\\""]}\n',
  });
  // A malformed scratch backlog would make this whole section vacuous (no tasks means
  // "nothing was written" is trivially true), so prove the fixture parsed.
  const fixture = p.pb(['plan', '--layers', '--json']);
  let fixtureIds = [];
  try { fixtureIds = JSON.parse(fixture.stdout).tasks.map((t) => t.id).sort(); } catch { /* reported below */ }
  ok('the guarded-dry-run fixture parses (its backlog has both tasks)',
    JSON.stringify(fixtureIds) === JSON.stringify(['a', 'b']), fixture.stdout.slice(0, 300) + fixture.stderr.slice(0, 300));
  const before = p.snap();
  const r = p.pb(['plan', '--layers', '--check-gates']);
  const after = p.snap();
  ok('the dry run does not touch the backlog, journal, state or cycle brief',
    before === after, 'a guarded file changed');
  ok('no acceptance_check is executed by a dry run (`--check-gates` runs GATES only)',
    !existsSync(join(p.root, 'memory/ran-check')), 'memory/ran-check exists — a task check ran');
  ok('--check-gates DOES evaluate the gate (the failing gate is named)',
    /gate FAIL/.test(r.stdout) && /Gates FAILING: L0/.test(r.stdout), r.stdout);
  ok('--check-gates exits non-zero while a layer gate fails', r.status === 2, `exit=${r.status}`);
  ok('evaluating the gate is still not a write', before === p.snap(), 'a guarded file changed');
  ok('--strict makes open work a failure', p.pb(['plan', '--layers', '--strict']).status === 1,
    `exit=${p.pb(['plan', '--layers', '--strict']).status}`);
}

// --- 3. gates block the CLAIM path, not just the report ------------------------
{
  // An L0 task is claimable while its OWN gate is red (the gate guards the layers
  // above); the L1 task must not be, at any priority.
  const p = makePlaybook({
    tasks: 'tasks:\n' +
      '  - {id: upper, title: L1 work (higher priority), status: todo, priority: 1, layer: L1}\n' +
      '  - {id: lower, title: L0 work, status: todo, priority: 2, layer: L0}\n',
  });
  const plan = JSON.parse(p.pb(['plan', '--layers', '--json']).stdout);
  ok('a failing lower gate keeps the higher layer out of the ready set',
    plan.ready.join() === 'lower', JSON.stringify(plan.ready));
  // Without --check-gates the gate is not run, and the blocker says so: the plan must
  // never present an UNVERIFIED gate as if it were evaluated.
  ok('an unchecked gate blocks and is marked as not evaluated',
    (plan.tasks.find((t) => t.id === 'upper')?.gate_blocked_by || []).every((b) => b.evaluated === false),
    JSON.stringify(plan.tasks.find((t) => t.id === 'upper')?.gate_blocked_by));
  const checked = JSON.parse(p.pb(['plan', '--layers', '--check-gates', '--json']).stdout);
  ok('--check-gates marks the blocker as evaluated and still blocking',
    (checked.tasks.find((t) => t.id === 'upper')?.gate_blocked_by || []).every((b) => b.evaluated === true),
    JSON.stringify(checked.tasks.find((t) => t.id === 'upper')?.gate_blocked_by));
  ok('the failing layer gate outranks priority in selection',
    /Next task: \[lower\]/.test(p.pb(['next']).stdout), p.pb(['next']).stdout);

  // With the lower layer DONE, the gated layer above is the only work left — and it
  // must still be refused, by name, while the gate is red.
  const done = p.pb(['record', '--task', 'lower', '--action', 'execute', '--status', 'done', '--force']);
  ok('the lower-layer task can be recorded done', done.status === 0, done.stdout + done.stderr);
  const noWork = p.pb(['next']);
  ok('with only higher-layer work left, selection offers nothing claimable',
    /No claimable/.test(noWork.stdout + noWork.stderr) && !/Next task: \[/.test(noWork.stdout),
    noWork.stdout + noWork.stderr);
  ok('the refusal says which layer is holding it and why',
    /layer L1 held by layer L0/.test(noWork.stdout) && /gate FAILING/.test(noWork.stdout),
    noWork.stdout + noWork.stderr);

  // Green the gate. `upper` is now the only open work, so the claim lands on the very
  // task the red gate refused a moment ago.
  writeFileSync(join(p.root, 'memory/gate0.ok'), 'ok\n');
  const gated = p.pb(['plan', '--layers', '--check-gates']);
  ok('a passing gate stops blocking the layer above', !/Gates FAILING/.test(gated.stdout), gated.stdout);
  ok('the gate state is reported as PASS, not merely unblocked', /gate PASS/.test(gated.stdout), gated.stdout);
  const claim = p.pb(['next', '--claim', '--force']);
  ok('the formerly refused task is now claimed',
    /Claimed \[upper\]/.test(claim.stdout) && claim.status === 0,
    claim.stdout + claim.stderr);
}
{
  // A finished layer whose GATE is red still holds the layer above: the gate is the
  // claim that the layer is sound, and "all its tasks were ticked off" is not that
  // claim. This is the difference between a task list and a maturity gate.
  const p2 = makePlaybook({
    tasks: 'tasks:\n' +
      '  - {id: below, title: L0 work, status: done, priority: 1, layer: L0}\n' +
      '  - {id: above, title: L1 work, status: todo, priority: 2, layer: L1}\n',
  });
  const gatedRed = JSON.parse(p2.pb(['plan', '--layers', '--check-gates', '--json']).stdout);
  ok('a lower layer that is DONE but whose gate is red still holds the layer above',
    gatedRed.ready.length === 0 && (gatedRed.tasks.find((t) => t.id === 'above')?.gate_blocked_by.length || 0) === 1,
    JSON.stringify(gatedRed.tasks.find((t) => t.id === 'above')));
  ok('the group is quiet about a finished dependency — only the gate is holding it',
    (gatedRed.tasks.find((t) => t.id === 'above')?.group_blocked_by.length || 0) === 0,
    JSON.stringify(gatedRed.tasks.find((t) => t.id === 'above')));
  writeFileSync(join(p2.root, 'memory/gate0.ok'), 'ok\n');
  const gatedGreen = JSON.parse(p2.pb(['plan', '--layers', '--check-gates', '--json']).stdout);
  ok('green the lower gate and the layer above finally opens',
    gatedGreen.ready.join() === 'above' && gatedGreen.tasks.find((t) => t.id === 'above')?.group_blocked_by.length === 0,
    JSON.stringify(gatedGreen.tasks.find((t) => t.id === 'above')));
}

// --- 4. derived layer vs. declared layer: a contradiction must FAIL ------------
{
  const p = makePlaybook({
    tasks: 'tasks:\n' +
      '  - {id: deep, title: dependency, status: done, priority: 1, layer: L1}\n' +
      '  - {id: early, title: declared too early, status: todo, priority: 2, layer: L0, dependencies: [deep]}\n',
  });
  const plan = JSON.parse(p.pb(['plan', '--layers', '--json']).stdout);
  ok('a task declared in an earlier layer than its dependency is a plan problem',
    plan.problems.some((x) => /declared layer "L0" but depends on deep in layer "L1"/.test(x.message)),
    JSON.stringify(plan.problems));
  ok('the contradiction is reported with the deep-derived position',
    plan.problems.some((x) => x.code === 'layer-order' || x.code === 'layer-too-early'), JSON.stringify(plan.problems));
  ok('a contradictory plan exits 2 from the dry run', p.pb(['plan', '--layers']).status === 2, `exit=${p.pb(['plan', '--layers']).status}`);
  const v = p.pb(['validate']);
  ok('a contradictory plan fails `pb validate` (structure is a guardrail)', v.status === 1, v.stdout + v.stderr);
  ok('validate names the offending task', /\[early\]/.test(v.stdout + v.stderr), v.stdout + v.stderr);
}

// --- 5. cycles and unknown layers fail validate --------------------------------
{
  const p = makePlaybook({
    tasks: 'tasks:\n' +
      '  - {id: x, title: X, status: todo, priority: 1, layer: L0, dependencies: [z]}\n' +
      '  - {id: y, title: Y, status: todo, priority: 2, layer: L1, dependencies: [x]}\n' +
      '  - {id: z, title: Z, status: todo, priority: 3, layer: L1, dependencies: [y]}\n',
  });
  const plan = JSON.parse(p.pb(['plan', '--layers', '--json']).stdout);
  ok('a dependency cycle is a plan problem', plan.problems.some((x) => x.code === 'cycle'), JSON.stringify(plan.problems));
  ok('the cycle names every task that cannot be ordered',
    /x, y, z/.test(plan.problems.find((x) => x.code === 'cycle')?.message || ''), JSON.stringify(plan.problems));
  ok('a cyclic plan exits 2 from the dry run', p.pb(['plan', '--layers']).status === 2, `exit=${p.pb(['plan', '--layers']).status}`);
  ok('a cyclic plan fails `pb validate`', p.pb(['validate']).status === 1, p.pb(['validate']).stdout);
}
{
  const p = makePlaybook({
    tasks: 'tasks:\n  - {id: a, title: A, status: todo, priority: 1, layer: L9}\n',
  });
  const plan = JSON.parse(p.pb(['plan', '--layers', '--json']).stdout);
  ok('an undeclared layer is a plan problem',
    plan.problems.some((x) => x.code === 'unknown-layer'), JSON.stringify(plan.problems));
  ok('an unknown layer fails `pb validate`', p.pb(['validate']).status === 1, p.pb(['validate']).stdout);
}

// --- 6. no layers declared: the engine behaves exactly as before ---------------
{
  const p = makePlaybook({
    layers: '',
    tasks: 'tasks:\n  - {id: a, title: A, status: todo, priority: 1}\n',
  });
  const r = p.pb(['plan', '--layers']);
  ok('an unlayered playbook says so and stays valid', /flat queue/.test(r.stdout) && r.status === 0, r.stdout);
  // The scratch fixture has no SKILL.md/indices, so `validate` is expected to report
  // THOSE; what matters here is that declaring no layers adds nothing to the list.
  // Asserting "exit 0" would only be testing the fixture, and asserting "exit 1" would
  // be vacuous — so compare a layered twin against this one instead.
  const bare = p.pb(['validate']);
  const withLayers = makePlaybook({
    tasks: 'tasks:\n  - {id: a, title: A, status: todo, priority: 1, layer: L0}\n',
  }).pb(['validate']);
  const bareFailures = (bare.stdout + bare.stderr).match(/^\s+[-•]\s.*$/gm)?.length
    ?? (bare.stdout + bare.stderr).split('\n').filter((l) => /missing|not found|error/i.test(l)).length;
  const layeredFailures = (withLayers.stdout + withLayers.stderr).match(/^\s+[-•]\s.*$/gm)?.length
    ?? (withLayers.stdout + withLayers.stderr).split('\n').filter((l) => /missing|not found|error/i.test(l)).length;
  ok('declaring NO layers adds no structural failures to a playbook',
    bareFailures === layeredFailures,
    `bare=${bareFailures} layered=${layeredFailures}\n--- bare ---\n${bare.stdout}${bare.stderr}\n--- layered ---\n${withLayers.stdout}${withLayers.stderr}`);
  ok('a legacy playbook with no `layers` key still parses and reports no layer problems',
    !/layer/i.test((bare.stdout + bare.stderr).replace(/layers?\b[^.]*declares? no[^.]*\./gi, '')) ||
    !/unknown-layer|cycle|layer-order|layer-too-early/.test(bare.stdout + bare.stderr),
    bare.stdout + bare.stderr);
  const plan = JSON.parse(p.pb(['plan', '--layers', '--json']).stdout);
  ok('an unlayered playbook plans the task at depth 0',
    (plan.tasks.find((t) => t.id === 'a') || {}).derived_layer === 0, JSON.stringify(plan.tasks));
  ok('an unlayered task is claimable with no gate in its way',
    plan.tasks.find((t) => t.id === 'a')?.ready === true, JSON.stringify(plan.tasks));
}

// --- 7. derived depth follows the dependency chain -----------------------------
{
  const p = makePlaybook({
    layers: '',
    tasks: 'tasks:\n' +
      '  - {id: one, title: 1, status: todo, priority: 1}\n' +
      '  - {id: two, title: 2, status: todo, priority: 2, dependencies: [one]}\n' +
      '  - {id: three, title: 3, status: todo, priority: 3, dependencies: [two]}\n' +
      '  - {id: wide, title: 4, status: todo, priority: 4, dependencies: [one]}\n',
  });
  const plan = JSON.parse(p.pb(['plan', '--layers', '--json']).stdout);
  const depth = Object.fromEntries(plan.tasks.map((t) => [t.id, t.derived_layer]));
  ok('depth is derived from the dependency chain, not declared',
    depth.one === 0 && depth.two === 1 && depth.three === 2 && depth.wide === 1, JSON.stringify(depth));
  ok('only the root of the open chain is claimable', plan.ready.join() === 'one', JSON.stringify(plan.ready));
  ok('the critical path measures the longest open chain',
    plan.critical_path.length === 3 && plan.critical_path.head === 'three' && plan.critical_path.open_tasks === 4,
    JSON.stringify(plan.critical_path));
}

// --- 8. unlayered tasks are unconstrained in BOTH directions -------------------
// The rule is symmetric and total: no gate holds an unlayered task back, and it
// holds nothing back. This replaced a `layers_unlayered_loose` flag that was read and
// printed but never consulted — it advertised a "fast lane" that did not exist, and a
// knob that reports behavior it does not have is worse than no knob. Pinned here so
// the honest rule cannot drift back into an inert one.
{
  const p = makePlaybook({
    tasks: 'tasks:\n' +
      '  - {id: free, title: no layer, status: todo, priority: 1}\n' +
      '  - {id: below, title: L0 work, status: todo, priority: 2, layer: L0}\n' +
      '  - {id: above, title: L1 work, status: todo, priority: 3, layer: L1}\n',
  });
  const plan = JSON.parse(p.pb(['plan', '--layers', '--check-gates', '--json']).stdout);
  const free = plan.tasks.find((t) => t.id === 'free');
  const above = plan.tasks.find((t) => t.id === 'above');
  ok('an unlayered task is marked unlayered', free.unlayered === true && free.layer === null, JSON.stringify(free));
  ok('no gate holds an unlayered task back even while a lower layer gate is failing',
    free.gate_blocked_by.length === 0 && free.ready === true, JSON.stringify(free));
  ok('an unlayered task does not join a layer bucket',
    plan.unlayered_tasks.includes('free') && !plan.layers.some((l) => l.tasks.includes('free')),
    JSON.stringify({ unlayered: plan.unlayered_tasks, layers: plan.layers.map((l) => l.tasks) }));
  ok('an unlayered task holds NOTHING back: the higher layer is still blocked by its own layer',
    above.group_blocked_by.join() === 'below', JSON.stringify(above.group_blocked_by));
  // The inert knob is gone from the payload: nothing may advertise it again.
  ok('the plan payload does not carry a relaxation knob',
    plan.unlayered_loose === undefined, JSON.stringify(Object.keys(plan)));
  const text = p.pb(['plan', '--layers']).stdout;
  ok('the report states the symmetric rule and not a fast lane',
    /declare no layer — no gate holds them back, and they hold nothing back/.test(text) && !/fast lane|interleave freely/.test(text),
    text);
}

// --- 9. adopting layers through the CLI: `pb plan --layer` ---------------------
// The scaffolding path is how a repo actually adopts layers, and it is the one place
// a typo lands: an undeclared layer must be refused BEFORE a task is written, or the
// backlog quietly fills with tasks no plan can place.
{
  const p = makePlaybook({ tasks: 'tasks: []\n' });
  // This fixture has no skills index, so scaffold with `--skill ''` — `--layer` is what
  // is under test here, and a skill id would only be testing the catalog.
  const flat = ['--skill', ''];
  p.pb(['cycle', '--new', '--force', '--goal', 'adopt layers', '--stop', 'tasks planned']);
  const cyclePath = join(p.root, 'memory/cycle.md');
  writeFileSync(cyclePath, readFileSync(cyclePath, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
    'No conflicts found.',
  ));
  const good = p.pb(['plan', '--goal', 'substrate work', '--layer', 'L0', '--check', 'node -e process.exit(0)', ...flat]);
  ok('`pb plan --layer L0` stamps the declared layer',
    /Planned \[/.test(good.stdout) && /layer: L0/.test(good.stdout), good.stdout + good.stderr);
  const bad = p.pb(['plan', '--goal', 'bogus task', '--layer', 'L9', ...flat]);
  ok('scaffolding into an undeclared layer is refused',
    bad.status !== 0 && /Unknown layer/.test(bad.stdout + bad.stderr), bad.stdout + bad.stderr);
  ok('the refused scaffold wrote nothing to the backlog',
    !/bogus task/.test(readFileSync(join(p.root, 'memory/backlog.yaml'), 'utf8')),
    readFileSync(join(p.root, 'memory/backlog.yaml'), 'utf8'));
  const noLayer = p.pb(['plan', '--goal', 'flat task', ...flat]);
  ok('`--layer` is optional so a repo can adopt layers incrementally',
    /Planned \[/.test(noLayer.stdout) && !/layer:/.test(noLayer.stdout), noLayer.stdout + noLayer.stderr);
}

console.log(`\ntest-layered-plan: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
