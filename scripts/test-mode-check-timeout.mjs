#!/usr/bin/env node
// ============================================================================
//  test-mode-check-timeout.mjs — a mode check that is KILLED must never be reported as
//  one that FAILED.
// ----------------------------------------------------------------------------
//  The defect this pins (plan-20261010-025): runModeChecks kept a hard-coded
//  `timeout: 120000` with piped stdio, so `modes/coding.yaml`'s `tests_green` principle —
//  which runs the whole suite, `npm test` — was killed at 120 s and printed as
//  `FAIL  [tests_green] npm test`. The suite was GREEN and took 142 s. A green suite
//  reported as red, with no hint that a timer had fired: the same class of lie as a toast
//  claiming a write that never landed.
//
//  Proven here end to end against the real CLI in a scratch playbook, whose own mode file is
//  replaced by one with principles whose behaviour we control:
//    green    exits 0, fast                       -> PASS
//    red      exits 1                             -> FAIL (the only real failure)
//    hang     never exits, tight per-check limit  -> TIMEOUT, a NON-VERDICT
//    chatty   exits 0 but out-prints a tiny bound -> OUTPUT-LIMIT, a NON-VERDICT
//  and, the shape of the live incident: a SLOW GREEN check is a non-verdict under a tight
//  limit and PASSES once the limit is raised — the remedy the old message never offered.
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

const work = mkdtempSync(join(tmpdir(), 'pb-mode-check-'));
const repo = join(work, 'repo');
const pbRoot = join(repo, '.agents-playbook');
mkdirSync(repo, { recursive: true });

const MODE_FILE = join(pbRoot, 'modes', 'coding.yaml');

