#!/usr/bin/env node
// scripts/test-repair-state.mjs
// ----------------------------------------------------------------------------
// Crash-recovery guardrail for the state projection.
//
// backlog-state.json is DERIVED data: the append-only journal is the record of
// what happened, and the projection is a fast view of it. That distinction only
// pays off if the projection can be rebuilt — after a lost write, a truncated
// file, or a process killed mid-transaction. These assertions pin the rebuild
// rules, the drift alarm, and the boundary of what a rebuild may legally do:
//   - replay claim/terminal/release rows into status;
//   - scope the rebuild to the CURRENT backlog (history is not resurrected);
//   - PRESERVE fields the journal does not model (worker/checker/provider) —
//     silently dropping them would be data loss dressed up as a repair;
//   - never move the ordering counter backwards;
//   - report drift and exit non-zero from --check.
// ----------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const root = tempDir('pbrepair-');
for (const d of ['scripts', 'memory', 'modes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'playbook.yaml'),
  'name: repair-test\nversion: 0.3.6\nentry: SKILL.md\n' +
  'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
  'index:\n  cli: scripts/pb.mjs\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
  'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
  'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - {id: L1, status: active}\n');
writeFileSync(join(root, 'memory/cycle.md'), '# c\n## 5. Do I have any conflicting memory?\nNone\n');

// The backlog is what scopes the rebuild. `gone-task` appears in the journal but
// NOT here — resurrecting it would be wrong.
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n' +
  '  - {id: A, title: claimed, status: todo, priority: 1}\n' +
  '  - {id: B, title: finished, status: todo, priority: 2}\n' +
  '  - {id: C, title: released, status: todo, priority: 3}\n' +
  '  - {id: D, title: stale, status: todo, priority: 4}\n');

const journalPath = join(root, 'memory/journal.ndjson');
const statePath = join(root, 'memory/backlog-state.json');
const rows = [
  { seq: 1, ts: '2026-01-01T00:00:01.000Z', loop_id: 'L1', task: 'A', agent: 'alice', action: 'claim', status: 'in_progress', claimed_by: 'alice', claim_token: 'tok-a', mode: 'coding' },
  { seq: 2, ts: '2026-01-01T00:00:02.000Z', loop_id: 'L1', task: 'gone-task', agent: 'alice', action: 'claim', status: 'in_progress', claimed_by: 'alice' },
  { seq: 3, ts: '2026-01-01T00:00:03.000Z', loop_id: 'L1', task: 'B', agent: 'bob', action: 'implement', status: 'done', checks: 'passed' },
  { seq: 4, ts: '2026-01-01T00:00:04.000Z', loop_id: 'L1', task: 'C', agent: 'carol', action: 'claim', status: 'in_progress', claimed_by: 'carol', claim_token: 'tok-c' },
  { seq: 5, ts: '2026-01-01T00:00:05.000Z', loop_id: 'L1', task: 'C', agent: 'carol', action: 'release', status: 'todo' },
  { seq: 6, ts: '2026-01-01T00:00:06.000Z', loop_id: 'L1', task: 'D', agent: 'dave', action: 'claim', status: 'in_progress', claimed_by: 'dave' },
  { seq: 7, ts: '2026-01-01T00:00:07.000Z', loop_id: 'L1', task: 'D', agent: 'dave', action: 'blocked', status: 'blocked' },
];
writeFileSync(journalPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// The projection is WRONG on purpose: B's completion was lost, C is still marked
// held after its release, and A carries projection-only fields the journal cannot
// reconstruct.
const projection = {
  A: {
    status: 'in_progress', claimed_by: 'alice', agent_id: 'alice', claim_token: 'tok-a',
    claimed_at: '2026-01-01T00:00:01.000Z', loop_id: 'L1', mode: 'coding', seq: 1, updated_by: 'alice',
    worker: { agent: 'alice', branch: 'agent/A-alice', worktree_path: '/tmp/nope', status: 'created' },
    checker: { verdict: 'pass', recorded_at: '2026-01-01T00:00:09.000Z', agent: 'rev' },
  },
  C: { status: 'in_progress', claimed_by: 'carol', claim_token: 'tok-c', updated_by: 'carol' },
  D: { status: 'todo', updated_by: 'dave' },
  __seq: 7, __written_at: '2026-01-01T00:00:07.000Z', __written_by: 'dave',
};
writeFileSync(statePath, JSON.stringify(projection, null, 2) + '\n');

const pbPath = join(root, 'scripts/pb.mjs');
const pb = (args) => spawnSync(process.execPath, [pbPath, ...args], { cwd: root, encoding: 'utf8' });
const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };

