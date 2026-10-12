import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

function makeRoot(prefix = 'pbruncard-') {
  const root = tempDir(prefix);
  for (const d of ['scripts', 'memory', 'processes', 'skills/run-task', 'artifacts/reports']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  copyModules(resolve('node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'SKILL.md'), '# test skill\n');
  writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  writeFileSync(join(root, 'memory/backlog-state.json'), JSON.stringify({
    'task-1': {
      status: 'in_progress',
      claimed_by: 'codex',
      loop_id: 'loop-test-001',
      worker: {
        agent: 'codex',
        branch: 'agent/task-1-codex',
        worktree_path: '/tmp/wenmei-worker-task-1-codex',
        status: 'created'
      },
      checker: { verdict: 'pass', notes: 'diff and checks verified' },
      provider: { name: 'codex', status: 'ok' }
    }
  }, null, 2));
  writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
  writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
  writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
  writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run task\n');
  writeFileSync(join(root, 'memory/backlog.yaml'), [
    'tasks:',
    '  - id: task-1',
    '    title: Build worker RunCard projection',
    '    status: todo',
    '    skill: run-task',
    '    priority: 1',
    '    acceptance_checks:',
    '      - node scripts/pb.mjs validate',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'memory/loops.yaml'), 'active: loop-test-001\nloops:\n  - id: loop-test-001\n    status: active\n    started_at: now\n');
  writeFileSync(join(root, 'memory/cycle.md'), '# Cycle\n## 1. What is this cycle\'s goal?\nTest\n## 2. What challenges do I foresee?\nNone\n## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');
  writeFileSync(join(root, 'playbook.yaml'), [
    'name: t', 'version: 0.3.6', 'entry: SKILL.md',
    'paths:', '  scripts: scripts', '  processes: processes', '  skills: skills', '  memory: memory', '  artifacts: artifacts', '  reports: artifacts/reports',
    'index:', '  processes_index: processes/index.yaml', '  skills_index: skills/index.yaml', '  memory:', '    project_memory: memory/project-memory.md', '    backlog: memory/backlog.yaml', '    journal: memory/journal.ndjson', '    cycle: memory/cycle.md', '    loops: memory/loops.yaml', '    lessons: memory/lessons.ndjson', '    processes: memory/processes.ndjson',
    'default_mode: coding', 'modes: { coding: modes/coding.yaml }', 'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', ''
  ].join('\n'));
  return root;
}

const root = makeRoot();
const pb = (args) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], { cwd: root, encoding: 'utf8' });
const card = JSON.parse(pb(['runcard', 'show', 'task-1', '--json']));
if (card.schema !== 'agent-playbook.runcard.v1') throw new Error('RunCard schema version missing');
if (card.task_id !== 'task-1') throw new Error('RunCard task_id mismatch');
if (card.status !== 'in_progress') throw new Error(`RunCard did not merge backlog-state status: ${card.status}`);
if (card.worker.branch !== 'agent/task-1-codex') throw new Error('RunCard worker branch missing');
if (card.checker.verdict !== 'pass') throw new Error('RunCard checker verdict missing');
const list = JSON.parse(pb(['runcard', 'list', '--json']));
if (!Array.isArray(list.runcards) || list.runcards.length !== 1) throw new Error('RunCard list JSON shape wrong');
console.log('PASS — portable RunCard projection includes task, worker, checker, provider, and schema metadata');
