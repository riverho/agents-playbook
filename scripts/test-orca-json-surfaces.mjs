import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbjson-');
for (const d of ['scripts', 'memory', 'processes', 'skills/run-task', 'artifacts/reports', 'modes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
writeFileSync(join(root, 'SKILL.md'), '# test skill\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '{"ts":"2026-01-01T00:00:00Z","task":"task-json","action":"seed","status":"done"}\n');
writeFileSync(join(root, 'memory/lessons.ndjson'), '');
writeFileSync(join(root, 'memory/processes.ndjson'), '');
writeFileSync(join(root, 'memory/backlog-state.json'), JSON.stringify({ 'task-json': { status: 'todo', loop_id: 'loop-json-001' } }, null, 2));
writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run task\n');
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: task-json',
  '    title: JSON surface task',
  '    status: todo',
  '    skill: run-task',
  '    priority: 1',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
  '',
].join('\n'));
writeFileSync(join(root, 'memory/loops.yaml'), 'active: loop-json-001\nloops:\n  - id: loop-json-001\n    status: active\n    started_at: now\n');
writeFileSync(join(root, 'memory/cycle.md'), '# Cycle\n## 1. What is this cycle\'s goal?\nTest\n## 2. What challenges do I foresee?\nNone\n## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');
writeFileSync(join(root, 'playbook.yaml'), [
  'name: json-test', 'version: 0.3.6', 'entry: SKILL.md',
  'paths:', '  scripts: scripts', '  processes: processes', '  skills: skills', '  memory: memory', '  artifacts: artifacts', '  reports: artifacts/reports',
  'index:', '  processes_index: processes/index.yaml', '  skills_index: skills/index.yaml', '  memory:', '    project_memory: memory/project-memory.md', '    backlog: memory/backlog.yaml', '    journal: memory/journal.ndjson', '    cycle: memory/cycle.md', '    loops: memory/loops.yaml', '    lessons: memory/lessons.ndjson', '    processes: memory/processes.ndjson',
  'default_mode: coding', 'modes:', '  coding: modes/coding.yaml', 'loop:', '  description: test', 'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', ''
].join('\n'));
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');

const pb = (args) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], { cwd: root, encoding: 'utf8' });
const status = JSON.parse(pb(['status', '--json']));
if (status.schema !== 'agent-playbook.status.v1') throw new Error('status JSON schema missing');
if (status.backlog.counts.todo !== 1) throw new Error('status JSON backlog counts wrong');
if (status.loop.id !== 'loop-json-001') throw new Error('status JSON loop missing');
if (status.guardrails.status !== 'green') throw new Error(`status JSON guardrails not green: ${JSON.stringify(status.guardrails)}`);
const task = JSON.parse(pb(['task', 'show', 'task-json', '--json']));
if (task.schema !== 'agent-playbook.task.v1') throw new Error('task JSON schema missing');
if (task.task.id !== 'task-json') throw new Error('task JSON id mismatch');
if (!Array.isArray(task.acceptance_checks) || task.acceptance_checks.length !== 1) throw new Error('task JSON checks missing');
console.log('PASS — status --json and task show --json expose machine-readable Agent-Playbook state');
