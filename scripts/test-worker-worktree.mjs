#!/usr/bin/env node
// scripts/test-worker-worktree.mjs
// ----------------------------------------------------------------------------
// Full WorkTree lifecycle guardrail (multi-agent debt item 2).
//
// The lifecycle used to be half-built: `create` checked branch/path existence
// OUTSIDE the state lock and then ran `git worktree add` AFTER releasing it, so
// two agents racing for one task could both observe a free slot and both try to
// claim it; `merge-ready` never looked at the branch at all, so it could bless a
// worker that had produced no commits, in a worktree that no longer existed; and
// merge readiness ran the task's acceptance checks against the ROOT checkout
// rather than the worker's tree — the exact opposite of what isolation means.
//
// This suite pins the whole path: atomic slot acquisition, status accounting,
// checks that run IN the worktree, a merge gate that reads the branch, and a
// merge that actually lands the work.
// ----------------------------------------------------------------------------

import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// --- fixture: a real git repo with a real playbook engine ---------------------
const root = tempDir('pbwt-');
for (const d of ['scripts', 'memory', 'modes', 'processes', 'skills/run-task', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
cpSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
writeFileSync(join(root, 'SKILL.md'), '---\nname: t\ndescription: t\n---\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
writeFileSync(join(root, 'skills/run-task/SKILL.md'), '---\nname: run-task\ndescription: t\n---\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: loop-wt-001\nloops:\n  - id: loop-wt-001\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
writeFileSync(join(root, 'memory/cycle.md'),
  '# Cycle\n## 1. What is this cycle\'s goal?\nWorktree\n## 2. What challenges do I foresee?\nNone\n' +
  '## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');
// The task's acceptance check proves the check ran in the WORKER's tree: it looks
// for a file that exists only in the worker branch, never in the root checkout.
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: wt-task',
  '    title: Worktree lifecycle task',
  '    status: todo',
  '    skill: run-task',
  '    priority: 1',
  '    acceptance_checks:',
  '      - node -e "require(\'fs\').accessSync(\'worker-artifact.txt\')"',
  '',
].join('\n'));
writeFileSync(join(root, 'playbook.yaml'), [
  'name: worker-worktree-test', 'version: 0.3.6', 'entry: SKILL.md',
  'paths:', '  scripts: scripts', '  processes: processes', '  skills: skills', '  memory: memory', '  artifacts: artifacts', '  reports: artifacts/reports',
  'index:', '  processes_index: processes/index.yaml', '  skills_index: skills/index.yaml', '  memory:',
  '    project_memory: memory/project-memory.md', '    backlog: memory/backlog.yaml', '    journal: memory/journal.ndjson',
  '    cycle: memory/cycle.md', '    loops: memory/loops.yaml', '    lessons: memory/lessons.ndjson', '    processes: memory/processes.ndjson',
  'loop:', '  description: test loop', '  steps:', '    - id: orient', '      do: orient', '      command: node scripts/pb.mjs status',
  'default_mode: coding', 'modes:', '  coding: modes/coding.yaml',
  'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', '',
].join('\n'));

const git = (args, cwd = root, { quiet = true } = {}) => {
  const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'] });
  return out || '';
};
git(['init']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test']);
writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
git(['add', '.']);
git(['commit', '-m', 'seed']);

const pbPath = join(root, 'scripts/pb.mjs');
const statePath = join(root, 'memory/backlog-state.json');
const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const readJournal = () => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// stdout and stderr are captured SEPARATELY. The CLI deliberately routes git's
// chatter to stderr so `--json` stdout stays parseable; a harness that concatenates
// the two then parses JSON corrupts itself on any warning git emits.
function runPb(args, { agent = 'root', env = {} } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [pbPath, ...args], { cwd: root, env: { ...process.env, PB_AGENT_ID: agent, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => res({ code, out, err, combined: `${out}${err}` }));
  });
}
const parseJson = (r) => { try { return JSON.parse(r.out); } catch { return {}; } };
const pb = (args, opts) => runPb(args, opts);

// --- 1. claim, then acquire the worker slot atomically ------------------------
const claim = await pb(['next', '--claim'], { agent: 'root' });
ok('task claimed before a worker is opened', /Claimed \[wt-task\]/.test(claim.out), claim.out.slice(-200));
const claimToken = /Claim token: ([0-9a-f]+)/.exec(claim.out)?.[1];

const created = await pb(['worker', 'create', 'wt-task', '--agent', 'root', '--execute', '--json']);
const createdPayload = parseJson(created);
ok('worker create --execute records a worker in state',
  created.code === 0 && !!(readState()['wt-task']?.worker), created.out.slice(0, 400));
const createdWorkerPath = createdPayload.worktree || createdPayload.worktree_path;
// Reassigned in section 2: the setup worker is torn down and a racer wins the slot,
// so later sections must act on the SURVIVING worktree, not the setup one.
let workerPath = createdWorkerPath;
ok('the worktree exists on disk and git knows about it',
  !!createdWorkerPath && existsSync(createdWorkerPath) && git(['worktree', 'list']).includes(createdPayload.branch),
  `path=${createdWorkerPath} branch=${createdPayload.branch}`);
ok('the worker record captures the base commit it forked from',
  typeof readState()['wt-task']?.worker?.base_commit === 'string' && readState()['wt-task'].worker.base_commit.length >= 7,
  JSON.stringify(readState()['wt-task']?.worker));

// --- 2. concurrent slot acquisition: exactly one winner, no half-made state ---
// A worker slot belongs to the TASK, not to the task+agent pair (the branch name
// embeds the agent, so a per-pair check let two agents open two slots for one
// task). Release the setup worker first so the race starts from a genuinely free
// slot, then let two racers contend for it.
{
  await pb(['worker', 'remove', 'wt-task', '--agent', 'root', '--delete-branch', '--force', '--execute']);
  const before = git(['worktree', 'list']).trim().split('\n').length;
  const racers = await Promise.all([
    runPb(['worker', 'create', 'wt-task', '--agent', 'racer-a', '--execute'], { agent: 'racer-a', env: { PB_TXN_TEST_PRELOCK_MS: '250' } }),
    runPb(['worker', 'create', 'wt-task', '--agent', 'racer-b', '--execute'], { agent: 'racer-b', env: { PB_TXN_TEST_PRELOCK_MS: '250' } }),
  ]);
  const winners = racers.filter((r) => r.code === 0);
  const loser = racers.find((r) => r.code !== 0);
  const after = git(['worktree', 'list']).trim().split('\n').length;
  const winnerIdx = winners[0] ? (winners[0] === racers[0] ? 'a' : 'b') : null;
  const loserIdx = winnerIdx === 'a' ? 'b' : 'a';
  const loserPath = resolve(root, '..', `${basename(root)}-worker-wt-task-racer-${loserIdx}`);
  ok('exactly one of two racing worker creates succeeds (the slot is per-task)', winners.length === 1,
    racers.map((r) => `exit=${r.code} ${r.out.trim().split('\n').filter(Boolean).slice(-2).join(' | ')}`).join('\n'));
  ok('the winner opened exactly one worktree (no double-create)',
    after === before + 1, `worktree lines before=${before} after=${after} (expected ${before + 1})\n${git(['worktree', 'list'])}`);
  ok('the losing racer left no orphan worktree on disk', !existsSync(loserPath), `loser path exists: ${loserPath}`);
  ok('the losing racer fails with an actionable reason, not a stack trace',
    !!loser && /already has a live worker slot/i.test(loser.combined) && !/\bat .*\(node:internal/.test(loser.combined),
    loser?.combined.slice(0, 300));
  const rec = readState()['wt-task']?.worker || {};
  const winnerName = `racer-${winnerIdx}`;
  ok('the recorded worker is the winner (no lost update on the worker record)',
    rec.agent === winnerName && rec.worktree_path.includes(winnerName), `recorded=${rec.agent} winner=${winnerName}`);
  // Continue the rest of the suite against the surviving slot.
  const survivedPath = rec.worktree_path;
  ok('the winner\'s worktree is the one on disk', existsSync(survivedPath), survivedPath);
  workerPath = survivedPath;
}

// --- 3. status accounting: ahead / behind / clean ---------------------------------
{
  const status = await pb(['worker', 'status', 'wt-task', '--json']);
  const payload = parseJson(status);
  ok('worker status reports a machine-readable worktree state',
    status.code === 0 && payload.schema === 'agent-playbook.worker-status.v1', status.out.slice(0, 400));
  ok('a fresh worker reports clean and level with its base',
    payload.clean === true && payload.ahead === 0, JSON.stringify(payload));
  ok('status counts the tracked files the worker shares with root',
    Array.isArray(payload.changed) && payload.changed.length === 0, JSON.stringify(payload.changed));

  // make a commit inside the worker tree — this is the work the merge gate judges
  writeFileSync(join(workerPath, 'worker-artifact.txt'), 'produced inside the worktree\n');
  git(['add', 'worker-artifact.txt'], workerPath);
  git(['commit', '-m', 'worker: produce artifact'], workerPath);

  const after = parseJson(await pb(['worker', 'status', 'wt-task', '--json']));
  ok('status sees the worker commit (ahead by 1)', after.ahead === 1, JSON.stringify(after));
  ok('status reports the branch head commit', typeof after.head === 'string' && after.head.length >= 7, JSON.stringify(after));
}

// --- 4. the task's checks must run IN the worker tree, not the root checkout ----
{
  const rootHas = existsSync(join(root, 'worker-artifact.txt'));
  ok('the artifact exists only in the worker tree (so the check is meaningful)', rootHas === false);
  const verify = await pb(['worker', 'verify', 'wt-task', '--json']);
  const payload = parseJson(verify);
  ok('worker verify runs the task checks inside the worktree and passes',
    verify.code === 0 && payload.passed === true, verify.out.slice(0, 500));
  const rec = readState()['wt-task']?.worker || {};
  ok('verify records last_verified_commit so staleness is detectable',
    typeof rec.last_verified_commit === 'string' && rec.last_verified_commit.length >= 7, JSON.stringify(rec));
}

// --- 5. the merge gate reads the branch, not just the journal -------------------
{
  // deliver the task through its real checks, from the worker's perspective
  const done = await pb(['record', '--task', 'wt-task', '--action', 'implement', '--status', 'in_progress', '--notes', 'work in progress'],
    { agent: 'worker-1', env: { PB_CLAIM_TOKEN: claimToken } });
  ok('a delegated progress record is accepted with the claim token', done.code === 0, done.out.slice(0, 300));

  const premature = await pb(['worker', 'merge-ready', 'wt-task', '--json']);
  const pPayload = parseJson(premature);
  ok('merge gate is closed while the task is not done', pPayload.ready === false, JSON.stringify(pPayload.reasons));

  // A worker whose tree is dirty must not be mergeable: uncommitted work would be
  // silently left behind by `git worktree remove`.
  writeFileSync(join(workerPath, 'scratch.txt'), 'uncommitted\n');
  const dirty = await pb(['worker', 'merge-ready', 'wt-task', '--json']);
  const dirtyPayload = parseJson(dirty);
  ok('a dirty worktree blocks the merge gate', dirtyPayload.ready === false && dirtyPayload.reasons.some((r) => /uncommitted|dirty/i.test(r)),
    JSON.stringify(dirtyPayload.reasons));
  rmSync(join(workerPath, 'scratch.txt'));
}

// --- 6. merge: land the branch, then tear the slot down ------------------------
{
  // Record the task done against the WORKER's tree (--at), so the checks that
  // certify it are the ones that ran on the isolated branch. Recording done at the
  // root would fail here — the artifact does not exist there yet — which is exactly
  // the ordering problem --at solves.
  const done = await pb(['record', '--task', 'wt-task', '--action', 'implement', '--status', 'done',
    '--at', workerPath, '--token', claimToken, '--notes', 'delivered in the worker worktree'],
  { agent: 'worker-1', env: { PB_CLAIM_TOKEN: claimToken } });
  ok('recording done against the worker tree runs the checks there and passes', done.code === 0, done.out.slice(0, 500));
  const doneRow = readJournal().filter((r) => r.task === 'wt-task' && r.status === 'done').at(-1);
  ok('the done row records that checks ran in the worker tree (not the root)',
    doneRow?.checks === 'passed' && typeof doneRow?.check_cwd === 'string' && doneRow.check_cwd !== 'root',
    JSON.stringify(doneRow));

  const refused = await pb(['worker', 'merge', 'wt-task', '--execute', '--json']);
  ok('merge still refuses without an independent checker verdict',
    refused.code !== 0 && /checker verdict/i.test(refused.combined) && !existsSync(join(root, 'worker-artifact.txt')),
    refused.combined.slice(0, 400));

  // the independent verdict, then the gated merge
  await pb(['worker', 'checker', 'wt-task', '--verdict', 'pass', '--notes', 'branch reviewed'], { agent: 'checker-1' });
  const merged = await pb(['worker', 'merge', 'wt-task', '--agent', 'root', '--execute', '--json']);
  const mergePayload = parseJson(merged);
  ok('a fully gated merge lands the worker artifact in the root checkout',
    merged.code === 0 && existsSync(join(root, 'worker-artifact.txt')), merged.out.slice(0, 500));
  ok('the merge records the merge commit and disposition in worker state',
    typeof mergePayload.merge_commit === 'string' && readState()['wt-task']?.worker?.status === 'merged',
    `payload.merge_commit=${mergePayload.merge_commit} raw=${JSON.stringify(merged.out.slice(0, 200))} state=${JSON.stringify(readState()['wt-task']?.worker?.status)}`);

  // Teardown is always available and is symmetric with create.
  const removed = await pb(['worker', 'remove', 'wt-task', '--delete-branch', '--force', '--execute']);
  ok('teardown removes the worktree and records the reason', removed.code === 0 && !existsSync(workerPath),
    removed.out.slice(0, 300));
  const rec = readState()['wt-task']?.worker || {};
  ok('the removal is journaled with its disposition',
    rec.status === 'removed' && !!rec.removed_at && rec.merge_commit, JSON.stringify(rec));
}

console.log(`\ntest-worker-worktree: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

