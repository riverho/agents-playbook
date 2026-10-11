#!/usr/bin/env node
// ============================================================================
//  check-flow-room-app.mjs — the Flow-room gate for the room as it lives NOW,
//  in apps/flow-room.
// ----------------------------------------------------------------------------
//  scripts/check-flow-room.mjs certifies the old Wenmei playground worktree the room
//  was built in. Since the extraction (fa19099) that worktree is history: the gate
//  reads it, not this repo, and reported 25 failures against a room nobody edits any
//  more. This is the gate for the extracted app. Each step is an existing check; this
//  runs them in order and fails if any one fails (its own exit code, never a pipe's):
//
//    contract    scripts/check-room-contract.mjs      the approved design contract (D18)
//    provenance  scripts/check-app-source-provenance  every edit to a copied file is recorded
//    decoupled   scripts/check-app-decoupled.mjs      no reach-back into Wenmei, no linked deps
//    types       npm --prefix apps/flow-room run check
//    tests       npm --prefix apps/flow-room test     geometry, legend budget, honesty rules
//    build       npm --prefix apps/flow-room run build the dist the browser step serves
//    browser     scripts/check-room-browser.mjs       T3 (>= 9px at every zoom), F4 reduced motion, G5 beacons
//
//  The browser render (scripts/check-app-render.mjs) is not here: it draws the
//  playbook it runs in, and a worker worktree has no backlog (memory/ is gitignored),
//  so it would assert an empty room. Run it in the root checkout, or with --url
//  against a server started with --root <the playbook>.
//
//    node scripts/check-flow-room-app.mjs
// ============================================================================

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const STEPS = [
  ['contract', process.execPath, ['scripts/check-room-contract.mjs']],
  ['provenance', process.execPath, ['scripts/check-app-source-provenance.mjs']],
  ['decoupled', process.execPath, ['scripts/check-app-decoupled.mjs']],
  ['types', 'npm', ['--prefix', 'apps/flow-room', 'run', 'check']],
  ['tests', 'npm', ['--prefix', 'apps/flow-room', 'test']],
  ['build', 'npm', ['--prefix', 'apps/flow-room', 'run', 'build']],
  ['browser', process.execPath, ['scripts/check-room-browser.mjs']],
  ['stack-proof', process.execPath, ['scripts/check-stack-proof.mjs']],
];

let failed = 0;
for (const [name, cmd, args] of STEPS) {
  const started = Date.now();
  const r = win && cmd === 'npm'
    ? spawnSync('cmd.exe', ['/d', '/c', 'npm', ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    : spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const ms = Date.now() - started;
  const ok = r.status === 0;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(10)} ${ms}ms  ${[cmd === process.execPath ? 'node' : cmd, ...args].join(' ')}`);
  if (!ok) {
    failed += 1;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim().split(/\r?\n/).slice(-15);
    for (const line of out) console.log(`    ${line}`);
  }
}
if (failed) {
  console.error(`\nFLOW ROOM APP GATE FAILED (${failed} of ${STEPS.length} step(s))`);
  process.exit(1);
}
console.log(`\nThe Flow room app holds: contract, provenance, decoupling, types and tests.`);
