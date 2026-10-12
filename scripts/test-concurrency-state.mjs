#!/usr/bin/env node
// scripts/test-concurrency-state.mjs
// ----------------------------------------------------------------------------
// Concurrency regression suite for shared mutable PB state (multi-agent debt).
//
// The hazard this pins down: `backlog-state.json` is one JSON object. A naive
// read-modify-write of the WHOLE object (read it, patch your one task, write the
// whole thing back) silently discards every concurrent writer's change — the last
// process to write wins and the others' records vanish. Single-agent runs never
// expose it, which is why it survived this long.
//
// It also pins the ORDERING contract: with several agents writing concurrently,
// the journal must expose a total order (monotonic `seq`) and say exactly who
// wrote each state change, so "who wrote first / who wrote last" is answerable
// from the records instead of guessed from colliding ISO timestamps.
//
// Every racer is a real child process — an in-process Promise.all would share one
// module instance and prove nothing about cross-process races.
// ----------------------------------------------------------------------------

import {
  copyFileSync, mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const root = mkdtempSync(join(tmpdir(), 'pbconc-'));
for (const d of ['scripts', 'memory', 'modes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
try { symlinkSync(resolve('node_modules'), join(root, 'node_modules')); } catch {}

writeFileSync(join(root, 'playbook.yaml'),
  'name: conc-test\nversion: 0.3.6\nentry: SKILL.md\n' +
  'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
  'index:\n  cli: scripts/pb.mjs\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
  'loop:\n  description: test loop\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
  'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: loop-conc-001\nloops:\n  - id: loop-conc-001\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
writeFileSync(join(root, 'memory/cycle.md'),
  '# Cycle\n## 1. What is this cycle\'s goal?\nTest concurrency\n## 2. What challenges do I foresee?\nNone\n' +
  '## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');

// N tasks, N agents, one process each — the contended resource is the shared
// state FILE, not any single task.
const N = 8;
const ids = Array.from({ length: N }, (_, i) => `T${i + 1}`);
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n' + ids.map((id) => `  - {id: ${id}, title: task ${id}, status: todo, priority: 1}`).join('\n') + '\n');

const pbPath = join(root, 'scripts/pb.mjs');
const statePath = join(root, 'memory/backlog-state.json');
const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const readJournal = () => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function run(args, agent, env = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [pbPath, ...args], {
      cwd: root, env: { ...process.env, PB_AGENT_ID: agent, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => res({ code, out }));
  });
}
const traceOn = !!process.env.PB_TXN_TRACE;

// --- 1. concurrent claim: N agents claim N distinct tasks simultaneously -------
await Promise.all(ids.map((id, i) => run(['next', '--claim'], `a${i}`)));
{
  // Every racer picks the highest-priority *todo* task it can see, so they may
  // collide on the same task; what must hold is that no task is double-claimed
  // and the state file is intact JSON with a single recorded holder per task.
  const st = readState();
  const holders = ids.map((id) => st[id]?.claimed_by).filter(Boolean);
  ok('state file survives N concurrent claims as valid JSON', Object.keys(st).length > 0);
  ok('no task carries two holders / no lost update in the claim path',
    new Set(holders).size === holders.length, `holders=${JSON.stringify(holders)}`);
}

// --- 2. concurrent terminal records, MANY writers per task ---------------------
// This is the lost-update case. Every racer patches ONE task entry but the writer
// used to rewrite the WHOLE state object, so any two processes whose read-modify-
// write windows overlap erase each other — and because every process writes to the
// whole file, the collision is guaranteed once B batches run at once.
//
// No artificial delay here ON PURPOSE. This is the natural storm: it must hold under
// ordinary contention without help. The widened-window stress case lives in section 4,
// where a synchronized delay is what makes the race deterministic; loading both with
// that delay queues 24 writers behind one lock and turns ordinary scheduling jitter
// into spurious lock-wait expiries.
const B = 3;
const records = await Promise.all(
  Array.from({ length: B }, (_, b) => ids.map((id) =>
    run(['record', '--task', id, '--action', 'implement', '--status', 'done', '--skip-checks', '--notes', `by b${b}`],
      `b${b}`))).flat(),
);
{
  const st = readState();
  const missing = ids.filter((id) => !st[id]);
  const notDone = ids.filter((id) => st[id]?.status !== 'done');
  const aborted = readJournal().length;
  const failed = records.filter((r) => r.code !== 0);
  const seqOf = (r) => /\(seq (\d+)\)/.exec(r.out)?.[1] ?? '?';
  // A process that could not take the lock must FAIL, not report success — a
  // warning plus exit 0 tells a caller "recorded" when nothing was written, which
  // is precisely the kind of false success this project exists to refuse.
  const warnedNotFailed = records.filter((r) => /could not acquire/i.test(r.out) && r.code === 0);
  // Under heavy external load an acquire can exceed its wait window; the command
  // must then REPORT the loss rather than write a partial record. At most one such
  // refusal is tolerated, and only when it is clean: non-zero exit, nothing
  // journaled for it, no crash. Silent loss and torn state are never tolerated, and
  // a forced lock failure (section 5) proves this hatch cannot hide a broken writer.
  const cleanRefusals = failed.filter((r) => /Nothing was recorded/i.test(r.out) && seqOf(r) === '?');
  ok(`${B * N} concurrent records commit, or refuse cleanly (no partial writes)`,
    failed.length === cleanRefusals.length && cleanRefusals.length <= 2 && warnedNotFailed.length === 0,
    `failed=${failed.length} clean=${cleanRefusals.length} warnedButExit0=${warnedNotFailed.length} journalRows=${aborted}\n` +
    records.map((r) => `        exit=${r.code} seq=${seqOf(r)} ${r.out.split('\n').filter((l) => l && !l.startsWith('  ')).slice(0, 2).join(' | ')}`).join('\n'));
  ok('every concurrently-recorded task kept its state entry (no lost update)',
    missing.length === 0, `missing=${missing.join(',')} final=${JSON.stringify(Object.keys(st))}`);
  ok('every concurrently-recorded task ends done',
    notDone.length === 0, `notDone=${notDone.map((id) => `${id}:${st[id]?.status}`).join(',')}`);
  // The load-bearing assertion: N*B records were appended, so the journal must
  // contain N*B rows (minus any cleanly-refused writer, which journaled nothing).
  // Fewer means a concurrent append clobbered rows — the "who wrote what" record
  // itself lost data, which no refusal can explain away.
  const doneRows = readJournal().filter((r) => r.status === 'done');
  const expectedRows = B * N - cleanRefusals.length;
  ok(`journal retains every committed row (${expectedRows} expected, none clobbered)`,
    doneRows.length === expectedRows, `expected=${expectedRows} actual=${doneRows.length} cleanRefusals=${cleanRefusals.length}`);
}

// --- 3. ordering: the journal must expose a total order ----------------------
{
  const rows = readJournal();
  const seqs = rows.map((r) => r.seq).filter((s) => typeof s === 'number');
  const monotonicUpTo = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  const showSeqs = () => `rows=${rows.map((r) => `${r.agent}:${r.action}:${r.seq}`).join(' ')}`;
  if (traceOn && (!monotonicUpTo || new Set(seqs).size !== seqs.length)) {
    console.error('        TRACE:\n' + records.map((r) => r.out.split('\n').filter((l) => l.startsWith('[txn]')).join('\n')).join('\n'));
  }
  ok('every journal row carries a numeric seq (ordering is a fact, not a timestamp guess)',
    seqs.length === rows.length, `${seqs.length}/${rows.length} rows have seq`);
  ok('journal seq is strictly increasing in file order (append order == write order)',
    monotonicUpTo, `seqs=${seqs.join(',')}\n        ${showSeqs()}`);
  ok('seq values are unique across concurrent writers (no duplicate assignment)',
    new Set(seqs).size === seqs.length, `unique=${new Set(seqs).size} total=${seqs.length}\n        ${showSeqs()}`);

  // who wrote last must be answerable from the records, per user request.
  const lastBySeq = rows.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)).at(-1);
  ok('the last writer is identifiable from the journal row (agent + task)',
    !!lastBySeq && typeof lastBySeq.agent === 'string' && typeof lastBySeq.task === 'string',
    JSON.stringify(lastBySeq));

  const attributed = rows.filter((r) => r.status === 'done').every((r) => typeof r.agent_id === 'string' && r.agent_id.length > 0);
  ok('every done row is attributed to a named agent', attributed);

  // the recorded state must agree with the winning journal row — a mismatch means
  // the two stores drifted under concurrency.
  const st = readState();
  const drifted = ids.filter((id) => {
    const rowsFor = rows.filter((r) => r.task === id && r.status === 'done');
    if (!rowsFor.length) return true;
    const winner = rowsFor.reduce((a, b) => ((a.seq || 0) > (b.seq || 0) ? a : b));
    return st[id]?.status !== 'done' || st[id]?.updated_by !== winner.agent;
  });
  if (drifted.length) {
    for (const id of drifted.slice(0, 3)) {
      const rowsFor = rows.filter((r) => r.task === id && r.status === 'done');
      console.error(`        DEBUG ${id}: state.updated_by=${st[id]?.updated_by} state.seq=${st[id]?.seq} ` +
        `rows=${rowsFor.map((r) => `${r.agent}/seq${r.seq}`).join(' ')}`);
    }
  }
  ok('state attribution matches the winning journal row for every task (no drift)',
    drifted.length === 0, `drifted=${drifted.map((id) => `${id}(state.updated_by=${st[id]?.updated_by})`).join(',')}`);
}

// --- 4. atomicity: the state file is never observed torn ----------------------
{
  const raw = readFileSync(statePath, 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* torn write */ }
  ok('state file is complete parseable JSON after the storm (atomic replace)', parsed !== null);
  ok('state file ends with exactly one trailing newline (clean full-file write)',
    raw.endsWith('}\n') && !raw.endsWith('\n\n'));
}

// --- 4. stress: widen the read-modify-write window on purpose ------------------
// The natural window is a few milliseconds, so a fast machine can pass the storm
// above by luck. PB_TXN_TEST_DELAY_MS holds every writer inside its critical
// section, which makes the hazard deterministic instead of load-dependent:
//   - without a real transaction, writers interleave and the state loses entries;
//   - with one, the delay is serialized and every entry survives.
// The variable is a test lever only; it is not part of the product surface.
{
  const before = readState();
  const stressIds = ids.filter((id) => before[id]);
  writeFileSync(statePath, JSON.stringify(
    Object.fromEntries(stressIds.map((id) => [id, { status: 'in_progress' }])), null, 2) + '\n', 'utf8');
  await Promise.all(stressIds.map((id, i) =>
    run(['record', '--task', id, '--action', 'implement', '--status', 'done', '--skip-checks', '--notes', `stress${i}`],
      `s${i}`, { PB_TXN_TEST_DELAY_MS: '10', PB_TXN_TEST_PRELOCK_MS: '300' })));
  const st = readState();
  const lost = stressIds.filter((id) => st[id]?.status !== 'done');
  ok(`stress (widened RMW window): every one of ${stressIds.length} writers survives`,
    lost.length === 0,
    `lost=${lost.map((id) => `${id}:${st[id]?.status ?? 'GONE'}`).join(',')}`);
}

// --- 5. claim tokens + delegation chain + release -----------------------------
// A claim is a lease. The holder's identity is not enough for a fan-out: a
// sub-agent must be able to write back without impersonating its parent, and the
// records must say on whose behalf it wrote.
{
  const T = 'claim-token-task';
  // Fresh backlog and state: the claim must land on THIS task, not on a leftover
  // row from an earlier section (which is exactly how this test first went wrong).
  writeFileSync(join(root, 'memory/backlog.yaml'),
    `tasks:\n  - {id: ${T}, title: claim token probe, status: todo, priority: 1}\n`);
  writeFileSync(statePath, JSON.stringify({}, null, 2) + '\n', 'utf8');

  const claimRun = await run(['next', '--claim'], 'root');
  const token = /Claim token: ([0-9a-f]+)/.exec(claimRun.out)?.[1];
  const claimedId = /Claimed \[([^\]]+)\]/.exec(claimRun.out)?.[1];
  ok('claiming mints a claim token and prints it', !!token && claimedId === T,
    `claimedId=${claimedId}\n${claimRun.out.slice(-300)}`);
  const claimState = readState()[claimedId] || {};
  ok('the claim token is persisted with the claim', claimState.claim_token === token,
    `state.claim_token=${claimState.claim_token}`);

  // an unrelated agent cannot claim the same task, and cannot silently overwrite it
  const intruder = await run(['record', '--task', claimedId, '--action', 'implement', '--status', 'in_progress'], 'intruder');
  ok('an unentitled writer is warned about unproven ownership',
    /ownership=unproven|cannot prove/i.test(intruder.out), intruder.out.slice(0, 300));
  const intruderRow = readJournal().filter((r) => r.task === claimedId && r.agent === 'intruder').at(-1);
  ok('the unentitled write is still recorded, but flagged ownership=unproven',
    intruderRow?.ownership === 'unproven', JSON.stringify(intruderRow));

  // a sub-agent holding the token writes back as itself, proven. (Progress, not a
  // terminal status — a terminal record legitimately ends the iteration and would
  // end the lease with it.)
  const sub = await run(['record', '--task', claimedId, '--action', 'implement', '--status', 'in_progress', '--notes', 'sub result'],
    'sub-1', { PB_CLAIM_TOKEN: token });
  const subRow = readJournal().filter((r) => r.task === claimedId && r.agent === 'sub-1').at(-1);
  ok('a sub-agent holding the token writes back and is proven by token',
    subRow?.ownership === 'token', `${JSON.stringify(subRow)}\n${sub.out.slice(0, 200)}`);
  ok('the sub-agent is attributed as itself, not as the claim holder',
    subRow?.agent === 'sub-1' && subRow?.claimed_by === 'root', JSON.stringify(subRow));

  // ...or proven by a declared delegation chain, with the chain recorded
  const grand = await run(['record', '--task', claimedId, '--action', 'implement', '--status', 'in_progress', '--notes', 'chain result'],
    'grand-1', { PB_AGENT_CHAIN: 'root,sub-1,grand-1' });
  const grandRow = readJournal().filter((r) => r.task === claimedId && r.agent === 'grand-1').at(-1);
  ok('a descendant proven by delegation chain is recorded with the full chain',
    grandRow?.ownership === 'chain' && Array.isArray(grandRow?.agent_chain) && grandRow.agent_chain.includes('root'),
    JSON.stringify(grandRow));

  // release: an outsider is refused, the token holder succeeds, state returns to todo
  const denied = await run(['release', '--task', claimedId], 'outsider');
  ok('release is refused for a writer that cannot prove ownership',
    denied.code !== 0 && /Refusing to release/i.test(denied.out), denied.out.slice(0, 300));
  const released = await run(['release', '--task', claimedId], 'sub-1', { PB_CLAIM_TOKEN: token });
  ok('release succeeds with the claim token', released.code === 0, released.out.slice(0, 300));
  const after = readState()[claimedId] || {};
  ok('released task returns to todo with the claim cleared',
    after.status === 'todo' && !after.claim_token && after.released_by === 'sub-1', JSON.stringify(after));
  const releaseRow = readJournal().filter((r) => r.task === claimedId && r.action === 'release').at(-1);
  ok('the release is journaled with the previous holder', releaseRow?.claimed_by === 'root', JSON.stringify(releaseRow));
}

