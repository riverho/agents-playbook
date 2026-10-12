#!/usr/bin/env node
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';
const root = tempDir('pbq5-');
mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'memory'), { recursive: true }); mkdirSync(join(root, 'artifacts/reports'), { recursive: true });
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
writeFileSync(join(root, 'playbook.yaml'), 'name: t\nindex:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    cycle: memory/cycle.md\npaths:\n  reports: artifacts/reports\nguardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), "tasks:\n  - {id: W, title: waiting, status: todo}\n");
execSync(`node ${join(root, 'scripts/pb.mjs')} cycle --new`, { cwd: root, stdio: 'pipe' });
const out = execSync(`node ${join(root, 'scripts/pb.mjs')} checkpoint`, { cwd: root }).toString();
if (!out.includes('Q5')) { console.error('FAIL — checkpoint did not flag an unanswered Q5'); process.exit(1); }
console.log('PASS — checkpoint flags an unanswered Q5 (memory-conflict check)');
