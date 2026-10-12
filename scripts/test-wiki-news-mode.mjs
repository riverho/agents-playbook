#!/usr/bin/env node
// Behavioral test for wiki-news: pack-local skills resolve only under wiki-news,
// the mode can dry-run through the generic orchestrator, and pb.mjs has no pack literal.

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const repoRoot = process.cwd();
const root = tempDir('pbwikinews-');
for (const d of ['scripts', 'scripts/lib', 'memory', 'modes', 'skills', 'processes', 'artifacts/reports']) mkdirSync(join(root, d), { recursive: true });
for (const f of ['scripts/pb.mjs', 'scripts/pb-daily-monitor.mjs', 'scripts/wiki-news-daily.mjs', 'scripts/lib/loop-lib.mjs']) copyFileSync(f, join(root, f));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
copyFileSync(resolve('modes/coding.yaml'), join(root, 'modes/coding.yaml'));
copyFileSync(resolve('modes/wiki-news.yaml'), join(root, 'modes/wiki-news.yaml'));
cpSync(resolve('modes/wiki-news'), join(root, 'modes/wiki-news'), { recursive: true });

writeFileSync(join(root, 'playbook.yaml'),
  'name: t\n' +
  'index:\n' +
  '  memory:\n' +
  '    backlog: memory/backlog.yaml\n' +
  '    journal: memory/journal.ndjson\n' +
  '    loops: memory/loops.yaml\n' +
  'default_mode: coding\n' +
  'modes:\n' +
  '  coding: modes/coding.yaml\n' +
  '  wiki-news: modes/wiki-news.yaml\n' +
  'guardrails:\n' +
  '  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - {id: core, file: skills/core.md}\n');
writeFileSync(join(root, 'skills/core.md'), '---\nname: core\n---\n# core\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks: []\n');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - {id: L1, status: active, mode: wiki-news}\n');

const pb = join(root, 'scripts/pb.mjs');
const daily = join(root, 'scripts/pb-daily-monitor.mjs');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

let out = run(`node "${pb}" mode skills wiki-news`);
ok('daily-wiki-refresh resolves under wiki-news', /daily-wiki-refresh/.test(out), out);
ok('wiki-news-ingest resolves under wiki-news', /wiki-news-ingest/.test(out), out);
ok('engine skill still resolves under wiki-news', /\bcore\b/.test(out), out);
out = run(`node "${pb}" mode skills coding`);
ok('wiki-news pack skills are not visible under coding', !/daily-wiki-refresh|wiki-news-ingest|wiki-news-verify/.test(out), out);
out = run(`node "${daily}" --mode wiki-news --dry-run`);
ok('generic daily monitor can dry-run wiki-news scaffold', /would plan: Refresh/.test(out) && /wiki-news monitor/.test(out), out);
const engineSrc = readFileSync(join(repoRoot, 'scripts/pb.mjs'), 'utf8');
ok('scripts/pb.mjs contains no wiki-news-specific code', !/wiki-news|daily-wiki-refresh|wiki-news-ingest/.test(engineSrc), 'found wiki-news-specific code in pb.mjs');

console.log(`\ntest-wiki-news-mode: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