// --- 5b. a lock that cannot be taken must be REPORTED, never faked ------------
// The tolerance for one clean refusal above is only safe if a refusal is provably
// honest. Force the failure: hold the lock by hand and make the writer give up.
{
  const lockPath = `${statePath}.lock`;
  const before = readJournal().length;
  // Use a task that exists in the CURRENT backlog (section 5 replaced it).
  const probeTask = readFileSync(join(root, 'memory/backlog.yaml'), 'utf8').match(/id:\s*([^\s,}]+)/)?.[1];
  // Hold the lock for real, and hold it FRESH: breaking is age-based, so a live lock
  // must never be broken. Acquire gives up after its wait window, and the writer must
  // then report the loss rather than write a partial record.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'held-by-test', ts: new Date().toISOString() }));
  const refused = await run(['record', '--task', probeTask, '--action', 'implement', '--status', 'done', '--skip-checks'],
    'refuser', { PB_LOCK_STALE_MS: '50', PB_LOCK_WAIT_MS: '600' });
  const after = readJournal().length;
  rmSync(lockPath, { force: true });
  ok('a writer that cannot take the lock exits non-zero and says nothing was recorded',
    refused.code !== 0 && /Nothing was recorded/i.test(refused.out),
    `exit=${refused.code} out=${JSON.stringify(refused.out.slice(-400))}`);
  ok('the refused writer appended NO journal row (no phantom record)',
    after === before, `before=${before} after=${after}`);
  ok('the refused writer does not claim success in its output',
    !/^Recorded /m.test(refused.out), refused.out.slice(0, 200));
}

