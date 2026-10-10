#!/usr/bin/env node
// scripts/test-plan-linkage.mjs
// ----------------------------------------------------------------------------
// LINKAGE AT BIRTH (P3). `dependencies:` was already enforced — validate rejected a
// malformed list, the claim path refused an unmet prerequisite, the layer depth derived
// from the deepest dependency — but nothing could DECLARE one at creation, so every
// scaffolded task was born unlinked and `pb graph` had no dep edge to draw. This suite
// pins the fix by BEHAVIOUR, and every assertion is written so it can fail:
//
//   1. `pb plan --dep <id>` writes the dependency into the backlog at birth, and the
//      claim path honours it: the dependent is NOT claimable while the prerequisite is
//      open (the refusal names it, and leaves no lease), and IS claimable once the
//      prerequisite's checks actually exited 0.
//   2. `pb graph --json` draws that dependency INVERTED (prerequisite → task), exactly
//      the direction `plan --layers --json` does not use, and marks it done-through only
//      when the prerequisite's done row ran its checks.
//   3. A task planned while another is in flight gets a journal `action: spawn` row
//      carrying `origin_task`; the graph turns that into a task→task spawn edge
//      (proven, evidence 'spawn') instead of hanging the card off `start`.
//   4. An unknown `--dep` id and a self-dependency are REFUSED with nothing written —
//      asserted against the backlog text, not just the exit code.
//   5. A hand-edited bad dependency (unknown id, self-reference) makes `pb validate`
//      RED, and repairing the same line makes it GREEN — the failure is the file, not a
//      cache.
//   6. The structural probe refuses a `--layer`/`--dep` pair validate would reject
//      before it is written, and is not a blanket refusal (the legal pair is accepted).
//
// Fixtures are temp playbook roots with the real engine copied in, the pattern the other
// suites use; no assertion here depends on this repo's own backlog.
// ----------------------------------------------------------------------------
import {
  mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// `record --status done` runs these checks with PB_CLAIM_TOKEN/PB_AGENT_CHAIN stamped on
// the environment (that is how P3's own work is recorded). An inherited token would make
// "the refusal left no lease" / attribution assertions pass for the wrong reason, so the
// suite scrubs every PB_* identity it does not set itself.
const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['PB_CLAIM_TOKEN', 'PB_AGENT_CHAIN', 'PB_PARENT_AGENT_ID', 'PB_AGENT_ID', 'PB_SESSION_ID', 'PB_RUNTIME']) delete e[k];
  return e;
})();
function runPb(root, args, { agent = 'agent', env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...BASE_ENV, PB_AGENT_ID: agent, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', combined: `${r.stdout || ''}${r.stderr || ''}` };
}
function parseJson(r, what) {
  try { return JSON.parse(r.out); }
  catch (e) { throw new Error(`${what}: no parseable JSON (exit ${r.code}): ${e.message}\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 600)}`); }
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const readJournal = (root) => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const plannedId = (r) => (/Planned \[([^\]]+)\]/.exec(r.out) || [])[1] || null;

// A playbook that can plan, claim and record for real: a minimal but RESOLVABLE skill +
// process catalog (otherwise every `pb plan` would fail on the fixture instead of on the
// behaviour under test), an active loop, a cycle brief without the unanswered-Q5 marker,
// and an empty or supplied backlog. It declares no layers unless a test asks for them —
// an unlayered fixture cannot be held back by a layer gate or a lower layer's open work,
// so a refusal here can only be the dependency.
function makeFixture({ layers = '', tasks = 'tasks: []\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pblink-'));
  for (const d of ['scripts', 'memory', 'modes', 'skills/run-task', 'processes', 'artifacts/reports']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  try { symlinkSync(resolve('node_modules'), join(root, 'node_modules')); } catch { /* already linked */ }
  writeFileSync(join(root, 'SKILL.md'), '---\nname: linkage-test\ndescription: t\n---\n');
  writeFileSync(join(root, 'skills/index.yaml'),
    'skills:\n  - {id: run-task, file: skills/run-task/SKILL.md, process: run-task}\n');
  writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run-task\n');
  writeFileSync(join(root, 'processes/index.yaml'),
    'processes:\n  - {id: run-task, file: processes/run-task.yaml}\n');
  writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\nsteps: []\n');
  writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  // Without this the fixture is validate-RED for an unrelated reason, and every "RED"
  // assertion below would pass vacuously.
  writeFileSync(join(root, 'memory/project-memory.md'), '# fixture memory\n');
  writeFileSync(join(root, 'playbook.yaml'),
    'name: linkage-test\nversion: 0.7.1\nentry: SKILL.md\n' +
    'north_star: Make "done" mean a verified exit code, not a claim.\n' +
    'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
    'index:\n  cli: scripts/pb.mjs\n  skills_index: skills/index.yaml\n  processes_index: processes/index.yaml\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
    'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
    'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
    'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n' +
    layers);
  writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - id: L1\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(root, 'memory/cycle.md'), '# c\n## 1. Goal\nlink tasks at birth\n## 2. Foresee\nx\n## 3. Prior\nx\n## 4. Stop\nx\n## 5. Conflicts\nNone\n');
  writeFileSync(join(root, 'memory/backlog.yaml'), tasks);
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  const backlogPath = join(root, 'memory/backlog.yaml');
  return {
    root,
    backlogPath,
    statePath: join(root, 'memory/backlog-state.json'),
    pb: (args, opts = {}) => runPb(root, args, opts),
    backlogText: () => readFileSync(backlogPath, 'utf8'),
    journal: () => readJournal(root),
  };
}
const CHECK = 'node -e process.exit(0)';

