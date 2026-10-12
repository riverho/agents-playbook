// Acceptance coverage for v0.3 loop epochs + learning gate.
// Builds a temp playbook, closes a failed loop, proves the next loop is blocked
// until a lesson is recorded, and verifies loop_id stamping.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbloop-');
for (const d of ['scripts', 'memory', 'processes', 'skills', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'SKILL.md'), '# test skill\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: A',
  '    title: first task',
  '    status: todo',
  '    priority: 1',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
  '  - id: B',
  '    title: task to claim',
  '    status: todo',
  '    priority: 2',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
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

const pb = (args, options = {}) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
  cwd: root,
  encoding: 'utf8',
  stdio: options.stdio || 'pipe',
});
const mustFail = (args) => {
  try {
    pb(args);
    return false;
  } catch {
    return true;
  }
};

pb(['loop', 'new', '--goal', 'loop one', '--stop', 'quarantine']);
let loops = yaml.load(readFileSync(join(root, 'memory/loops.yaml'), 'utf8'));
const firstLoop = loops.active;
if (!firstLoop) throw new Error('loop new did not set active loop');

pb(['record', '--task', 'A', '--action', 'note', '--status', 'done', '--notes', 'scoped']);
const firstJournal = JSON.parse(readFileSync(join(root, 'memory/journal.ndjson'), 'utf8').trim());
if (firstJournal.loop_id !== firstLoop) throw new Error('record did not stamp active loop_id');

pb(['loop', 'close', '--status', 'failed', '--reason', 'contaminated logs']);
if (!existsSync(join(root, 'artifacts/loops', firstLoop, 'quarantine.md'))) {
  throw new Error('failed close did not write quarantine artifact');
}
if (!mustFail(['loop', 'new'])) {
  throw new Error('new loop was allowed before failed-loop learning reflection');
}

pb([
  'learn', '--loop', firstLoop, '--source', 'user', '--severity', 'high',
  '--promotion', 'skill', '--target', 'skills/harden/SKILL.md',
  '--notes', 'Need cleanup before retry',
]);
pb(['loop', 'new', '--from-lessons', '--goal', 'loop two', '--stop', 'done']);
loops = yaml.load(readFileSync(join(root, 'memory/loops.yaml'), 'utf8'));
if (!loops.active || loops.active === firstLoop) throw new Error('second loop did not become active');
const cycle = readFileSync(join(root, 'memory/cycle.md'), 'utf8');
if (!cycle.includes('lesson-') || !cycle.includes('Need cleanup before retry')) {
  throw new Error('cycle was not seeded from open lessons');
}

pb(['next', '--claim']);
if (!mustFail(['loop', 'close', '--status', 'done', '--allow-unreflected'])) {
  throw new Error('done close did not refuse while a task was in_progress');
}

console.log('PASS — loop epochs stamp records, quarantine failed loops, gate learning, and seed next cycle');