// --- 1. --check reports the drift and exits non-zero --------------------------
{
  const r = pb(['repair-state', '--check']);
  ok('--check exits non-zero when the projection disagrees with the journal', r.status === 1,
    `exit=${r.status}\n${r.stdout}${r.stderr}`);
  ok('--check names the lost completion (B should be done)', /\[B\].*journal=done/.test(r.stdout), r.stdout);
  ok('--check names the stale claim (C was released)', /\[C\].*journal=todo/.test(r.stdout), r.stdout);
  ok('--check does NOT resurrect a task that left the backlog',
    !/gone-task/.test(r.stdout), r.stdout);
  const json = JSON.parse(pb(['repair-state', '--check', '--json']).stdout);
  ok('--json emits machine-readable drift with a schema id',
    json.schema === 'agent-playbook.repair-state.v1' && Array.isArray(json.drift), JSON.stringify(json).slice(0, 300));
}

// --- 2. dry run changes nothing ----------------------------------------------
{
  const before = readFileSync(statePath, 'utf8');
  const r = pb(['repair-state']);
  ok('a bare repair-state is a dry run that does not write', r.status === 0 && readFileSync(statePath, 'utf8') === before);
  ok('the dry run states what it would rebuild', /Would rebuild/.test(r.stdout), r.stdout);
}

// --- 3. --apply rebuilds from the journal ------------------------------------
{
  const r = pb(['repair-state', '--apply']);
  ok('--apply exits 0', r.status === 0, `${r.stdout}${r.stderr}`);
  const st = readState();
  ok('a lost completion is restored (B → done)', st.B?.status === 'done', JSON.stringify(st.B));
  ok('a released claim is restored to todo with the claim cleared',
    st.C?.status === 'todo' && !st.C.claim_token && !st.C.claimed_by, JSON.stringify(st.C));
  ok('a blocked task is restored as blocked', st.D?.status === 'blocked', JSON.stringify(st.D));
  ok('a live claim keeps its holder and token',
    st.A?.status === 'in_progress' && st.A.claimed_by === 'alice' && st.A.claim_token === 'tok-a', JSON.stringify(st.A));
  ok('the journal-only task is NOT resurrected', st['gone-task'] === undefined, JSON.stringify(Object.keys(st)));
  ok('projection-only fields are preserved by default (worker + checker)',
    !!st.A?.worker && !!st.A?.checker, JSON.stringify(st.A));
  ok('the writer attribution is rebuilt from the winning journal row',
    st.B?.updated_by === 'bob' && st.D?.updated_by === 'dave', `B=${st.B?.updated_by} D=${st.D?.updated_by}`);
  // The counter must never move BACKWARDS (that would let a later writer reuse a
  // sequence already committed); advancing past the journal's high-water mark is
  // correct, since the rebuild is itself a committed write.
  ok('the ordering counter never moves backwards', st.__seq >= 7, `__seq=${st.__seq}`);
  ok('the repair is stamped in the projection metadata', st.__written_by === 'repair-state', st.__written_by);
}

// --- 4. the repaired projection is now consistent ----------------------------
{
  const r = pb(['repair-state', '--check']);
  ok('after --apply, --check is clean and exits 0', r.status === 0 && /No drift/.test(r.stdout),
    `exit=${r.status}\n${r.stdout}`);
}

// --- 5. a torn/invalid projection is recoverable -----------------------------
{
  writeFileSync(statePath, '{"A": {"status": "in_progress"'); // truncated mid-write
  const r = pb(['repair-state', '--apply']);
  const st = readState();
  ok('a truncated projection is rebuilt rather than crashing', r.status === 0 && st.B?.status === 'done',
    `exit=${r.status} state=${JSON.stringify(st).slice(0, 200)}\n${r.stderr}`);
}

// --- 6. --strict drops what the journal cannot justify -----------------------
{
  // Put the projection-only fields back, then repair strictly.
  const st = readState();
  st.A = { ...st.A, worker: { agent: 'alice', branch: 'b' }, checker: { verdict: 'pass' } };
  writeFileSync(statePath, JSON.stringify(st, null, 2) + '\n');
  pb(['repair-state', '--apply', '--strict']);
  const strict = readState();
  ok('--strict does not carry forward fields the journal cannot justify',
    strict.A?.worker === undefined && strict.A?.checker === undefined, JSON.stringify(strict.A));
  ok('--strict still rebuilds the statuses', strict.A?.status === 'in_progress' && strict.B?.status === 'done',
    JSON.stringify({ A: strict.A?.status, B: strict.B?.status }));
}

// --- 7. a journal ahead of the projection is flagged as a lost write ----------
{
  const st = readState();
  st.__seq = 2; // projection claims less progress than the records do
  writeFileSync(statePath, JSON.stringify(st, null, 2) + '\n');
  const json = JSON.parse(pb(['repair-state', '--check', '--json']).stdout);
  ok('a journal ahead of the projection is reported as a lost state write',
    json.lost_state_write === true && json.journal_max_seq > json.state_seq,
    JSON.stringify({ state_seq: json.state_seq, journal_max_seq: json.journal_max_seq, lost: json.lost_state_write }));
}

console.log(`\ntest-repair-state: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
