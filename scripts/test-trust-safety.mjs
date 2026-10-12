// Acceptance coverage for high-priority trust & safety changes:
// 1. record --status done/blocked refuses unknown task IDs.
// 2. next --claim refuses while another task is in_progress.
// 3. validate --task runs structural validation before task checks.
// 4. pb preserves hand-edited formatting/comments in backlog.yaml.
// 5. Loop artifact paths are stored with forward slashes (carry-on portability).
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbtrust-');
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
writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
writeFileSync(join(root, 'memory/backlog.yaml'), [
  '# Hand-edited header comment that must survive',
  'tasks:',
  '  # Task T1 comment',
  '  - id: T1',
  '    title: first',
  '    status: todo',
  '    priority: 1',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
  '  - id: T2',
  '    title: second',
  '    status: todo',
  '    priority: 2',
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
const mustFail = (args) => {
  try { pb(args); return false; }
  catch { return true; }
};
const fillQ5 = () => {
  const path = join(root, 'memory/cycle.md');
  const text = readFileSync(path, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
    'No conflicts found.',
  );
  writeFileSync(path, text, 'utf8');
};

const failures = [];

pb(['loop', 'new', '--goal', 'g', '--stop', 's']);
pb(['cycle', '--new', '--goal', 'g', '--stop', 's']);
fillQ5();

if (!mustFail(['record', '--task', 'UNKNOWN', '--action', 'x', '--status', 'done'])) {
  failures.push('record --status done for unknown task did not fail');
}
if (!mustFail(['record', '--task', 'UNKNOWN', '--action', 'x', '--status', 'blocked'])) {
  failures.push('record --status blocked for unknown task did not fail');
}

pb(['next', '--claim']);
if (!mustFail(['next', '--claim'])) {
  failures.push('next --claim did not refuse while a task was already in_progress');
}

pb(['record', '--task', 'T1', '--action', 'x', '--status', 'done']);
writeFileSync(join(root, 'playbook.yaml'), master.replace('loop:', 'loopx:'));
if (!mustFail(['validate', '--task', 'T2'])) {
  failures.push('validate --task did not fail on corrupted master');
}
writeFileSync(join(root, 'playbook.yaml'), master);

const backlogAfter = readFileSync(join(root, 'memory/backlog.yaml'), 'utf8');
if (!backlogAfter.includes('# Hand-edited header comment that must survive')) {
  failures.push('backlog header comment was lost');
}
if (!backlogAfter.includes('# Task T1 comment')) {
  failures.push('backlog task comment was lost');
}
if (existsSync(join(root, 'memory/backlog-state.json'))) {
  const state = JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8'));
  if (state.T1?.status !== 'done') {
    failures.push('sidecar state did not record T1 as done');
  }
}

const loops = yaml.load(readFileSync(join(root, 'memory/loops.yaml'), 'utf8'));
const loop = loops.loops[0];
if (loop.artifacts.includes('\\')) {
  failures.push('loop artifacts path contains backslash: ' + loop.artifacts);
}

rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error('FAIL — trust & safety checks:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS — trust & safety gates: unknown-task record, one in_progress, structural+task validation, backlog preservation, portable paths');
