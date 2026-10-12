#!/usr/bin/env node
// scripts/test-daily-monitor.mjs
// ----------------------------------------------------------------------------
// Behavioral test for the blogwatch daily-monitor orchestrator. Runs it in a
// temp copy of the playbook with a passing config and a failing config.
// ----------------------------------------------------------------------------

import {
  mkdtempSync, mkdirSync, copyFileSync, cpSync, symlinkSync,
  writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const repoRoot = process.cwd();

function buildRoot(watches) {
  const root = tempDir('pbdaily-');
  for (const d of ['scripts', 'scripts/lib', 'memory', 'modes', 'skills', 'processes', 'artifacts/reports']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  copyFileSync(resolve(repoRoot, 'scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  copyFileSync(resolve(repoRoot, 'scripts/pb-daily-monitor.mjs'), join(root, 'scripts/pb-daily-monitor.mjs'));
  copyFileSync(resolve(repoRoot, 'scripts/lib/loop-lib.mjs'), join(root, 'scripts/lib/loop-lib.mjs'));
  copyModules(resolve(repoRoot, 'node_modules'), join(root, 'node_modules'));
  copyFileSync(resolve(repoRoot, 'modes/coding.yaml'), join(root, 'modes/coding.yaml'));
  copyFileSync(resolve(repoRoot, 'modes/blogwatch.yaml'), join(root, 'modes/blogwatch.yaml'));
  cpSync(resolve(repoRoot, 'modes/blogwatch'), join(root, 'modes/blogwatch'), { recursive: true });

  // Inject the test watches into the copied config.
  writeFileSync(join(root, 'modes/blogwatch/config/daily-watches.yaml'), yaml.dump({ watches }));

  writeFileSync(join(root, 'playbook.yaml'), [
    'name: t',
    'index:',
    '  memory:',
    '    backlog: memory/backlog.yaml',
    '    journal: memory/journal.ndjson',
    '    loops: memory/loops.yaml',
    '    cycle: memory/cycle.md',
    '    processes: memory/processes.ndjson',
    'paths:',
    '  artifacts: artifacts',
    'default_mode: coding',
    'default_monitor_mode: blogwatch',
    'modes:',
    '  coding: modes/coding.yaml',
    '  blogwatch: modes/blogwatch.yaml',
    'guardrails:',
    '  allowed_statuses: [todo, in_progress, blocked, done]',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks:\n');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');
  return root;
}

function runOrchestrator(root) {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts/pb-daily-monitor.mjs')], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function backlogState(root) {
  const tasks = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'))?.tasks || [];
  const state = existsSync(join(root, 'memory/backlog-state.json'))
    ? JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8'))
    : {};
  return tasks.map((t) => ({ ...t, ...(state[t.id] || {}) }));
}

function logLines(root, file) {
  const p = join(root, 'artifacts/reports', file);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// ---------------------------------------------------------------------------
// Success case: two passing watches
// ---------------------------------------------------------------------------
const passing = [
  { id: 'w1', source: 'feed-a', criteria: 'keyword A', check: "node -e \"console.log('w1 ok'); process.exit(0)\"" },
  { id: 'w2', source: 'feed-b', criteria: 'keyword B', check: "node -e \"console.log('w2 ok'); process.exit(0)\"" },
];
let root = buildRoot(passing);
let r = runOrchestrator(root);
ok('success run exits 0', r.code === 0, r.out);
const state1 = backlogState(root);
ok('two watch tasks recorded', state1.length === 2, JSON.stringify(state1));
ok('all tasks done', state1.every((t) => t.status === 'done'), JSON.stringify(state1));
ok('reflection log has one entry', logLines(root, 'orchestrator-reflections.ndjson').length === 1);
ok('error log is empty', logLines(root, 'orchestrator-errors.ndjson').length === 0);
rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Failure-surfacing case: one passing, one failing
// ---------------------------------------------------------------------------
const mixed = [
  { id: 'w1', source: 'feed-a', criteria: 'keyword A', check: "node -e \"console.log('w1 ok'); process.exit(0)\"" },
  { id: 'w2', source: 'feed-b', criteria: 'keyword B', check: "node -e \"console.log('w2 fail'); process.exit(1)\"" },
];
root = buildRoot(mixed);
r = runOrchestrator(root);
ok('failure run exits non-zero', r.code !== 0, `code=${r.code}\n${r.out}`);
const state2 = backlogState(root);
ok('one task done and one blocked',
  state2.some((t) => t.status === 'done') && state2.some((t) => t.status === 'blocked'),
  JSON.stringify(state2));
ok('error log has one entry', logLines(root, 'orchestrator-errors.ndjson').length === 1);
const err = logLines(root, 'orchestrator-errors.ndjson')[0];
ok('error entry names the failing watch', err && (err.watch_id === 'w2' || (err.title && err.title.includes('feed-b'))),
  JSON.stringify(err));
rmSync(root, { recursive: true, force: true });

console.log(`\ntest-daily-monitor: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
