#!/usr/bin/env node
// scripts/test-pack-carryon.mjs
// ----------------------------------------------------------------------------
// Behavioral test for pack carry-on + well-formedness validation (phase 7).
// Runs the real check-modes.mjs against temp playbooks: a pack with a missing
// referenced file fails; a pack carrying package.json or node_modules fails
// carry-on; a clean pack passes. Modes on the global indices (coding) are exempt.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbcarry-');
for (const d of ['scripts', 'skills', 'processes', 'modes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync('scripts/check-modes.mjs', join(root, 'scripts/check-modes.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
const checker = join(root, 'scripts/check-modes.mjs');

// base playbook: a valid coding mode (global indices, exempt) + the packmode under test.
writeFileSync(join(root, 'playbook.yaml'),
  'name: t\nversion: 0\nentry: x\npaths: {root: .}\nindex: {}\nloop: {description: x}\n' +
  'default_mode: coding\n' +
  'modes:\n  coding: modes/coding.yaml\n  packmode: modes/packmode.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'modes/coding.yaml'),
  'id: coding\ndescription: strict\ndirective: ""\n' +
  'skills_index: skills/index.yaml\nprocesses_index: processes/index.yaml\n' +
  'principles:\n  - {id: a, kind: advice, text: x}\n  - {id: c, kind: check, text: x, check: npm test}\n');
// packmode: pack-local skills index, valid mode fields.
writeFileSync(join(root, 'modes/packmode.yaml'),
  'id: packmode\ndescription: pack\ndirective: ""\n' +
  'skills_index: modes/packmode/skills/index.yaml\nprocesses_index: processes/index.yaml\n' +
  'principles:\n  - {id: a, kind: advice, text: x}\n');

const packDir = join(root, 'modes/packmode');
function buildPack({ referenceMissing = false, withPackageJson = false, withNodeModules = false } = {}) {
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(join(packDir, 'skills'), { recursive: true });
  const fileRef = 'modes/packmode/skills/ps.md';
  writeFileSync(join(packDir, 'skills/index.yaml'), `skills:\n  - {id: ps, file: ${fileRef}}\n`);
  if (!referenceMissing) writeFileSync(join(root, fileRef), '# ps\n');
  if (withPackageJson) writeFileSync(join(packDir, 'package.json'), '{}\n');
  if (withNodeModules) mkdirSync(join(packDir, 'node_modules'), { recursive: true });
}

function runChecker() {
  try { execSync(`node "${checker}"`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, out: '' }; }
  catch (e) { return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

buildPack();
let r = runChecker();
ok('a clean carry-on pack passes', r.code === 0, r.out);

buildPack({ referenceMissing: true });
r = runChecker();
ok('a pack referencing a missing file fails', r.code !== 0 && /missing file/.test(r.out), r.out);

buildPack({ withPackageJson: true });
r = runChecker();
ok('a pack carrying package.json fails carry-on', r.code !== 0 && /not carry-on/.test(r.out), r.out);

buildPack({ withNodeModules: true });
r = runChecker();
ok('a pack carrying node_modules fails carry-on', r.code !== 0 && /not carry-on/.test(r.out), r.out);

console.log(`\ntest-pack-carryon: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
