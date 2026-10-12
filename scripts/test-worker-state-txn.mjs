#!/usr/bin/env node
// scripts/test-worker-state-txn.mjs
// ----------------------------------------------------------------------------
// Regression: the worker write paths must commit through the serialized state
// transaction, not a bare read-modify-write of backlog-state.json.
//
// The archive flagged `pb worker checker` and `pb worker provider-rate-limit`
// as newly relevant lost-update hazards. Both now go through `commitIteration`
// (O_EXCL lock + atomic replace, journal row and state touch in one commit).
// This pins that contract under real cross-process contention: N tasks, two
// writers each, all fired at once. A bare RMW would clobber most of them.
// ----------------------------------------------------------------------------

import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const root = tempDir('pbwtxn-');
for (const d of ['scripts', 'memory', 'modes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'playbook.yaml'),
  'name: wtxn-test\nversion: 0.3.6\nentry: SKILL.md\n' +
  'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
  'index:\n  cli: scripts/pb.mjs\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
  'loop:\n  description: test loop\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
  'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: loop-wtxn-001\nloops:\n  - id: loop-wtxn-001\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
writeFileSync(join(root, 'memory/cycle.md'),
  '# Cycle\n## 1. What is this cycle\'s goal?\nTest worker writes\n## 2. What challenges do I foresee?\nNone\n' +
  '## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');

const N = 6;
const ids = Array.from({ length: N }, (_, i) => `W${i + 1}`);
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n' + ids.map((id) => `  - {id: ${id}, title: task ${id}, status: todo, priority: 1}`).join('\n') + '\n');

const pbPath = join(root, 'scripts/pb.mjs');
const statePath = join(root, 'memory/backlog-state.json');
const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const readJournal = () => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function run(args, agent) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [pbPath, ...args], {
      cwd: root, env: { ...process.env, PB_AGENT_ID: agent },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => res({ code, out }));
  });
}

const writers = await Promise.all(
  ids.flatMap((id, i) => [
    run(['worker', 'checker', id, '--verdict', 'pass', '--notes', `review ${id}`], `checker-${i}`),
    run(['worker', 'provider-rate-limit', id, '--provider', 'codex', '--retry-after', '5h'], `provider-${i}`),
  ]),
);

const st = readState();
const rows = readJournal();
const failed = writers.filter((r) => r.code !== 0);

ok('all worker writers exit 0 (none reported a false failure)', failed.length === 0,
  failed.map((r) => r.out.slice(0, 200)).join('\n'));
ok('the state file survives the storm as valid JSON', Object.keys(st).length > 0);
ok('every checker verdict persisted (no lost update)', ids.every((id) => st[id]?.checker?.verdict === 'pass'),
  JSON.stringify(Object.fromEntries(ids.map((id) => [id, st[id]?.checker?.verdict]))));
ok('every provider cooldown persisted (no lost update)', ids.every((id) => st[id]?.provider?.status === 'rate_limited'),
  JSON.stringify(Object.fromEntries(ids.map((id) => [id, st[id]?.provider?.status]))));
ok('the journal retains every worker row (2N expected)', rows.length === 2 * N,
  `rows=${rows.length} expected=${2 * N}`);
ok('every worker row carries a numeric seq', rows.every((r) => typeof r.seq === 'number'),
  JSON.stringify(rows.filter((r) => typeof r.seq !== 'number')));
ok('worker journal seq is strictly increasing in file order',
  rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq),
  JSON.stringify(rows.map((r) => r.seq)));
ok('each state touch is stamped with its writer (updated_by)',
  ids.every((id) => typeof st[id]?.updated_by === 'string' && st[id]?.updated_by),
  JSON.stringify(Object.fromEntries(ids.map((id) => [id, st[id]?.updated_by]))));

console.log(`\ntest-worker-state-txn: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
