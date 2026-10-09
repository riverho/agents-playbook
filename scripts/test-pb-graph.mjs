#!/usr/bin/env node
// scripts/test-pb-graph.mjs
// ----------------------------------------------------------------------------
// The Flow room's engine half (P1, DESIGN.md §4). Every surface added for a graph
// UI is pinned here by BEHAVIOUR, not by the existence of a field:
//
//   1. `pb graph --json` — schema, and the node's status comes from the STATE
//      PROJECTION. The fixture's backlog.yaml says `status: todo` for a task the
//      projection calls `done`; an assertion that reads the YAML would be green on a
//      graph that lies, so the YAML text itself is asserted to still say `todo`.
//   2. Edge direction is proven by an inverted dependency: `plan --layers` maps
//      task → prerequisite (upstream); the graph must emit prerequisite → task.
//   3. The human batch is non-empty when a `manual: true` task exists, AND a declared
//      human-layer gate is NOT executed: the fixture gate writes a marker file if it
//      ever runs, and the test asserts the marker never appears.
//   4. Provenance — a node's journal rows carry the writer, ownership, delegation
//      chain and seq, and a spawn edge says whether it is a fact or a claim.
//   5. `pb comment` journals a row and does NOT move the task's status (asserted in
//      both the projection and a `repair-state --check` round trip).
//   6. `docs:` validation is RED before the file exists and GREEN after — the file is
//      created and removed in a temp fixture, never by weakening a real backlog.
//   7. A worker merge is journaled through commitIteration, so `repair-state --strict`
//      — which DROPS projection-only fields — keeps the merge.
//
// Fixtures are temp playbook roots (the pattern the other suites use): the engine is
// copied in, `node_modules` is symlinked, and every state file is written by the test.
// ----------------------------------------------------------------------------
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// The suite must behave the same however it is invoked. `record --status done` runs
// these checks with PB_CLAIM_TOKEN/PB_AGENT_CHAIN stamped on the environment (that is
// how the P1 work itself is recorded), which would silently make the "an unentitled
// comment does not change anything" assertion untestable. Scrub them.
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

// The gate command a graph must NEVER run: executing it is observable because it
// writes a marker file, and it exits 1 either way, so a graph that ran it would also
// be tempted to call the batch red.
const GATE_MARKER = 'GATE-RAN';
const HUMAN_GATE = `node -e "require('fs').writeFileSync('${GATE_MARKER}','the graph executed a gate command');process.exit(1)"`;

