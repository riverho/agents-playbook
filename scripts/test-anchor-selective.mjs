#!/usr/bin/env node
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';
const root = tempDir('pbanc-');
mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'memory'), { recursive: true });
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
writeFileSync(join(root, 'playbook.yaml'), 'name: t\nindex:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\nguardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), "tasks:\n  - {id: W, title: claimed, status: in_progress, acceptance_checks: ['echo SENTINEL_CHECK_XYZ']}\n");
const out = execSync(`node ${join(root, 'scripts/pb.mjs')} anchor`, { cwd: root }).toString();
if (!out.includes('SENTINEL_CHECK_XYZ')) { console.error('FAIL — anchor did not surface the claimed task check'); process.exit(1); }
console.log('PASS — anchor surfaces the claimed task and its acceptance_checks');
