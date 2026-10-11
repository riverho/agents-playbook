#!/usr/bin/env node
// scripts/test-check-runner-limits.mjs — plan-20261010-027
// ----------------------------------------------------------------------------
// Four rough edges an independent checker found in the check runner, each pinned:
//   1. a refusal caused ONLY by the output bound names the output remedy, and does not
//      tell the reader to raise a time limit;
//   2. an overflow says when it was cut (a chatty-then-hanging check would only reveal
//      its hang once the bound is raised);
//   3. a red check's echoed output is bounded by BYTES, not just lines (one 200 KB line
//      used to be echoed whole);
//   4. `pb loop run --retry 0` means zero retries; a negative or non-number is refused.
// ----------------------------------------------------------------------------
import { makeFixture, makeSuite, runPb } from './test-fixture-playbook.mjs';

const t = makeSuite('test-check-runner-limits');
const { ok } = t;
const CHATTY = 'node -e "process.stdout.write(\'x\'.repeat(5000))"';
const CHATTY_HANG = 'node -e "process.stdout.write(\'y\'.repeat(5000)); setTimeout(() => {}, 2500)"';
const RED_LONG_LINE = 'node -e "process.stderr.write(\'z\'.repeat(200000)); process.exit(3)"';

const root = t.track(makeFixture({
  tasks: [
    { id: 'chatty', title: 'a green check that prints a lot', checks: [CHATTY] },
    { id: 'chatty-hang', title: 'prints a lot, then hangs', checks: [CHATTY_HANG] },
    { id: 'red-line', title: 'a red check with one huge line', checks: [RED_LONG_LINE] },
  ],
}));
const env = { PB_CHECK_MAX_OUTPUT_BYTES: '1000', PB_CHECK_TIMEOUT_MS: '60000' };

// 1. pure overflow → the output remedy only
{
  const r = runPb(root, ['record', '--task', 'chatty', '--action', 'execute', '--status', 'done', '--notes', 'x'], { env });
  ok('a pure overflow is refused as no-verdict', r.code !== 0 && /exceeded the output limit/.test(r.err), r.combined.slice(-800));
  ok('…and names the output remedy', /OUTPUT-LIMIT: bound 1000 bytes; make the check quieter/.test(r.err), r.err);
  ok('…and does NOT tell the reader to raise a time limit', !/check_timeout_ms|PB_CHECK_TIMEOUT_MS=/.test(r.err), r.err);
}
// 2. overflow says when it was cut
{
  const r = runPb(root, ['record', '--task', 'chatty-hang', '--action', 'execute', '--status', 'done', '--notes', 'x'], { env });
  ok('an overflow says how far into the time limit it was cut', /It was cut after \d+ms of a 60000ms time limit/.test(r.err), r.err);
  ok('…and warns that a bigger bound may expose a hang', /may still run on — and time out — if it is hanging/.test(r.err));
}
// 3. bounded tail by bytes
{
  const r = runPb(root, ['validate', '--task', 'red-line'], { env: { PB_CHECK_TIMEOUT_MS: '60000', PB_CHECK_MAX_OUTPUT_BYTES: '1000000' } });
  ok('a red check is reported as FAIL', /FAIL\s+node -e/.test(r.combined), r.combined.slice(0, 400));
  ok('…with its echoed output bounded by bytes', Buffer.byteLength(r.combined) < 8000, `${Buffer.byteLength(r.combined)} bytes printed`);
  ok('…and saying how much was not shown', /earlier bytes not shown\]/.test(r.combined));
}
// 4. --retry
{
  const zero = runPb(root, ['loop', 'run', '--auto', '--retry', '0', '--dry-run', '--max-tasks', '1']);
  ok('--retry 0 means zero retries', /retry=0/.test(zero.out), zero.combined.slice(0, 600));
  const none = runPb(root, ['loop', 'run', '--auto', '--dry-run', '--max-tasks', '1']);
  ok('no --retry still means 3', /retry=3/.test(none.out), none.combined.slice(0, 600));
  for (const bad of ['-1', 'abc', '1.5']) {
    const r = runPb(root, ['loop', 'run', '--auto', '--retry', bad, '--dry-run']);
    ok(`--retry ${bad} is refused`, r.code !== 0 && /--retry must be a whole number/.test(r.err), r.combined.slice(0, 300));
  }
}

t.finish();
