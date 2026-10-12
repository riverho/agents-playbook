// Acceptance coverage for `loop new --fresh`: a fresh loop must archive the existing
// backlog (nothing lost) and reset it to empty, so a stale task model (tasks that assume
// earlier "done" artifacts/paths that no longer exist on disk) can't be silently inherited
// and claimed by the next loop. Default `loop new` (no flag) must keep continuing as-is.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbfresh-');
for (const d of ['scripts', 'memory', 'processes', 'skills', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'SKILL.md'), '# test skill\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
mkdirSync(join(root, 'skills/run-task'), { recursive: true });
writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run task\n');
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: IMPL-001',
  '    title: stale task assuming old app/ layout',
  '    status: todo',
  '    priority: 1',
  '',
].join('\n'));
writeFileSync(join(root, 'playbook.yaml'), [
  'name: t',
  'version: 0.3.1',
  'entry: SKILL.md',
  'paths:',
  '  scripts: scripts',
  '  processes: processes',
  '  skills: skills',
  '  memory: memory',
  '  artifacts: artifacts',
  '  reports: artifacts/reports',
  'index:',
  '  processes_index: processes/index.yaml',
  '  skills_index: skills/index.yaml',
  '  memory:',
  '    project_memory: memory/project-memory.md',
  '    backlog: memory/backlog.yaml',
  '    journal: memory/journal.ndjson',
  '    cycle: memory/cycle.md',
  '    loops: memory/loops.yaml',
  '    lessons: memory/lessons.ndjson',
  '    processes: memory/processes.ndjson',
  'loop:',
  '  description: test',
  'guardrails:',
  '  allowed_statuses: [todo, in_progress, blocked, done]',
  '',
].join('\n'));

const pb = (args) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe',
});

// 1. Default `loop new` continues from the existing (stale) backlog untouched.
pb(['loop', 'new']);
let backlog = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'));
if (backlog.tasks.length !== 1 || backlog.tasks[0].id !== 'IMPL-001') {
  throw new Error('default `loop new` should not touch the existing backlog');
}
pb(['loop', 'close', '--status', 'abandoned', '--reason', 'switching to fresh test']);

// 2. `loop new --fresh` archives the stale backlog and resets it to empty.
const out = pb(['loop', 'new', '--fresh']);
if (!/archived/.test(out)) throw new Error('--fresh did not report archiving the stale backlog');
backlog = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'));
if (!Array.isArray(backlog.tasks) || backlog.tasks.length !== 0) {
  throw new Error('--fresh should reset the backlog to an empty task list');
}
const loops = yaml.load(readFileSync(join(root, 'memory/loops.yaml'), 'utf8'));
const freshLoop = loops.loops.find((l) => l.id === loops.active);
if (!freshLoop.reset_backlog || freshLoop.reset_backlog.count !== 1) {
  throw new Error('loop record was not stamped with reset_backlog');
}
const snapshotPath = join(root, freshLoop.reset_backlog.archived_to);
if (!existsSync(snapshotPath)) throw new Error('archived backlog snapshot is missing on disk');
const snapshot = yaml.load(readFileSync(snapshotPath, 'utf8'));
if (snapshot.tasks[0].id !== 'IMPL-001') throw new Error('archived snapshot does not contain the original stale task');

// 3. `pb plan` must append cleanly after the fresh reset wrote `tasks: []`.
pb(['cycle', '--new', '--goal', 'rebuild from current state', '--stop', 'new scope agreed']);
writeFileSync(join(root, 'memory/cycle.md'), readFileSync(join(root, 'memory/cycle.md'), 'utf8').replace(
  /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
  'No conflicts found.',
));
pb(['plan', '--goal', 'planned after fresh reset', '--check', 'node scripts/pb.mjs validate']);
backlog = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'));
if (backlog.tasks.length !== 1 || backlog.tasks[0].title !== 'planned after fresh reset') {
  throw new Error('pb plan should produce one valid task after `tasks: []` fresh reset');
}

// 4. A fresh-loop task list must come from new work, not the old IMPL-* ids.
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: LOOP2-001',
  '    title: real current-state task',
  '    status: todo',
  '    priority: 1',
  '',
].join('\n'));
const cyclePath = join(root, 'memory/cycle.md');
writeFileSync(cyclePath, readFileSync(cyclePath, 'utf8').replace(
  /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
  'No conflicts found.',
));
const next = pb(['next', '--claim']);
if (!/LOOP2-001/.test(next)) throw new Error('next --claim did not pick up the new ground-up task');

console.log('PASS — `loop new --fresh` archives a stale backlog and resets it for a ground-up loop; default `loop new` keeps continuing as-is');