// ============================================================================
//  1. plan --dep links at birth; the claim path honours the order
// ============================================================================
{
  const fx = makeFixture();
  // The prerequisite is planned first — with no --dep, because there is nothing to
  // depend on yet. Linkage is per-edge, not a mode.
  const first = fx.pb(['plan', '--goal', 'the foundation', '--priority', '1', '--check', CHECK], { agent: 'worker' });
  const F = plannedId(first);
  ok('a task can still be planned without --dep (linkage is per-edge, not a mode)',
    first.code === 0 && !!F, first.combined.slice(0, 400));
  if (!F) { console.error('cannot continue without a planned id'); process.exit(1); }

  const claimed = fx.pb(['next', '--claim'], { agent: 'worker' });
  const token = (/Claim token: ([0-9a-f]+)/.exec(claimed.combined) || [])[1] || null;
  ok('the agent that will spawn the child is the one executing the parent',
    claimed.code === 0 && new RegExp(`Claimed \\[${F}\\]`).test(claimed.combined) && !!token, claimed.combined.slice(0, 400));

  // The dependent is planned FROM the parent, with --dep.
  const second = fx.pb(['plan', '--goal', 'the dependent', '--priority', '2', '--check', CHECK, '--dep', F], { agent: 'worker' });
  const D = plannedId(second);
  ok('`pb plan --dep <id>` scaffolds the dependent and reports the declared dependency',
    second.code === 0 && !!D && second.out.includes(`← ${F}`), second.combined.slice(0, 500));
  if (!D) { console.error('cannot continue without a dependent id'); process.exit(1); }

  const yaml = fx.backlogText();
  ok('the dependency is IN the backlog the moment the task is (not appended later by hand)',
    new RegExp(`- id: ${D}[\\s\\S]{0,400}?dependencies:\\s*\\n\\s*- ${F}`).test(yaml), yaml.slice(-600));

  // --- the spawn row: origin_task is a recorded fact, not a graph guess --------
  const spawnRow = fx.journal().find((r) => r.task === D && r.action === 'spawn');
  ok('a task born while another is in flight records origin_task on its spawn journal row',
    !!spawnRow && spawnRow.origin_task === F, JSON.stringify(spawnRow));
  ok('the spawn row is attributable and numbered like every other write (agent, seq, ownership)',
    !!spawnRow && spawnRow.agent === 'worker' && typeof spawnRow.seq === 'number' && spawnRow.ownership === 'unclaimed',
    JSON.stringify(spawnRow));
  ok('the spawn row states the truth at birth: the new task is `todo`',
    !!spawnRow && spawnRow.status === 'todo', JSON.stringify(spawnRow && spawnRow.status));

  // --- the engine's own map is upstream; the graph must invert it -------------
  const plan = parseJson(fx.pb(['plan', '--layers', '--json']), 'plan --layers --json');
  ok('`plan --layers --json` maps the dependent to its prerequisite (UPSTREAM)',
    (plan.edges[D] || []).join() === F, JSON.stringify({ [D]: plan.edges[D], [F]: plan.edges[F] }));

  const g1 = parseJson(fx.pb(['graph', '--json']), 'graph --json');
  const depEdge = g1.edges.find((e) => e.kind === 'dep' && e.to === D);
  ok('`pb graph --json` draws the dependency INVERTED (prerequisite → task)',
    !!depEdge && depEdge.from === F && depEdge.to === D, JSON.stringify(g1.edges));
  ok('the graph does NOT draw the upstream direction for that dependency',
    !g1.edges.some((e) => e.kind === 'dep' && e.from === D && e.to === F), JSON.stringify(g1.edges));
  const spawnEdge = g1.edges.find((e) => e.kind === 'spawn' && e.to === D);
  ok('origin_task yields a TASK→TASK spawn edge, proven by the explicit spawn row',
    !!spawnEdge && spawnEdge.from === F && spawnEdge.proven === true && spawnEdge.evidence === 'spawn',
    JSON.stringify(spawnEdge));
  ok('the spawned card is NOT hung off `start`',
    !g1.edges.some((e) => e.kind === 'spawn' && e.to === D && e.from === 'start'),
    JSON.stringify(g1.edges.filter((e) => e.kind === 'spawn')));
  ok('the new task is still `todo` — a spawn row cannot start work',
    g1.nodes.find((n) => n.id === D)?.status === 'todo', JSON.stringify(g1.nodes.find((n) => n.id === D)?.status));
  ok('the spawn row replays as a non-event: `repair-state --check` finds no drift',
    fx.pb(['repair-state', '--check']).code === 0, fx.pb(['repair-state', '--check']).combined.slice(0, 300));

  // --- the ordering the claim path enforces -----------------------------------
  const blocked = fx.pb(['next', '--claim'], { agent: 'other' });
  ok('while the dependency is open the dependent is NOT claimable, and the refusal names it',
    !new RegExp(`Claimed \\[${D}\\]`).test(blocked.combined) && blocked.combined.includes(F),
    blocked.combined.slice(0, 500));
  const st1 = readJson(fx.statePath);
  ok('the refused claim left no lease on the dependent',
    !(st1[D] && st1[D].claimed_by) && (st1[D]?.status ?? 'todo') !== 'in_progress', JSON.stringify(st1[D] || null));

  const done = fx.pb(['record', '--task', F, '--action', 'execute', '--status', 'done', '--notes', 'delivered', '--files', 'foundation.mjs'],
    { agent: 'worker', env: { PB_CLAIM_TOKEN: token } });
  ok('the prerequisite reaches done through its own acceptance checks',
    done.code === 0 && /checks: passed/.test(done.out), done.combined.slice(0, 500));

  const claimed2 = fx.pb(['next', '--claim'], { agent: 'other' });
  ok('once the dependency is done the dependent IS claimable (the order is real, not cosmetic)',
    claimed2.code === 0 && new RegExp(`Claimed \\[${D}\\]`).test(claimed2.combined), claimed2.combined.slice(0, 500));

  const g2 = parseJson(fx.pb(['graph', '--json']), 'graph after done');
  ok('the dep edge is marked done-through only once the prerequisite\'s checks exited 0',
    g2.edges.find((e) => e.kind === 'dep' && e.to === D)?.exited_zero === true,
    JSON.stringify(g2.edges.find((e) => e.kind === 'dep' && e.to === D)));
  ok('the spawn edge survives the claim and still points at its origin',
    g2.edges.find((e) => e.kind === 'spawn' && e.to === D)?.from === F,
    JSON.stringify(g2.edges.find((e) => e.kind === 'spawn' && e.to === D)));

  const v = fx.pb(['validate']);
  ok('`pb validate` is green on a backlog whose dependency was declared by `pb plan --dep`',
    v.code === 0, v.combined.slice(0, 500));
}

