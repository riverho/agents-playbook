#!/usr/bin/env node
// scripts/test-self-update.mjs
// ----------------------------------------------------------------------------
// Behavioral test for `pb update` (phase 8) — offline via --source <dir>.
// Builds a temp install (vA) + a temp "newer" source (vB) and asserts:
//   - engine files are refreshed (a new engine file appears, pb.mjs overwritten),
//   - the master `version:` line is bumped to vB (comments preserved),
//   - user state (memory/backlog.yaml) is PRESERVED (not overwritten),
//   - a second update reports "already up to date".
// The GitHub path shares the same overlay logic; only the source differs.
// ----------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const base = tempDir('pbupd-');
const install = join(base, 'install');
const source = join(base, 'source');
for (const d of [join(install, 'scripts'), join(install, 'memory'), join(source, 'scripts')]) mkdirSync(d, { recursive: true });
copyModules(resolve('node_modules'), join(install, 'node_modules'));

// --- an older INSTALL fixture (v0.3.2) ---------------------------------------
copyFileSync('scripts/pb.mjs', join(install, 'scripts/pb.mjs'));
writeFileSync(join(install, 'playbook.yaml'),
  '# USER_CUSTOM_MARKER — must survive an update\n' +
  'name: t\nversion: 0.3.2\n' +
  'index:\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n' +
  'update:\n  repo: riverho/agents-playbook\n');
writeFileSync(join(install, 'memory/journal.ndjson'), '');
writeFileSync(join(install, 'memory/backlog.yaml'), 'tasks:\n  - {id: USER_TASK_KEEP, status: todo}\n'); // user state

// --- the SOURCE (newer, v0.3.3) ----------------------------------------------
// pb.mjs with a detectable marker (still valid JS — a trailing comment).
writeFileSync(join(source, 'scripts/pb.mjs'), readFileSync('scripts/pb.mjs', 'utf8') + '\n// PB_UPDATE_MARKER_v033\n');
writeFileSync(join(source, 'scripts/newfile.mjs'), '// a brand-new engine file shipped in v0.3.3\n');
writeFileSync(join(source, 'playbook.yaml'), 'name: t\nversion: 0.3.3\n');
writeFileSync(join(source, 'package.json'), '{"name":"agent-playbook","version":"0.3.3"}\n');
// a DIFFERENT backlog in the source — must NOT be copied over the install's.
mkdirSync(join(source, 'memory'), { recursive: true });
writeFileSync(join(source, 'memory/backlog.yaml'), 'tasks:\n  - {id: SOURCE_TASK_SHOULD_NOT_APPEAR, status: todo}\n');

const pb = join(install, 'scripts/pb.mjs');
function run(extra) {
  try { return { out: execSync(`node "${pb}" update ${extra}`, { cwd: install, stdio: ['ignore', 'pipe', 'pipe'] }).toString(), code: 0 }; }
  catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status == null ? 1 : e.status }; }
}
const read = (rel) => readFileSync(join(install, rel), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// --check is a dry run: reports available, changes nothing.
let r = run(`--check --source "${source}"`);
ok('--check reports an update is available, exit 0', r.code === 0 && /Update available/.test(r.out), r.out);
ok('--check changes nothing (no new engine file yet)', !existsSync(join(install, 'scripts/newfile.mjs')), '');

// apply the update.
r = run(`--source "${source}"`);
ok('update applies, exit 0', r.code === 0 && /Updated v0\.3\.2 → v0\.3\.3/.test(r.out), r.out);
ok('a new engine file was added', existsSync(join(install, 'scripts/newfile.mjs')), '');
ok('pb.mjs was overwritten with the source version', /PB_UPDATE_MARKER_v033/.test(read('scripts/pb.mjs')), '');
ok('master version line bumped to 0.3.3', /^version: 0\.3\.3$/m.test(read('playbook.yaml')), read('playbook.yaml'));
ok('user customization in the master is preserved', /USER_CUSTOM_MARKER/.test(read('playbook.yaml')), '');
ok('user state (memory/backlog.yaml) is PRESERVED, not overwritten',
  /USER_TASK_KEEP/.test(read('memory/backlog.yaml')) && !/SOURCE_TASK_SHOULD_NOT_APPEAR/.test(read('memory/backlog.yaml')),
  read('memory/backlog.yaml'));

// second run is idempotent.
r = run(`--source "${source}"`);
ok('a second update reports "already up to date"', r.code === 0 && /Already up to date/.test(r.out), r.out);

console.log(`\ntest-self-update: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
