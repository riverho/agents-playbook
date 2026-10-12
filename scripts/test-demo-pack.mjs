#!/usr/bin/env node
// scripts/test-demo-pack.mjs
// ----------------------------------------------------------------------------
// The existence proof for Stage 2 (phase 7): the REAL modes/demo pack mounts
// with ZERO pb.mjs change. Copies the real pack into a temp playbook and asserts
// its pack-local skill resolves under `demo` and not under `coding`; and that the
// engine source contains no "demo"-specific code (resolution is data-driven).
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const repoRoot = process.cwd();
const root = tempDir('pbdemo-');
for (const d of ['scripts', 'memory', 'modes', 'skills', 'processes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
const pb = join(root, 'scripts/pb.mjs');

// copy the REAL pack + coding mode into the temp playbook (exercise real artifacts).
copyFileSync(resolve('modes/coding.yaml'), join(root, 'modes/coding.yaml'));
copyFileSync(resolve('modes/demo.yaml'), join(root, 'modes/demo.yaml'));
cpSync(resolve('modes/demo'), join(root, 'modes/demo'), { recursive: true });

writeFileSync(join(root, 'playbook.yaml'),
  'name: t\n' +
  'index:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n' +
  'default_mode: coding\n' +
  'modes:\n  coding: modes/coding.yaml\n  demo: modes/demo.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
// stub global indices coding points at (pb list prints; does not stat files).
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - {id: core, file: skills/core.md}\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks: []\n'); // no in_progress task pins the mode

const setMode = (mode) => writeFileSync(join(root, 'memory/loops.yaml'),
  `active: L1\nloops:\n  - {id: L1, status: active, mode: ${mode}}\n`);
const run = (a) => execSync(`node "${pb}" ${a}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// 1. under demo: the pack-local skill resolves (and the engine skill too — union).
setMode('demo');
let out = run('list skills');
ok('demo-skill resolves under the demo mode', /demo-skill/.test(out), out);
ok('engine skill (core) still resolves under demo (additive union)', /\bcore\b/.test(out), out);
out = run('list processes');
ok('demo-proc resolves under the demo mode', /demo-proc/.test(out), out);

// 2. under coding: the pack-local skill is NOT visible.
setMode('coding');
out = run('list skills');
ok('demo-skill is NOT visible under coding', !/demo-skill/.test(out) && /\bcore\b/.test(out), out);

// 3. the engine has ZERO knowledge of the demo pack (resolution is data-driven).
const engineSrc = readFileSync(join(repoRoot, 'scripts/pb.mjs'), 'utf8');
ok('scripts/pb.mjs contains no "demo"-specific code (mounts purely from YAML)', !/demo/i.test(engineSrc),
  'found "demo" in pb.mjs — the mechanism should be data-driven, not hard-coded');

console.log(`\ntest-demo-pack: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
