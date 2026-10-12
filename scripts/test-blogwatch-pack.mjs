#!/usr/bin/env node
// scripts/test-blogwatch-pack.mjs
// ----------------------------------------------------------------------------
// Behavioral test for the blogwatch Stage-2 pack: the real modes/blogwatch pack
// mounts with ZERO pb.mjs change. Copies the real pack into a temp playbook and
// asserts its pack-local skill resolves under `blogwatch` and not under `coding`;
// and that the engine source contains no "blogwatch"-specific code.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const repoRoot = process.cwd();
const root = tempDir('pbblogwatch-');
for (const d of ['scripts', 'memory', 'modes', 'skills', 'processes']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
const pb = join(root, 'scripts/pb.mjs');

// Copy the REAL pack + coding mode into the temp playbook (exercise real artifacts).
copyFileSync(resolve('modes/coding.yaml'), join(root, 'modes/coding.yaml'));
copyFileSync(resolve('modes/blogwatch.yaml'), join(root, 'modes/blogwatch.yaml'));
cpSync(resolve('modes/blogwatch'), join(root, 'modes/blogwatch'), { recursive: true });

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
  '  blogwatch: modes/blogwatch.yaml\n' +
  'guardrails:\n' +
  '  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - {id: core, file: skills/core.md}\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks: []\n'); // no in_progress task pins the mode

const setMode = (mode) => writeFileSync(join(root, 'memory/loops.yaml'),
  `active: L1\nloops:\n  - {id: L1, status: active, mode: ${mode}}\n`);
const run = (a) => execSync(`node "${pb}" ${a}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// 1. under blogwatch: the pack-local skill resolves (and the engine skill too — union).
setMode('blogwatch');
let out = run('list skills');
ok('watch-feeds resolves under the blogwatch mode', /watch-feeds/.test(out), out);
ok('engine skill (core) still resolves under blogwatch (additive union)', /\bcore\b/.test(out), out);
out = run('list processes');
ok('watch-feeds process resolves under the blogwatch mode', /watch-feeds/.test(out), out);

// 2. under coding: the pack-local skill is NOT visible.
setMode('coding');
out = run('list skills');
ok('watch-feeds is NOT visible under coding', !/watch-feeds/.test(out) && /\bcore\b/.test(out), out);

// 3. the engine has ZERO knowledge of the blogwatch pack (resolution is data-driven).
const engineSrc = readFileSync(join(repoRoot, 'scripts/pb.mjs'), 'utf8');
ok('scripts/pb.mjs contains no "blogwatch"-specific code (mounts purely from YAML)', !/blogwatch/i.test(engineSrc),
  'found "blogwatch" in pb.mjs — the mechanism should be data-driven, not hard-coded');

console.log(`\ntest-blogwatch-pack: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
