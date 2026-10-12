#!/usr/bin/env node
// scripts/test-atomic-claim.mjs
// ----------------------------------------------------------------------------
// Behavioral test for the atomic claim primitive (phase 6, track B / step 3).
// Launches N agents that race to claim ONE todo task concurrently. The O_EXCL
// claim lock + in-lock re-verify must resolve the race to EXACTLY ONE winner —
// never a double-claim. Without the lock this is a flaky lost-update race.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbatom-');
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
// EXACTLY ONE claimable task — the contended resource.
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks:\n  - {id: T1, title: one, status: todo, priority: 1}\n');

const readState = () => {
  try { return JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8')); }
  catch { return {}; }
};

// Launch all racers as concurrently as possible (process.execPath = real node.exe,
// not a shim — safe to spawn directly per project-memory #9).
function race(agent) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [pb, 'next', '--claim'], { cwd: root, env: { ...process.env, PB_AGENT_ID: agent } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => res({ agent, code, out }));
  });
}

const N = 8;
const results = await Promise.all(Array.from({ length: N }, (_, i) => race(`a${i}`)));

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const claimers = results.filter((r) => /Claimed \[T1\]/.test(r.out));
ok(`exactly ONE of ${N} concurrent racers claimed T1`, claimers.length === 1,
  `claimers=[${claimers.map((r) => r.agent).join(',')}], count=${claimers.length}`);

const st = readState().T1 || {};
ok('T1 ends in_progress with a single recorded holder', st.status === 'in_progress' && typeof st.claimed_by === 'string', JSON.stringify(st));
ok('the recorded holder is the winning racer (no lost update)', claimers.length === 1 && st.claimed_by === claimers[0].agent, `holder=${st.claimed_by}`);

// every non-winner must have NOT claimed (rejected or found nothing claimable).
const losers = results.filter((r) => !/Claimed \[T1\]/.test(r.out));
ok('all non-winners did not double-claim', losers.length === N - 1, `losers=${losers.length}`);

console.log(`\ntest-atomic-claim: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
