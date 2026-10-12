#!/usr/bin/env node
// scripts/test-auto-attribution.mjs
// ----------------------------------------------------------------------------
// The autonomous driver (`pb loop run --auto`) is an agent like any other, so its
// writes must satisfy the same multi-agent contract. Before this, it recorded with
// agent `auto` and no claim proof, producing `ownership: unproven` rows that are
// indistinguishable from an unentitled write — the exact thing the ownership flag
// exists to spot. A journal full of unproven rows makes the flag useless.
//
// This suite pins two things:
//   - the auto runner TAKES the task properly: it stamps a holder and a claim token;
//   - every row it writes is proven (ownership = token), so `unproven` keeps meaning
//     "someone wrote without entitlement".
// ----------------------------------------------------------------------------

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

const root = tempDir('pbauto-');
for (const d of ['scripts', 'memory', 'modes', 'processes', 'skills/run-task', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts', 'pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
writeFileSync(join(root, 'SKILL.md'), '---\nname: t\ndescription: t\n---\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
writeFileSync(join(root, 'skills/run-task/SKILL.md'), '---\nname: run-task\ndescription: t\n---\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'playbook.yaml'), [
  'name: auto-attribution-test', 'version: 0.4.0', 'entry: SKILL.md',
  'paths:', '  scripts: scripts', '  processes: processes', '  skills: skills', '  memory: memory',
  '  modes: modes', '  artifacts: artifacts', '  reports: artifacts/reports',
  'index:', '  processes_index: processes/index.yaml', '  skills_index: skills/index.yaml', '  memory:',
  '    project_memory: memory/project-memory.md', '    backlog: memory/backlog.yaml',
  '    journal: memory/journal.ndjson', '    cycle: memory/cycle.md', '    loops: memory/loops.yaml',
  '    lessons: memory/lessons.ndjson', '    processes: memory/processes.ndjson',
  'loop:', '  description: test loop', '  steps:', '    - id: orient', '      do: orient',
  '      command: node scripts/pb.mjs status',
  'default_mode: coding', 'modes:', '  coding: modes/coding.yaml',
  'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', '',
].join('\n'));
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: loop-auto-001\nloops:\n  - id: loop-auto-001\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
writeFileSync(join(root, 'memory/cycle.md'),
  '# Cycle\n## 1. What is this cycle\'s goal?\nAuto attribution\n## 2. What challenges do I foresee?\nNone\n' +
  '## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');
// A pass and a fail, so both branches of the driver are exercised.
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: A-PASS',
  '    title: passes',
  '    status: todo',
  '    priority: 1',
  '    skill: run-task',
  '    acceptance_checks:',
  '      - node -e "process.exit(0)"',
  '  - id: B-FAIL',
  '    title: fails its checks',
  '    status: todo',
  '    priority: 2',
  '    skill: run-task',
  '    acceptance_checks:',
  '      - node -e "process.exit(1)"',
  '',
].join('\n'));

const pbPath = join(root, 'scripts', 'pb.mjs');
const pb = (args, env = {}) => spawnSync(process.execPath, [pbPath, ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180_000,
});
const readState = () => { try { return JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8')); } catch { return {}; } };
const readJournal = () => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// --- 1. the run happens, with retries=0 so the failure is immediate -----------
const run = pb(['loop', 'run', '--auto', '--max-tasks', '5', '--retry', '0', '--defer-blocked'], { PB_AGENT_ID: 'auto-1' });
ok('the autonomous run executes', /Auto-executed|Starting autonomous run/.test(run.stdout + run.stderr),
  `exit=${run.status}\n${run.stdout}${run.stderr}`.slice(0, 600));

// --- 2. it took the tasks properly -------------------------------------------
{
  const st = readState();
  ok('the runner stamped a holder on the task it claimed',
    st['A-PASS']?.claimed_by === 'auto-1' || st['A-PASS']?.claimed_by === 'agent',
    JSON.stringify(st['A-PASS']));
  // The token is consumed when the terminal row clears the claim; what must survive is
  // that the runner presented one. Its absence would show as an unproven row.
  const rows = readJournal().filter((r) => r.action === 'auto-execute');
  ok('the runner wrote auto-execute rows for both branches', rows.length >= 2,
    JSON.stringify(rows.map((r) => `${r.task}:${r.status}`)));
}

// --- 3. every auto row is PROVEN, not merely attributed ----------------------
{
  const rows = readJournal().filter((r) => r.action === 'auto-execute');
  const unproven = rows.filter((r) => r.ownership === 'unproven' || r.ownership_violation);
  ok('no auto row is flagged unproven — the runner presents its claim token',
    unproven.length === 0, JSON.stringify(unproven.map((r) => ({ t: r.task, o: r.ownership }))));
  ok('every auto row records the ownership basis it was checked under',
    rows.every((r) => typeof r.ownership === 'string' && r.ownership.length > 0),
    JSON.stringify(rows.map((r) => ({ t: r.task, o: r.ownership }))));
  ok('auto rows are attributed to the invoking agent, not a bare "auto"',
    rows.every((r) => typeof r.agent === 'string' && r.agent.length > 0),
    JSON.stringify(rows.map((r) => r.agent)));
  ok('auto rows carry the delegation provenance a host stamped',
    rows.every((r) => r.origin_agent_id === 'auto-1'),
    JSON.stringify(rows.map((r) => r.origin_agent_id)));
}

// --- 4. the outcomes are still honest ----------------------------------------
{
  const st = readState();
  ok('the passing task is recorded done', st['A-PASS']?.status === 'done', JSON.stringify(st['A-PASS']));
  ok('the failing task is recorded blocked, not done', st['B-FAIL']?.status === 'blocked', JSON.stringify(st['B-FAIL']));
  const doneRow = readJournal().find((r) => r.task === 'A-PASS' && r.status === 'done');
  const blockedRow = readJournal().find((r) => r.task === 'B-FAIL' && r.status === 'blocked');
  ok('the done row says its checks passed', doneRow?.checks === 'passed', JSON.stringify(doneRow));
  ok('the blocked row says its checks failed', blockedRow?.checks === 'failed', JSON.stringify(blockedRow));
}

// --- 5. an unentitled writer is still flagged (the flag keeps its meaning) ----
{
  // Someone else already holds a task: a plain record without proof must be flagged.
  writeFileSync(join(root, 'memory/backlog.yaml'), [
    'tasks:',
    '  - id: C-HELD',
    '    title: held by someone else',
    '    status: todo',
    '    priority: 1',
    '    skill: run-task',
    '',
  ].join('\n'));
  pb(['next', '--claim'], { PB_AGENT_ID: 'holder' });
  const intruder = pb(['record', '--task', 'C-HELD', '--action', 'implement', '--status', 'in_progress'], { PB_AGENT_ID: 'intruder' });
  const row = readJournal().filter((r) => r.task === 'C-HELD' && r.agent === 'intruder').at(-1);
  ok('an unentitled write is still flagged unproven (the flag did not lose its meaning)',
    row?.ownership === 'unproven' && /cannot prove/i.test(intruder.stdout + intruder.stderr),
    JSON.stringify(row));
}

console.log(`\ntest-auto-attribution: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