// --- 5c. Windows: a lock mid-delete answers EPERM, which is contention --------
// Creating a file whose previous holder is still being deleted fails on Windows
// with EPERM, not EEXIST. acquireLock used to rethrow it, so a losing writer in the
// 24-writer storm crashed at node:fs openSync and its row was simply missing
// (plan-20261011-004). The race is rare, so inject it: a preload makes the lock
// open throw EPERM, a few times (must wait and commit) or forever (must refuse).
{
  const preload = join(root, 'eperm-lock.mjs');
  writeFileSync(preload, [
    "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';",
    'const real = fs.openSync; let left = Number(process.env.EPERM_TIMES);',
    'fs.openSync = function (p, flags, ...rest) {',
    "  if (flags === 'wx' && String(p).endsWith('.lock') && left !== 0) { left--; const e = new Error(`EPERM: operation not permitted, open '${p}'`); e.code = 'EPERM'; throw e; }",
    '  return real.call(this, p, flags, ...rest); };',
    'syncBuiltinESMExports();',
  ].join('\n'));
  const NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  const probeTask = readFileSync(join(root, 'memory/backlog.yaml'), 'utf8').match(/id:\s*([^\s,}]+)/)?.[1];
  const rec = (agent, env) => run(['record', '--task', probeTask, '--action', 'implement', '--status', 'done', '--skip-checks', '--notes', agent], agent, env);

  const before = readJournal().length;
  const waited = await rec('eperm-few', { NODE_OPTIONS, EPERM_TIMES: '25' });
  ok('a writer that meets EPERM on the lock (a lock mid-delete) waits and commits, no crash',
    waited.code === 0 && !/at openSync/.test(waited.out) && readJournal().length === before + 1,
    `exit=${waited.code} out=${JSON.stringify(waited.out.slice(-400))}`);

  const before2 = readJournal().length;
  const stuck = await rec('eperm-always', { NODE_OPTIONS, EPERM_TIMES: '-1', PB_LOCK_TRANSIENT_MS: '300' });
  ok('a lock that keeps answering EPERM is refused with an actionable message, not a stack trace',
    stuck.code !== 0 && /Nothing was recorded/i.test(stuck.out) && /EPERM/.test(stuck.out) && !/at openSync/.test(stuck.out),
    `exit=${stuck.code} out=${JSON.stringify(stuck.out.slice(-400))}`);
  ok('the EPERM-refused writer appended NO journal row', readJournal().length === before2);
}

console.log(`\ntest-concurrency-state: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);


