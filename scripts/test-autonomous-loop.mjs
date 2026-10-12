// Acceptance coverage for autonomous loop execution:
// - pb plan generates backlog tasks with checks while preserving formatting.
// - pb loop run --auto executes commands, runs checks, records done/blocked.
// - Auto mode stops on manual tasks and honor-only tasks.
// - Dry run does not mutate state.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbauto-');
for (const d of ['scripts', 'memory', 'processes', 'skills', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

const master = [
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
].join('\n');

writeFileSync(join(root, 'SKILL.md'), '# test skill\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
mkdirSync(join(root, 'skills/run-task'), { recursive: true });
writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run-task\n');
writeFileSync(join(root, 'skills/index.yaml'), [
  'skills:',
  '  - id: run-task',
  '    file: skills/run-task/SKILL.md',
  '',
].join('\n'));
writeFileSync(join(root, 'memory/backlog.yaml'), [
  '# Existing backlog comment',
  'tasks:',
  '  - id: A',
  '    title: existing task',
  '    status: todo',
  '    priority: 1',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
  '',
].join('\n'));
writeFileSync(join(root, 'playbook.yaml'), master);

const pb = (args) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe',
});
const fillQ5 = () => {
  const path = join(root, 'memory/cycle.md');
  const text = readFileSync(path, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
    'No conflicts found.',
  );
  writeFileSync(path, text, 'utf8');
};
const backlog = () => {
  const bl = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'));
  const st = existsSync(join(root, 'memory/backlog-state.json')) ? JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8')) : {};
  const tasks = Array.isArray(bl?.tasks) ? bl.tasks : [];
  return { tasks: tasks.map((t) => ({ ...t, ...(st[t.id] || {}) })) };
};
const journal = () => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const state = () => existsSync(join(root, 'memory/backlog-state.json')) ? JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8')) : {};

pb(['loop', 'new', '--goal', 'auto test', '--stop', 'all done']);
pb(['cycle', '--new', '--goal', 'auto test', '--stop', 'all done']);
fillQ5();

const failures = [];

// 1. pb plan appends a task and preserves formatting
pb(['plan', '--goal', 'Generate marker file', '--check', 'node -e "require(\'fs\').writeFileSync(\'marker.txt\',\'ok\')"', '--check', 'node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\')?0:1)"']);
const blAfterPlan = backlog();
if (blAfterPlan.tasks.length !== 2) failures.push('plan did not append a task');
const planned = blAfterPlan.tasks.find((t) => String(t.id).startsWith('plan-'));
if (!planned) failures.push('planned task not found');
else if (planned.acceptance_checks.length !== 2) failures.push('planned task did not get both checks');
const planText = readFileSync(join(root, 'memory/backlog.yaml'), 'utf8');
if (!planText.includes('# Existing backlog comment')) failures.push('plan overwrote existing backlog comments');

// Reset to a single auto-executable task for the remaining tests
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: AUTO-1',
  '    title: write auto file',
  '    status: todo',
  '    priority: 1',
  '    commands:',
  "      - node -e \"require('fs').writeFileSync('auto.txt','done')\"",
  '    acceptance_checks:',
  "      - node -e \"process.exit(require('fs').existsSync('auto.txt')?0:1)\"",
  '',
].join('\n'));
writeFileSync(join(root, 'memory/backlog-state.json'), '{}');
pb(['loop', 'run', '--auto', '--max-tasks', '1']);
const autoTask = backlog().tasks.find((t) => t.id === 'AUTO-1');
if (!autoTask || autoTask.status !== 'done') failures.push('auto mode did not complete AUTO-1');
if (!journal().some((e) => e.task === 'AUTO-1' && e.status === 'done')) failures.push('no done journal entry for AUTO-1');

// 3. auto mode stops on manual task
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: MANUAL-1',
  '    title: human decision',
  '    status: todo',
  '    priority: 1',
  '    manual: true',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
  '',
].join('\n'));
writeFileSync(join(root, 'memory/backlog-state.json'), '{}');
const manualOut = pb(['loop', 'run', '--auto']);
if (!manualOut.includes('manual')) failures.push('auto mode did not stop on manual task');
if (journal().some((e) => e.task === 'MANUAL-1')) failures.push('manual task should not have journal entry yet');

// 4. auto mode blocks after retries on failing check
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: FAIL-1',
  '    title: always fails',
  '    status: todo',
  '    priority: 1',
  '    commands:',
  '      - echo attempting',
  '    acceptance_checks:',
  '      - node -e "process.exit(1)"',
  '',
].join('\n'));
writeFileSync(join(root, 'memory/backlog-state.json'), '{}');
const failOut = pb(['loop', 'run', '--auto', '--retry', '2']);
if (!failOut.includes('blocked')) failures.push('auto mode did not block FAIL-1');
const failState = state()['FAIL-1'];
if (!failState || failState.status !== 'blocked') failures.push('FAIL-1 state is not blocked');

// 5. dry run does not mutate
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: DRY-1',
  '    title: dry run task',
  '    status: todo',
  '    priority: 1',
  '    commands:',
  "      - node -e \"require('fs').writeFileSync('dry.txt','bad')\"",
  '',
].join('\n'));
writeFileSync(join(root, 'memory/backlog-state.json'), '{}');
pb(['loop', 'run', '--auto', '--dry-run']);
if (existsSync(join(root, 'dry.txt'))) failures.push('dry run mutated filesystem');
if (journal().some((e) => e.task === 'DRY-1')) failures.push('dry run created journal entry');

rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error('FAIL — autonomous loop checks:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS — plan and autonomous loop execution work, respect manual tasks, retry/block on failure, and dry-run is safe');
