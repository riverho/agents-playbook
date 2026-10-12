#!/usr/bin/env node
// scripts/test-mode-resolve.mjs
// ----------------------------------------------------------------------------
// Behavioral test for mode resolution + `pb mode show/set` + anchor injection
// (phase 6, track A / step 2). Runs the real CLI in an isolated temp playbook.
//
// Asserts:
//   1. default resolution: task.mode ?? loop.mode ?? default_mode.
//   2. anchor --brief contains EXACTLY ONE `Mode:` line (the slice stays tiny).
//   3. empty directive is NON-BLOCKING: anchor + mode show exit 0 and report
//      "inherits host prompt" — it must never gate.
//   4. `mode set` scopes to the active loop; loop.mode overrides default_mode.
//   5. task.mode (the in_progress task) overrides loop.mode.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbmode-');
mkdirSync(join(root, 'scripts'));
mkdirSync(join(root, 'memory'), { recursive: true });
mkdirSync(join(root, 'modes'), { recursive: true });
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

const pb = join(root, 'scripts/pb.mjs');

writeFileSync(join(root, 'playbook.yaml'),
  'name: t\n' +
  'index:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n' +
  'default_mode: coding\n' +
  'modes:\n  coding: modes/coding.yaml\n  prose: modes/prose.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');

// coding: empty directive (the intentional placeholder).
writeFileSync(join(root, 'modes/coding.yaml'),
  'id: coding\ndescription: strict\ndirective: ""\n' +
  'skills_index: skills/index.yaml\nprocesses_index: processes/index.yaml\n' +
  'principles:\n  - {id: smallest_diff, kind: advice, text: small}\n');
// prose: a non-empty directive.
writeFileSync(join(root, 'modes/prose.yaml'),
  'id: prose\ndescription: write clearly\ndirective: "Write plainly."\n' +
  'skills_index: skills/index.yaml\nprocesses_index: processes/index.yaml\n' +
  'principles:\n  - {id: cite, kind: advice, text: cite}\n');

writeFileSync(join(root, 'memory/journal.ndjson'), '');

const setBacklog = (yaml) => writeFileSync(join(root, 'memory/backlog.yaml'), yaml);
const setLoops = (yaml) => writeFileSync(join(root, 'memory/loops.yaml'), yaml);

setBacklog('tasks: []\n');
setLoops('active: null\nloops: []\n');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}
// run returns {out, code}; never throws on non-zero (we assert on code).
function run(cmdArgs) {
  try {
    const out = execSync(`node "${pb}" ${cmdArgs}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { out, code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status == null ? 1 : e.status };
  }
}

// 1. default resolution -> coding, exit 0 ----------------------------------------
let r = run('mode show');
ok('mode show resolves to default_mode (coding), exit 0', r.code === 0 && /Active mode: coding/.test(r.out), `code=${r.code}`);

// 3. empty directive non-blocking: show reports inherit, exit 0 ------------------
ok('empty directive is reported as "inherits host prompt" and does not gate',
  r.code === 0 && /inherits the host/i.test(r.out), r.out.trim());

// 2. anchor --brief has EXACTLY ONE Mode: line, exit 0 ---------------------------
r = run('anchor --brief');
const modeLines = r.out.split('\n').filter((l) => l.trimStart().startsWith('Mode:'));
ok('anchor --brief contains exactly ONE Mode: line', r.code === 0 && modeLines.length === 1, `code=${r.code}, count=${modeLines.length}`);

// empty directive non-blocking on the full anchor too ----------------------------
r = run('anchor');
ok('full anchor exits 0 with an empty-directive mode', r.code === 0 && /Mode: coding/.test(r.out), `code=${r.code}`);

// 4. mode set scopes to the active loop; loop.mode overrides default -------------
setLoops("active: L1\nloops:\n  - {id: L1, status: active}\n");
r = run('mode set prose');
ok('mode set prose succeeds against an active loop', r.code === 0 && /Mode set: prose/.test(r.out), r.out.trim());
r = run('mode show');
ok('loop.mode (prose) overrides default_mode (coding)', r.code === 0 && /Active mode: prose/.test(r.out), r.out.trim());

// mode set with no active loop should refuse (non-zero) ---------------------------
setLoops('active: null\nloops: []\n');
r = run('mode set prose');
ok('mode set refuses when there is no active loop', r.code !== 0, `code=${r.code}`);

// 5. task.mode overrides loop.mode -----------------------------------------------
setLoops("active: L1\nloops:\n  - {id: L1, status: active, mode: prose}\n");
setBacklog("tasks:\n  - {id: T, title: t, status: in_progress, mode: coding}\n");
r = run('mode show');
ok('task.mode (coding) overrides loop.mode (prose)', r.code === 0 && /Active mode: coding/.test(r.out), r.out.trim());

console.log(`\ntest-mode-resolve: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
