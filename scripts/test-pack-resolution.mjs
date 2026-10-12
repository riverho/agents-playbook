#!/usr/bin/env node
// scripts/test-pack-resolution.mjs
// ----------------------------------------------------------------------------
// Behavioral test for pack-composable index resolution (phase 7 / Stage 2).
// Skills/processes resolve as (engine globals) UNION (active mode's pack-local
// indices). A pack-local skill is visible only while its mode is active; engine
// skills always resolve (additive, not override).
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbpack-');
for (const d of ['scripts', 'memory', 'modes', 'skills', 'processes', 'modes/packmode/skills']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
const pb = join(root, 'scripts/pb.mjs');

writeFileSync(join(root, 'playbook.yaml'),
  'name: t\n' +
  'index:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n' +
  'default_mode: coding\n' +
  'modes:\n  coding: modes/coding.yaml\n  packmode: modes/packmode.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');

// engine globals (the "engine" skill/process)
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - {id: harden, file: skills/harden.md, process: harden}\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - {id: harden, file: processes/harden.yaml}\n');
// pack-local index for packmode (its own skill)
writeFileSync(join(root, 'modes/packmode/skills/index.yaml'), 'skills:\n  - {id: packskill, file: modes/packmode/skills/packskill.md, process: harden}\n');

const m = (skillsIdx) => 'id: M\ndescription: x\ndirective: ""\n' +
  `skills_index: ${skillsIdx}\nprocesses_index: processes/index.yaml\n` +
  'principles:\n  - {id: a, kind: advice, text: x}\n';
writeFileSync(join(root, 'modes/coding.yaml'), m('skills/index.yaml').replace('id: M', 'id: coding'));
writeFileSync(join(root, 'modes/packmode.yaml'), m('modes/packmode/skills/index.yaml').replace('id: M', 'id: packmode'));

writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks: []\n');

const setMode = (mode) => writeFileSync(join(root, 'memory/loops.yaml'),
  mode ? `active: L1\nloops:\n  - {id: L1, status: active, mode: ${mode}}\n` : 'active: null\nloops: []\n');

function run(cmdArgs) {
  try { return { out: execSync(`node "${pb}" ${cmdArgs}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString(), code: 0 }; }
  catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status == null ? 1 : e.status }; }
}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// under coding (pointers == global): engine skill resolves, pack skill does NOT.
setMode('coding');
let r = run('list skills');
ok('engine skill (harden) resolves under coding', /\bharden\b/.test(r.out), r.out);
ok('pack-local skill (packskill) is NOT visible under coding', !/packskill/.test(r.out), r.out);

// under packmode: union = engine globals + pack-local -> BOTH resolve.
setMode('packmode');
r = run('list skills');
ok('pack-local skill (packskill) resolves under its own mode', /packskill/.test(r.out), r.out);
ok('engine skill (harden) still resolves under packmode (additive union)', /\bharden\b/.test(r.out), r.out);

// default (no loop.mode) falls back to default_mode coding -> pack skill hidden.
setMode(null);
r = run('list skills');
ok('default mode hides the pack-local skill', !/packskill/.test(r.out) && /\bharden\b/.test(r.out), r.out);

console.log(`\ntest-pack-resolution: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
