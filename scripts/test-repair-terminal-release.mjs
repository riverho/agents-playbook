// scripts/test-repair-terminal-release.mjs
// ----------------------------------------------------------------------------
// A journal row can carry BOTH a lifecycle action and a terminal status:
// `release` says "the claim ends here", `status: blocked` says "it ends as
// blocked". The replay in `reconstructStateFromJournal` checked the ACTION first,
// so a `release` row stamped `blocked` was replayed as `todo` — the projection
// then disagreed with a journal that plainly records the task as blocked, and
// `pb repair-state --check` reported drift on a HEALTHY playbook while offering a
// "repair" that would have resurrected finished blocked work as unclaimed todo.
//
// This pins the precedence rule: a TERMINAL row status wins over the release
// action, while a plain `release`/`todo` row keeps returning the claim to the pool.
// It also pins the end-to-end property on the real CLI path: record a task
// blocked, and the projection must then agree with the journal (no drift).
// ----------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
};

// A scratch playbook in the shape the existing suite uses: only the pieces the
// record/repair paths actually read.
const root = mkdtempSync(join(tmpdir(), 'pbrelterm-'));
for (const d of ['scripts', 'memory', 'modes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
try { symlinkSync(resolve('node_modules'), join(root, 'node_modules')); } catch {}

writeFileSync(join(root, 'playbook.yaml'),
  'name: repair-terminal-release-test\nversion: 0.6.3\nentry: SKILL.md\n' +
  'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
  'index:\n  cli: scripts/pb.mjs\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
  'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
  'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - {id: L1, status: active}\n');
writeFileSync(join(root, 'memory/cycle.md'), '# c\n## 5. Do I have any conflicting memory?\nNone\n');

// T1 is the end-to-end case (real CLI record path).
// T2/T3 are the replay-precedence cases, driven purely through a synthetic journal.
// T1 carries priority 1 so the claim in step 3 selects it: T2 replays blocked and T3
// replays todo, but only T1 is left as unclaimed todo work after the repair.
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n' +
  '  - {id: T1, title: blocked via record, status: todo, priority: 1}\n' +
  '  - {id: T2, title: release row stamped blocked, status: todo, priority: 2}\n' +
  '  - {id: T3, title: release row stamped todo, status: todo, priority: 3}\n');

const journalPath = join(root, 'memory/journal.ndjson');
const statePath = join(root, 'memory/backlog-state.json');
// T1 has NO journal history yet — it is the fresh task that step 3 claims for real.
const journalRows = [
  // The row shape `pb record --action release --status blocked` produces: the action
  // says release, the status says the iteration ended blocked. Terminal wins.
  { seq: 1, ts: '2026-01-01T00:00:01.000Z', loop_id: 'L1', task: 'T2', agent: 'bob', agent_id: 'bob', claimed_by: 'bob', action: 'claim', status: 'in_progress', claim_token: 'tok-t2', mode: 'coding' },
  { seq: 2, ts: '2026-01-01T00:00:02.000Z', loop_id: 'L1', task: 'T2', agent: 'bob', agent_id: 'bob', claimed_by: 'bob', action: 'release', status: 'blocked', checks: 'none' },
  // The ordinary release: the claim goes back to the pool.
  { seq: 3, ts: '2026-01-01T00:00:03.000Z', loop_id: 'L1', task: 'T3', agent: 'cid', agent_id: 'cid', claimed_by: 'cid', action: 'claim', status: 'in_progress', claim_token: 'tok-t3', mode: 'coding' },
  { seq: 4, ts: '2026-01-01T00:00:04.000Z', loop_id: 'L1', task: 'T3', agent: 'cid', agent_id: 'cid', claimed_by: 'cid', action: 'release', status: 'todo', checks: 'none' },
];
writeFileSync(journalPath, journalRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// Projection state per task, chosen so the claim in step 3 is deterministic:
//  T1 todo        — no journal history, and the only unclaimed todo, so
//                   `next --claim` must pick it;
//  T2 blocked     — agrees with its terminal release row (the healthy case, and the
//                   case the old action-first replay got wrong);
//  T3 in_progress — WRONG on purpose: its journal ends in a plain release, so the
//                   repair returns it to todo. Until the repair runs, T3 is not
//                   claimable, which is what keeps step 1's drift report to T3 alone.
writeFileSync(statePath, JSON.stringify({
  T1: { status: 'todo', updated_by: 'ann' },
  T2: { status: 'blocked', claimed_by: 'bob', agent_id: 'bob', seq: 2, updated_by: 'bob' },
  T3: { status: 'in_progress', claimed_by: 'cid', claim_token: 'tok-t3', seq: 4, updated_by: 'cid' },
  __seq: 4, __written_at: '2026-01-01T00:00:04.000Z', __written_by: 'cid',
}, null, 2) + '\n');
const pbPath = join(root, 'scripts/pb.mjs');
const pb = (args) => spawnSync(process.execPath, [pbPath, ...args], { cwd: root, encoding: 'utf8' });
const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };

// --- 1. a terminal release row must NOT be reported as drift ------------------
{
  const r = pb(['repair-state', '--check']);
  // T3 is drifted ON PURPOSE (step 2 repairs it), so --check exits 1 here; what this
  // asserts is which tasks it blames. T2's projection already says blocked and its
  // journal ends in a terminal release row, so an action-first replay wrongly reports
  // it as `journal=todo` — the whole defect, visible as a false drift on healthy state.
  ok('--check does not blame a task whose terminal release row is already honored',
    !/\[T2\]/.test(r.stdout), r.stdout + r.stderr);
  ok('--check does not claim T2 (blocked) should be todo',
    !/\[T2\][^\n]*journal=todo/.test(r.stdout), r.stdout);
  ok('the intentional T3 drift is still reported (the check is not vacuous)',
    /\[T3\][^\n]*journal=todo/.test(r.stdout), r.stdout);
}

// --- 2. replay precedence: terminal status beats the release action -------------
{
  const r = pb(['repair-state', '--apply']);
  const state = readState();
  ok('a release row stamped blocked replays to blocked',
    state.T2?.status === 'blocked', `T2=${JSON.stringify(state.T2)}`);
  ok('an ordinary release row still returns the claim to todo',
    state.T3?.status === 'todo', `T3=${JSON.stringify(state.T3)}`);
  ok('the repaired projection agrees with the journal (no drift)',
    pb(['repair-state', '--check']).status === 0, r.stdout + r.stderr);
}

// --- 3. end-to-end: recording blocked must not look like drift -----------------
{
  // T1 is the only unclaimed todo after the repair (T2 is blocked, T3 is in_progress),
  // so a bare `next --claim` must pick it — no need to add a task selector.
  const claim = pb(['next', '--claim']);
  ok('claiming T1 succeeds in the scratch playbook',
    /\[T1\]/.test(claim.stdout) && readState().T1?.status === 'in_progress', claim.stdout + claim.stderr);
  const token = (claim.stdout.match(/claim token:\s*(\S+)/i) || [])[1] || readState().T1?.claim_token;
  const rec = pb(['record', '--task', 'T1', '--action', 'release', '--status', 'blocked',
    '--notes', 'blocked on purpose', '--token', token]);
  ok('recording blocked on a claimed task succeeds', rec.status === 0, `${rec.stdout}${rec.stderr}`);
  ok('the projection marks the task blocked', readState().T1?.status === 'blocked',
    JSON.stringify(readState().T1));
  const check = pb(['repair-state', '--check']);
  ok('a blocked record leaves the projection in agreement with the journal',
    check.status === 0, `exit=${check.status}\n${check.stdout}${check.stderr}`);
}

console.log(fail === 0
  ? '\ntest-repair-terminal-release: all assertions passed'
  : `\ntest-repair-terminal-release: ${fail} assertion(s) failed`);
process.exit(fail === 0 ? 0 : 1);
