#!/usr/bin/env node
// ============================================================================
//  test-timeout-kills-tree.mjs — a check the engine KILLS must not be able to write after
//  the kill returns.
// ----------------------------------------------------------------------------
//  The defect this pins (plan-20261010-026): on a timer kill the engine killed only its
//  direct child. On Windows that was the `cmd.exe` shim, so the real check — and anything
//  the check had started — kept running. An independent checker measured a check killed at
//  2000ms writing its marker file 12 SECONDS later, and the Lead found three orphaned
//  `node hang.js` processes still alive 27.5 minutes after the gate that started them had
//  reported TIMEOUT. The engine had declared "no verdict" while the work went on.
//
//  Proven end to end against the real CLI in a scratch playbook (rule 25):
//    direct     the check itself writes late                 -> TIMEOUT, marker never appears
//    grandchild the check starts a writer, then hangs        -> TIMEOUT, marker never appears
//    overflow   the check starts a writer, then out-prints   -> OUTPUT-LIMIT, marker never appears
//    green      exits 0 and prints                           -> PASS (the launcher is invisible)
//    red        exits 3 with a stderr line                   -> FAIL, the line is shown verbatim
//  and the runner leaves no status file behind in its temp directory.
//
//  The POSIX branch (process-group kill) cannot be exercised on a Windows machine. This test
//  runs on whatever platform it is on; it proves the branch that platform takes.
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIMIT_MS = 1500;      // the per-check limit the engine enforces in this test
const LATE_MS = 4000;       // when the fixtures write their marker, well after the limit
const LINGER_MS = 1000;             // each green follow-up check: under the limit, so it PASSES
const LINGERS = 5;                 // ...and five of them keep pb alive well past the late write

const work = mkdtempSync(join(tmpdir(), 'pb-tree-kill-'));
const repo = join(work, 'repo');
const pbRoot = join(repo, '.agents-playbook');
const pbTmp = join(work, 'tmp');      // the engine's temp dir for this test: pid files land here
mkdirSync(repo, { recursive: true });
mkdirSync(pbTmp, { recursive: true });