// --- fixture A: a non-git playbook with deps, a manual task, a doc and provenance --
function makeGraphFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pbgraph-'));
  for (const d of ['scripts', 'memory', 'modes', 'processes', 'skills/run-task', 'artifacts/reports', 'docs']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  cpSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  try { symlinkSync(resolve('node_modules'), join(root, 'node_modules')); } catch { /* already linked */ }
  writeFileSync(join(root, 'SKILL.md'), '---\nname: graph-test\ndescription: t\n---\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
  writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
  writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
  writeFileSync(join(root, 'skills/run-task/SKILL.md'), '---\nname: run-task\ndescription: t\n---\n');
  writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
  writeFileSync(join(root, 'memory/lessons.ndjson'), '');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');
  writeFileSync(join(root, 'memory/loops.yaml'),
    'active: loop-graph-001\nloops:\n  - id: loop-graph-001\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n    goal: fixture loop\n    stop: fixture stop\n    mode: coding\n');
  writeFileSync(join(root, 'memory/cycle.md'),
    '---\nphase: 7\nstarted: "2026-01-01T00:00:00.000Z"\n' +
    'goal: "paint the graph fixture"\nstop: "the projection is green; the room renders it"\n---\n' +
    '# Cycle Brief — phase 7\n## 1. What is this cycle\'s goal?\npaint the graph fixture\n');
  // Block style throughout, and `layers` is a list of mappings: a flow mapping closed
  // on the next line is invalid YAML, and a malformed fixture would make the gate
  // assertions below pass vacuously.
  writeFileSync(join(root, 'playbook.yaml'), [
    'name: graph-test', 'version: 0.0.1', 'entry: SKILL.md',
    'north_star: Make "done" mean a verified exit code, not a claim.',
    'paths:', '  scripts: scripts', '  processes: processes', '  skills: skills', '  memory: memory',
    '  modes: modes', '  artifacts: artifacts', '  reports: artifacts/reports',
    'index:', '  processes_index: processes/index.yaml', '  skills_index: skills/index.yaml', '  memory:',
    '    project_memory: memory/project-memory.md', '    backlog: memory/backlog.yaml',
    '    journal: memory/journal.ndjson', '    cycle: memory/cycle.md', '    loops: memory/loops.yaml',
    '    lessons: memory/lessons.ndjson', '    processes: memory/processes.ndjson',
    'loop:', '  description: test loop', '  steps:',
    '    - id: orient', '      do: orient', '      command: node scripts/pb.mjs status',
    '    - id: select', '      do: select', '      command: node scripts/pb.mjs next --claim',
    '    - id: act', '      do: act',
    '    - id: verify', '      do: verify', '      command: node scripts/pb.mjs validate',
    '    - id: record', '      do: record', '      command: node scripts/pb.mjs record',
    '    - id: report', '      do: report', '      command: node scripts/pb.mjs report',
    'default_mode: coding', 'modes:', '  coding: modes/coding.yaml',
    'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]',
    'layers:',
    '  - id: L0', '    name: infra', '    human: true', '    gate: >-', `      ${HUMAN_GATE}`,
    '  - id: L1', '    name: work',
    '',
  ].join('\n'));
  // `prereq` is declared L0 so the dependency crosses a layer (same-layer deps are a
  // validate failure by design), and every task says `status: todo` ON DISK even
  // though the projection says otherwise for two of them.
  writeFileSync(join(root, 'memory/backlog.yaml'), [
    'tasks:',
    '  - id: prereq', '    title: the prerequisite', '    status: todo', '    skill: run-task',
    '    mode: coding', '    priority: 1', '    layer: L0',
    '    acceptance_checks:', '      - node -e process.exit(0)',
    '  - id: dependent', '    title: the dependent task', '    status: todo', '    skill: run-task',
    '    mode: coding', '    priority: 2', '    layer: L1', '    dependencies: [prereq]',
    '    acceptance_checks:', '      - node -e process.exit(0)',
    '  - id: spawned', '    title: the defect found at runtime', '    status: todo', '    skill: run-task',
    '    mode: coding', '    priority: 3', '    layer: L1',
    '    acceptance_checks:', '      - node -e process.exit(0)',
    '  - id: human-task', '    title: publish under a person\'s authority', '    status: todo', '    skill: run-task',
    '    mode: coding', '    priority: 4', '    layer: L1', '    manual: true',
    '    acceptance_checks:', '      - node -e process.exit(0)',
    '  - id: doc-task', '    title: a task with an attached design document', '    status: todo', '    skill: run-task',
    '    mode: coding', '    priority: 5', '    layer: L1', '    docs:',
    '      - docs/attached-design.md',
    '    acceptance_checks:', '      - node -e process.exit(0)',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'memory/journal.ndjson'), [
    JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', loop_id: 'loop-graph-001', task: 'prereq', agent: 'lead', agent_id: 'lead', claimed_by: 'lead', mode: 'coding', ownership: 'unclaimed', action: 'execute', status: 'done', checks: 'passed', check_cwd: 'root', result: null, files: [], notes: 'prerequisite delivered', seq: 1, origin_agent: 'lead', origin_runtime: 'dsh' }),
    JSON.stringify({ ts: '2026-01-01T00:00:02.000Z', loop_id: 'loop-graph-001', task: 'dependent', agent: 'lead', agent_id: 'lead', claimed_by: 'lead', mode: 'coding', ownership: 'token', agent_chain: ['lead', 'p1-graph-projection'], claim_token: 'tok-fix-1', action: 'claim', status: 'in_progress', checks: 'none', result: null, files: [], notes: 'claimed dependent', seq: 2, origin_agent: 'lead', origin_runtime: 'dsh' }),
    JSON.stringify({ ts: '2026-01-01T00:00:03.000Z', loop_id: 'loop-graph-001', task: 'spawned', agent: 'lead', agent_id: 'lead', claimed_by: 'lead', mode: 'coding', ownership: 'unproven', action: 'spawn', status: 'in_progress', checks: 'none', result: null, files: [], notes: 'spawned the defect found at runtime', seq: 3, origin_agent: 'lead', origin_runtime: 'dsh' }),
    '',
  ].join('\n'));
  // The projection disagrees with the YAML on purpose: `prereq` is done, `dependent` is
  // claimed. A graph that read backlog.yaml would paint both as `todo`.
  writeFileSync(join(root, 'memory/backlog-state.json'), JSON.stringify({
    prereq: { status: 'done', seq: 1, updated_at: '2026-01-01T00:00:01.000Z', updated_by: 'lead' },
    dependent: { status: 'in_progress', claimed_by: 'lead', agent_id: 'lead', claim_token: 'tok-fix-1', claimed_at: '2026-01-01T00:00:02.000Z', seq: 2, mode: 'coding', loop_id: 'loop-graph-001', updated_at: '2026-01-01T00:00:02.000Z', updated_by: 'lead' },
    __seq: 3, __written_at: '2026-01-01T00:00:02.000Z', __written_by: 'fixture',
  }, null, 2) + '\n');
  return root;
}

// ============================================================================
//  1. docs: RED before the file exists, GREEN after — then RED again when it goes
// ============================================================================
{
  const root = makeGraphFixture();
  const DOC = join(root, 'docs/attached-design.md');
  ok('the fixture starts without the attached document', !existsSync(DOC), DOC);

  const red = runPb(root, ['validate']);
  ok('validate is RED while a task\'s docs: entry does not exist', red.code === 1, `exit=${red.code}\n${red.combined.slice(0, 400)}`);
  ok('the RED failure names the missing document and the task',
    /Task doc-task docs path does not exist: docs\/attached-design\.md/.test(red.combined), red.combined.slice(0, 500));

  writeFileSync(DOC, '# attached design\n');
  const green = runPb(root, ['validate']);
  ok('validate is GREEN once the document exists', green.code === 0, `exit=${green.code}\n${green.combined.slice(0, 400)}`);

  rmSync(DOC);
  const redAgain = runPb(root, ['validate']);
  ok('validate is RED again when the document is removed (the check is the file, not a cache)', redAgain.code === 1, `exit=${redAgain.code}`);

  // The graph itself must still render the association as declared, even while the
  // file is missing: the UI shows what the task declares, validate is what refuses.
  const g = parseJson(runPb(root, ['graph', '--json']), 'graph --json');
  const docNode = g.nodes.find((n) => n.id === 'doc-task');
  ok('the node carries the declared document association',
    docNode && Array.isArray(docNode.docs) && docNode.docs.join() === 'docs/attached-design.md',
    JSON.stringify(docNode?.docs));
}

// ============================================================================
//  2. graph: schema, node truth from the projection, and the cycle rail
// ============================================================================
const root = makeGraphFixture();
const graphRun = runPb(root, ['graph', '--json']);
ok('pb graph --json exits 0', graphRun.code === 0, `exit=${graphRun.code}\n${graphRun.combined.slice(0, 400)}`);
const graph = parseJson(graphRun, 'graph --json');
ok('the payload is versioned with the graph schema',
  graph.schema === 'agent-playbook.graph.v1', String(graph.schema));
ok('the payload has start/goal/nodes/edges/human',
  !!graph.start && !!graph.goal && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && !!graph.human,
  Object.keys(graph).join(','));
ok('the fixture rendered every task as a node exactly once',
  graph.nodes.length === 5 && new Set(graph.nodes.map((n) => n.id)).size === 5,
  graph.nodes.map((n) => n.id).join(','));

const yamlText = readFileSync(join(root, 'memory/backlog.yaml'), 'utf8');
ok('the fixture backlog.yaml really does say status: todo (so the next assertion can fail)',
  /- id: prereq[\s\S]*?status: todo/.test(yamlText) && /- id: dependent[\s\S]*?status: todo/.test(yamlText));

const prereqNode = graph.nodes.find((n) => n.id === 'prereq');
const dependentNode = graph.nodes.find((n) => n.id === 'dependent');
ok('a node\'s status comes from the state projection, not from backlog.yaml',
  prereqNode?.status === 'done', `prereq.node.status=${prereqNode?.status}`);
ok('an in-progress claim is projected as in_progress',
  dependentNode?.status === 'in_progress', `dependent.node.status=${dependentNode?.status}`);
ok('the node names who holds it and under which loop',
  dependentNode?.claim.by === 'lead' && dependentNode?.claim.loop_id === 'loop-graph-001',
  JSON.stringify(dependentNode?.claim));
ok('the node exposes the claim touch seq (dispatch order)',
  dependentNode?.claim.seq === 2, String(dependentNode?.claim.seq));

ok('the master\'s loop steps define the cycle rail',
  dependentNode?.cycle.steps.join() === 'orient,select,act,verify,record,report', JSON.stringify(dependentNode?.cycle.steps));
ok('the rail marks the step of the task\'s most recent journal row',
  dependentNode?.cycle.step === 'select' && dependentNode.cycle.index === 1, JSON.stringify(dependentNode?.cycle));
ok('the rail lists the steps the journal rows show it passed through',
  dependentNode?.cycle.filled.join() === 'select', JSON.stringify(dependentNode?.cycle.filled));
ok('an unknown action lands on `act`, not on nothing',
  graph.nodes.find((n) => n.id === 'spawned')?.cycle.step === 'act',
  JSON.stringify(graph.nodes.find((n) => n.id === 'spawned')?.cycle));

ok('the node counts executable checks and reports gate quality',
  prereqNode?.checks === 1 && prereqNode?.gate_quality === '✓verified',
  `${prereqNode?.checks} ${prereqNode?.gate_quality}`);
ok('the node carries the resolved layer, declared or derived',
  prereqNode?.declared_layer === 'L0' && prereqNode?.derived_layer === 0 && prereqNode?.layer === 'L0',
  JSON.stringify({ l: prereqNode?.layer, d: prereqNode?.declared_layer, i: prereqNode?.derived_layer }));

// --- start / goal bookends -------------------------------------------------
ok('the start bookend is the loop epoch plus the cycle brief',
  graph.start.id === 'start' && graph.start.loop === 'loop-graph-001' && graph.start.phase === 7 &&
  graph.start.goal === 'paint the graph fixture', JSON.stringify(graph.start));
ok('the goal bookend carries the prose stop and the north star',
  graph.goal.id === 'goal' && graph.goal.stop === 'the projection is green; the room renders it' &&
  /verified exit code/.test(String(graph.goal.north_star)), JSON.stringify(graph.goal));
ok('the stop condition is split into its clauses for the checklist',
  graph.goal.conditions.length === 2, JSON.stringify(graph.goal.conditions));
ok('NO stop condition is ever reported as met — a prose stop has no exit code',
  graph.goal.conditions.every((c) => c.met === null) && graph.goal.conditions_evaluated === false,
  JSON.stringify(graph.goal.conditions));

// ============================================================================
//  3. edges: the dependency is INVERTED, spawn provenance is labelled, HIL is proven
// ============================================================================
const plan = parseJson(runPb(root, ['plan', '--layers', '--json']), 'plan --layers --json');
ok('the engine\'s own edge map points UPSTREAM (task → prerequisite)',
  plan.edges.dependent.join() === 'prereq', JSON.stringify(plan.edges.dependent));
const depEdges = graph.edges.filter((e) => e.kind === 'dep');
ok('the graph emits the dependency INVERTED (prerequisite → task)',
  depEdges.length === 1 && depEdges[0].from === 'prereq' && depEdges[0].to === 'dependent',
  JSON.stringify(depEdges));
ok('the graph does NOT emit the upstream direction',
  !graph.edges.some((e) => e.from === 'dependent' && e.to === 'prereq'),
  JSON.stringify(graph.edges.filter((e) => e.from === 'dependent' || e.to === 'dependent')));
ok('a dependency whose prerequisite exited 0 is marked done-through',
  depEdges[0].exited_zero === true, JSON.stringify(depEdges[0]));

const spawnEdges = graph.edges.filter((e) => e.kind === 'spawn');
const spawnFact = spawnEdges.find((e) => e.to === 'spawned');
const spawnClaim = spawnEdges.find((e) => e.to === 'dependent');
ok('an explicit journal action:spawn row is projected as a proven spawn from the start',
  spawnFact && spawnFact.from === 'start' && spawnFact.proven === true && spawnFact.evidence === 'spawn',
  JSON.stringify(spawnFact));
ok('the spawn edge carries the provenance the UI must show (by/seq/loop/origin)',
  spawnFact?.by === 'lead' && spawnFact?.seq === 3 && spawnFact?.loop === 'loop-graph-001' && spawnFact?.origin_runtime === 'dsh',
  JSON.stringify(spawnFact));
ok('a plain claim row is projected as a CLAIM (proven:false), never as a fact',
  spawnClaim && spawnClaim.proven === false && spawnClaim.evidence === 'claim',
  JSON.stringify(spawnClaim));

const hilEdges = graph.edges.filter((e) => e.kind === 'hil');
ok('a manual, unfinished task is connected to the human batch',
  hilEdges.length === 1 && hilEdges[0].from === 'human-task' && hilEdges[0].to === 'human',
  JSON.stringify(hilEdges));

// ============================================================================
//  4. the human batch: proven without running a gate, and the gate is NOT run
// ============================================================================
ok('the human batch is non-empty when a manual task exists',
  graph.human.batch.length === 1, JSON.stringify(graph.human.batch));
ok('the batch entry names the task and the command only a person can satisfy',
  graph.human.batch[0].kind === 'manual' && graph.human.batch[0].tasks.join() === 'human-task' &&
  graph.human.batch[0].command === 'node -e process.exit(0)', JSON.stringify(graph.human.batch[0]));
ok('the batch explains why it is a question, not a retry', /manual: true/.test(graph.human.batch[0].reason || ''));
ok('a declared human layer gate with open work above it is reported as UNEVALUATED, not as resolved',
  graph.human.unevaluated_gates.length === 1 && graph.human.unevaluated_gates[0].layer === 'L0' &&
  graph.human.unevaluated_gates[0].evaluated === false &&
  graph.human.unevaluated_gates[0].tasks.includes('human-task'), JSON.stringify(graph.human.unevaluated_gates));
ok('an unevaluated gate is NOT silently folded into the human batch',
  !graph.human.batch.some((b) => b.kind === 'gate'), JSON.stringify(graph.human.batch));
ok('the payload states that gates were not checked', graph.human.gates_checked === false);
ok('pb graph did NOT execute the layer gate command',
  !existsSync(join(root, GATE_MARKER)), `marker ${join(root, GATE_MARKER)} exists — a read-only projection ran a gate`);
ok('pb validate neither executed the gate', !existsSync(join(root, GATE_MARKER)));
ok('pb plan --layers --json neither executed the gate', !existsSync(join(root, GATE_MARKER)));

// --- non-JSON rendering is a real path too ---------------------------------
const textRun = runPb(root, ['graph']);
ok('the human-readable graph rendering exits 0 and is not JSON',
  textRun.code === 0 && textRun.out.includes('agent-playbook.graph.v1') && !textRun.out.trim().startsWith('{'),
  textRun.out.slice(0, 300));

// ============================================================================
//  5. the per-task journal read path (on the RunCard)
// ============================================================================
const card = parseJson(runPb(root, ['runcard', 'show', 'dependent', '--json']), 'runcard show');
ok('the RunCard carries the task\'s journal rows, in order',
  Array.isArray(card.journal) && card.journal.length === 1 && card.journal[0].seq === 2 &&
  card.journal[0].action === 'claim', JSON.stringify(card.journal));
ok('the row keeps its attribution and provenance fields verbatim',
  card.journal[0].ownership === 'token' && card.journal[0].agent_chain.join() === 'lead,p1-graph-projection' &&
  card.journal[0].origin_runtime === 'dsh' && card.journal[0].notes === 'claimed dependent',
  JSON.stringify(card.journal[0]));
ok('journal_range.count agrees with the rows (one read path, not two)',
  card.journal_range.count === card.journal.length, JSON.stringify(card.journal_range));
const cards = parseJson(runPb(root, ['runcard', 'list', '--json']), 'runcard list');
ok('every RunCard in the list carries its journal array',
  cards.runcards.length === 5 && cards.runcards.every((c) => Array.isArray(c.journal)),
  cards.runcards.map((c) => `${c.task_id}:${Array.isArray(c.journal)}`).join(' '));
ok('the node embeds the same rows as the RunCard (one projection, composed)',
  dependentNode?.journal.length === card.journal.length && dependentNode.journal[0].seq === card.journal[0].seq);

// ============================================================================
//  6. pb comment: journal-native, attributable — and it CANNOT move the status
// ============================================================================
const stateFile = join(root, 'memory/backlog-state.json');
const before = readJson(stateFile);
const commented = runPb(root, ['comment', '--task', 'dependent', '--text', 'steer: keep the diagram honest', '--token', 'tok-fix-1', '--chain', 'lead,p1-graph-projection'], { agent: 'lead' });
ok('pb comment exits 0 and reports the seq', commented.code === 0 && /seq \d+/.test(commented.out), commented.combined.slice(0, 300));
const commentRow = readJournal(root).at(-1);
ok('the comment is an appended journal row with action: comment',
  commentRow.action === 'comment' && commentRow.notes === 'steer: keep the diagram honest', JSON.stringify(commentRow));
ok('the comment carries full attribution (agent, claimed_by, ownership, chain)',
  commentRow.agent === 'lead' && commentRow.claimed_by === 'lead' && commentRow.ownership === 'token' &&
  commentRow.agent_chain.join() === 'lead,p1-graph-projection', JSON.stringify(commentRow));
const after = readJson(stateFile);
ok('the comment did NOT change the task status',
  before.dependent.status === 'in_progress' && after.dependent.status === 'in_progress',
  `${before.dependent.status} → ${after.dependent.status}`);
ok('the comment did not disturb the claim lease',
  after.dependent.claim_token === 'tok-fix-1' && after.dependent.claimed_by === 'lead',
  JSON.stringify(after.dependent));

const afterComment = parseJson(runPb(root, ['graph', '--json']), 'graph after comment');
const dependentAfter = afterComment.nodes.find((n) => n.id === 'dependent');
ok('the graph shows the comment as the newest event on the rail',
  dependentAfter?.cycle.step === 'record' && dependentAfter.cycle.index === 4 &&
  dependentAfter.cycle.filled.join() === 'select,record', JSON.stringify(dependentAfter?.cycle));
ok('the comment appears in the card\'s steering thread',
  dependentAfter?.journal.at(-1).action === 'comment', JSON.stringify(dependentAfter?.journal.at(-1)));

// An UNENTITLED comment (no token, another agent) is recorded but flagged, and still
// cannot move the status — the ownership flag is the point of the claim contract.
const intruder = runPb(root, ['comment', '--task', 'dependent', '--text', 'unentitled note'], { agent: 'stranger' });
const intruderRow = readJournal(root).at(-1);
ok('a comment from a writer who cannot prove the claim is recorded as unproven',
  intruder.code === 0 && intruderRow.ownership === 'unproven' && /cannot prove/i.test(intruder.combined),
  `${intruderRow.ownership} :: ${intruder.combined.slice(0, 200)}`);
ok('even an unentitled comment leaves the status alone',
  readJson(stateFile).dependent.status === 'in_progress', JSON.stringify(readJson(stateFile).dependent.status));

const drift = runPb(root, ['repair-state', '--check']);
ok('the comment rows replay as non-events: repair-state finds no drift',
  drift.code === 0 && /No drift/.test(drift.combined), `exit=${drift.code}\n${drift.combined.slice(0, 400)}`);

// ============================================================================
//  7. a merged worker branch is journaled, so repair-state --strict keeps the merge
// ============================================================================
function makeGitFixture() {
  const gitRoot = mkdtempSync(join(tmpdir(), 'pbgraphmerge-'));
  for (const d of ['scripts', 'memory', 'modes', 'processes', 'skills/run-task', 'artifacts/reports']) {
    mkdirSync(join(gitRoot, d), { recursive: true });
  }
  cpSync(resolve('scripts/pb.mjs'), join(gitRoot, 'scripts/pb.mjs'));
  try { symlinkSync(resolve('node_modules'), join(gitRoot, 'node_modules')); } catch { /* already linked */ }
  writeFileSync(join(gitRoot, 'SKILL.md'), '---\nname: merge-test\ndescription: t\n---\n');
  writeFileSync(join(gitRoot, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
  writeFileSync(join(gitRoot, 'processes/run-task.yaml'), 'id: run-task\n');
  writeFileSync(join(gitRoot, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
  writeFileSync(join(gitRoot, 'skills/run-task/SKILL.md'), '---\nname: run-task\ndescription: t\n---\n');
  writeFileSync(join(gitRoot, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(gitRoot, 'memory/project-memory.md'), '# memory\n');
  writeFileSync(join(gitRoot, 'memory/journal.ndjson'), '');
  writeFileSync(join(gitRoot, 'memory/lessons.ndjson'), '');
  writeFileSync(join(gitRoot, 'memory/processes.ndjson'), '');
  writeFileSync(join(gitRoot, 'memory/loops.yaml'),
    'active: loop-graph-merge\nloops:\n  - id: loop-graph-merge\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(gitRoot, 'memory/cycle.md'), '# Cycle\n## 4. Where do I stop?\nmerge lands\n');
  writeFileSync(join(gitRoot, 'playbook.yaml'), [
    'name: graph-merge-test', 'version: 0.0.1', 'entry: SKILL.md',
    'paths:', '  scripts: scripts', '  processes: processes', '  skills: skills', '  memory: memory',
    '  artifacts: artifacts', '  reports: artifacts/reports',
    'index:', '  processes_index: processes/index.yaml', '  skills_index: skills/index.yaml', '  memory:',
    '    project_memory: memory/project-memory.md', '    backlog: memory/backlog.yaml',
    '    journal: memory/journal.ndjson', '    cycle: memory/cycle.md', '    loops: memory/loops.yaml',
    '    lessons: memory/lessons.ndjson', '    processes: memory/processes.ndjson',
    'loop:', '  description: test loop', '  steps:', '    - id: orient', '      do: orient',
    'default_mode: coding', 'modes:', '  coding: modes/coding.yaml',
    'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]',
    '',
  ].join('\n'));
  writeFileSync(join(gitRoot, 'memory/backlog.yaml'), [
    'tasks:',
    '  - id: graph-merge', '    title: a branch that must land', '    status: todo', '    skill: run-task',
    '    mode: coding', '    priority: 1',
    '    acceptance_checks:', '      - node -e process.exit(0)',
    '',
  ].join('\n'));
  const git = (args, cwd = gitRoot) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(gitRoot, '.gitignore'), 'node_modules/\n');
  git(['add', '.']);
  git(['commit', '-m', 'seed']);
  // The branch `pb worker merge` will look for: `agent/<task>-<agent>` (no worker record
  // is opened here — the merge gate is a journal+checker gate, and this test is about
  // what the merge WRITES, not about isolating a worktree).
  git(['checkout', '-b', 'agent/graph-merge-root']);
  writeFileSync(join(gitRoot, 'landed-by-merge.txt'), 'produced on the branch\n');
  git(['add', 'landed-by-merge.txt']);
  git(['commit', '-m', 'branch work']);
  git(['checkout', '-']);
  return { gitRoot, git };
}
const { gitRoot } = makeGitFixture();
const journalBeforeMerge = readJournal(gitRoot).length;
const recorded = runPb(gitRoot, ['record', '--task', 'graph-merge', '--action', 'implement', '--status', 'done', '--notes', 'delivered on a branch'], { agent: 'root' });
ok('the fixture task reaches done through its own checks', recorded.code === 0 && /checks: passed/.test(recorded.out), recorded.combined.slice(0, 400));
const checkered = runPb(gitRoot, ['worker', 'checker', 'graph-merge', '--verdict', 'pass', '--notes', 'reviewed'], { agent: 'checker-1' });
ok('an independent checker verdict is recorded', checkered.code === 0, checkered.combined.slice(0, 300));
const ready = runPb(gitRoot, ['worker', 'merge-ready', 'graph-merge', '--json']);
ok('the merge gate is open for the reviewed branch', ready.code === 0 && parseJson(ready, 'merge-ready').ready === true,
  `exit=${ready.code} ${ready.combined.slice(0, 400)}`);
const merged = runPb(gitRoot, ['worker', 'merge', 'graph-merge', '--agent', 'root', '--execute', '--json'], { agent: 'root' });
ok('the gated merge executes and lands the branch', merged.code === 0 && existsSync(join(gitRoot, 'landed-by-merge.txt')),
  `exit=${merged.code}\n${merged.combined.slice(0, 400)}`);
const mergePayload = parseJson(merged, 'worker merge');
ok('the merge payload reports the commit AND the journal seq that proves it',
  typeof mergePayload.merge_commit === 'string' && typeof mergePayload.journal_seq === 'number',
  JSON.stringify({ c: mergePayload.merge_commit, s: mergePayload.journal_seq }));

const journalAfterMerge = readJournal(gitRoot);
const mergeRows = journalAfterMerge.filter((r) => r.action === 'merge');
const mergeRow = mergeRows.at(-1);
ok('the merge got its own append-only journal row (exactly one, and the newest)',
  mergeRows.length === 1 && journalAfterMerge.at(-1).action === 'merge' && mergeRow.seq === mergePayload.journal_seq,
  `rows ${journalBeforeMerge} → ${journalAfterMerge.length}, merge rows=${mergeRows.length}, seq=${mergeRow?.seq} vs payload ${mergePayload.journal_seq}`);
ok('the row carries the worker record it committed (branch, status, commit)',
  mergeRow?.worker?.status === 'merged' && mergeRow?.worker?.branch === 'agent/graph-merge-root' &&
  mergeRow?.worker?.merge_commit === mergePayload.merge_commit, JSON.stringify(mergeRow));
ok('the row is attributed like every other write (agent, ownership, loop)',
  mergeRow?.agent === 'root' && typeof mergeRow?.ownership === 'string' && mergeRow?.loop_id === 'loop-graph-merge',
  JSON.stringify({ agent: mergeRow?.agent, ownership: mergeRow?.ownership, loop: mergeRow?.loop_id }));
ok('a merge row is an EVENT, not the task\'s latest done record (checks stay "none")',
  mergeRow?.status === 'merged' && mergeRow?.checks === 'none', `${mergeRow?.status}/${mergeRow?.checks}`);
ok('the merge did not poison the merge gate (lastDoneEntry still finds the real done row)',
  runPb(gitRoot, ['worker', 'merge-ready', 'graph-merge', '--json']).code === 0);

const strictApply = runPb(gitRoot, ['repair-state', '--strict', '--apply']);
ok('repair-state --strict --apply rebuilds the projection', strictApply.code === 0, strictApply.combined.slice(0, 300));
const rebuilt = readJson(join(gitRoot, 'memory/backlog-state.json'));
ok('the STRICT rebuild keeps the merge — the journal models it now',
  rebuilt['graph-merge']?.worker?.status === 'merged' &&
  rebuilt['graph-merge']?.worker?.merge_commit === mergePayload.merge_commit,
  JSON.stringify(rebuilt['graph-merge']));
ok('the strict rebuild still drops genuinely projection-only fields (checker), so the test is not vacuous',
  rebuilt['graph-merge']?.checker === undefined, JSON.stringify(rebuilt['graph-merge']?.checker));
ok('the rebuild leaves the task status terminal',
  rebuilt['graph-merge']?.status === 'done', JSON.stringify(rebuilt['graph-merge']?.status));
const driftAfter = runPb(gitRoot, ['repair-state', '--check']);
ok('the strict rebuild is stable: a second --check finds no drift', driftAfter.code === 0, driftAfter.combined.slice(0, 300));

console.log(`\ntest-pb-graph: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
