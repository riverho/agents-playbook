#!/usr/bin/env node
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbmodeplan-');
for (const d of ['scripts', 'memory', 'modes/custom/skills/local-skill', 'modes/custom/processes', 'skills', 'processes', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'SKILL.md'), '# test skill\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks: []\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
mkdirSync(join(root, 'skills/run-task'), { recursive: true });
writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run task\n');
writeFileSync(join(root, 'modes/custom.yaml'), [
  'id: custom',
  'description: custom mode with a pack-local skill',
  'skills_index: modes/custom/skills/index.yaml',
  'processes_index: modes/custom/processes/index.yaml',
  '',
].join('\n'));
writeFileSync(join(root, 'modes/custom/skills/index.yaml'), 'skills:\n  - id: local-skill\n    file: modes/custom/skills/local-skill/SKILL.md\n    process: local-proc\n');
writeFileSync(join(root, 'modes/custom/skills/local-skill/SKILL.md'), '# local skill\n');
writeFileSync(join(root, 'modes/custom/processes/index.yaml'), 'processes:\n  - id: local-proc\n    file: modes/custom/processes/local-proc.yaml\n');
writeFileSync(join(root, 'modes/custom/processes/local-proc.yaml'), 'id: local-proc\n');
writeFileSync(join(root, 'playbook.yaml'), [
  'name: t',
  'version: 0.0.0',
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
  'default_mode: coding',
  'modes:',
  '  custom: modes/custom.yaml',
  'loop:',
  '  description: test',
  'guardrails:',
  '  allowed_statuses: [todo, in_progress, blocked, done]',
  '',
].join('\n'));

const pb = (args) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });

pb(['loop', 'new', '--goal', 'mode-local planning', '--stop', 'task planned']);
pb(['mode', 'set', 'custom']);
pb(['cycle', '--new', '--force', '--goal', 'mode-local planning', '--stop', 'task planned']);
writeFileSync(join(root, 'memory/cycle.md'), readFileSync(join(root, 'memory/cycle.md'), 'utf8').replace(
  /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
  'No conflicts found.',
));
pb(['plan', '--goal', 'use local skill', '--skill', 'local-skill', '--check', 'node scripts/pb.mjs validate']);
let backlog = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'));
if (backlog.tasks[0].mode !== 'custom') throw new Error('pb plan must stamp the resolved mode onto mode-local tasks');
pb(['loop', 'close', '--status', 'abandoned', '--reason', 'validate after loop closes']);
pb(['validate']);

console.log('PASS — pb plan stamps mode-local tasks so pb validate still resolves their skills after the loop closes');
