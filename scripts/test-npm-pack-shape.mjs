#!/usr/bin/env node
// scripts/test-npm-pack-shape.mjs
// ----------------------------------------------------------------------------
// Pins the npm-11/npm-12 `npm pack --json` shapes, and — the part that actually
// broke — that an UNREADABLE pack result FAILS the gate instead of skipping it.
//
// The regression this guards: `pack:plugin` read `parsed[0]`. npm 12 answers with an
// object keyed by package name, so `parsed[0]` was undefined and control fell through to a
// branch that printed the raw output and exited 0. The engine-in-tarball assertion simply
// stopped running while the gate kept reporting success. The suite below is deliberately
// about the FAILURE path, because that is the half a happy-path test cannot see.
// ----------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { firstPackedEntry } from './lib/npm-pack.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// --- 1. both shipped shapes decode to the same entry -------------------------
const entry = { filename: 'dsh-agents-playbook-0.7.1.tgz', files: [{ path: 'engine/scripts/pb.mjs' }], entryCount: 77, unpackedSize: 1 };
ok('npm 11 shape (array) decodes', firstPackedEntry([entry])?.filename === entry.filename);
ok('npm 12 shape (object keyed by name) decodes', firstPackedEntry({ 'dsh-agents-playbook': entry })?.filename === entry.filename);

// --- 2. an unrecognized shape is NOT guessed at ------------------------------
for (const [label, value] of [['null', null], ['a string', 'npm notice'], ['a number', 7], ['an empty array', []], ['an empty object', {}]]) {
  ok(`${label} yields no entry (so the caller must fail, not pass)`, firstPackedEntry(value) === undefined);
}

// --- 3. the gate fails LOUDLY when the pack result cannot be read -----------
{
  const work = mkdtempSync(join(tmpdir(), 'packshape-'));
  const stub = join(work, 'npm-stub.mjs');
  writeFileSync(stub, 'process.stdout.write(\'{"unexpected":"shape"}\\n\');\n');
  const r = spawnSync(process.execPath, [resolve('scripts', 'pack-dsh-plugin.mjs'), '--pack', '--dry-run'], {
    cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, npm_execpath: stub },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('an unreadable pack result exits NON-zero (it used to exit 0)', r.status !== 0, `exit=${r.status}\n${out.slice(0, 400)}`);
  ok('...and names the reason', /could not read `npm pack --json` output/.test(out), out.slice(0, 400));
  rmSync(work, { recursive: true, force: true });
}

// --- 4. the real pack still proves the engine is in the tarball --------------
{
  const real = spawnSync(process.execPath, [resolve('scripts', 'pack-dsh-plugin.mjs'), '--pack', '--dry-run'], { cwd: resolve('.'), encoding: 'utf8' });
  const out = `${real.stdout || ''}${real.stderr || ''}`;
  ok('the real pack exits 0', real.status === 0, `exit=${real.status}\n${out.slice(-400)}`);
  ok('the real pack asserts the engine is in the tarball', /engine in tarball: yes/.test(out), out.slice(-300));
}

console.log(`\ntest-npm-pack-shape: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