// ============================================================================
//  2. refusals: unknown id, self-dependency — and NOTHING is written
// ============================================================================
{
  const fx = makeFixture();

  // Discover the id the engine would mint next WITHOUT guessing its date format: plan a
  // canary, read the id out of the engine's own output, then put the backlog back to
  // empty (nextPlanId counts tasks with today's prefix) so the next mint is that same id.
  const canary = fx.pb(['plan', '--goal', 'canary', '--check', CHECK], { agent: 'worker' });
  const selfId = plannedId(canary);
  writeFileSync(fx.backlogPath, 'tasks:\n');
  ok('the engine mints an id the test can name exactly (so the self-dependency case is exact)',
    !!selfId, canary.combined.slice(0, 400));

  const beforeYaml = fx.backlogText();
  const beforeRows = fx.journal().length;

  const unknown = fx.pb(['plan', '--goal', 'orphan work', '--dep', 'ghost-task-zzz'], { agent: 'worker' });
  ok('an unknown --dep id is refused up front, with the id named and "nothing was written"',
    unknown.code === 1 &&
    /Refusing to plan — dependency "ghost-task-zzz" is not in the backlog/.test(unknown.combined) &&
    /Nothing was written/.test(unknown.combined),
    unknown.combined.slice(0, 500));
  ok('the refused unknown dependency wrote no task and no journal row',
    fx.backlogText() === beforeYaml && !/orphan work/.test(fx.backlogText()) && fx.journal().length === beforeRows,
    fx.backlogText().slice(-400));

  const self = fx.pb(['plan', '--goal', 'self work', '--dep', selfId], { agent: 'worker' });
  ok('a self-dependency is refused with the id named',
    self.code === 1 && new RegExp(`${selfId} cannot depend on itself`).test(self.combined.replace(/\s+/g, ' ')),
    self.combined.slice(0, 500));
  ok('the refused self-dependency wrote no task and no journal row',
    fx.backlogText() === beforeYaml && !/self work/.test(fx.backlogText()) && fx.journal().length === beforeRows,
    fx.backlogText().slice(-400));

  // The control: the id the self-dep case used really IS the id about to be minted.
  const control = fx.pb(['plan', '--goal', 'the control task', '--check', CHECK], { agent: 'worker' });
  ok('the control proves the refused id WAS the next id, so the self-check was not vacuous',
    new RegExp(`Planned \\[${selfId}\\]`).test(control.out), control.combined.slice(0, 400));

  const dup = fx.pb(['plan', '--goal', 'duplicate dep', '--dep', selfId, '--dep', selfId], { agent: 'worker' });
  ok('the same --dep id twice is refused rather than silently deduplicated',
    dup.code === 1 && /more than once/.test(dup.combined) && !/duplicate dep/.test(fx.backlogText()),
    dup.combined.slice(0, 400));
}

