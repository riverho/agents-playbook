#!/usr/bin/env node
// scripts/test-mode-routing.mjs
// ----------------------------------------------------------------------------
// Behavioral test for mode-routed claiming (phase 6, track B / step 4).
// An agent of mode M claims only tasks tagged M, plus UNTAGGED tasks (claimable
// by any mode). This is what lets a pool of mode-specialized agents share one
// board. Ties tracks A (modes) and B (multi-agent) together.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbroute-');
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
  'modes:\n  coding: modes/m.yaml\n  legal: modes/m.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
// one mode file reused for both ids (routing only needs the registry to know them).
writeFileSync(join(root, 'modes/m.yaml'),
  'id: coding\ndescription: x\ndirective: ""\n' +
  'skills_index: skills/index.yaml\nprocesses_index: processes/index.yaml\n' +
  'principles:\n  - {id: a, kind: advice, text: x}\n');
writeFileSync(join(root, 'memory/loops.yaml'), "active: L1\nloops:\n  - {id: L1, status: active}\n");
writeFileSync(join(root, 'memory/cycle.md'), '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered.\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');

const statePath = join(root, 'memory/backlog-state.json');
function resetBacklog(tasksYaml) {
  writeFileSync(join(root, 'memory/backlog.yaml'), tasksYaml);
  if (existsSync(statePath)) unlinkSync(statePath); // fresh claim ledger
}
function run(cmdArgs, agent) {
  try {
    const out = execSync(`node "${pb}" ${cmdArgs}`, { cwd: root, env: { ...process.env, PB_AGENT_ID: agent || 'agent' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
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

// Scenario A — routing on a shared board.
// Tlegal is HIGHEST priority; a coding agent must still skip it and take Tcoding.
resetBacklog('tasks:\n' +
  '  - {id: Tlegal, title: l, status: todo, priority: 1, mode: legal}\n' +
  '  - {id: Tcoding, title: c, status: todo, priority: 2, mode: coding}\n' +
  '  - {id: Tuntagged, title: u, status: todo, priority: 3}\n');

let r = run('next --claim --mode coding', 'c1');
ok('coding agent claims the coding task, skipping a higher-priority legal task',
  r.code === 0 && /Claimed \[Tcoding\]/.test(r.out) && !/Claimed \[Tlegal\]/.test(r.out), r.out.trim());

r = run('next --claim --mode legal', 'l1');
ok('legal agent claims the legal task', r.code === 0 && /Claimed \[Tlegal\]/.test(r.out), r.out.trim());

r = run('next --claim --mode coding', 'c2');
ok('untagged task is claimable by any mode (not starved)', r.code === 0 && /Claimed \[Tuntagged\]/.test(r.out), r.out.trim());

// Scenario B — an agent whose mode matches nothing gets a clear message, not a wrong claim.
resetBacklog('tasks:\n  - {id: OnlyLegal, title: l, status: todo, priority: 1, mode: legal}\n');
r = run('next --mode coding', 'c3');
ok('coding agent sees "no tasks match mode" when only other-mode tasks remain',
  r.code === 0 && /No todo tasks match mode "coding"/.test(r.out), r.out.trim());
// and must NOT be able to claim it
r = run('next --claim --mode coding', 'c3');
ok('coding agent cannot claim a legal-only board', !/Claimed \[OnlyLegal\]/.test(r.out), r.out.trim());

console.log(`\ntest-mode-routing: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
