#!/usr/bin/env node
// Real acceptance check for "tri-state pb report": build a temp playbook with a
// hollow, a real, and a no-check task; run `pb report`; assert all 3 gate markers.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';
const root = tempDir('pbrep-');
mkdirSync(join(root, 'scripts'));
mkdirSync(join(root, 'memory'), { recursive: true });
mkdirSync(join(root, 'artifacts/reports'), { recursive: true });
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
writeFileSync(join(root, 'playbook.yaml'),
  'name: t\nindex:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\npaths:\n  reports: artifacts/reports\nguardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'),
  "tasks:\n  - {id: H, title: hollow, status: todo, acceptance_checks: ['node scripts/pb.mjs validate']}\n  - {id: R, title: real, status: todo, acceptance_checks: ['grep -q x README.md']}\n  - {id: N, title: none, status: todo}\n");
writeFileSync(join(root, 'memory/journal.ndjson'), JSON.stringify({ ts: new Date().toISOString(), task: 'H', action: 'execute', status: 'done', checks: 'passed' }) + '\n');
execSync(`node ${join(root, 'scripts/pb.mjs')} report`, { cwd: root, stdio: 'pipe' });
const f = readdirSync(join(root, 'artifacts/reports')).find((x) => x.endsWith('.md'));
const rep = readFileSync(join(root, 'artifacts/reports', f), 'utf8');
const need = ['✓verified', '·honor', '⚠hollow', '⚠hollow-checks'];
const missing = need.filter((m) => !rep.includes(m));
if (missing.length) { console.error('FAIL — missing gate markers:', missing); process.exit(1); }
console.log('PASS — pb report distinguishes verified / honor / hollow');