function pb(args, env = {}) {
  const r = spawnSync(process.execPath, [join(pbRoot, 'scripts', 'pb.mjs'), ...args], {
    cwd: pbRoot, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Replace the scratch playbook's active mode with one whose principles we control.
function writeMode(principles) {
  const body = [
    'id: coding',
    'description: probe mode for the mode-check timeout gate',
    'principles:',
    ...principles.flatMap((p) => [
      `  - id: ${p.id}`,
      '    kind: check',
      `    text: probe ${p.id}`,
      `    check: node ${p.id}.js`,
      ...(p.timeoutMs === undefined ? [] : [`    check_timeout_ms: ${p.timeoutMs}`]),
    ]),
    '',
  ].join('\n');
  writeFileSync(MODE_FILE, body, 'utf8');
}

const SCRIPTS = {
  // exits 0 immediately
  green: 'process.exit(0);',
  // exits 1 — the only thing that may be called a failure
  red: 'console.log("deliberately red"); process.exit(1);',
  // never exits WITHIN the limit (it does stand down after 6s, because on Windows the
  // timeout kill does not take the process tree — plan-20261010-026 — and a truly immortal
  // fixture holds this temp directory open, which makes the cleanup below fail EPERM. That
  // is not hypothetical: the first run of this gate died exactly that way.)
  hang: 'setTimeout(() => process.exit(0), 6000);',
  // green, but slow: the live incident's shape (a suite that outruns a tight limit)
  slow: 'setTimeout(() => process.exit(0), 4000);',
  // green, but prints far more than the bound we set
  chatty: 'for (let i = 0; i < 400; i += 1) console.log("y".repeat(1024)); process.exit(0);',
};

try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', pbRoot], { cwd: repo, stdio: 'ignore' });
  mkdirSync(join(pbRoot, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    cpSync(join(ROOT, 'node_modules', dep), join(pbRoot, 'node_modules', dep), { recursive: true });
  }
  pb(['loop', 'new']);
  for (const [name, body] of Object.entries(SCRIPTS)) writeFileSync(join(pbRoot, `${name}.js`), `${body}\n`, 'utf8');

  // ── 1. all four outcomes in one run ────────────────────────────────────────
  writeMode([
    { id: 'green' },
    { id: 'red' },
    { id: 'hang', timeoutMs: 2000 },
    { id: 'chatty', timeoutMs: 60000 },
  ]);
  const mixed = pb(['mode', 'check'], { PB_CHECK_MAX_OUTPUT_BYTES: '1000' });
  const out = mixed.out;

  check(mixed.code !== 0, 'a run with a red principle and two non-verdicts exited 0');
  check(/PASS {2}\[green\]/.test(out), `the green principle was not reported PASS:\n${out}`);
  check(/FAIL {2}\[red\]/.test(out), `the red principle was not reported FAIL:\n${out}`);
  check(/TIMEOUT {2}\[hang\]/.test(out), `the hanging principle was not reported TIMEOUT:\n${out}`);
  check(/OUTPUT-LIMIT {2}\[chatty\]/.test(out), `the over-printing principle was not reported OUTPUT-LIMIT:\n${out}`);

  // The heart of it: a killed check must not read as a failed one.
  const timeoutLine = out.split('\n').find((l) => l.includes('[hang]')) ?? '';
  const overflowLine = out.split('\n').find((l) => l.includes('[chatty]')) ?? '';
  check(!/FAIL/.test(timeoutLine), `the TIMEOUT line says FAIL: ${timeoutLine.trim()}`);
  check(!/FAIL/.test(overflowLine), `the OUTPUT-LIMIT line says FAIL: ${overflowLine.trim()}`);
  check(out.includes('NOT a failing mode check'), 'the non-verdict lines do not say they are not failures');
  check(/reached NO VERDICT/.test(out), `the verdict does not name the non-verdicts:\n${out}`);
  check(/NOT failures/.test(out), 'the verdict does not state that a non-verdict is not a failure');
  check(/1 principle\(s\) exited non-zero/.test(out), `the verdict does not count the real failures:\n${out}`);
  check(out.includes('check_timeout_ms on principle [hang]'), 'the TIMEOUT does not name which limit fired');
  check(/limit 2000ms from check_timeout_ms on principle \[hang\]/.test(out), 'the reported limit/source is wrong for a per-principle limit');
  check(out.includes('max_output_bytes') || out.includes('limit 1000 bytes'), 'the OUTPUT-LIMIT does not name the output bound');

  // ── 2. the shape of the live incident: a slow GREEN check ──────────────────
  writeMode([{ id: 'slow' }]);
  const tight = pb(['mode', 'check'], { PB_MODE_CHECK_TIMEOUT_MS: '1000' });
  check(tight.code !== 0, 'a slow green check under a tight limit exited 0 — a non-verdict must not be a pass');
  check(/TIMEOUT {2}\[slow\]/.test(tight.out), `the slow green check was not TIMEOUT:\n${tight.out}`);
  check(/from env PB_MODE_CHECK_TIMEOUT_MS/.test(tight.out), 'the env limit source was not reported');
  check(!/FAIL/.test(tight.out.split('\n').find((l) => l.includes('[slow]')) ?? ''), 'the slow green check was called FAIL');

  const raised = pb(['mode', 'check'], { PB_MODE_CHECK_TIMEOUT_MS: '60000' });
  check(raised.code === 0, `raising the limit did not make the slow green check pass (exit ${raised.code}):\n${raised.out}`);
  check(/PASS {2}\[slow\]/.test(raised.out), 'the raised-limit run did not report PASS');
  check(/checks passed/.test(raised.out), 'the raised-limit run did not report the mode as passed');

  // ── 3. validate --mode shares the verdict ─────────────────────────────────
  const viaValidate = pb(['validate', '--mode'], { PB_MODE_CHECK_TIMEOUT_MS: '1000' });
  check(viaValidate.code !== 0, 'validate --mode exited 0 for an unverified mode');
  check(/NO VERDICT/.test(viaValidate.out), `validate --mode did not report a non-verdict:\n${viaValidate.out}`);
  check(!/check FAILED/.test(viaValidate.out) || !/slow/.test(viaValidate.out), 'validate --mode called a timeout a FAILED check');

  // ── 4. resolution order, and the default ──────────────────────────────────
  writeMode([{ id: 'green', timeoutMs: 45000 }]);
  const fromField = pb(['mode', 'check']);
  check(/limit 45000ms per mode check from check_timeout_ms on principle \[green\]/.test(fromField.out),
    `the per-principle field did not win over the default:\n${fromField.out}`);

  writeMode([{ id: 'green' }]);
  const fromDefault = pb(['mode', 'check']);
  check(/limit 600000ms per mode check from default/.test(fromDefault.out),
    `the default limit is not reported as 600000ms from default:\n${fromDefault.out}`);
  check(fromDefault.code === 0, 'an all-green mode did not pass');

  const nonsense = pb(['mode', 'check'], { PB_MODE_CHECK_TIMEOUT_MS: 'banana' });
  check(/PB_MODE_CHECK_TIMEOUT_MS is not a positive number of milliseconds/.test(nonsense.out),
    `a nonsense env limit did not warn:\n${nonsense.out}`);
  check(/limit 600000ms per mode check from default/.test(nonsense.out),
    'a nonsense env limit did not fall through to the default — it must not disable the limit');

  // the mode document's own field, between principle and env
  const modePath = MODE_FILE;
  writeFileSync(modePath, `${readFileSync(modePath, 'utf8')}mode_check_timeout_ms: 33000\n`, 'utf8');
  const fromDoc = pb(['mode', 'check'], { PB_MODE_CHECK_TIMEOUT_MS: '7000' });
  check(/limit 33000ms per mode check from mode mode_check_timeout_ms/.test(fromDoc.out),
    `the mode document field did not win over the env:\n${fromDoc.out}`);
} catch (err) {
  problems.push(`harness error: ${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  // Retry: a timeout fixture can still be releasing its handles. Swallowing this silently is
  // how %TEMP% reached 3580 stale fixture directories (plan-20261009-008), so say so instead.
  let removed = false;
  for (let attempt = 0; attempt < 8 && !removed; attempt += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      removed = !existsSync(work);
    } catch {
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  if (!removed) console.error(`note: left the scratch playbook on disk (still held): ${work}`);
}

console.log('Mode checks — a killed check is a NON-VERDICT, not a failure');
console.log('  outcomes : PASS / FAIL / TIMEOUT / OUTPUT-LIMIT reported distinctly');
console.log('  limit    : principle field > mode field > PB_MODE_CHECK_TIMEOUT_MS > PB_CHECK_TIMEOUT_MS > 600000 default');
console.log('  remedy   : raising the limit turns the non-verdict into a PASS');
console.log('  shared   : `pb mode check` and `validate --mode` reach the same verdict');

if (problems.length) {
  console.error(`\nMODE CHECK TIMEOUT FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nA green mode check is never reported as a failed one.');
