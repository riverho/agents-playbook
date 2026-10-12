#!/usr/bin/env node
// scripts/test-kill-failure-reported.mjs — plan-20261010-042
// ----------------------------------------------------------------------------
// When a check hits its limit the launcher kills the whole process tree. If that kill
// FAILS, the engine has stopped waiting while the check may still be running — so the
// report must say so next to TIMEOUT, not only in the check's own stderr.
//
// The failure is forced honestly on Windows: PB_TASKKILL (where the launcher finds
// taskkill.exe) points at a file that does not exist, so the real kill call fails (ENOENT).
// On POSIX a group kill cannot be made to fail from outside without privileges, so the
// forced case is skipped there and only the quiet case runs.
// ----------------------------------------------------------------------------
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixture, makeSuite, readJournal, runPb } from './test-fixture-playbook.mjs';
import { tempDir } from './lib/test-temp.mjs';

const t = makeSuite('test-kill-failure-reported');
const { ok } = t;
const SLOW = 'node -e "setTimeout(() => {}, 4000)"';
const root = t.track(makeFixture({ tasks: [{ id: 'slow', title: 'a check that outlives its limit', checks: [SLOW] }] }));
const env = { PB_CHECK_TIMEOUT_MS: '800' };

// the quiet case: the kill works, the report has no warning
{
  const r = runPb(root, ['validate', '--task', 'slow'], { env });
  ok('a timed-out check is reported as TIMEOUT', /TIMEOUT\s+node -e/.test(r.out), r.combined);
  ok('a kill that worked prints no warning', !/could NOT be killed/.test(r.out), r.out);
}

if (process.platform === 'win32') {
  const nowhere = tempDir('pb-no-sysroot-');
  rmSync(nowhere, { recursive: true, force: true });
  const r = runPb(root, ['validate', '--task', 'slow'], { env: { ...env, PB_TASKKILL: join(nowhere, 'taskkill.exe') } });
  ok('the forced case still reports TIMEOUT', /TIMEOUT\s+node -e/.test(r.out), r.combined);
  ok('a failed kill is reported next to the verdict', /WARNING: the check's process tree could NOT be killed \(pid \d+: /.test(r.out), r.out);
  ok('the warning says processes may still be running', /may still be running/.test(r.out));
  // PB_TASKKILL may only name a taskkill.exe: any other program is ignored (the real one runs)
  const other = runPb(root, ['validate', '--task', 'slow'], { env: { ...env, PB_TASKKILL: process.execPath } });
  ok('a PB_TASKKILL that is not taskkill.exe is ignored', other.out.includes('TIMEOUT  node -e') && !/could NOT be killed/.test(other.out), other.out);
  // an autonomous run moves on — the failed kill must be in its journal row
  const auto = runPb(root, ['loop', 'run', '--auto', '--max-tasks', '1', '--retry', '0'], { agent: 'auto', env: { ...env, PB_TASKKILL: join(nowhere, 'taskkill.exe') } });
  const rows = readJournal(root).filter((x) => x.task === 'slow' && x.action === 'auto-execute');
  const last = rows[rows.length - 1];
  ok('an autonomous run journals the failed kill', !!last && Array.isArray(last.check_timeouts) && String(last.check_timeouts[0]?.kill_failed ?? '').startsWith('pid ') && String(last.check_timeouts[0]?.kill_failed).includes('ENOENT'), auto.combined.slice(-600) + JSON.stringify(last));
  // a refused record leaves one 'check-run' row (no status change) carrying the failed kill
  const before = readJournal(root).length;
  const rec = runPb(root, ['record', '--task', 'slow', '--action', 'execute', '--status', 'done', '--notes', 'x'], { agent: 'lead', env: { ...env, PB_TASKKILL: join(nowhere, 'taskkill.exe') } });
  const after = readJournal(root);
  const cr = after[after.length - 1];
  ok('a refused record journals one check-run row with the failed kill', rec.code !== 0 && after.length === before + 1 && cr.action === 'check-run' && String(cr.check_timeouts?.[0]?.kill_failed ?? '').includes('ENOENT'), rec.combined.slice(-500) + JSON.stringify(cr));
  ok('…and does not move the task', cr.status === 'todo' || cr.status === 'blocked');
  // the leaked child sleeps 4s and exits on its own; give it the time so the temp root can go
  await new Promise((res) => setTimeout(res, 4200));
} else {
  console.log('  SKIP  forcing a failed kill needs win32 (taskkill under SystemRoot)');
}

t.finish();
