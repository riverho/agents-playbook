#!/usr/bin/env node
// scripts/test-agent-identity.mjs
// ----------------------------------------------------------------------------
// Behavioral test for agent identity + mode stamping (phase 6, track B / step 1).
// Runs the real CLI in an isolated temp playbook and asserts that BOTH the claim
// ledger (backlog-state.json — the single authority) and the journal carry
// agent_id, claimed_by, and mode. Also asserts a sane default agent_id.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbid-');
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
// active loop + an answered cycle brief so the real claim path (not --force) runs.
writeFileSync(join(root, 'memory/loops.yaml'), "active: L1\nloops:\n  - {id: L1, status: active}\n");
writeFileSync(join(root, 'memory/cycle.md'), '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered.\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
// two todo tasks, no acceptance_checks (record done skips checks).
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n  - {id: T1, title: one, status: todo, priority: 1}\n  - {id: T2, title: two, status: todo, priority: 2}\n');

const readState = () => JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8'));
const lastJournal = () => {
  const lines = readFileSync(join(root, 'memory/journal.ndjson'), 'utf8').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
};
function run(cmdArgs, env = {}) {
  return execSync(`node "${pb}" ${cmdArgs}`, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// 1. claim with PB_AGENT_ID=alice -> claim ledger carries agent_id, claimed_by, mode
run('next --claim', { PB_AGENT_ID: 'alice' });
let s = readState().T1 || {};
ok('claim ledger carries agent_id from PB_AGENT_ID', s.agent_id === 'alice', JSON.stringify(s));
ok('claim ledger carries claimed_by', s.claimed_by === 'alice', JSON.stringify(s));
ok('claim ledger carries resolved mode (coding)', s.mode === 'coding', JSON.stringify(s));

// 2. record done -> journal entry carries agent_id, claimed_by, mode
run('record --task T1 --action implement --status done --notes x', { PB_AGENT_ID: 'alice' });
let j = lastJournal();
ok('journal entry carries agent_id', j.agent_id === 'alice', JSON.stringify(j));
ok('journal entry carries claimed_by', j.claimed_by === 'alice', JSON.stringify(j));
ok('journal entry carries mode (coding)', j.mode === 'coding', JSON.stringify(j));

// 3. default agent_id when PB_AGENT_ID is unset
run('next --claim', { PB_AGENT_ID: '' });
s = readState().T2 || {};
ok('default agent_id is "agent" when PB_AGENT_ID unset', s.agent_id === 'agent', JSON.stringify(s));

console.log(`\ntest-agent-identity: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
