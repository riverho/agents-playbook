#!/usr/bin/env node
// scripts/test-wip-per-agent.mjs
// ----------------------------------------------------------------------------
// Behavioral test for per-agent WIP scoping (phase 6, track B / step 2).
// The "one in_progress" guard must be PER AGENT: two different agents can each
// hold a task concurrently (a global guard would serialize them to 1), while the
// same agent is still held to one at a time.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbwip-');
mkdirSync(join(root, 'scripts'));
mkdirSync(join(root, 'memory'), { recursive: true });
mkdirSync(join(root, 'modes'), { recursive: true });
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
const pb = join(root, 'scripts/pb.mjs');

writeFileSync(join(root, 'playbook.yaml'),
  'name: t\n' +
  'index:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
  'default_mode: coding\n' +
  'modes:\n  coding: modes/coding.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'modes/coding.yaml'),
  'id: coding\ndescription: strict\ndirective: ""\n' +
  'skills_index: skills/index.yaml\nprocesses_index: processes/index.yaml\n' +
  'principles:\n  - {id: smallest_diff, kind: advice, text: small}\n');
writeFileSync(join(root, 'memory/loops.yaml'), "active: L1\nloops:\n  - {id: L1, status: active}\n");
writeFileSync(join(root, 'memory/cycle.md'), '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered.\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n' +
  '  - {id: T1, title: one, status: todo, priority: 1}\n' +
  '  - {id: T2, title: two, status: todo, priority: 2}\n' +
  '  - {id: T3, title: three, status: todo, priority: 3}\n');

const readState = () => JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8'));
function run(cmdArgs, agent) {
  try {
    const out = execSync(`node "${pb}" ${cmdArgs}`, { cwd: root, env: { ...process.env, PB_AGENT_ID: agent }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { out, code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status == null ? 1 : e.status };
  }
}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// 1. alice claims T1
let r = run('next --claim', 'alice');
ok('alice claims a task (exit 0)', r.code === 0 && /Claimed \[T1\]/.test(r.out), `code=${r.code}`);
ok('T1 ledger holder is alice', (readState().T1 || {}).claimed_by === 'alice', JSON.stringify(readState().T1));

// 2. bob claims T2 concurrently — NOT blocked by alice's in_progress task
r = run('next --claim', 'bob');
ok('bob claims concurrently (a global guard would have refused)', r.code === 0 && /Claimed \[T2\]/.test(r.out), `code=${r.code}\n${r.out}`);
ok('T2 ledger holder is bob', (readState().T2 || {}).claimed_by === 'bob', JSON.stringify(readState().T2));

// 3. alice tries to claim a second task while holding T1 -> refused
r = run('next --claim', 'alice');
ok('same agent (alice) is refused a second concurrent claim', r.code !== 0 && /already hold/.test(r.out), `code=${r.code}\n${r.out}`);

console.log(`\ntest-wip-per-agent: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