// ============================================================================
//  3. the structural probe: refuse what validate would reject, and only that
// ============================================================================
{
  const fx = makeFixture({
    layers: 'layers:\n  - {id: L0, name: substrate}\n  - {id: L1, name: surface}\n',
    tasks: 'tasks:\n  - {id: base-task, title: the substrate, status: todo, skill: run-task, mode: coding, priority: 1, layer: L0, acceptance_checks: ["' + CHECK + '"]}\n',
  });
  const beforeYaml = fx.backlogText();

  const sameLayer = fx.pb(['plan', '--goal', 'same-layer work', '--layer', 'L0', '--dep', 'base-task', '--check', CHECK], { agent: 'worker' });
  ok('a --dep from the SAME layer is refused before it is written (validate would reject it)',
    sameLayer.code === 1 && /same or a later layer/.test(sameLayer.combined), sameLayer.combined.slice(0, 500));
  ok('that refusal wrote nothing to the backlog', fx.backlogText() === beforeYaml, fx.backlogText().slice(-400));

  const deeper = fx.pb(['plan', '--goal', 'deeper work', '--layer', 'L1', '--dep', 'base-task', '--check', CHECK], { agent: 'worker' });
  ok('the probe is not a blanket refusal: a dependency from a LOWER layer is accepted',
    deeper.code === 0 && !!plannedId(deeper), deeper.combined.slice(0, 500));
  ok('`pb validate` is green after the accepted layered dependency',
    fx.pb(['validate']).code === 0, fx.pb(['validate']).combined.slice(0, 400));
}

// ============================================================================
//  4. a hand-edited bad dependency: validate RED, then GREEN — the file, not a cache
// ============================================================================
{
  const head = 'tasks:\n' +
    '  - {id: good, title: the prerequisite, status: todo, skill: run-task, mode: coding, priority: 1, acceptance_checks: ["' + CHECK + '"]}\n' +
    '  - {id: bad, title: the dependent, status: todo, skill: run-task, mode: coding, priority: 2, ';
  const tail = ', acceptance_checks: ["' + CHECK + '"]}\n';
  const fx = makeFixture({ tasks: head + 'dependencies: [ghost-task-zzz]' + tail });

  const red = fx.pb(['validate']);
  ok('`pb validate` is RED on a hand-edited dependency that names no task',
    red.code === 1 && /depends on "ghost-task-zzz"/.test(red.combined), red.combined.slice(0, 500));

  const ghostGraph = parseJson(fx.pb(['graph', '--json']), 'graph with an unknown dependency');
  ok('the graph draws no edge to a card that does not exist (it cannot invent one)',
    !ghostGraph.edges.some((e) => e.kind === 'dep' && e.to === 'bad' && e.from === 'ghost-task-zzz'),
    JSON.stringify(ghostGraph.edges));

  writeFileSync(fx.backlogPath, head + 'dependencies: [good]' + tail);
  const green = fx.pb(['validate']);
  ok('`pb validate` goes GREEN once the same line names a real task (no cache, no free pass)',
    green.code === 0, green.combined.slice(0, 400));
  const goodGraph = parseJson(fx.pb(['graph', '--json']), 'graph with a repaired dependency');
  const repaired = goodGraph.edges.find((e) => e.kind === 'dep' && e.to === 'bad');
  ok('the repaired dependency is drawn in the graph, inverted, with no re-plan required',
    !!repaired && repaired.from === 'good', JSON.stringify(goodGraph.edges));

  writeFileSync(fx.backlogPath, head + 'dependencies: [bad]' + tail);
  const selfRed = fx.pb(['validate']);
  ok('`pb validate` is RED on a hand-edited self-dependency',
    selfRed.code === 1 && /depends on itself/.test(selfRed.combined), selfRed.combined.slice(0, 400));
}

console.log(`\ntest-plan-linkage: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