function pb(args, env = {}) {
  const r = spawnSync(process.execPath, [join(pbRoot, 'scripts', 'pb.mjs'), ...args], {
    cwd: pbRoot, encoding: 'utf8',
    env: { ...process.env, TEMP: pbTmp, TMP: pbTmp, TMPDIR: pbTmp, PB_CHECK_TIMEOUT_MS: String(LIMIT_MS), ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const marker = (name) => join(pbRoot, `marker-${name}.txt`);
// A writer that lands its marker LATE_MS after it starts. Every fixture stands down on its own
// shortly after, so a broken engine leaves markers (the RED we want), not immortal processes.
const WRITER = `const fs = require('fs'); setTimeout(() => { fs.writeFileSync(process.argv[2], 'late'); process.exit(0); }, ${LATE_MS});`;
const FIXTURES = {
  'writer.cjs': WRITER,
  // the check itself writes late
  'direct.cjs': `const fs = require('fs'); setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker('direct'))}, 'late'); process.exit(0); }, ${LATE_MS});`,
  // the check starts a writer (sharing its stdio, as real tools do), then hangs past the limit
  'grandchild.cjs': `const { spawn } = require('child_process'); spawn(process.execPath, ['writer.cjs', ${JSON.stringify(marker('grandchild'))}], { stdio: 'inherit' }); setTimeout(() => process.exit(0), ${LATE_MS + 2000});`,
  // the check starts a writer, then out-prints the output bound
  'overflow.cjs': `const { spawn } = require('child_process'); spawn(process.execPath, ['writer.cjs', ${JSON.stringify(marker('overflow'))}], { stdio: 'inherit' }); for (let i = 0; i < 400; i += 1) console.log('y'.repeat(1024)); setTimeout(() => process.exit(0), ${LATE_MS + 2000});`,
  'linger.cjs': `setTimeout(() => process.exit(0), ${LINGER_MS});`,
  'green.cjs': `console.log('green-output-7f3a'); process.exit(0);`,
  'red.cjs': `console.error('red-detail-9c1e'); process.exit(3);`,
};

function addTask(goal, ...scripts) {
  const r = pb(['plan', '--goal', goal, ...scripts.flatMap((s) => ['--check', `node ${s}`])]);
  const id = (r.out.match(/plan-\d+-\d+/) || [])[0];
  if (!id) throw new Error(`pb plan did not mint a task for ${scripts.join(', ')}:\n${r.out}`);
  return id;
}

// The killed check runs first; a green check that lingers past the late write runs second, so
// the engine is still ALIVE at the moment a surviving tree would write its marker. Without that,
// this test proves nothing on Windows: when pb itself exits, the OS tears its children down with
// it, so a leaked tree only does harm — and is only visible — while the engine carries on (the
// next check, `pb loop run`, the room server, a harness that calls pb from a long-lived process).
async function killedCase(name, script, outcomeRe, env = {}) {
  const id = addTask(`tree-kill probe: ${name}`, script, ...Array(LINGERS).fill('linger.cjs'));
  const started = Date.now();
  const r = pb(['validate', '--task', id], env);
  const ranFor = Date.now() - started;
  check(r.code !== 0, `[${name}] a killed check exited 0`);
  check(outcomeRe.test(r.out), `[${name}] the outcome was not ${outcomeRe}:\n${r.out}`);
  check(/PASS {2}node linger.cjs/.test(r.out), `[${name}] the lingering check did not run after the kill:\n${r.out}`);
  check(ranFor > LATE_MS + 500, `[${name}] pb was alive for only ${ranFor}ms, not past the late write at ${LATE_MS}ms — the test proves nothing`);
  await sleep(500);
  check(!existsSync(marker(name)),
    `[${name}] the check's process tree outlived the kill: its marker was written while the engine carried on`);
}

try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', pbRoot], { cwd: repo, stdio: 'ignore' });
  mkdirSync(join(pbRoot, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    cpSync(join(ROOT, 'node_modules', dep), join(pbRoot, 'node_modules', dep), { recursive: true });
  }
  pb(['loop', 'new']);
  // `pb plan` refuses without a phase brief whose Q5 is answered — and no command answers it.
  pb(['cycle', '--new', '--goal', 'probe the tree kill', '--stop', 'the probes ran']);
  const brief = join(pbRoot, 'memory', 'cycle.md');
  writeFileSync(brief, readFileSync(brief, 'utf8').replace(/\(Your host memory is the PAST[\s\S]*?memory\.\)/, 'NONE — scratch playbook for a test.'), 'utf8');
  for (const [file, body] of Object.entries(FIXTURES)) writeFileSync(join(pbRoot, file), `${body}\n`, 'utf8');

  // ── the kill paths ─────────────────────────────────────────────────────────
  await killedCase('direct', 'direct.cjs', /TIMEOUT/);
  await killedCase('grandchild', 'grandchild.cjs', /TIMEOUT/);
  await killedCase('overflow', 'overflow.cjs', /OUTPUT-LIMIT/, { PB_CHECK_TIMEOUT_MS: '30000', PB_CHECK_MAX_OUTPUT_BYTES: '1000' });

  // ── the launcher must be invisible to a check that runs normally ──────────
  const greenId = addTask('tree-kill probe: green', 'green.cjs');
  const green = pb(['validate', '--task', greenId]);
  check(green.code === 0, `a green check did not pass through the runner (exit ${green.code}):\n${green.out}`);
  check(/PASS {2}node green.cjs/.test(green.out), `the green check was not reported PASS:\n${green.out}`);

  const redId = addTask('tree-kill probe: red', 'red.cjs');
  const red = pb(['validate', '--task', redId]);
  check(red.code !== 0, 'a red check exited 0 through the runner');
  check(/FAIL {2}node red.cjs/.test(red.out), `the red check was not reported FAIL:\n${red.out}`);
  check(!/^\s*(TIMEOUT|OUTPUT-LIMIT) /m.test(red.out), `a plain failure was reported as a kill:\n${red.out}`);
  check(red.out.includes('red-detail-9c1e'), `the red check's stderr did not reach the report verbatim:\n${red.out}`);

  // ── nothing left behind ───────────────────────────────────────────────────
  const leftovers = readdirSync(pbTmp).filter((f) => /^pb-check-/.test(f));
  check(leftovers.length === 0, `the runner left ${leftovers.length} status file(s) behind: ${leftovers.join(', ')}`);
} catch (err) {
  problems.push(`harness error: ${String(err?.message ?? err)}`);
} finally {
  let removed = false;
  for (let attempt = 0; attempt < 8 && !removed; attempt += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      removed = !existsSync(work);
    } catch {
      await sleep(750);
    }
  }
  if (!removed) console.error(`note: left the scratch playbook on disk (still held): ${work}`);
}

console.log('Killed checks — the whole process tree dies with the kill');
console.log(`  platform : ${process.platform} (${process.platform === 'win32' ? 'taskkill /T /F' : 'process-group kill'})`);
console.log('  kills    : timer (direct + grandchild) and output-limit; no marker lands while the engine carries on');
console.log('  fidelity : green passes, red fails with its stderr shown, no status file left behind');

if (problems.length) {
  console.error(`\nTREE KILL FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nA killed check cannot write after the kill returns.');
