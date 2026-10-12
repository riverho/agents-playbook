#!/usr/bin/env node
// test-temp-cleanup — a test's temp fixture is gone when the test exits, and removing it
// never follows a link (plan-20261009-008).
//
// ~1450 pb* fixture dirs had piled up in %TEMP%, many holding a node_modules LINK into
// this repo or another worktree. A child process makes a fixture through
// scripts/lib/test-temp.mjs, puts a link (a junction on Windows) to a precious directory
// inside it, and exits — normally, and by process.exit(1) as a failing test does. The
// fixture must be gone and the precious directory untouched.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 800)}` : ''}`); fail++; }
}

const precious = mkdtempSync(join(tmpdir(), 'precious-target-'));
writeFileSync(join(precious, 'keep.txt'), 'do not delete');
const lib = pathToFileURL(resolve('scripts/lib/test-temp.mjs')).href;

for (const [label, exit] of [['a passing test', ''], ['a failing test (process.exit(1))', 'process.exit(1);']]) {
  const child = `
    import { tempDir } from ${JSON.stringify(lib)};
    import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = tempDir('pbtempclean-');
    mkdirSync(join(root, 'deep'));
    writeFileSync(join(root, 'deep', 'file.txt'), 'x');
    symlinkSync(${JSON.stringify(precious)}, join(root, 'node_modules'), 'junction');
    symlinkSync(${JSON.stringify(precious)}, join(root, 'deep', 'nested-link'), 'junction');
    mkdirSync(root + '-worker-task-agent');
    console.log(root);
    ${exit}
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' });
  const made = (r.stdout || '').trim().split(/\r?\n/).pop();
  ok(`${label}: the child made a fixture`, !!made && made.includes('pbtempclean-'), `${r.stdout}${r.stderr}`);
  ok(`${label}: the fixture is gone after exit`, !!made && !existsSync(made), made);
  ok(`${label}: its worker worktree sibling is gone too`, !!made && !existsSync(`${made}-worker-task-agent`));
  ok(`${label}: the linked target was NOT followed`, existsSync(join(precious, 'keep.txt')) && readFileSync(join(precious, 'keep.txt'), 'utf8') === 'do not delete');
}

rmSync(precious, { recursive: true, force: true });
console.log(`\ntest-temp-cleanup: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
