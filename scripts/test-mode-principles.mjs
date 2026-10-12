#!/usr/bin/env node
// scripts/test-mode-principles.mjs
// ----------------------------------------------------------------------------
// Behavioral test for kind:check principle gating (phase 6, track A / step 3).
// Asserts that kind:check principles actually gate (exit code), kind:advice
// never gates, and toggling a check principle changes the gate. This is what
// keeps modes from going faith-based.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbprin-');
mkdirSync(join(root, 'scripts'));
mkdirSync(join(root, 'memory'), { recursive: true });
mkdirSync(join(root, 'modes'), { recursive: true });
copyFileSync('scripts/pb.mjs', join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
const pb = join(root, 'scripts/pb.mjs');

// helper scripts the check principles invoke (no `node -e`, no cmd-specials).
writeFileSync(join(root, 'scripts/pass.mjs'), 'process.exit(0);\n');
writeFileSync(join(root, 'scripts/fail.mjs'), 'process.exit(1);\n');

// supporting files so structural `pb validate` passes (we test the mode gate ON TOP).
mkdirSync(join(root, 'processes'), { recursive: true });
mkdirSync(join(root, 'skills'), { recursive: true });
writeFileSync(join(root, 'SKILL.md'), '# entry\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# mem\n');

const writeMaster = (defaultMode) => writeFileSync(join(root, 'playbook.yaml'),
  'name: t\nversion: 0.0.0\nentry: SKILL.md\n' +
  'paths:\n  root: .\n' +
  'index:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n' +
  'loop:\n  description: test\n' +
  `default_mode: ${defaultMode}\n` +
  'modes:\n  passing: modes/passing.yaml\n  failing: modes/failing.yaml\n  adviceonly: modes/adviceonly.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');

const base = 'skills_index: skills/index.yaml\nprocesses_index: processes/index.yaml\n';
writeFileSync(join(root, 'modes/passing.yaml'),
  `id: passing\ndescription: ok\ndirective: ""\n${base}` +
  'principles:\n  - {id: tests, kind: check, check: node scripts/pass.mjs}\n  - {id: small, kind: advice, text: small}\n');
writeFileSync(join(root, 'modes/failing.yaml'),
  `id: failing\ndescription: bad\ndirective: ""\n${base}` +
  'principles:\n  - {id: tests, kind: check, check: node scripts/fail.mjs}\n  - {id: small, kind: advice, text: small}\n');
writeFileSync(join(root, 'modes/adviceonly.yaml'),
  `id: adviceonly\ndescription: nudges\ndirective: ""\n${base}` +
  'principles:\n  - {id: small, kind: advice, text: small}\n');

writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks: []\n');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: null\nloops: []\n');

function run(cmdArgs) {
  try {
    const out = execSync(`node "${pb}" ${cmdArgs}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
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

// 1. passing check principle -> mode check exit 0
writeMaster('passing');
let r = run('mode check');
ok('passing kind:check principle gates green (exit 0)', r.code === 0 && /checks passed/.test(r.out), `code=${r.code}`);

// 2. failing check principle -> mode check exit nonzero
writeMaster('failing');
r = run('mode check');
ok('failing kind:check principle gates red (exit nonzero)', r.code !== 0 && /FAIL/.test(r.out), `code=${r.code}`);

// 3. advice-only mode never gates -> exit 0
writeMaster('adviceonly');
r = run('mode check');
ok('advice-only mode never gates (exit 0)', r.code === 0, `code=${r.code}`);

// 4. validate --mode also gates on the check principle
writeMaster('failing');
r = run('validate --mode');
ok('validate --mode fails when the check principle fails', r.code !== 0 && /Mode "failing" check FAILED/.test(r.out), `code=${r.code}`);
// plain validate (no --mode) must stay structural-only and pass (no recursion/gating)
r = run('validate');
ok('plain validate stays structural-only (passes despite failing check principle)', r.code === 0 && /validation passed/.test(r.out), `code=${r.code}`);

// 5. toggling: removing the check principle flips the gate from red to green
writeFileSync(join(root, 'modes/failing.yaml'),
  `id: failing\ndescription: bad\ndirective: ""\n${base}` +
  'principles:\n  - {id: small, kind: advice, text: small}\n');
r = run('mode check');
ok('removing the check principle flips the gate red -> green', r.code === 0, `code=${r.code}`);

console.log(`\ntest-mode-principles: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
